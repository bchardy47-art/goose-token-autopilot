import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDexLegitimacyReport,
  scoreEntry,
  scoreBlockedMover,
  determineFinalRecommendation,
  writeDexLegitimacyReport,
  renderDexLegitimacyReport,
  renderDexLegitimacyReportUsage,
  ALWAYS_MISSING_SIGNALS,
  type DexLegitimacyReport,
  type LegitimacyItem,
} from '../src/token-grab/dexLegitimacyReport';
import type { DayWatchCycleEntry } from '../src/token-grab/dexDayWatch';
import type { TopEntry, TopBlockedMover } from '../src/token-grab/dexValidationLoop';
import type { DexPaperPositionReport, TrackedPosition } from '../src/token-grab/dexPaperPositionTracker';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_A = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump';
const CONTRACT_B = 'ELON2222222222222222222222222222222222222222222';
const CONTRACT_C = 'JUNK3333333333333333333333333333333333333333333';

function makeTopEntry(overrides?: Partial<TopEntry>): TopEntry {
  return {
    symbol: 'GOOD',
    contract: CONTRACT_A,
    priceChangePct: 25,
    liquidityChangePct: 10,
    volumeLiquidityRatio: 0.5,
    ...overrides,
  };
}

function makeBlockedMover(overrides?: Partial<TopBlockedMover>): TopBlockedMover {
  return {
    symbol: 'JUNK',
    contract: CONTRACT_C,
    priceChangePct: 30,
    liquidityChangePct: -5,
    volumeLiquidityRatio: 2.5,
    blockReasons: ['loseCount 4/5'],
    ...overrides,
  };
}

function makeCycleEntry(overrides?: Partial<DayWatchCycleEntry>): DayWatchCycleEntry {
  return {
    generatedAt: '2026-06-09T10:00:00.000Z',
    cycleNumber: 1,
    newestRunFile: 'run-20260609-100000.json',
    contractsWatched: 5,
    winners: 2,
    losers: 1,
    flat: 1,
    missing: 1,
    runnerCandidateTrades: 1,
    runnerFakePnl: 0.5,
    journalTotalSimulated: 1,
    journalFakePnl: 0.5,
    plannerLatestRealRun: 'run-20260609-100000.json',
    currentCyclePaperEntry: 1,
    historicalJournalWinners: 0,
    blockedHistoryRisk: 1,
    watchOnly: 0,
    noEntry: 0,
    finalRecommendation: 'MANUAL_REVIEW_NEEDED',
    topCurrentCycleEntries: [makeTopEntry()],
    topBlockedMovers: [makeBlockedMover()],
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
    ...overrides,
  };
}

function makeTrackedPosition(overrides?: Partial<TrackedPosition>): TrackedPosition {
  return {
    symbol: 'GOOD',
    contract: CONTRACT_A,
    sourceRunFile: 'run-20260609-100000.json',
    entryObservedAt: '2026-06-09T10:00:00.000Z',
    exitObservedAt: '2026-06-09T10:15:00.000Z',
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.00125,
    maxRunupPct: 25,
    maxDrawdownPct: -2,
    holdMinutes: 15,
    exitReason: 'TAKE_PROFIT',
    fakePnlDollars: 0.25,
    status: 'CLOSED',
    ...overrides,
  };
}

