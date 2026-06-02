import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { buildSignalAuditReport, formatSignalAuditTable, renderSignalAudit } from '../src/signalAudit';

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
      tokenAddress: 'AuditMint11111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/audit',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/audit',
        pairAddress: 'AuditPair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }], socials: [{ url: 'https://x.com/example', type: 'twitter' }] },
        baseToken: { address: 'AuditMint11111111111111111111111111111111111', name: 'Audit Token', symbol: 'AUD' },
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
  signalClass: 'EARLY_RUNNER' | 'LATE_RUNNER' | 'INSTANT_DUMP' | 'DEAD_NOISE' | 'TOO_DANGEROUS';
  bestGainPct: number;
  worstDrawdownPct: number;
  movedBeforeDiscoveryPct: number;
  mintAuthority?: 'SAFE' | 'UNSAFE' | 'UNKNOWN';
  freezeAuthority?: 'SAFE' | 'UNSAFE' | 'UNKNOWN';
  holderConcentrationStatus?: 'SAFE' | 'RISKY' | 'UNKNOWN';
  topHolderPct?: number;
  top10HolderPct?: number;
  safetyStatus?: string;
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
  db.createWatchOnlyOutcome(watchId, tokenId, '15m', 15, new Date().toISOString(), 1, 1.1, 10, options.bestGainPct, options.worstDrawdownPct, false, false, 12000, 7000, 25000, 'seed', { seeded: true });
  db.createSolanaSafetyEnrichment(
    tokenId,
    options.mint,
    new Date().toISOString(),
    options.freezeAuthority ?? 'SAFE',
    options.mintAuthority ?? 'SAFE',
    options.mintAuthority !== 'UNSAFE',
    options.freezeAuthority !== 'UNSAFE',
    'Tokenkeg',
    '1000000',
    6,
    20,
    options.topHolderPct ?? 8,
    options.top10HolderPct ?? 32,
    (options.holderConcentrationStatus ?? 'SAFE') === 'RISKY' ? 'HIGH' : 'LOW',
    options.holderConcentrationStatus ?? 'SAFE',
    null,
    'UNKNOWN',
    'Pool111',
    10,
    options.safetyStatus ?? 'ok',
    [],
    'seeded enrichment',
    { seeded: true }
  );
  return { tokenId, watchId };
}

describe('signal audit', () => {
  it('signal audit returns candidate rows', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    const report = buildSignalAuditReport(db, config);
    expect(report.candidateRows.length).toBeGreaterThan(0);
    expect(report.candidateRows[0]).toHaveProperty('watchCandidateId');
    expect(report.candidateRows[0]).toHaveProperty('symbol');
    db.close();
  });

  it('signal audit includes class counts', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Audit222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalAuditReport(db, config);
    expect(report.summary).toHaveProperty('signalClassCounts');
    expect((report.summary.signalClassCounts as Record<string, number>).EARLY_RUNNER).toBe(1);
    expect((report.summary.signalClassCounts as Record<string, number>).INSTANT_DUMP).toBe(1);
    db.close();
  });

  it('signal audit includes safetyByClass', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, {
      mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50,
      mintAuthority: 'SAFE', freezeAuthority: 'UNSAFE', holderConcentrationStatus: 'RISKY', topHolderPct: 22, top10HolderPct: 68, safetyStatus: 'risky'
    });
    const report = buildSignalAuditReport(db, config);
    expect(report.summary).toHaveProperty('safetyByClass');
    expect((report.summary as any).safetyByClass.EARLY_RUNNER.mintAuthoritySafeCount).toBe(1);
    expect((report.summary as any).safetyByClass.EARLY_RUNNER.freezeAuthorityUnsafeCount).toBe(1);
    expect((report.summary as any).safetyByClass.EARLY_RUNNER.holderRiskyCount).toBe(1);
    db.close();
  });

  it('signal audit includes early-runner vs instant-dump comparison', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Audit222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalAuditReport(db, config);
    expect(report.comparison).toHaveProperty('earlyRunnerVsInstantDump');
    db.close();
  });

  it('signal audit includes final safety line', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = buildSignalAuditReport(db, config);
    expect(report.finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('signal audit works with empty DB', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = buildSignalAuditReport(db, config);
    expect(report.candidateRows).toEqual([]);
    expect(report.finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('signal audit never opens paper positions', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    buildSignalAuditReport(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    db.close();
  });

  it('signal audit never records real trade attempts', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    buildSignalAuditReport(db, config);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('class filter works', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Audit222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalAuditReport(db, config, { ...process.env, SIGNAL_AUDIT_CLASS: 'EARLY_RUNNER' });
    expect(report.candidateRows.length).toBe(1);
    expect(report.candidateRows[0].signalClass).toBe('EARLY_RUNNER');
    db.close();
  });

  it('limit works', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    seedCandidate(db, { mint: 'Audit222', symbol: 'DUMP', signalClass: 'INSTANT_DUMP', bestGainPct: 5, worstDrawdownPct: -40, movedBeforeDiscoveryPct: 20 });
    const report = buildSignalAuditReport(db, config, { ...process.env, SIGNAL_AUDIT_LIMIT: '1' });
    expect(report.candidateRows.length).toBe(1);
    db.close();
  });

  it('signal-audit table includes mintAuth/freezeAuth/holder/top10Pct/safetyStatus columns', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, {
      mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50,
      mintAuthority: 'SAFE', freezeAuthority: 'SAFE', holderConcentrationStatus: 'SAFE', topHolderPct: 8, top10HolderPct: 32, safetyStatus: 'ok'
    });
    const report = buildSignalAuditReport(db, config);
    const table = formatSignalAuditTable(report);
    expect(table).toContain('mintAuth');
    expect(table).toContain('freezeAuth');
    expect(table).toContain('holder');
    expect(table).toContain('top10Pct');
    expect(table).toContain('safetyStatus');
    db.close();
  });

  it('table format renders readable candidate rows', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    const report = buildSignalAuditReport(db, config);
    const table = formatSignalAuditTable(report);
    expect(table).toContain('Signal Audit Report');
    expect(table).toContain('EARLY');
    db.close();
  });

  it('renderSignalAudit defaults to json and supports table', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    seedCandidate(db, { mint: 'Audit111', symbol: 'EARLY', signalClass: 'EARLY_RUNNER', bestGainPct: 40, worstDrawdownPct: -10, movedBeforeDiscoveryPct: 50 });
    const report = buildSignalAuditReport(db, config);
    expect(renderSignalAudit(report, {} as NodeJS.ProcessEnv)).toContain('"summary"');
    expect(renderSignalAudit(report, { SIGNAL_AUDIT_FORMAT: 'table' } as NodeJS.ProcessEnv)).toContain('Signal Audit Report');
    db.close();
  });
});
