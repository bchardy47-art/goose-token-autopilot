import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperLearningSummary,
  renderRipperLearningSummary,
  decideRecommendation,
  type LearningSummary,
  type BucketStats,
} from '../src/token-grab/ripperLearningSummaryReport';
import type { LearningMemoryRow, OutcomeLabel, MemoryUniverse } from '../src/token-grab/ripperLearningMemory';

let tmpDir: string;
let memoryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlsr-test-'));
  memoryPath = path.join(tmpDir, 'learning-memory.jsonl');
});

afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function row(opts: Partial<LearningMemoryRow> & {
  contract: string;
  outcomeLabel: OutcomeLabel;
  wouldRejectByLiqOrAge: boolean;
  memoryUniverse?: MemoryUniverse;
}): LearningMemoryRow {
  return {
    contract:              opts.contract,
    cycleId:               opts.cycleId ?? 'cycle-test',
    capturedAt:            opts.capturedAt ?? '2026-06-12T13:27:44.582Z',
    observedAt:            opts.observedAt ?? '2026-06-12T13:37:44.582Z',
    outcomeSource:         opts.outcomeSource ?? 'obs-test.jsonl',
    gateDecision:          opts.gateDecision ?? 'BUY_APPROVED_PAPER',
    clusterRisk:           opts.clusterRisk ?? 'CLEAN',
    ripperScore:           opts.ripperScore ?? 100,
    launchAgeBucket:       opts.launchAgeBucket ?? 'PRIME_WINDOW',
    ageMinutes:            opts.ageMinutes ?? 8,
    liquidityUsd:          opts.liquidityUsd ?? 20_000,
    liquidityBucket:       opts.liquidityBucket ?? 'LIQ_10K_30K',
    bubbleMapsScore:       opts.bubbleMapsScore ?? null,
    vlrBucket:             opts.vlrBucket ?? 'VLR_0_5_TO_2',
    entryDecision:         opts.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    timingPath:            opts.timingPath ?? 'ENTER_NOW',
    priceChangePct:        opts.priceChangePct ?? null,
    outcomeLabel:          opts.outcomeLabel,
    // Default to SHADOW_ENROLLED_APPROVED so existing tests continue to exercise
    // the policy-promotion path without modification.
    memoryUniverse:        opts.memoryUniverse ?? 'SHADOW_ENROLLED_APPROVED',
    wouldRejectByLiqOrAge: opts.wouldRejectByLiqOrAge,
    blockedByLowLiquidity: opts.blockedByLowLiquidity ?? false,
    blockedByAgeGte10m:    opts.blockedByAgeGte10m ?? false,
    sourceFiles:           opts.sourceFiles ?? ['cycle-test.jsonl'],
    reportOnly:            true,
    readOnly:              true,
    paperOnly:             true,
    realTradingLocked:     true,
    tradingExecuted:       0,
  };
}

