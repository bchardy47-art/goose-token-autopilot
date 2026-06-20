import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runRejectedOutcomeTracker,
  renderRejectedOutcomeTracker,
  type RejectedOutcomeTrackerResult,
} from '../src/token-grab/ripperRejectedOutcomeTracker';

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface MemSpec {
  contract?: string; gate?: string; pnl?: number | null; m5?: number | null;
  cluster?: string; liq?: string; vlr?: string; entryDecision?: string;
  blockedByLowLiquidity?: boolean; blockedByAgeGte10m?: boolean; outcomeLabel?: string;
}
function memRow(spec: MemSpec): Record<string, unknown> {
  return {
    contract:              spec.contract ?? 'C1',
    symbol:                'TKN',
    gateDecision:          spec.gate ?? 'BUY_REJECTED',
    entryDecision:         spec.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    priceChangePct:        spec.pnl === undefined ? 0 : spec.pnl,
    entryMomentumPct:      spec.m5 ?? null,
    clusterRisk:           spec.cluster ?? 'UNKNOWN',
    liquidityBucket:       spec.liq ?? 'LIQ_10K_30K',
    vlrBucket:             spec.vlr ?? 'VLR_LT_0_5',
    outcomeLabel:          spec.outcomeLabel ?? 'UNKNOWN',
    blockedByLowLiquidity: spec.blockedByLowLiquidity ?? false,
    blockedByAgeGte10m:    spec.blockedByAgeGte10m ?? false,
  };
}

let root: string;
let memoryPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-test-'));
  memoryPath = path.join(root, 'learning-memory.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function opts(extra: Record<string, unknown> = {}) {
  return { memoryPath, generatedAt: '2026-06-19T21:00:00.000Z', ...extra };
}