function makePositionReport(positions: TrackedPosition[] = []): DexPaperPositionReport {
  return {
    generatedAt: '2026-06-09T10:20:00.000Z',
    sourcePlanner: 'data/token-grab/paper-plans/dex-paper-entry-plan.json',
    sourceMode: 'day-log',
    runsDir: 'data/token-grab/dex-watch-runs',
    totalPositions: positions.length,
    openPositions: positions.filter(p => p.status === 'OPEN').length,
    closedPositions: positions.filter(p => p.status === 'CLOSED').length,
    totalFakePnlDollars: positions.reduce((s, p) => s + p.fakePnlDollars, 0),
    winRatePct: 100,
    positions,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

const BASE_OPTS = {
  dayLogPath: 'data/token-grab/day-watch/dex-day-watch-today.jsonl',
  runsDir: 'data/token-grab/dex-watch-runs',
};

// ── scoreEntry ────────────────────────────────────────────────────────────────────────────

describe('scoreEntry', () => {
  it('returns PASS_TO_HUMAN HIGH when all thresholds met and paper has profitable exit', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 8, volumeLiquidityRatio: 0.4 });
    const position = makeTrackedPosition({ exitReason: 'TAKE_PROFIT' });
    const { verdict, confidence } = scoreEntry(entry, position);
    expect(verdict).toBe('PASS_TO_HUMAN');
    expect(confidence).toBe('HIGH');
  });

  it('returns PASS_TO_HUMAN MEDIUM when thresholds met but no paper position', () => {
    const entry = makeTopEntry({ priceChangePct: 15, liquidityChangePct: 5, volumeLiquidityRatio: 1.0 });
    const { verdict, confidence } = scoreEntry(entry);
    expect(verdict).toBe('PASS_TO_HUMAN');
    expect(confidence).toBe('MEDIUM');
  });

  it('returns PASS_TO_HUMAN when VLR is exactly 1', () => {
    const entry = makeTopEntry({ priceChangePct: 15, liquidityChangePct: 5, volumeLiquidityRatio: 1.0 });
    const { verdict } = scoreEntry(entry);
    expect(verdict).toBe('PASS_TO_HUMAN');
  });

  it('returns WATCH MEDIUM when thresholds met but paper result is MAX_HOLD_TIMEOUT', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 8, volumeLiquidityRatio: 0.4 });
    const position = makeTrackedPosition({ exitReason: 'MAX_HOLD_TIMEOUT' });
    const { verdict, confidence, reasons } = scoreEntry(entry, position);
    expect(verdict).toBe('WATCH');
    expect(confidence).toBe('MEDIUM');
    expect(reasons.some(r => r.includes('MAX_HOLD_TIMEOUT'))).toBe(true);
  });

  it('returns WATCH MEDIUM when paper result is STILL_OPEN', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 8, volumeLiquidityRatio: 0.4 });
    const position = makeTrackedPosition({ exitReason: 'STILL_OPEN', status: 'OPEN' });
    const { verdict, confidence } = scoreEntry(entry, position);
    expect(verdict).toBe('WATCH');
    expect(confidence).toBe('MEDIUM');
  });

  it('returns WATCH LOW when price ok but liquidity missing or weak', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 2, volumeLiquidityRatio: undefined });
    const { verdict, confidence } = scoreEntry(entry);
    expect(verdict).toBe('WATCH');
    expect(confidence).toBe('LOW');
  });

  it('returns DANGER HIGH when paper position triggered STOP_LOSS', () => {
    const entry = makeTopEntry({ priceChangePct: 30, liquidityChangePct: 10, volumeLiquidityRatio: 0.3 });
    const position = makeTrackedPosition({ exitReason: 'STOP_LOSS' });
    const { verdict, confidence, reasons } = scoreEntry(entry, position);
    expect(verdict).toBe('DANGER');
    expect(confidence).toBe('HIGH');
    expect(reasons.some(r => r.includes('STOP_LOSS'))).toBe(true);
  });

  it('returns DANGER HIGH when paper position triggered LIQUIDITY_DUMP', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const position = makeTrackedPosition({ exitReason: 'LIQUIDITY_DUMP' });
    const { verdict, confidence } = scoreEntry(entry, position);
    expect(verdict).toBe('DANGER');
    expect(confidence).toBe('HIGH');
  });

  it('returns DANGER HIGH when paper position triggered VLR_SPIKE', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const position = makeTrackedPosition({ exitReason: 'VLR_SPIKE' });
    const { verdict, confidence } = scoreEntry(entry, position);
    expect(verdict).toBe('DANGER');
    expect(confidence).toBe('HIGH');
  });

  it('returns DANGER MEDIUM when VLR is too high (> 1)', () => {
    const entry = makeTopEntry({ priceChangePct: 30, liquidityChangePct: 10, volumeLiquidityRatio: 1.5 });
    const { verdict, confidence, reasons } = scoreEntry(entry);
    expect(verdict).toBe('DANGER');
    expect(confidence).toBe('MEDIUM');
    expect(reasons.some(r => r.includes('VLR too high'))).toBe(true);
  });

  it('returns IGNORE LOW when no market data at all', () => {
    const entry = makeTopEntry({
      priceChangePct: undefined,
      liquidityChangePct: undefined,
      volumeLiquidityRatio: undefined,
    });
    const { verdict, confidence, reasons } = scoreEntry(entry);
    expect(verdict).toBe('IGNORE');
    expect(confidence).toBe('LOW');
    expect(reasons).toContain('INSUFFICIENT_MARKET_DATA');
  });

  it('returns IGNORE when price is below threshold', () => {
    const entry = makeTopEntry({ priceChangePct: 5, liquidityChangePct: 2, volumeLiquidityRatio: 0.3 });
    const { verdict } = scoreEntry(entry);
    expect(verdict).toBe('IGNORE');
  });

  it('DANGER from bad paper exit takes precedence over VLR check', () => {
    const entry = makeTopEntry({ priceChangePct: 30, liquidityChangePct: 10, volumeLiquidityRatio: 2.0 });
    const position = makeTrackedPosition({ exitReason: 'STOP_LOSS' });
    const { verdict, confidence } = scoreEntry(entry, position);
    expect(verdict).toBe('DANGER');
    expect(confidence).toBe('HIGH');
  });
});

