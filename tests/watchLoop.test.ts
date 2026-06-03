import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { AppLogger } from '../src/logger';
import { createStopSignal, installWatchLoopSignalHandlers, runWatchCycle, runWatchLoop } from '../src/watchLoop';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLiveCandidate(overrides: Record<string, unknown> = {}) {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'LoopMint111111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/loop',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/loop',
        pairAddress: 'LoopPair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'LoopMint111111111111111111111111111111111111', name: 'Loop Token', symbol: 'LOOP' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

describe('watch loop', () => {
  it('watch-cycle runs without paper buys', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }) });
    const summary = await runWatchCycle(db, config, 1, new AppLogger(false));
    expect(summary.paperBuysOpened).toBe(0);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    db.close();
  });

  it('watch-cycle reports cycle-scoped paper buys only when auto-paper is disabled and old paper buys exist', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_AUTO_PAPER_TRADING: 'false' });
    cleanup.push(dir);
    const db = createDb(config);
    const candidate = makeLiveCandidate({
      tokenAddress: 'LoopMintHistorical1111111111111111111111111111',
      pairAddress: 'LoopPairHistorical111',
      url: 'https://dexscreener.com/solana/loop-historical',
      movedBeforeDiscoveryPct: 20
    });
    const tokenId = db.upsertToken(candidate);
    db.insertSnapshot(tokenId, candidate);
    const proposalId = db.createProposal(tokenId, 'BUY', 1, 'PAPER_BUY', 'historical paper buy', 'PENDING', {});
    db.createPaperTrade(tokenId, proposalId, 'BUY', 1, candidate.priceUsd ?? 1, 1, 'historical paper buy');
    db.createPosition(tokenId, 'PAPER', 'OPEN', candidate.priceUsd ?? 1, 1, 1, 'historical paper buy');

    const summary = await runWatchCycle(db, config, 1, new AppLogger(false));

    expect(db.getDailyPaperBuyCount()).toBe(1);
    expect(summary.paperBuysOpened).toBe(0);
    expect(db.getOpenPositionCount('PAPER')).toBe(1);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('watch-cycle runs without real trade attempts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }) });
    const summary = await runWatchCycle(db, config, 1, new AppLogger(false));
    expect(summary.realTradeAttempts).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('watch-loop respects max cycles', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const sleep = vi.fn(async () => {});
    const result = await runWatchLoop(db, config, { maxCycles: 2, intervalSeconds: 1, sleep, logger: new AppLogger(false), registerSignalHandlers: false });
    expect(result.cyclesCompleted).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('watch-loop uses interval override without waiting in tests', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const sleep = vi.fn(async (_ms: number) => {});
    await runWatchLoop(db, config, { maxCycles: 2, intervalSeconds: 7, sleep, logger: new AppLogger(false), registerSignalHandlers: false });
    expect(sleep).toHaveBeenCalledWith(7000);
    db.close();
  });

  it('watch-loop summary includes real trading locked', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const logger = new AppLogger(false);
    const summary = await runWatchCycle(db, config, 1, logger);
    expect(summary.finalSafetyStatus).toContain('Real trading remains locked');
    expect(logger.entries.some((entry) => entry.includes('Real trading remains locked'))).toBe(true);
    db.close();
  });

  it('Ctrl+C/signal handler is present and loop supports clean stop', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const stopSignal = createStopSignal();
    const cleanupHandlers = installWatchLoopSignalHandlers(stopSignal, new AppLogger(false));
    process.emit('SIGINT');
    expect(stopSignal.stopped).toBe(true);
    cleanupHandlers();
    const result = await runWatchLoop(db, config, { maxCycles: 3, intervalSeconds: 1, sleep: async () => {}, logger: new AppLogger(false), stopSignal, registerSignalHandlers: false });
    expect(result.stoppedGracefully).toBe(true);
    expect(result.cyclesCompleted).toBe(0);
    db.close();
  });
});
