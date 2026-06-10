import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tryClassifyItem,
  buildDexWinnerCandidateReport,
  writeDexWinnerCandidateReport,
  renderDexWinnerCandidateReport,
  renderDexWinnerCandidateReportUsage,
  type DexWinnerCandidateReport,
  type WinnerCandidate,
} from '../src/token-grab/dexWinnerCandidateReport';
import type {
  DexLegitimacyReport,
  LegitimacyItem,
  BlockedMoverItem,
} from '../src/token-grab/dexLegitimacyReport';
import { ALWAYS_MISSING_SIGNALS } from '../src/token-grab/dexLegitimacyReport';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_A = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump';
const CONTRACT_B = 'ELON2222222222222222222222222222222222222222222';
const CONTRACT_C = 'JUNK3333333333333333333333333333333333333333333';

function makeItem(overrides?: Partial<LegitimacyItem>): LegitimacyItem {
  return {
    symbol: 'GOOD',
    contract: CONTRACT_A,
    sourceRunFile: 'run-20260609-100000.json',
    observedAt: '2026-06-09T10:00:00.000Z',
    priceChangePct: 25,
    liquidityChangePct: 10,
    volumeLiquidityRatio: 0.5,
    legitimacyVerdict: 'PASS_TO_HUMAN',
    confidence: 'MEDIUM',
    reasons: ['price +25.0%'],
    missingSignals: [...ALWAYS_MISSING_SIGNALS],
    holderConcentrationStatus: 'UNKNOWN',
    creatorWalletStatus: 'UNKNOWN',
    bubbleMapStatus: 'UNKNOWN',
    socialChatterStatus: 'UNKNOWN',
    mintAuthorityStatus: 'UNKNOWN',
    freezeAuthorityStatus: 'UNKNOWN',
    liquidityLockStatus: 'UNKNOWN',
    ...overrides,
  };
}

function makeBlockedMover(overrides?: Partial<BlockedMoverItem>): BlockedMoverItem {
  return {
    symbol: 'JUNK',
    contract: CONTRACT_C,
    priceChangePct: 120,
    blockedReasons: ['loseCount >= 1 (loseCount=2)', 'drainCount >= 1 (drainCount=1)'],
    verdict: 'DANGER',
    ...overrides,
  };
}