// ── scoreBlockedMover ─────────────────────────────────────────────────────────────────────

describe('scoreBlockedMover', () => {
  it('returns DANGER when blockReasons contains drain keyword', () => {
    const b = makeBlockedMover({ blockReasons: ['drainCount 3/5'] });
    expect(scoreBlockedMover(b)).toBe('DANGER');
  });

  it('returns DANGER when blockReasons contains lose keyword', () => {
    const b = makeBlockedMover({ blockReasons: ['loseCount 4/5'] });
    expect(scoreBlockedMover(b)).toBe('DANGER');
  });

  it('returns DANGER when blockReasons contains VLR keyword', () => {
    const b = makeBlockedMover({ blockReasons: ['VLR spike detected'] });
    expect(scoreBlockedMover(b)).toBe('DANGER');
  });

  it('returns DANGER when VLR is too high regardless of reasons', () => {
    const b = makeBlockedMover({ blockReasons: [], volumeLiquidityRatio: 2.0 });
    expect(scoreBlockedMover(b)).toBe('DANGER');
  });

  it('returns IGNORE when blockReasons has no danger keywords and VLR is safe', () => {
    const b = makeBlockedMover({ blockReasons: ['BLOCKED_HISTORY_RISK'], volumeLiquidityRatio: 0.8 });
    expect(scoreBlockedMover(b)).toBe('IGNORE');
  });

  it('returns IGNORE when blockReasons is empty and no VLR', () => {
    const b = makeBlockedMover({ blockReasons: [], volumeLiquidityRatio: undefined });
    expect(scoreBlockedMover(b)).toBe('IGNORE');
  });
});

// ── determineFinalRecommendation ──────────────────────────────────────────────────────────