function writeMemory(rows: LearningMemoryRow[]): void {
  fs.writeFileSync(
    memoryPath,
    rows.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

// Build N rows of a single class.
function makeRows(opts: {
  prefix:         string;
  count:          number;
  label:          OutcomeLabel;
  priceChange:    number | null;
  blocked:        boolean;
  timingPath?:    LearningMemoryRow['timingPath'];
  memoryUniverse?: MemoryUniverse;
}): LearningMemoryRow[] {
  const out: LearningMemoryRow[] = [];
  for (let i = 0; i < opts.count; i++) {
    out.push(row({
      contract:              `${opts.prefix}-${i}`,
      outcomeLabel:          opts.label,
      wouldRejectByLiqOrAge: opts.blocked,
      priceChangePct:        opts.priceChange,
      timingPath:            opts.timingPath ?? 'ENTER_NOW',
      // Default SHADOW_ENROLLED_APPROVED so recommendation tests work unchanged.
      memoryUniverse:        opts.memoryUniverse ?? 'SHADOW_ENROLLED_APPROVED',
    }));
  }
  return out;
}

describe('runRipperLearningSummary — basic dashboard', () => {
  it('builds bucket stats for overall, blocked, control, timing, and CLEAN/100/PRIME', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'BIG_WINNER',   wouldRejectByLiqOrAge: false, priceChangePct: 8,   timingPath: 'ENTER_NOW' }),
      row({ contract: 'b', outcomeLabel: 'FLAT_JUNK',    wouldRejectByLiqOrAge: true,  priceChangePct: 0,   timingPath: 'WAIT_10M' }),
      row({ contract: 'c', outcomeLabel: 'DUMP',         wouldRejectByLiqOrAge: true,  priceChangePct: -3,  timingPath: 'WAIT_10M' }),
      row({ contract: 'd', outcomeLabel: 'SMALL_WINNER', wouldRejectByLiqOrAge: false, priceChangePct: 2,   timingPath: 'ENTER_NOW' }),
      row({ contract: 'e', outcomeLabel: 'UNKNOWN',      wouldRejectByLiqOrAge: false, priceChangePct: null,timingPath: null }),
    ]);
    const summary = runRipperLearningSummary({ memoryPath });
    expect(summary.totalRows).toBe(5);
    expect(summary.observedRows).toBe(4);
    expect(summary.unknownRows).toBe(1);
    expect(summary.liqOrAgeBlocked.observedRows).toBe(2);
    expect(summary.liqOrAgeBlocked.outcomes.flat_junk).toBe(1);
    expect(summary.liqOrAgeBlocked.outcomes.dump).toBe(1);
    expect(summary.control.outcomes.big_winner).toBe(1);
    expect(summary.control.outcomes.small_winner).toBe(1);
    expect(summary.waitTenMinutes.observedRows).toBe(2);
    expect(summary.enterNow.observedRows).toBe(2);
    expect(summary.cleanScore100Prime.observedRows).toBeGreaterThan(0);
    expect(summary.reportOnly).toBe(true);
    expect(summary.readOnly).toBe(true);
    expect(summary.paperOnly).toBe(true);
    expect(summary.realTradingLocked).toBe(true);
    expect(summary.tradingExecuted).toBe(0);
  });
});

