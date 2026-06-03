import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { classifyWatchOnlyCandidate, runWatchAnalysis, summarizeWatchOnlySignalAnalysis } from '../src/watchAnalysis';
import { buildWatchOnlyReport, classifyWatchPriority, classifyWatchRunnerProfile, renderWatchAutopsy } from '../src/watchOnly';
import { buildDailyReport } from '../src/paper/dailyReport';
import { verifySafety } from '../src/verifySafety';

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
      tokenAddress: 'AnalysisMint111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/analysis',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/analysis',
        pairAddress: 'AnalysisPair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'AnalysisMint111111111111111111111111111111111', name: 'Analysis Token', symbol: 'ANL' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

describe('watch-only signal analysis', () => {
  it('classifier assigns HIGH_WATCH_PRIORITY for strong RUNNER_PROFILE with good liquidity/volume and low drawdown', () => {
    expect(classifyWatchPriority({
      profile: 'RUNNER_PROFILE',
      liquidityUsd: 15000,
      volume1hUsd: 150000,
      momentumScore: 22,
      worstDrawdownPct: -5,
      priceChange5mPct: 5,
      priceChange1hPct: 20
    })).toBe('HIGH_WATCH_PRIORITY');
  });

  it('classifier assigns MEDIUM_WATCH_PRIORITY for near-runner/unknown strong setup', () => {
    expect(classifyWatchPriority({
      profile: 'RUNNER_PROFILE',
      liquidityUsd: 11000,
      volume1hUsd: 90000,
      momentumScore: 19,
      worstDrawdownPct: -12,
      priceChange5mPct: 4,
      priceChange1hPct: 18
    })).toBe('MEDIUM_WATCH_PRIORITY');
    expect(classifyWatchPriority({
      profile: 'UNKNOWN_PROFILE',
      liquidityUsd: 13000,
      volume1hUsd: 80000,
      momentumScore: 18,
      worstDrawdownPct: -8,
      priceChange5mPct: 3,
      priceChange1hPct: 12
    })).toBe('MEDIUM_WATCH_PRIORITY');
  });

  it('classifier assigns LOW_WATCH_PRIORITY for noise/weak setup and AVOID_WATCH_PRIORITY for dump or severe drawdown', () => {
    expect(classifyWatchPriority({
      profile: 'NOISE_PROFILE',
      liquidityUsd: 7000,
      volume1hUsd: 30000,
      momentumScore: 8,
      worstDrawdownPct: -6,
      priceChange5mPct: 1,
      priceChange1hPct: 3
    })).toBe('LOW_WATCH_PRIORITY');
    expect(classifyWatchPriority({
      profile: 'DUMP_PROFILE',
      liquidityUsd: 15000,
      volume1hUsd: 120000,
      momentumScore: 10,
      worstDrawdownPct: -40,
      priceChange5mPct: -30,
      priceChange1hPct: -55
    })).toBe('AVOID_WATCH_PRIORITY');
  });

  it('classifier assigns RUNNER_PROFILE for high momentum/high volume/high liquidity', () => {
    expect(classifyWatchRunnerProfile({
      momentumScore: 20,
      safetyScore: 15,
      volume1hUsd: 150000,
      liquidityUsd: 15000,
      priceChange5mPct: 10,
      priceChange1hPct: 20,
      holderConcentration: 'SAFE',
      priceUsd: 1
    })).toBe('RUNNER_PROFILE');
  });

  it('classifier assigns DUMP_PROFILE for sharp negative action or risky low-safety high-volume setup', () => {
    expect(classifyWatchRunnerProfile({
      momentumScore: 8,
      safetyScore: 12,
      volume1hUsd: 120000,
      liquidityUsd: 15000,
      priceChange5mPct: -30,
      priceChange1hPct: -10,
      holderConcentration: 'SAFE',
      priceUsd: 1
    })).toBe('DUMP_PROFILE');
    expect(classifyWatchRunnerProfile({
      momentumScore: 8,
      safetyScore: 5,
      volume1hUsd: 120000,
      liquidityUsd: 15000,
      priceChange5mPct: 0,
      priceChange1hPct: 0,
      holderConcentration: 'RISKY',
      priceUsd: 1
    })).toBe('DUMP_PROFILE');
  });

  it('classifier assigns NOISE_PROFILE for low liquidity/low volume/missing data and fallback UNKNOWN_PROFILE otherwise', () => {
    expect(classifyWatchRunnerProfile({
      momentumScore: 12,
      safetyScore: 12,
      volume1hUsd: 40000,
      liquidityUsd: 9000,
      priceChange5mPct: 0,
      priceChange1hPct: 0,
      holderConcentration: 'SAFE',
      priceUsd: 1
    })).toBe('NOISE_PROFILE');
    expect(classifyWatchRunnerProfile({
      momentumScore: 12,
      safetyScore: 12,
      volume1hUsd: 80000,
      liquidityUsd: 10000,
      priceChange5mPct: 0,
      priceChange1hPct: 0,
      holderConcentration: 'SAFE',
      priceUsd: 1
    })).toBe('UNKNOWN_PROFILE');
  });

  it('+30% post-discovery gain with low movedBeforeDiscoveryPct => EARLY_RUNNER', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      id: 1,
      tokenId: 1,
      createdAt: new Date().toISOString(),
      status: 'WATCH_ONLY' as const,
      reason: 'interesting enough to track, unsafe to trade',
      entryPriceUsd: 1,
      latestPriceUsd: 1.3,
      bestPriceUsd: 1.3,
      worstPriceUsd: 1,
      bestGainPct: 35,
      worstDrawdownPct: -5,
      liquidityUsd: 12000,
      volume5mUsd: 7000,
      volume1hUsd: 25000,
      rawJson: JSON.stringify({})
    };
    const snapshot = makeLiveCandidate({ movedBeforeDiscoveryPct: 50 });
    expect(classifyWatchOnlyCandidate(candidate, snapshot, config).signalClass).toBe('EARLY_RUNNER');
  });

  it('+30% post-discovery gain with high movedBeforeDiscoveryPct => LATE_RUNNER', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', MAX_CHASE_PCT: '150' });
    cleanup.push(dir);
    const candidate = {
      id: 1,
      tokenId: 1,
      createdAt: new Date().toISOString(),
      status: 'WATCH_ONLY' as const,
      reason: 'interesting enough to track, unsafe to trade',
      entryPriceUsd: 1,
      latestPriceUsd: 1.3,
      bestPriceUsd: 1.3,
      worstPriceUsd: 1,
      bestGainPct: 35,
      worstDrawdownPct: -5,
      liquidityUsd: 12000,
      volume5mUsd: 7000,
      volume1hUsd: 25000,
      rawJson: JSON.stringify({})
    };
    const snapshot = makeLiveCandidate({ movedBeforeDiscoveryPct: 200 });
    expect(classifyWatchOnlyCandidate(candidate, snapshot, config).signalClass).toBe('LATE_RUNNER');
  });

  it('stop-loss drawdown => INSTANT_DUMP', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      id: 1,
      tokenId: 1,
      createdAt: new Date().toISOString(),
      status: 'WATCH_ONLY' as const,
      reason: 'interesting enough to track, unsafe to trade',
      entryPriceUsd: 1,
      latestPriceUsd: 0.6,
      bestPriceUsd: 1,
      worstPriceUsd: 0.6,
      bestGainPct: 5,
      worstDrawdownPct: -40,
      liquidityUsd: 12000,
      volume5mUsd: 7000,
      volume1hUsd: 25000,
      rawJson: JSON.stringify({})
    };
    expect(classifyWatchOnlyCandidate(candidate, makeLiveCandidate(), config).signalClass).toBe('INSTANT_DUMP');
  });

  it('low liquidity / explicit no-sell / unsafe authority => TOO_DANGEROUS', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const baseCandidate = {
      id: 1,
      tokenId: 1,
      createdAt: new Date().toISOString(),
      status: 'WATCH_ONLY' as const,
      reason: 'interesting enough to track, unsafe to trade',
      entryPriceUsd: 1,
      latestPriceUsd: 1,
      bestPriceUsd: 1,
      worstPriceUsd: 1,
      bestGainPct: 0,
      worstDrawdownPct: 0,
      liquidityUsd: 4000,
      volume5mUsd: 7000,
      volume1hUsd: 25000,
      rawJson: JSON.stringify({})
    };
    expect(classifyWatchOnlyCandidate(baseCandidate, makeLiveCandidate(), config).signalClass).toBe('TOO_DANGEROUS');
    expect(classifyWatchOnlyCandidate({ ...baseCandidate, liquidityUsd: 12000 }, makeLiveCandidate({ sellQuoteAvailable: 'NO' }), config).signalClass).toBe('TOO_DANGEROUS');
    expect(classifyWatchOnlyCandidate({ ...baseCandidate, liquidityUsd: 12000 }, makeLiveCandidate({ mintAuthority: 'UNSAFE' }), config).signalClass).toBe('TOO_DANGEROUS');
  });

  it('flat candidate => DEAD_NOISE', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      id: 1,
      tokenId: 1,
      createdAt: new Date().toISOString(),
      status: 'WATCH_ONLY' as const,
      reason: 'interesting enough to track, unsafe to trade',
      entryPriceUsd: 1,
      latestPriceUsd: 1.01,
      bestPriceUsd: 1.02,
      worstPriceUsd: 0.99,
      bestGainPct: 2,
      worstDrawdownPct: -1,
      liquidityUsd: 12000,
      volume5mUsd: 7000,
      volume1hUsd: 25000,
      rawJson: JSON.stringify({})
    };
    expect(classifyWatchOnlyCandidate(candidate, makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }), config).signalClass).toBe('DEAD_NOISE');
  });

  it('watch-analysis never opens paper positions and never calls real execution', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.35, 12000, 7000, 25000, { snapshot: makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }) });
    await runWatchAnalysis(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('watch-report includes signal class summary, profile counts, and priority counts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ movedBeforeDiscoveryPct: 20, liquidityUsd: 15000, volume1hUsd: 150000 }));
    db.saveScore({ tokenId, scoredAt: new Date().toISOString(), momentumScore: 25, safetyScore: 20, socialScore: 10, totalScore: 55, verdict: 'WATCH', reasons: [], redFlags: [], autopilotBlocked: true, autopilotBlockers: [] });
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.35, 15000, 7000, 150000, { snapshot: makeLiveCandidate({ movedBeforeDiscoveryPct: 20, liquidityUsd: 15000, volume1hUsd: 150000 }) });
    await runWatchAnalysis(db, config);
    const report = buildWatchOnlyReport(db, config) as any;
    expect(report).toHaveProperty('watchOnlySignalClassCounts');
    expect(report).toHaveProperty('watchRunnerProfileCounts');
    expect(report).toHaveProperty('watchRunnerProfileSummary');
    expect(report).toHaveProperty('watchPriorityCounts');
    expect(report).toHaveProperty('watchPrioritySummary');
    expect(report).toHaveProperty('analysisSummaryLine', 'Watch-only analysis is research only.');
    db.close();
  });

  it('watch-autopsy renders runner and dump sections, aggregate comparison, red flag comparisons, profile counts, and safety footer', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);

    const runnerTokenId = db.upsertToken(makeLiveCandidate({ mint: 'RunnerMint111', symbol: 'RUN', movedBeforeDiscoveryPct: 20, sellQuoteAvailable: 'YES', holderConcentration: 'SAFE', mintAuthority: 'SAFE', freezeAuthority: 'SAFE', liquidityUsd: 15000, volume1hUsd: 150000, priceChange1hPct: 20 }));
    db.saveScore({ tokenId: runnerTokenId, scoredAt: new Date().toISOString(), momentumScore: 30, safetyScore: 25, socialScore: 10, totalScore: 65, verdict: 'WATCH', reasons: ['runner signal'], redFlags: ['creator status unknown'], autopilotBlocked: true, autopilotBlockers: [] });
    db.upsertWatchOnlyCandidate(runnerTokenId, 'WATCH_ONLY', 'runner', 1, 1.8, 15000, 9000, 150000, { snapshot: makeLiveCandidate({ mint: 'RunnerMint111', symbol: 'RUN', movedBeforeDiscoveryPct: 20, sellQuoteAvailable: 'YES', holderConcentration: 'SAFE', mintAuthority: 'SAFE', freezeAuthority: 'SAFE', liquidityUsd: 15000, volume1hUsd: 150000, priceChange1hPct: 20 }) });
    db.sqlite.prepare(`UPDATE watch_only_candidates
      SET latest_price_usd = ?, best_price_usd = ?, worst_price_usd = ?, best_gain_pct = ?, worst_drawdown_pct = ?, liquidity_usd = ?, volume_5m_usd = ?, volume_1h_usd = ?
      WHERE token_id = ?`).run(1.8, 1.8, 0.95, 80, -5, 15000, 9000, 150000, runnerTokenId);

    const dumpTokenId = db.upsertToken(makeLiveCandidate({ mint: 'DumpMint111', symbol: 'DMP', movedBeforeDiscoveryPct: 10, sellQuoteAvailable: 'UNKNOWN', holderConcentration: 'RISKY', mintAuthority: 'SAFE', freezeAuthority: 'SAFE', liquidityUsd: 9000, volume1hUsd: 120000, priceChange5mPct: -30 }));
    db.saveScore({ tokenId: dumpTokenId, scoredAt: new Date().toISOString(), momentumScore: 12, safetyScore: 8, socialScore: 5, totalScore: 31, verdict: 'AVOID', reasons: ['dump signal'], redFlags: ['sell quote unknown', 'holder concentration risky'], autopilotBlocked: true, autopilotBlockers: [] });
    db.upsertWatchOnlyCandidate(dumpTokenId, 'WATCH_ONLY', 'dump', 1, 0.7, 9000, 4000, 120000, { snapshot: makeLiveCandidate({ mint: 'DumpMint111', symbol: 'DMP', movedBeforeDiscoveryPct: 10, sellQuoteAvailable: 'UNKNOWN', holderConcentration: 'RISKY', mintAuthority: 'SAFE', freezeAuthority: 'SAFE', liquidityUsd: 9000, volume1hUsd: 120000, priceChange5mPct: -30 }) });
    db.sqlite.prepare(`UPDATE watch_only_candidates
      SET latest_price_usd = ?, best_price_usd = ?, worst_price_usd = ?, best_gain_pct = ?, worst_drawdown_pct = ?, liquidity_usd = ?, volume_5m_usd = ?, volume_1h_usd = ?
      WHERE token_id = ?`).run(0.7, 1.05, 0.3, 5, -70, 9000, 4000, 120000, dumpTokenId);

    await runWatchAnalysis(db, config);
    const autopsy = renderWatchAutopsy(db, config);
    expect(autopsy).toContain('Watch-Only Winner Autopsy');
    expect(autopsy).toContain('Top Runners');
    expect(autopsy).toContain('Top Dumps');
    expect(autopsy).toContain('Runner vs Dump Comparison');
    expect(autopsy).toContain('RUNNER_PROFILE');
    expect(autopsy).toContain('DUMP_PROFILE');
    expect(autopsy).toContain('HIGH_WATCH_PRIORITY');
    expect(autopsy).toContain('AVOID_WATCH_PRIORITY');
    expect(autopsy).toContain('common red flags among runners');
    expect(autopsy).toContain('common red flags among dumps');
    expect(autopsy).toContain('Watch-only analysis is research only.');
    expect(autopsy).toContain('Real trading remains locked.');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('daily-report includes watch-only analysis summary', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.35, 12000, 7000, 25000, { snapshot: makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }) });
    await runWatchAnalysis(db, config);
    const report = buildDailyReport(db, config);
    expect(report).toHaveProperty('watchOnlySignalClassCounts');
    expect(report).toHaveProperty('analysisSummaryLine', 'Watch-only analysis is research only.');
    db.close();
  });

  it('real trading remains locked', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.35, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    await runWatchAnalysis(db, config);
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
    db.close();
  });

  it('signal analysis summary helper returns class counts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }));
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.35, 12000, 7000, 25000, { snapshot: makeLiveCandidate({ movedBeforeDiscoveryPct: 20 }) });
    await runWatchAnalysis(db, config);
    const summary = summarizeWatchOnlySignalAnalysis(db);
    expect(summary).toHaveProperty('watchOnlySignalClassCounts');
    db.close();
  });
});