function makeLegitimacyReport(
  items: LegitimacyItem[] = [],
  blockedMovers: BlockedMoverItem[] = [],
): DexLegitimacyReport {
  return {
    generatedAt: '2026-06-09T10:00:00.000Z',
    dayLogPath: 'data/token-grab/day-watch/dex-day-watch-today.jsonl',
    runsDir: 'data/token-grab/dex-watch-runs',
    totalCurrentCycleEntriesReviewed: items.length,
    passToHumanCount: 0,
    watchCount: 0,
    ignoreCount: 0,
    dangerCount: 0,
    items,
    blockedMovers,
    finalRecommendation: 'NO_CLEAN_SIGNAL',
    missingSignalSummary: [...ALWAYS_MISSING_SIGNALS],
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

const BASE_OPTS = { sourceFile: 'test-legitimacy.json' };

// ── tryClassifyItem ───────────────────────────────────────────────────────────────────────

describe('tryClassifyItem', () => {
  it('TAKE_PROFIT exit becomes PASS_TO_HUMAN', () => {
    const item = makeItem({ paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.25 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('PASS_TO_HUMAN');
  });

  it('RUNNER_TARGET exit also becomes PASS_TO_HUMAN', () => {
    const item = makeItem({ paperExitReason: 'RUNNER_TARGET', paperFakePnlDollars: 0.5 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('PASS_TO_HUMAN');
  });

  it('MAX_HOLD_TIMEOUT with positive P/L becomes HIGH_CONVICTION_WATCH', () => {
    const item = makeItem({ paperExitReason: 'MAX_HOLD_TIMEOUT', paperFakePnlDollars: 0.34 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('HIGH_CONVICTION_WATCH');
  });

  it('STILL_OPEN position becomes HIGH_CONVICTION_WATCH', () => {
    const item = makeItem({ paperExitReason: 'STILL_OPEN', paperFakePnlDollars: 0.1 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('HIGH_CONVICTION_WATCH');
  });

  it('MAX_HOLD_TIMEOUT with zero P/L becomes WATCH', () => {
    const item = makeItem({ paperExitReason: 'MAX_HOLD_TIMEOUT', paperFakePnlDollars: 0 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('WATCH');
  });

  it('no paper position becomes WATCH', () => {
    const item = makeItem({ paperExitReason: undefined, paperFakePnlDollars: undefined });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('WATCH');
  });

  it('STOP_LOSS is rejected', () => {
    const item = makeItem({ paperExitReason: 'STOP_LOSS' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('STOP_LOSS');
  });

  it('LIQUIDITY_DUMP is rejected', () => {
    const item = makeItem({ paperExitReason: 'LIQUIDITY_DUMP' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('LIQUIDITY_DUMP');
  });

  it('VLR_SPIKE is rejected', () => {
    const item = makeItem({ paperExitReason: 'VLR_SPIKE' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('VLR_SPIKE');
  });

  it('MISSING_OR_STALE is rejected', () => {
    const item = makeItem({ paperExitReason: 'MISSING_OR_STALE' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('MISSING_DATA');
  });

  it('freeze authority ACTIVE is rejected', () => {
    const item = makeItem({ freezeAuthorityStatus: 'ACTIVE' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('FREEZE_AUTHORITY_ACTIVE');
  });

  it('holder concentration DANGER is rejected', () => {
    const item = makeItem({ holderConcentrationStatus: 'DANGER' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('HOLDER_DANGER');
  });

  it('freeze authority check happens before market check', () => {
    const item = makeItem({ freezeAuthorityStatus: 'ACTIVE', priceChangePct: 100, liquidityChangePct: 50 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('FREEZE_AUTHORITY_ACTIVE');
  });

  it('price below threshold → HARD_MARKET_FAIL', () => {
    const item = makeItem({ priceChangePct: 5 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('HARD_MARKET_FAIL');
  });

  it('liquidity below threshold → HARD_MARKET_FAIL', () => {
    const item = makeItem({ liquidityChangePct: 2 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('HARD_MARKET_FAIL');
  });

  it('VLR above threshold → HARD_MARKET_FAIL', () => {
    const item = makeItem({ volumeLiquidityRatio: 1.5 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') expect(result.category).toBe('HARD_MARKET_FAIL');
  });

  it('VLR exactly 1.0 is accepted', () => {
    const item = makeItem({ volumeLiquidityRatio: 1.0, paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.25 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
  });

  it('holder concentration WARNING downgrades PASS_TO_HUMAN to HIGH_CONVICTION_WATCH', () => {
    const item = makeItem({
      paperExitReason: 'TAKE_PROFIT',
      paperFakePnlDollars: 0.25,
      holderConcentrationStatus: 'WARNING',
    });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('HIGH_CONVICTION_WATCH');
  });

  it('mint authority ACTIVE downgrades to WATCH', () => {
    const item = makeItem({
      paperExitReason: 'TAKE_PROFIT',
      paperFakePnlDollars: 0.25,
      mintAuthorityStatus: 'ACTIVE',
    });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.tier).toBe('WATCH');
  });

  it('confidence is MEDIUM when safety data is UNKNOWN for PASS_TO_HUMAN', () => {
    const item = makeItem({ paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.25 });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.candidate.confidence).toBe('MEDIUM');
  });

  it('confidence is HIGH when safety data is known and tier is PASS_TO_HUMAN', () => {
    const item = makeItem({
      paperExitReason: 'TAKE_PROFIT',
      paperFakePnlDollars: 0.25,
      mintAuthorityStatus: 'RENOUNCED',
      freezeAuthorityStatus: 'RENOUNCED',
      holderConcentrationStatus: 'CLEAN',
    });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') expect(result.candidate.confidence).toBe('HIGH');
  });

  it('missingSafetySignals includes MINT_FREEZE when status is UNKNOWN', () => {
    const item = makeItem({ paperExitReason: 'TAKE_PROFIT' });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') {
      expect(result.candidate.missingSafetySignals).toContain('MINT_FREEZE_NOT_CONNECTED');
      expect(result.candidate.missingSafetySignals).toContain('HOLDER_MAP_NOT_CONNECTED');
    }
  });

  it('missingSafetySignals is empty when safety data is known', () => {
    const item = makeItem({
      paperExitReason: 'TAKE_PROFIT',
      mintAuthorityStatus: 'RENOUNCED',
      freezeAuthorityStatus: 'RENOUNCED',
      holderConcentrationStatus: 'CLEAN',
    });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') {
      expect(result.candidate.missingSafetySignals).toHaveLength(0);
    }
  });

  it('reasons array has at most 3 entries', () => {
    const item = makeItem({
      paperExitReason: 'TAKE_PROFIT',
      mintAuthorityStatus: 'ACTIVE',
      holderConcentrationStatus: 'WARNING',
    });
    const result = tryClassifyItem(item);
    expect(result.type).toBe('candidate');
    if (result.type === 'candidate') {
      expect(result.candidate.reasons.length).toBeLessThanOrEqual(3);
    }
  });
});

// ── buildDexWinnerCandidateReport ─────────────────────────────────────────────────────────

describe('buildDexWinnerCandidateReport', () => {
  it('junk tokens (price < 15%) are excluded from normal report', () => {
    const item = makeItem({ priceChangePct: 5 });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates).toHaveLength(0);
    expect(report.candidateCount).toBe(0);
    expect(report.finalRecommendation).toBe('NO_CANDIDATES');
  });

  it('junk tokens do not appear in non-debug render', () => {
    const item = makeItem({ priceChangePct: 5, symbol: 'LOWPRICE' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report, false);
    expect(text).not.toContain('$LOWPRICE');
    expect(text).not.toContain('LOWPRICE');
  });

  it('rejectedCount increments for each rejected item', () => {
    const item1 = makeItem({ priceChangePct: 5 });
    const item2 = makeItem({ contract: CONTRACT_B, paperExitReason: 'STOP_LOSS' });
    const lrep = makeLegitimacyReport([item1, item2]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.rejectedCount).toBe(2);
    expect(report.candidateCount).toBe(0);
  });

  it('blocked movers from legitimacy report count in rejectedCount', () => {
    const blocked = makeBlockedMover();
    const lrep = makeLegitimacyReport([], [blocked]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.rejectedCount).toBe(1);
    expect(report.rejectCategoryCounts['BLOCKED_HISTORY']).toBe(1);
  });

  it('blocked movers and item rejections accumulate in rejectedCount', () => {
    const item = makeItem({ priceChangePct: 5 });
    const blocked = makeBlockedMover();
    const lrep = makeLegitimacyReport([item], [blocked]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.rejectedCount).toBe(2);
  });

  it('debug mode includes rejected array with reasons', () => {
    const item = makeItem({ priceChangePct: 5, symbol: 'CHEAPCOIN' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, { ...BASE_OPTS, debug: true });
    expect(report.rejected).toBeDefined();
    expect(report.rejected!.length).toBeGreaterThan(0);
    expect(report.rejected!.some(r => r.rejectCategory === 'HARD_MARKET_FAIL')).toBe(true);
  });

  it('debug mode includes blocked movers in rejected array', () => {
    const blocked = makeBlockedMover({ symbol: 'BLOCKEDCOIN' });
    const lrep = makeLegitimacyReport([], [blocked]);
    const report = buildDexWinnerCandidateReport(lrep, { ...BASE_OPTS, debug: true });
    expect(report.rejected).toBeDefined();
    expect(report.rejected!.some(r => r.rejectCategory === 'BLOCKED_HISTORY')).toBe(true);
  });

  it('non-debug mode does not include rejected array', () => {
    const item = makeItem({ priceChangePct: 5 });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.rejected).toBeUndefined();
  });

  it('XRPS-style MAX_HOLD_TIMEOUT positive P/L becomes HIGH_CONVICTION_WATCH', () => {
    const item = makeItem({
      symbol: 'XRPS',
      priceChangePct: 34.3,
      liquidityChangePct: 15.7,
      volumeLiquidityRatio: 0.5,
      paperExitReason: 'MAX_HOLD_TIMEOUT',
      paperFakePnlDollars: 0.34,
    });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0].tier).toBe('HIGH_CONVICTION_WATCH');
    expect(report.highConvictionWatchCount).toBe(1);
    expect(report.finalRecommendation).toBe('HIGH_CONVICTION_WATCH');
  });

  it('TAKE_PROFIT becomes PASS_TO_HUMAN', () => {
    const item = makeItem({ paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.25 });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates[0].tier).toBe('PASS_TO_HUMAN');
    expect(report.passToHumanCount).toBe(1);
    expect(report.finalRecommendation).toBe('PASS_TO_HUMAN');
  });

  it('STOP_LOSS is excluded — not a candidate', () => {
    const item = makeItem({ paperExitReason: 'STOP_LOSS' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates).toHaveLength(0);
    expect(report.rejectCategoryCounts['STOP_LOSS']).toBe(1);
  });

  it('LIQUIDITY_DUMP is excluded', () => {
    const item = makeItem({ paperExitReason: 'LIQUIDITY_DUMP' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates).toHaveLength(0);
    expect(report.rejectCategoryCounts['LIQUIDITY_DUMP']).toBe(1);
  });

  it('VLR_SPIKE is excluded', () => {
    const item = makeItem({ paperExitReason: 'VLR_SPIKE' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates).toHaveLength(0);
    expect(report.rejectCategoryCounts['VLR_SPIKE']).toBe(1);
  });

  it('active freeze authority is excluded', () => {
    const item = makeItem({ freezeAuthorityStatus: 'ACTIVE' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates).toHaveLength(0);
    expect(report.rejectCategoryCounts['FREEZE_AUTHORITY_ACTIVE']).toBe(1);
  });

  it('holder concentration DANGER is excluded', () => {
    const item = makeItem({ holderConcentrationStatus: 'DANGER' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates).toHaveLength(0);
    expect(report.rejectCategoryCounts['HOLDER_DANGER']).toBe(1);
  });

  it('downgrades PASS_TO_HUMAN to HIGH_CONVICTION_WATCH when holderConcentrationStatus is WARNING', () => {
    const item = makeItem({
      paperExitReason: 'TAKE_PROFIT',
      paperFakePnlDollars: 0.25,
      holderConcentrationStatus: 'WARNING',
    });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates[0].tier).toBe('HIGH_CONVICTION_WATCH');
    expect(report.passToHumanCount).toBe(0);
    expect(report.highConvictionWatchCount).toBe(1);
  });

  it('candidates are sorted: PASS_TO_HUMAN before HIGH_CONVICTION_WATCH before WATCH', () => {
    const passItem = makeItem({ paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.2 });
    const hcwItem = makeItem({
      contract: CONTRACT_B,
      symbol: 'HCW',
      paperExitReason: 'MAX_HOLD_TIMEOUT',
      paperFakePnlDollars: 0.1,
    });
    const watchItem = makeItem({
      contract: CONTRACT_C,
      symbol: 'WATCHME',
      paperExitReason: undefined,
    });
    const lrep = makeLegitimacyReport([hcwItem, watchItem, passItem]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.candidates[0].tier).toBe('PASS_TO_HUMAN');
    expect(report.candidates[1].tier).toBe('HIGH_CONVICTION_WATCH');
    expect(report.candidates[2].tier).toBe('WATCH');
  });

  it('finalRecommendation is NO_CANDIDATES when nothing qualifies', () => {
    const lrep = makeLegitimacyReport([]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    expect(report.finalRecommendation).toBe('NO_CANDIDATES');
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('report has tradingExecuted: 0', () => {
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    expect(report.tradingExecuted).toBe(0);
  });

  it('report has noRealTradeSent: true', () => {
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    expect(report.noRealTradeSent).toBe(true);
  });

  it('report has readOnly: true and paperOnly: true', () => {
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    expect(report.readOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
  });

  it('report JSON does not contain auto-paper or live execution language', () => {
    const item = makeItem({ paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.25 });
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([item]), BASE_OPTS);
    const json = JSON.stringify(report);
    expect(json).not.toContain('autoPaper');
    expect(json).not.toContain('auto-paper');
    expect(json).not.toContain('liveHarness');
    expect(json).not.toContain('swapExecuted');
    expect(json).not.toContain('walletAddress');
    expect(json).not.toContain('privateKey');
  });
});

// ── writeDexWinnerCandidateReport ─────────────────────────────────────────────────────────

describe('writeDexWinnerCandidateReport', () => {
  it('writes JSON to the legitimacy output directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winner-test-'));
    const outPath = path.join(tmpDir, 'legitimacy', 'dex-winner-candidates-today.json');
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    writeDexWinnerCandidateReport(report, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.tradingExecuted).toBe(0);
    expect(parsed.noRealTradeSent).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates intermediate directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winner-mkdir-'));
    const outPath = path.join(tmpDir, 'deep', 'nested', 'report.json');
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    expect(() => writeDexWinnerCandidateReport(report, outPath)).not.toThrow();
    expect(fs.existsSync(outPath)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── renderDexWinnerCandidateReport ────────────────────────────────────────────────────────

describe('renderDexWinnerCandidateReport', () => {
  it('includes safety banner', () => {
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).toContain('PAPER ONLY');
    expect(text).toContain('READ-ONLY');
    expect(text).toContain('NO REAL TRADE SENT');
    expect(text).toContain('tradingExecuted: 0');
  });

  it('includes safety footer', () => {
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).toContain('token:auto-paper was NOT run');
  });

  it('shows NO_CANDIDATES cleanly when no candidates', () => {
    const report = buildDexWinnerCandidateReport(makeLegitimacyReport([]), BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).toContain('NO_CANDIDATES');
    expect(text).toContain('PAPER ONLY');
  });

  it('does NOT show top blocked mover table in normal output', () => {
    const blocked = makeBlockedMover({ symbol: 'JUNKTOKEN' });
    const lrep = makeLegitimacyReport([], [blocked]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).not.toMatch(/top\s+.*blocked\s+mover/i);
    expect(text).not.toContain('blocked movers');
    expect(text).not.toContain('JUNKTOKEN');
  });

  it('shows PASS_TO_HUMAN candidate with token details', () => {
    const item = makeItem({ symbol: 'MOONZ', paperExitReason: 'TAKE_PROFIT', paperFakePnlDollars: 0.3 });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).toContain('$MOONZ');
    expect(text).toContain('PASS_TO_HUMAN');
    expect(text).toContain('TAKE_PROFIT');
  });

  it('shows HIGH_CONVICTION_WATCH for XRPS-style token', () => {
    const item = makeItem({
      symbol: 'XRPS',
      priceChangePct: 34.3,
      liquidityChangePct: 15.7,
      volumeLiquidityRatio: 0.5,
      paperExitReason: 'MAX_HOLD_TIMEOUT',
      paperFakePnlDollars: 0.34,
    });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).toContain('$XRPS');
    expect(text).toContain('HIGH_CONVICTION_WATCH');
    expect(text).toContain('MAX_HOLD_TIMEOUT');
    expect(text).toContain('+$0.34');
  });

  it('shows "Rejected silently: N" line', () => {
    const item = makeItem({ priceChangePct: 5 }); // rejected
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report);
    expect(text).toContain('Rejected silently: 1');
  });

  it('does not show rejected token in normal (non-debug) render', () => {
    const item = makeItem({ priceChangePct: 5, symbol: 'JUNKCOIN' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, { ...BASE_OPTS, debug: true });
    const normalText = renderDexWinnerCandidateReport(report, false);
    expect(normalText).not.toContain('$JUNKCOIN');
    expect(normalText).not.toContain('Rejected (debug)');
  });

  it('debug render shows rejected tokens and reasons', () => {
    const item = makeItem({ priceChangePct: 5, symbol: 'JUNKCOIN' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, { ...BASE_OPTS, debug: true });
    const debugText = renderDexWinnerCandidateReport(report, true);
    expect(debugText).toContain('Rejected (debug)');
    expect(debugText).toContain('$JUNKCOIN');
    expect(debugText).toContain('HARD_MARKET_FAIL');
  });

  it('does not contain live trading or execution language', () => {
    const item = makeItem({ paperExitReason: 'TAKE_PROFIT' });
    const lrep = makeLegitimacyReport([item]);
    const report = buildDexWinnerCandidateReport(lrep, BASE_OPTS);
    const text = renderDexWinnerCandidateReport(report).toLowerCase();
    expect(text).not.toContain('swap executed');
    expect(text).not.toContain('buy order');
    expect(text).not.toContain('wallet signed');
    expect(text).not.toContain('private key');
  });
});

// ── renderDexWinnerCandidateReportUsage ───────────────────────────────────────────────────

describe('renderDexWinnerCandidateReportUsage', () => {
  it('is a pure string function — does not write files or call RPC', () => {
    const help = renderDexWinnerCandidateReportUsage();
    expect(typeof help).toBe('string');
    expect(help.length).toBeGreaterThan(100);
  });

  it('includes command name', () => {
    expect(renderDexWinnerCandidateReportUsage()).toContain('token:dex-winner-candidates');
  });

  it('includes PAPER ONLY / READ-ONLY / tradingExecuted: 0', () => {
    const help = renderDexWinnerCandidateReportUsage();
    expect(help).toContain('PAPER ONLY');
    expect(help).toContain('READ-ONLY');
    expect(help).toContain('tradingExecuted: 0');
  });

  it('includes all tier names', () => {
    const help = renderDexWinnerCandidateReportUsage();
    expect(help).toContain('PASS_TO_HUMAN');
    expect(help).toContain('HIGH_CONVICTION_WATCH');
    expect(help).toContain('WATCH');
  });

  it('includes hard kill rules', () => {
    const help = renderDexWinnerCandidateReportUsage();
    expect(help).toContain('STOP_LOSS');
    expect(help).toContain('LIQUIDITY_DUMP');
    expect(help).toContain('VLR_SPIKE');
    expect(help).toContain('Freeze authority ACTIVE');
  });

  it('includes --debug and --json flags', () => {
    const help = renderDexWinnerCandidateReportUsage();
    expect(help).toContain('--debug');
    expect(help).toContain('--json');
  });

  it('includes --help flag', () => {
    expect(renderDexWinnerCandidateReportUsage()).toContain('--help');
  });
});