describe('decideRecommendation — strict thresholds', () => {
  it('returns KEEP_COLLECTING when blocked observed < 150', () => {
    const rows = [
      ...makeRows({ prefix: 'b-w', count:   3, label: 'SMALL_WINNER', priceChange: 2,    blocked: true  }),
      ...makeRows({ prefix: 'b-j', count:  60, label: 'FLAT_JUNK',    priceChange: 0,    blocked: true  }),
      ...makeRows({ prefix: 'b-d', count:  37, label: 'DUMP',         priceChange: -3,   blocked: true  }),
      ...makeRows({ prefix: 'c-w', count:  60, label: 'SMALL_WINNER', priceChange: 2,    blocked: false }),
      ...makeRows({ prefix: 'c-j', count: 140, label: 'FLAT_JUNK',    priceChange: 0,    blocked: false }),
    ];
    writeMemory(rows);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.liqOrAgeBlocked.observedRows).toBe(100);
    expect(s.recommendation).toBe('KEEP_COLLECTING');
    expect(s.recommendationReason).toMatch(/< 150/);
  });

  it('returns PROMOTE_TO_PAPER_ONLY_TEST_REVIEW only under strict thresholds', () => {
    // Blocked: 300 rows = 9 small_winner (3%) + 285 dump (95%) + 6 flat_junk → junk+dump=97%
    // Control: 300 rows = 30 small_winner (10%) + 270 flat_junk
    // Blocked winner rate = 3% in [1,5] ✓
    // Control winner rate = 10% >= 3 * 3% = 9% ✓
    const rows = [
      ...makeRows({ prefix: 'b-w', count:   9, label: 'SMALL_WINNER', priceChange: 2,  blocked: true }),
      ...makeRows({ prefix: 'b-d', count: 285, label: 'DUMP',         priceChange: -3, blocked: true }),
      ...makeRows({ prefix: 'b-j', count:   6, label: 'FLAT_JUNK',    priceChange: 0,  blocked: true }),
      ...makeRows({ prefix: 'c-w', count:  30, label: 'SMALL_WINNER', priceChange: 2,  blocked: false }),
      ...makeRows({ prefix: 'c-j', count: 270, label: 'FLAT_JUNK',    priceChange: 0,  blocked: false }),
    ];
    writeMemory(rows);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.liqOrAgeBlocked.observedRows).toBe(300);
    expect(s.liqOrAgeBlocked.winnerRatePct).toBeCloseTo(3, 5);
    expect(s.liqOrAgeBlocked.flatJunkDumpPct).toBeCloseTo(97, 5);
    expect(s.control.winnerRatePct).toBeCloseTo(10, 5);
    expect(s.recommendation).toBe('PROMOTE_TO_PAPER_ONLY_TEST_REVIEW');
  });

  it('returns DO_NOT_PROMOTE when blocked junk+dump pct < 90%', () => {
    // Blocked: 300 = 30 small_winner (10%) + 30 flat_junk + 240 BIG_WINNER (winner rate = 90%, junk+dump=10%)
    const rows = [
      ...makeRows({ prefix: 'b-bw', count: 240, label: 'BIG_WINNER',   priceChange: 8,  blocked: true }),
      ...makeRows({ prefix: 'b-sw', count:  30, label: 'SMALL_WINNER', priceChange: 2,  blocked: true }),
      ...makeRows({ prefix: 'b-j',  count:  30, label: 'FLAT_JUNK',    priceChange: 0,  blocked: true }),
      ...makeRows({ prefix: 'c-w',  count:  60, label: 'SMALL_WINNER', priceChange: 2,  blocked: false }),
      ...makeRows({ prefix: 'c-j',  count: 240, label: 'FLAT_JUNK',    priceChange: 0,  blocked: false }),
    ];
    writeMemory(rows);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.liqOrAgeBlocked.flatJunkDumpPct).toBeLessThan(90);
    expect(s.recommendation).toBe('DO_NOT_PROMOTE');
  });

  it('returns DO_NOT_PROMOTE when blocked winner rate > 5%', () => {
    // Blocked: 300 = 30 small_winner (10% winner) + 270 dump (junk+dump=90% ✓ but winner outside band)
    const rows = [
      ...makeRows({ prefix: 'b-w', count:  30, label: 'SMALL_WINNER', priceChange: 2,  blocked: true }),
      ...makeRows({ prefix: 'b-d', count: 270, label: 'DUMP',         priceChange: -3, blocked: true }),
      ...makeRows({ prefix: 'c-w', count:  90, label: 'SMALL_WINNER', priceChange: 2,  blocked: false }),
      ...makeRows({ prefix: 'c-j', count: 210, label: 'FLAT_JUNK',    priceChange: 0,  blocked: false }),
    ];
    writeMemory(rows);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.liqOrAgeBlocked.winnerRatePct).toBeCloseTo(10, 5);
    expect(s.recommendation).toBe('DO_NOT_PROMOTE');
  });

  it('returns DO_NOT_PROMOTE when control winner rate < 3x blocked winner rate', () => {
    // Blocked: 300 = 9 small_winner (3%) + 285 dump + 6 flat_junk → all thresholds OK except control ratio
    // Control: 300 = 9 small_winner (3% same as blocked) + 291 flat_junk
    const rows = [
      ...makeRows({ prefix: 'b-w', count:   9, label: 'SMALL_WINNER', priceChange: 2,  blocked: true }),
      ...makeRows({ prefix: 'b-d', count: 285, label: 'DUMP',         priceChange: -3, blocked: true }),
      ...makeRows({ prefix: 'b-j', count:   6, label: 'FLAT_JUNK',    priceChange: 0,  blocked: true }),
      ...makeRows({ prefix: 'c-w', count:   9, label: 'SMALL_WINNER', priceChange: 2,  blocked: false }),
      ...makeRows({ prefix: 'c-j', count: 291, label: 'FLAT_JUNK',    priceChange: 0,  blocked: false }),
    ];
    writeMemory(rows);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.recommendation).toBe('DO_NOT_PROMOTE');
    expect(s.recommendationReason).toMatch(/control/);
  });

  it('decideRecommendation directly: PROMOTE only when all thresholds pass', () => {
    const blocked: BucketStats = {
      observedRows: 200, unknownRows: 0,
      outcomes: { big_winner: 0, winner: 0, small_winner: 4, flat_junk: 100, dump: 96, unknown: 0, total: 200 },
      winnerRatePct: 2, smallWinnerRatePct: 2, flatJunkDumpPct: 98, winnerOnePctToFivePct: 2,
    };
    const control: BucketStats = {
      observedRows: 200, unknownRows: 0,
      outcomes: { big_winner: 0, winner: 0, small_winner: 40, flat_junk: 160, dump: 0, unknown: 0, total: 200 },
      winnerRatePct: 20, smallWinnerRatePct: 20, flatJunkDumpPct: 80, winnerOnePctToFivePct: 20,
    };
    expect(decideRecommendation(blocked, control).recommendation).toBe('PROMOTE_TO_PAPER_ONLY_TEST_REVIEW');
  });

  it('decideRecommendation directly: KEEP_COLLECTING when blocked observed < 150', () => {
    const blocked: BucketStats = {
      observedRows: 100, unknownRows: 0,
      outcomes: { big_winner: 0, winner: 0, small_winner: 2, flat_junk: 50, dump: 48, unknown: 0, total: 100 },
      winnerRatePct: 2, smallWinnerRatePct: 2, flatJunkDumpPct: 98, winnerOnePctToFivePct: 2,
    };
    const control: BucketStats = {
      observedRows: 200, unknownRows: 0,
      outcomes: { big_winner: 0, winner: 0, small_winner: 40, flat_junk: 160, dump: 0, unknown: 0, total: 200 },
      winnerRatePct: 20, smallWinnerRatePct: 20, flatJunkDumpPct: 80, winnerOnePctToFivePct: 20,
    };
    expect(decideRecommendation(blocked, control).recommendation).toBe('KEEP_COLLECTING');
  });
});