describe('determineFinalRecommendation', () => {
  it('returns MANUAL_REVIEW_READY when passToHumanCount > 0', () => {
    expect(determineFinalRecommendation(1, 0, 0, 0)).toBe('MANUAL_REVIEW_READY');
  });

  it('returns MANUAL_REVIEW_READY even when dangerCount dominates', () => {
    expect(determineFinalRecommendation(1, 0, 0, 5)).toBe('MANUAL_REVIEW_READY');
  });

  it('returns TOO_MUCH_JUNK when danger dominates with no passing tokens', () => {
    expect(determineFinalRecommendation(0, 1, 0, 5)).toBe('TOO_MUCH_JUNK');
  });

  it('returns TOO_MUCH_JUNK when danger > pass + watch', () => {
    expect(determineFinalRecommendation(0, 2, 0, 3)).toBe('TOO_MUCH_JUNK');
  });

  it('returns COLLECT_MORE_DATA when watchCount > 0 and no pass or dominant danger', () => {
    expect(determineFinalRecommendation(0, 2, 1, 1)).toBe('COLLECT_MORE_DATA');
  });

  it('returns NO_CLEAN_SIGNAL when nothing found', () => {
    expect(determineFinalRecommendation(0, 0, 3, 0)).toBe('NO_CLEAN_SIGNAL');
  });

  it('returns NO_CLEAN_SIGNAL when all are IGNORE', () => {
    expect(determineFinalRecommendation(0, 0, 5, 0)).toBe('NO_CLEAN_SIGNAL');
  });
});

// ── buildDexLegitimacyReport ──────────────────────────────────────────────────────────────

