import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { buildSignalCompareReport, formatSignalCompareTable, renderSignalCompare } from '../src/signalCompare';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLiveCandidate(overrides: Record<string, unknown> = {}) {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'CompareMint111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/compare',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/compare',
        pairAddress: 'ComparePair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }], socials: [{ url: 'https://x.com/example', type: 'twitter' }] },
        baseToken: { address: 'CompareMint111111111111111111111111111111111', name: 'Compare Token', symbol: 'CMP' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

function seedCandidate(db: ReturnType<typeof createDb>, options: {
  mint: string;
  symbol: string;
  signalClass: 'EARLY_RUNNER' | 'INSTANT_DUMP';
  bestGainPct: number;
  worstDrawdownPct: number;
  movedBeforeDiscoveryPct: number;
}) {
  const snapshot = makeLiveCandidate({
    mint: options.mint,
    symbol: options.symbol,
    name: `${options.symbol} Token`,
    movedBeforeDiscoveryPct: options.movedBeforeDiscoveryPct,
    priceUsd: 1,
    liquidityUsd: 12000,
    volume5mUsd: 7000,
    volume1hUsd: 25000,
    buys5m: 25,
    sells5m: 10,
    sourceUrl: `https://dexscreener.com/solana/${options.symbol.toLowerCase()}`
  });
  const tokenId = db.upsertToken(snapshot);
  db.insertSnapshot(tokenId, snapshot);
  const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, {
    snapshot,
    score: {
      tokenId,
      scoredAt: new Date().toISOString(),
      momentumScore: 20,
      safetyScore: 10,
      socialScore: 8,
      totalScore: 38,
      verdict: 'WATCH',
      reasons: ['buy/sell ratio supportive at 2.50', 'liquidity is above configured minimum'],
      redFlags: ['freeze authority unknown', 'sell quote unavailable'],
      autopilotBlocked: true,
      autopilotBlockers: []
    },
    redFlags: ['freeze authority unknown', 'sell quote unavailable']
  });
  db.sqlite.prepare('UPDATE watch_only_candidates SET best_gain_pct = ?, worst_drawdown_pct = ? WHERE id = ?').run(options.bestGainPct, options.worstDrawdownPct, watchId);
  db.upsertWatchOnlySignalAnalysis(
    watchId,
    tokenId,
    options.signalClass,
    new Date().toISOString(),
    options.bestGainPct,
    options.worstDrawdownPct,
    options.movedBeforeDiscoveryPct,
    12000,
    'UNKNOWN',
    'UNKNOWN',
    'UNKNOWN',
    'seeded analysis',
    'Watch-only analysis is research only.',
    { seeded: true }
  );
}

describe('signal compare', () => {
  it('signal compare works with empty DB', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = buildSignalCompareReport(db, config);
    expect(report.summary).toHaveProperty('leftCount', 0);
    expect(report.finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('signal compare returns left/right counts', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(report.summary).toHaveProperty('leftCount', 1);
    expect(report.summary).toHaveProperty('rightCount', 1);
    db.close();
  });

  it('signal compare includes metric comparison', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(report.metricComparison).toHaveProperty('bestGainPct');
    db.close();
  });

  it('signal compare includes boolean/profile comparison', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(report.booleanProfileComparison).toHaveProperty('websitePresent');
    db.close();
  });

  it('signal compare includes red flag comparison', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(report.redFlagComparison).toHaveProperty('commonInLeftClass');
    db.close();
  });

  it('signal compare includes positive reason comparison', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(report.positiveReasonComparison).toHaveProperty('commonInLeftClass');
    db.close();
  });

  it('signal compare includes sample-size warning', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    const report = buildSignalCompareReport(db, config);
    expect(report.summary).toHaveProperty('sampleSizeWarning');
    db.close();
  });

  it('signal compare includes conservative operator recommendation', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(report.operatorRecommendation.join(' ')).toMatch(/Need more samples|Safety enrichment|Recommended next action/i);
    db.close();
  });

  it('signal compare includes finalSafetyStatus: Real trading remains locked.', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = buildSignalCompareReport(db, config);
    expect(report.finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('signal compare never opens paper positions', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    buildSignalCompareReport(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    db.close();
  });

  it('signal compare never records real trade attempts', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    buildSignalCompareReport(db, config);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('class override works', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    const report = buildSignalCompareReport(db, config, { SIGNAL_COMPARE_LEFT_CLASS: 'EARLY_RUNNER', SIGNAL_COMPARE_RIGHT_CLASS: 'EARLY_RUNNER' } as NodeJS.ProcessEnv);
    expect(report.summary).toHaveProperty('leftClass', 'EARLY_RUNNER');
    expect(report.summary).toHaveProperty('rightClass', 'EARLY_RUNNER');
    db.close();
  });

  it('table format works', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Cmp111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Cmp222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalCompareReport(db, config);
    expect(formatSignalCompareTable(report)).toContain('Signal Compare Report');
    expect(renderSignalCompare(report, { SIGNAL_COMPARE_FORMAT: 'table' } as NodeJS.ProcessEnv)).toContain('Signal Compare Report');
    db.close();
  });
});