describe('Rejected Outcome Tracker v1', () => {
  it('detects rejected winners', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'W1', pnl: 80, m5: 30, outcomeLabel: 'BIG_WINNER' }),
      memRow({ contract: 'W2', pnl: 15, m5: 10, outcomeLabel: 'WINNER' }),
      memRow({ contract: 'L1', pnl: -40, outcomeLabel: 'DUMP' }),
      memRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', pnl: 100 }),  // approved — ignored
    ]);
    const r = runRejectedOutcomeTracker(opts());
    expect(r.totalRejectedRows).toBe(3);
    expect(r.rejectedWinners).toBe(2);
    expect(r.rejectedBigWinners).toBe(1);   // only +80 >= 50
    expect(r.falseRejects).toBe(2);
  });

  it('detects correct rejects', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'L1', pnl: -40, outcomeLabel: 'DUMP' }),
      memRow({ contract: 'L2', pnl: 0, outcomeLabel: 'FLAT_JUNK' }),
      memRow({ contract: 'W1', pnl: 60, outcomeLabel: 'BIG_WINNER' }),
    ]);
    const r = runRejectedOutcomeTracker(opts());
    expect(r.correctRejects).toBe(2);       // -40 and 0 are not winners
    expect(r.rejectedLosers).toBe(1);
  });

  it('groups by reject reason', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'A', blockedByLowLiquidity: true, pnl: -10 }),
      memRow({ contract: 'B', blockedByLowLiquidity: true, pnl: 70 }),
      memRow({ contract: 'C', blockedByAgeGte10m: true, pnl: -5 }),
      memRow({ contract: 'D', entryDecision: 'WATCH', pnl: 5 }),
    ]);
    const r = runRejectedOutcomeTracker(opts());
    const liq = r.byRejectReason.find(g => g.key === 'LOW_LIQUIDITY');
    const age = r.byRejectReason.find(g => g.key === 'AGE_GTE_10M');
    const watch = r.byRejectReason.find(g => g.key === 'WATCH');
    expect(liq?.total).toBe(2);
    expect(liq?.winners).toBe(1);           // +70
    expect(age?.total).toBe(1);
    expect(watch?.total).toBe(1);
  });

  it('groups rejected winners by M5 band', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'N', pnl: 30, m5: 0 }),     // M5_NEUTRAL winner
      memRow({ contract: 'S', pnl: 60, m5: 30 }),    // M5_STRONG winner
      memRow({ contract: 'L', pnl: -10, m5: 0 }),    // not a winner
    ]);
    const r = runRejectedOutcomeTracker(opts());
    const neutral = r.winnersByM5Band.find(g => g.key === 'M5_NEUTRAL');
    const strong  = r.winnersByM5Band.find(g => g.key === 'M5_STRONG');
    expect(neutral?.total).toBe(1);
    expect(strong?.total).toBe(1);
  });

  it('handles old rows with missing optional fields', () => {
    writeJsonl(memoryPath, [
      { gateDecision: 'BUY_REJECTED', priceChangePct: 40 },   // no m5, cluster, buckets
      { gateDecision: 'BUY_REJECTED' },                       // no pnl → no outcome
      { gateDecision: 'BUY_REJECTED', priceChangePct: -10 },
    ]);
    expect(() => runRejectedOutcomeTracker(opts())).not.toThrow();
    const r = runRejectedOutcomeTracker(opts());
    expect(r.totalRejectedRows).toBe(3);
    expect(r.rejectedWithOutcome).toBe(2);
    expect(r.rejectedWinners).toBe(1);
  });

  it('does not mutate the input file', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'W1', pnl: 80 })]);
    const before = fs.readFileSync(memoryPath, 'utf-8');
    runRejectedOutcomeTracker(opts());
    expect(fs.readFileSync(memoryPath, 'utf-8')).toBe(before);
  });

  it('renders the safety footer and sets safety flags', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'W1', pnl: 80 })]);
    const r = runRejectedOutcomeTracker(opts());
    expect(r.noGateChanges).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    const text = renderRejectedOutcomeTracker(r);
    expect(text).toContain('SECTION 8 — SAFETY');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('NO_GATE_CHANGES=true');
  });

  it('always includes STUDY_ONLY_NO_GATE_CHANGE', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'L1', pnl: -10 })]);
    const r = runRejectedOutcomeTracker(opts());
    expect(r.diagnoses).toContain('STUDY_ONLY_NO_GATE_CHANGE');
  });

  it('flags too-strict gates when many rejects win, and incomplete data', () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 60; i++) rows.push(memRow({ contract: `BW${i}`, pnl: 80, m5: 30 }));  // 60 big winners
    for (let i = 0; i < 70; i++) rows.push(memRow({ contract: `NO${i}`, pnl: null }));         // no outcome (majority)
    writeJsonl(memoryPath, rows);
    // 60 with outcome / 130 total = 0.46 < 0.5 → incomplete; 60 big winners → too strict
    const r = runRejectedOutcomeTracker(opts());
    expect(r.diagnoses).toContain('REJECTED_WINNERS_EXIST');
    expect(r.diagnoses).toContain('GATES_MAY_BE_TOO_STRICT');
    expect(r.diagnoses).toContain('REJECT_OUTCOME_DATA_INCOMPLETE');
  });

  it('produces valid JSON output', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'W1', pnl: 80 }), memRow({ contract: 'L1', pnl: -10 })]);
    const r = runRejectedOutcomeTracker(opts());
    const parsed = JSON.parse(JSON.stringify(r)) as RejectedOutcomeTrackerResult;
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.diagnoses.length).toBeGreaterThan(0);
  });

  it('respects custom thresholds', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'A', pnl: 12 }),
      memRow({ contract: 'B', pnl: 8 }),
    ]);
    // win threshold 10 → only +12 is a winner
    const r1 = runRejectedOutcomeTracker(opts({ winPct: 10 }));
    expect(r1.rejectedWinners).toBe(1);
    // win threshold 5 → both winners
    const r2 = runRejectedOutcomeTracker(opts({ winPct: 5 }));
    expect(r2.rejectedWinners).toBe(2);
  });
});