describe('renderRipperLearningSummary — safety banners', () => {
  it('always prints HOLD_CURRENT_GATES, DO_NOT_ENABLE_REAL_TRADING, REPORT_ONLY, NO_POLICY_CHANGE', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'UNKNOWN', wouldRejectByLiqOrAge: true, priceChangePct: null }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    const text = renderRipperLearningSummary(s);
    expect(text).toContain('HOLD_CURRENT_GATES');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('REPORT_ONLY');
    expect(text).toContain('NO_POLICY_CHANGE');
  });
});

describe('safety guarantees', () => {
  it('module text never imports production gate logic or paper decision policy', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperLearningSummaryReport.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/from ['"].*\/trading\/real['"]/);
    expect(src).not.toMatch(/from ['"].*\/trading\/guards['"]/);
    expect(src).not.toMatch(/from ['"].*\/trading\/paper['"]/);
    expect(src).not.toMatch(/from ['"].*\/paper\/autoPaper['"]/);
    expect(src).not.toMatch(/from ['"].*\/autopilot\/runAutopilot['"]/);
    // No simulated-trade execution calls, no autopaper runner, no swap/wallet code.
    expect(src).not.toMatch(/\bpaperBuy\s*\(/);
    expect(src).not.toMatch(/\bpaperSell\s*\(/);
    expect(src).not.toMatch(/\brunAutoPaper\s*\(/);
    expect(src).not.toMatch(/\brunAutopilot\s*\(/);
    expect(src).not.toMatch(/\bexecuteSwap\s*\(/);
    expect(src).not.toMatch(/['"]token:auto-paper['"]/);
    expect(src).not.toMatch(/['"]token:paper-buy['"]/);
  });

  it('result rows preserve safety flags', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'FLAT_JUNK', wouldRejectByLiqOrAge: true, priceChangePct: 0 }),
    ]);
    const s: LearningSummary = runRipperLearningSummary({ memoryPath });
    expect(s.reportOnly).toBe(true);
    expect(s.readOnly).toBe(true);
    expect(s.paperOnly).toBe(true);
    expect(s.realTradingLocked).toBe(true);
    expect(s.tradingExecuted).toBe(0);
  });
});

// ── Universe separation ────────────────────────────────────────────────────────

describe('universe separation — policy evidence vs general market', () => {
  it('policyEvidenceRows counts only SHADOW_ENROLLED_APPROVED rows', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'FLAT_JUNK',  wouldRejectByLiqOrAge: true,  memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      row({ contract: 'b', outcomeLabel: 'FLAT_JUNK',  wouldRejectByLiqOrAge: true,  memoryUniverse: 'DEX_WATCH_GENERAL' }),
      row({ contract: 'c', outcomeLabel: 'SMALL_WINNER', wouldRejectByLiqOrAge: false, memoryUniverse: 'UNKNOWN_GENERAL' }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.policyEvidenceRows).toBe(1);
    expect(s.generalMarketRows).toBe(2);
  });

  it('policyLiqOrAgeBlocked counts only blocked SHADOW_ENROLLED_APPROVED rows', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'DUMP',      wouldRejectByLiqOrAge: true,  memoryUniverse: 'SHADOW_ENROLLED_APPROVED', priceChangePct: -5 }),
      row({ contract: 'b', outcomeLabel: 'FLAT_JUNK', wouldRejectByLiqOrAge: true,  memoryUniverse: 'DEX_WATCH_GENERAL',       priceChangePct: 0 }),
      row({ contract: 'c', outcomeLabel: 'BIG_WINNER',wouldRejectByLiqOrAge: true,  memoryUniverse: 'UNKNOWN_GENERAL',         priceChangePct: 10 }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    // Policy blocked = only row 'a'
    expect(s.policyLiqOrAgeBlocked.observedRows).toBe(1);
    expect(s.policyLiqOrAgeBlocked.outcomes.dump).toBe(1);
    // Broad blocked = all 3
    expect(s.liqOrAgeBlocked.observedRows).toBe(3);
  });

  it('DEX_WATCH_GENERAL rows do NOT affect promotion recommendation', () => {
    // Scenario: lots of dex-watch-general blocked junk rows that would push liqOrAgeBlocked
    // above 150 and look like 95% junk — but since they're DEX_WATCH_GENERAL, the
    // recommendation must still be KEEP_COLLECTING (policy evidence universe is empty).
    writeMemory([
      ...makeRows({ prefix: 'dex-j', count: 200, label: 'FLAT_JUNK',    priceChange: 0,  blocked: true,  memoryUniverse: 'DEX_WATCH_GENERAL' }),
      ...makeRows({ prefix: 'dex-d', count: 100, label: 'DUMP',         priceChange: -3, blocked: true,  memoryUniverse: 'DEX_WATCH_GENERAL' }),
      ...makeRows({ prefix: 'dex-c', count: 100, label: 'SMALL_WINNER', priceChange: 2,  blocked: false, memoryUniverse: 'DEX_WATCH_GENERAL' }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    // Broad blocked is large
    expect(s.liqOrAgeBlocked.observedRows).toBe(300);
    // But policy evidence is empty
    expect(s.policyEvidenceRows).toBe(0);
    expect(s.policyLiqOrAgeBlocked.observedRows).toBe(0);
    // Recommendation must be KEEP_COLLECTING (< 150 policy evidence rows)
    expect(s.recommendation).toBe('KEEP_COLLECTING');
    expect(s.recommendationReason).toMatch(/< 150/);
  });

  it('promotion uses SHADOW_ENROLLED_APPROVED stats even when general rows would distort', () => {
    // Policy evidence: 300 enrolled blocked rows that pass all thresholds
    // General market: 1000 rows with huge winner rate that would break ratio if mixed in
    const policyRows = [
      ...makeRows({ prefix: 'pe-w', count:   9, label: 'SMALL_WINNER', priceChange: 2,  blocked: true,  memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      ...makeRows({ prefix: 'pe-d', count: 285, label: 'DUMP',         priceChange: -3, blocked: true,  memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      ...makeRows({ prefix: 'pe-j', count:   6, label: 'FLAT_JUNK',    priceChange: 0,  blocked: true,  memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      ...makeRows({ prefix: 'pc-w', count:  30, label: 'SMALL_WINNER', priceChange: 2,  blocked: false, memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      ...makeRows({ prefix: 'pc-j', count: 270, label: 'FLAT_JUNK',    priceChange: 0,  blocked: false, memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
    ];
    const generalRows = [
      ...makeRows({ prefix: 'gen-w', count: 1000, label: 'BIG_WINNER', priceChange: 10, blocked: true, memoryUniverse: 'DEX_WATCH_GENERAL' }),
    ];
    writeMemory([...policyRows, ...generalRows]);
    const s = runRipperLearningSummary({ memoryPath });
    // Policy evidence universe is intact
    expect(s.policyEvidenceRows).toBe(600);
    expect(s.policyLiqOrAgeBlocked.observedRows).toBe(300);
    expect(s.policyLiqOrAgeBlocked.winnerRatePct).toBeCloseTo(3, 5);
    // Recommendation is based on policy only — passes thresholds
    expect(s.recommendation).toBe('PROMOTE_TO_PAPER_ONLY_TEST_REVIEW');
  });

  it('PAPER_POLICY_TEST_APPROVED rows go to generalMarket, not policy evidence', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'FLAT_JUNK',    wouldRejectByLiqOrAge: true,  memoryUniverse: 'PAPER_POLICY_TEST_APPROVED' }),
      row({ contract: 'b', outcomeLabel: 'SMALL_WINNER', wouldRejectByLiqOrAge: false, memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    expect(s.policyEvidenceRows).toBe(1);
    expect(s.generalMarketRows).toBe(1);
    expect(s.policyLiqOrAgeBlocked.observedRows).toBe(0);  // only enrolled blocked
    expect(s.policyControl.observedRows).toBe(1);          // the enrolled non-blocked row
  });
});

describe('renderRipperLearningSummary — universe sections', () => {
  it('renders POLICY EVIDENCE UNIVERSE section', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'FLAT_JUNK', wouldRejectByLiqOrAge: true, memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    const text = renderRipperLearningSummary(s);
    expect(text).toContain('POLICY EVIDENCE UNIVERSE');
    expect(text).toContain('SHADOW_ENROLLED_APPROVED');
  });

  it('renders GENERAL MARKET MEMORY section', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'FLAT_JUNK', wouldRejectByLiqOrAge: true, memoryUniverse: 'DEX_WATCH_GENERAL' }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    const text = renderRipperLearningSummary(s);
    expect(text).toContain('GENERAL MARKET MEMORY');
    expect(text).toContain('DEX_WATCH_GENERAL');
  });

  it('recommendation section notes it is based on policy evidence only', () => {
    writeMemory([
      row({ contract: 'a', outcomeLabel: 'UNKNOWN', wouldRejectByLiqOrAge: false, priceChangePct: null }),
    ]);
    const s = runRipperLearningSummary({ memoryPath });
    const text = renderRipperLearningSummary(s);
    expect(text).toContain('POLICY EVIDENCE UNIVERSE');
    expect(text).toContain('SHADOW_ENROLLED_APPROVED rows');
  });
});