describe('buildDexLegitimacyReport', () => {
  it('builds from day-log current-cycle entries', () => {
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [makeTopEntry()] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.totalCurrentCycleEntriesReviewed).toBe(1);
    expect(report.items).toHaveLength(1);
    expect(report.items[0].contract).toBe(CONTRACT_A);
    expect(report.items[0].symbol).toBe('GOOD');
  });

  it('deduplicates contracts across cycles (first occurrence wins)', () => {
    const entry1 = makeTopEntry({ priceChangePct: 20 });
    const entry2 = makeTopEntry({ priceChangePct: 50 });
    const cycle1 = makeCycleEntry({ cycleNumber: 1, topCurrentCycleEntries: [entry1] });
    const cycle2 = makeCycleEntry({ cycleNumber: 2, topCurrentCycleEntries: [entry2] });
    const report = buildDexLegitimacyReport([cycle1, cycle2], null, BASE_OPTS);
    expect(report.items).toHaveLength(1);
    expect(report.items[0].priceChangePct).toBe(20);
  });

  it('returns PASS_TO_HUMAN when VLR/price/liquidity are good and no bad paper exit', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const position = makeTrackedPosition({ exitReason: 'TAKE_PROFIT' });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const posReport = makePositionReport([position]);
    const report = buildDexLegitimacyReport([cycle], posReport, BASE_OPTS);
    expect(report.passToHumanCount).toBe(1);
    expect(report.items[0].legitimacyVerdict).toBe('PASS_TO_HUMAN');
    expect(report.items[0].confidence).toBe('HIGH');
  });

  it('returns WATCH when paper position is MAX_HOLD_TIMEOUT', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 8, volumeLiquidityRatio: 0.4 });
    const position = makeTrackedPosition({ exitReason: 'MAX_HOLD_TIMEOUT' });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const posReport = makePositionReport([position]);
    const report = buildDexLegitimacyReport([cycle], posReport, BASE_OPTS);
    expect(report.watchCount).toBe(1);
    expect(report.items[0].legitimacyVerdict).toBe('WATCH');
  });

  it('returns WATCH when there is no paper position but data is incomplete', () => {
    const entry = makeTopEntry({ priceChangePct: 20, liquidityChangePct: 2, volumeLiquidityRatio: undefined });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.watchCount).toBe(1);
  });

  it('returns DANGER when paper position had STOP_LOSS', () => {
    const entry = makeTopEntry({ priceChangePct: 30, liquidityChangePct: 10, volumeLiquidityRatio: 0.3 });
    const position = makeTrackedPosition({ exitReason: 'STOP_LOSS' });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const posReport = makePositionReport([position]);
    const report = buildDexLegitimacyReport([cycle], posReport, BASE_OPTS);
    expect(report.dangerCount).toBe(1);
    expect(report.items[0].legitimacyVerdict).toBe('DANGER');
  });

  it('attaches paper position data to matched items', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const position = makeTrackedPosition({ exitReason: 'TAKE_PROFIT', fakePnlDollars: 0.25 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const posReport = makePositionReport([position]);
    const report = buildDexLegitimacyReport([cycle], posReport, BASE_OPTS);
    const item = report.items[0];
    expect(item.paperExitReason).toBe('TAKE_PROFIT');
    expect(item.paperFakePnlDollars).toBe(0.25);
    expect(item.paperPositionStatus).toBe('CLOSED');
    expect(item.maxRunupPct).toBeDefined();
    expect(item.maxDrawdownPct).toBeDefined();
  });

  it('sets observedAt from cycleEntry generatedAt and sourceRunFile from newestRunFile', () => {
    const entry = makeTopEntry();
    const cycle = makeCycleEntry({
      generatedAt: '2026-06-09T10:00:00.000Z',
      newestRunFile: 'run-test-123.json',
      topCurrentCycleEntries: [entry],
    });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.items[0].observedAt).toBe('2026-06-09T10:00:00.000Z');
    expect(report.items[0].sourceRunFile).toBe('run-test-123.json');
  });

  it('collects blocked movers from all cycles and deduplicates by contract', () => {
    const b1 = makeBlockedMover({ priceChangePct: 20 });
    const b2 = makeBlockedMover({ priceChangePct: 50 }); // same contract, higher price
    const cycle1 = makeCycleEntry({ cycleNumber: 1, topCurrentCycleEntries: [], topBlockedMovers: [b1] });
    const cycle2 = makeCycleEntry({ cycleNumber: 2, topCurrentCycleEntries: [], topBlockedMovers: [b2] });
    const report = buildDexLegitimacyReport([cycle1, cycle2], null, BASE_OPTS);
    expect(report.blockedMovers).toHaveLength(1);
    expect(report.blockedMovers[0].priceChangePct).toBe(50); // highest kept
  });

  it('scores blocked movers with DANGER for drain/lose reasons', () => {
    const b = makeBlockedMover({ blockReasons: ['loseCount 4/5', 'drainCount 3/5'] });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [], topBlockedMovers: [b] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.blockedMovers[0].verdict).toBe('DANGER');
  });

  it('sets MANUAL_REVIEW_READY when passToHumanCount > 0', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.finalRecommendation).toBe('MANUAL_REVIEW_READY');
  });

  it('sets NO_CLEAN_SIGNAL when no entries and no blocked movers', () => {
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [], topBlockedMovers: [] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.finalRecommendation).toBe('NO_CLEAN_SIGNAL');
    expect(report.totalCurrentCycleEntriesReviewed).toBe(0);
  });

  it('sets COLLECT_MORE_DATA when only WATCH items present', () => {
    const entry = makeTopEntry({ priceChangePct: 5, liquidityChangePct: 8, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.finalRecommendation).toBe('COLLECT_MORE_DATA');
  });

  it('handles empty day-log gracefully', () => {
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(report.totalCurrentCycleEntriesReviewed).toBe(0);
    expect(report.items).toHaveLength(0);
    expect(report.blockedMovers).toHaveLength(0);
    expect(report.finalRecommendation).toBe('NO_CLEAN_SIGNAL');
  });

  it('handles missing positions file gracefully (null positions)', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    expect(report.items[0].paperExitReason).toBeUndefined();
    expect(report.items[0].paperFakePnlDollars).toBeUndefined();
  });
});

// ── UNKNOWN placeholders and missingSignals ───────────────────────────────────────────────

describe('UNKNOWN placeholder fields and missingSignals', () => {
  it('all placeholder statuses are UNKNOWN on every item', () => {
    const entry = makeTopEntry();
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const item = report.items[0];
    expect(item.holderConcentrationStatus).toBe('UNKNOWN');
    expect(item.creatorWalletStatus).toBe('UNKNOWN');
    expect(item.bubbleMapStatus).toBe('UNKNOWN');
    expect(item.socialChatterStatus).toBe('UNKNOWN');
    expect(item.mintAuthorityStatus).toBe('UNKNOWN');
    expect(item.freezeAuthorityStatus).toBe('UNKNOWN');
    expect(item.liquidityLockStatus).toBe('UNKNOWN');
  });

  it('missingSignals contains all expected signals on every item', () => {
    const entry = makeTopEntry();
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const sigs = report.items[0].missingSignals;
    expect(sigs).toContain('HOLDER_MAP_NOT_CONNECTED');
    expect(sigs).toContain('CREATOR_WALLET_NOT_CONNECTED');
    expect(sigs).toContain('BUBBLE_MAP_NOT_CONNECTED');
    expect(sigs).toContain('SOCIAL_CHATTER_NOT_CONNECTED');
    expect(sigs).toContain('MINT_FREEZE_NOT_CONNECTED');
    expect(sigs).toContain('LP_LOCK_NOT_CONNECTED');
    expect(sigs).toHaveLength(6);
  });

  it('missingSignalSummary on the report contains all signal names', () => {
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(report.missingSignalSummary).toEqual(expect.arrayContaining(ALWAYS_MISSING_SIGNALS));
    expect(report.missingSignalSummary).toHaveLength(6);
  });

  it('ALWAYS_MISSING_SIGNALS constant has all 6 entries', () => {
    expect(ALWAYS_MISSING_SIGNALS).toHaveLength(6);
    expect(ALWAYS_MISSING_SIGNALS).toContain('HOLDER_MAP_NOT_CONNECTED');
    expect(ALWAYS_MISSING_SIGNALS).toContain('LP_LOCK_NOT_CONNECTED');
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('report has tradingExecuted: 0', () => {
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(report.tradingExecuted).toBe(0);
  });

  it('report has noRealTradeSent: true', () => {
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(report.noRealTradeSent).toBe(true);
  });

  it('report has readOnly: true', () => {
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(report.readOnly).toBe(true);
  });

  it('report has paperOnly: true', () => {
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(report.paperOnly).toBe(true);
  });

  it('report JSON contains no auto-paper or live execution language', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const json = JSON.stringify(report);
    expect(json).not.toContain('autoPaper');
    expect(json).not.toContain('auto-paper');
    expect(json).not.toContain('liveHarness');
    expect(json).not.toContain('swapExecuted');
    expect(json).not.toContain('walletAddress');
    expect(json).not.toContain('privateKey');
  });
});

// ── I/O: writeDexLegitimacyReport ────────────────────────────────────────────────────────

describe('writeDexLegitimacyReport', () => {
  it('writes JSON to data/token-grab/legitimacy/ nested path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legitimacy-test-'));
    const outPath = path.join(tmpDir, 'token-grab', 'legitimacy', 'dex-legitimacy-report.json');
    const entry = makeTopEntry();
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, {
      ...BASE_OPTS,
      dayLogPath: 'data/token-grab/day-watch/dex-day-watch-today.jsonl',
    });
    writeDexLegitimacyReport(report, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.tradingExecuted).toBe(0);
    expect(parsed.noRealTradeSent).toBe(true);
    expect(parsed.readOnly).toBe(true);
    expect(parsed.paperOnly).toBe(true);
    expect(parsed.totalCurrentCycleEntriesReviewed).toBe(1);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates intermediate directories if they do not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legitimacy-mkdir-'));
    const outPath = path.join(tmpDir, 'deep', 'nested', 'dir', 'report.json');
    const report = buildDexLegitimacyReport([], null, BASE_OPTS);
    expect(() => writeDexLegitimacyReport(report, outPath)).not.toThrow();
    expect(fs.existsSync(outPath)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── renderDexLegitimacyReport ─────────────────────────────────────────────────────────────

describe('renderDexLegitimacyReport', () => {
  function makeReport(overrides?: Partial<DexLegitimacyReport>): DexLegitimacyReport {
    const base = buildDexLegitimacyReport([], null, BASE_OPTS);
    return { ...base, ...overrides };
  }

  it('includes safety banner', () => {
    const report = makeReport();
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('PAPER ONLY');
    expect(text).toContain('READ-ONLY');
    expect(text).toContain('NO REAL TRADE SENT');
    expect(text).toContain('tradingExecuted: 0');
  });

  it('includes safety footer', () => {
    const report = makeReport();
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('NO REAL TRADE SENT');
    expect(text).toContain('token:auto-paper was NOT run');
  });

  it('shows counts section', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('PASS_TO_HUMAN');
    expect(text).toContain('WATCH');
    expect(text).toContain('IGNORE');
    expect(text).toContain('DANGER');
    expect(text).toContain('Current-cycle entries reviewed');
  });

  it('shows missing signals section', () => {
    const report = makeReport();
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('Missing signals');
    expect(text).toContain('HOLDER_MAP_NOT_CONNECTED');
    expect(text).toContain('LP_LOCK_NOT_CONNECTED');
  });

  it('shows final recommendation', () => {
    const report = makeReport({ finalRecommendation: 'MANUAL_REVIEW_READY', passToHumanCount: 1 });
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('MANUAL_REVIEW_READY');
  });

  it('shows NO_CLEAN_SIGNAL when empty', () => {
    const report = makeReport();
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('NO_CLEAN_SIGNAL');
  });

  it('shows token details for PASS_TO_HUMAN items', () => {
    const entry = makeTopEntry({ symbol: 'MOONZ', priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('$MOONZ');
    expect(text).toContain('PASS_TO_HUMAN');
  });

  it('shows blocked mover section with DANGER label', () => {
    const b = makeBlockedMover({ blockReasons: ['loseCount 4/5'] });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [], topBlockedMovers: [b] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const text = renderDexLegitimacyReport(report);
    expect(text).toContain('DANGER blocked movers');
    expect(text).toContain('loseCount');
  });

  it('does not contain live trading or execution language', () => {
    const entry = makeTopEntry({ priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 0.5 });
    const cycle = makeCycleEntry({ topCurrentCycleEntries: [entry] });
    const report = buildDexLegitimacyReport([cycle], null, BASE_OPTS);
    const text = renderDexLegitimacyReport(report);
    const lower = text.toLowerCase();
    expect(lower).not.toContain('swap executed');
    expect(lower).not.toContain('buy order');
    expect(lower).not.toContain('wallet signed');
    expect(lower).not.toContain('private key');
  });
});

// ── renderDexLegitimacyReportUsage ───────────────────────────────────────────────────────

describe('renderDexLegitimacyReportUsage', () => {
  it('includes command name', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('token:dex-legitimacy-report');
  });

  it('includes --help flag', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('--help');
  });

  it('includes --json flag', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('--json');
  });

  it('mentions PAPER ONLY / READ-ONLY', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('PAPER ONLY');
    expect(help).toContain('READ-ONLY');
    expect(help).toContain('tradingExecuted: 0');
  });

  it('mentions all verdict values', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('PASS_TO_HUMAN');
    expect(help).toContain('WATCH');
    expect(help).toContain('IGNORE');
    expect(help).toContain('DANGER');
  });

  it('mentions all recommendation values', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('MANUAL_REVIEW_READY');
    expect(help).toContain('COLLECT_MORE_DATA');
    expect(help).toContain('TOO_MUCH_JUNK');
    expect(help).toContain('NO_CLEAN_SIGNAL');
  });

  it('mentions placeholder signals', () => {
    const help = renderDexLegitimacyReportUsage();
    expect(help).toContain('HOLDER_MAP');
    expect(help).toContain('BUBBLE_MAP');
    expect(help).toContain('LP_LOCK');
  });

  it('does not run a report when invoked — is purely a string', () => {
    // Verifies --help behavior: calling usage does not trigger I/O or scoring.
    const helpText = renderDexLegitimacyReportUsage();
    expect(typeof helpText).toBe('string');
    expect(helpText.length).toBeGreaterThan(100);
  });
});
