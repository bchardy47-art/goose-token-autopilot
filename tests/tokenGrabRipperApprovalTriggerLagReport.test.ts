import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  runRipperApprovalTriggerLagReport,
  renderRipperApprovalTriggerLagReport,
  type TriggerLagLabel,
} from '../src/token-grab/ripperApprovalTriggerLagReport';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_MS    = 1_750_000_000_000;
const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

const MS = { s: 1_000, m: 60_000 };

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeObs(opts: {
  contract?:        string;
  capturedAt?:      string;
  priceChangePct?:  number | null;
  liquidityUsd?:    number | null;
  volumeUsd?:       number | null;
  symbol?:          string;
  buyGateDecision?: string;
}) {
  return {
    buyGateDecision: opts.buyGateDecision ?? 'WATCH',
    capturedAt:      opts.capturedAt ?? at(0),
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct !== undefined ? opts.priceChangePct : 0.5,
      liquidityUsd:   opts.liquidityUsd  !== undefined ? opts.liquidityUsd   : 40_000,
      volumeUsd:      opts.volumeUsd     !== undefined ? opts.volumeUsd      : 25_000,
      symbol:         opts.symbol,
    },
  };
}

function makeApproval(opts: {
  contract?:       string;
  capturedAt?:     string;
  priceChangePct?: number;
  liquidityUsd?:   number;
}) {
  return {
    buyGateDecision: 'BUY_APPROVED_PAPER',
    capturedAt:      opts.capturedAt ?? at(0),
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? 0.5,
      liquidityUsd:   opts.liquidityUsd  ?? 40_000,
      volumeUsd:      25_000,
    },
  };
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlr-')); });
afterEach(()  => { fs.rmSync(tmpDir, { recursive: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n');
  return p;
}

function run(obsFixtures: object[], approvalFixtures: object[] = []) {
  const op = writeJsonl('o.jsonl', obsFixtures);
  const ap = writeJsonl('a.jsonl', approvalFixtures);
  return runRipperApprovalTriggerLagReport({
    observationPaths: [op],
    approvalPaths:    [ap],
  });
}

function rowFor(result: ReturnType<typeof run>, contract = CONTRACT_A) {
  const row = result.rows.find(r => r.contractKey === contract);
  if (!row) throw new Error(`No row for ${contract}`);
  return row;
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('reportOnly is true',        () => expect(run([]).reportOnly).toBe(true));
  it('readOnly is true',          () => expect(run([]).readOnly).toBe(true));
  it('tradingExecuted is 0',      () => expect(run([]).tradingExecuted).toBe(0));
  it('realTradingLocked is true', () => expect(run([]).realTradingLocked).toBe(true));
  it('paperOnly is true',         () => expect(run([]).paperOnly).toBe(true));
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns 0 rows when no approvals', () => {
    expect(run([]).rows).toHaveLength(0);
  });

  it('obs without BUY_APPROVED_PAPER produce no rows', () => {
    expect(run([makeObs({})]).rows).toHaveLength(0);
  });

  it('summary is all-zero when no approvals', () => {
    const { summary } = run([]);
    expect(summary.totalApproved).toBe(0);
    expect(summary.instantRipCount).toBe(0);
    expect(summary.avgMove1m).toBeNull();
    expect(summary.medianMove1m).toBeNull();
  });
});

// ── Label classification ──────────────────────────────────────────────────────

describe('label classification', () => {
  // approvalPct = 0.5, so move needs to get to >= 1.5 for +1.0 move
  const APPR_PCT = 0.5;

  it('NO_AFTER_DATA when no obs after approval', () => {
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('NO_AFTER_DATA');
  });

  it('INSTANT_RIP when move1m >= 1.0', () => {
    const r = run([
      makeObs({ capturedAt: at(0),          buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
      makeObs({ capturedAt: at(30 * MS.s),  priceChangePct: APPR_PCT + 1.5 }),   // +30s, move = 1.5
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('INSTANT_RIP');
  });

  it('FAST_RIP_5M when move5m >= 1.0 but move1m < 1.0', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
      makeObs({ capturedAt: at(30 * MS.s), priceChangePct: APPR_PCT + 0.5 }),  // +30s, move = 0.5 < 1.0
      makeObs({ capturedAt: at(2 * MS.m),  priceChangePct: APPR_PCT + 1.2 }),  // +2m, move = 1.2 >= 1.0
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('FAST_RIP_5M');
  });

  it('SLOW_RIP_15M when move15m >= 1.0 but move5m < 1.0', () => {
    const r = run([
      makeObs({ capturedAt: at(0),          buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
      makeObs({ capturedAt: at(30 * MS.s),  priceChangePct: APPR_PCT + 0.3 }),   // 1m: move 0.3
      makeObs({ capturedAt: at(3 * MS.m),   priceChangePct: APPR_PCT + 0.7 }),   // 5m: move 0.7 < 1.0
      makeObs({ capturedAt: at(10 * MS.m),  priceChangePct: APPR_PCT + 1.5 }),   // 15m: move 1.5 >= 1.0
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('SLOW_RIP_15M');
  });

  it('LATE_RIP when overall move >= 1.0 but not within 15m', () => {
    const r = run([
      makeObs({ capturedAt: at(0),          buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
      makeObs({ capturedAt: at(30 * MS.s),  priceChangePct: APPR_PCT + 0.1 }),
      makeObs({ capturedAt: at(3 * MS.m),   priceChangePct: APPR_PCT + 0.3 }),
      makeObs({ capturedAt: at(10 * MS.m),  priceChangePct: APPR_PCT + 0.5 }),
      makeObs({ capturedAt: at(30 * MS.m),  priceChangePct: APPR_PCT + 1.5 }),   // >15m, move 1.5
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('LATE_RIP');
  });

  it('NO_RIP_AFTER_APPROVAL when best overall move < 1.0', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
      makeObs({ capturedAt: at(5 * MS.m),  priceChangePct: APPR_PCT + 0.3 }),   // only 0.3 move
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('NO_RIP_AFTER_APPROVAL');
  });

  it('INSTANT_RIP takes priority over FAST_RIP_5M', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: APPR_PCT }),
      makeObs({ capturedAt: at(30 * MS.s), priceChangePct: APPR_PCT + 2.0 }),   // both move1m and move5m >= 1.0
    ]);
    expect(rowFor(r).label).toBe<TriggerLagLabel>('INSTANT_RIP');
  });
});

// ── Move field correctness ────────────────────────────────────────────────────

describe('move field correctness', () => {
  it('move1m = best pct within 1m minus approvalPct', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ capturedAt: at(45 * MS.s), priceChangePct: 1.2 }),  // within 1m
      makeObs({ capturedAt: at(2 * MS.m),  priceChangePct: 2.0 }),  // outside 1m
    ]);
    expect(rowFor(r).move1m).toBeCloseTo(1.2 - 0.5, 5);
  });

  it('move5m = best pct within 5m minus approvalPct', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ capturedAt: at(3 * MS.m),  priceChangePct: 1.8 }),  // within 5m
      makeObs({ capturedAt: at(10 * MS.m), priceChangePct: 3.0 }),  // outside 5m
    ]);
    expect(rowFor(r).move5m).toBeCloseTo(1.8 - 0.5, 5);
  });

  it('move15m = best pct within 15m minus approvalPct', () => {
    const r = run([
      makeObs({ capturedAt: at(0),          buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ capturedAt: at(12 * MS.m),  priceChangePct: 2.5 }),  // within 15m
      makeObs({ capturedAt: at(20 * MS.m),  priceChangePct: 5.0 }),  // outside 15m
    ]);
    expect(rowFor(r).move15m).toBeCloseTo(2.5 - 0.5, 5);
  });

  it('move1m is null when no obs within 1m after approval', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ capturedAt: at(2 * MS.m),  priceChangePct: 2.0 }),   // only obs is at 2m
    ]);
    expect(rowFor(r).move1m).toBeNull();
    expect(rowFor(r).move5m).not.toBeNull();
  });

  it('maxDrawdown = approvalPct - minAfterPct', () => {
    const r = run([
      makeObs({ capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 1.0 }),
      makeObs({ capturedAt: at(1 * MS.m),  priceChangePct: 0.3 }),   // lowest after: drawdown = 1.0 - 0.3
      makeObs({ capturedAt: at(5 * MS.m),  priceChangePct: 0.6 }),
    ]);
    expect(rowFor(r).maxDrawdown).toBeCloseTo(1.0 - 0.3, 5);
  });

  it('maxDrawdown is null when no obs after approval', () => {
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
    ]);
    expect(rowFor(r).maxDrawdown).toBeNull();
  });

  it('approvalPriceChangePct from obs closest to approvedAt', () => {
    // approval at t=0 via file, obs at t=10s (closest) has pct=0.7
    const r = run(
      [
        makeObs({ capturedAt: at(-30 * MS.s), priceChangePct: 0.1 }),   // 30s before
        makeObs({ capturedAt: at(10 * MS.s),  priceChangePct: 0.7 }),   // 10s after — closer
      ],
      [makeApproval({ capturedAt: at(0), priceChangePct: 0.5 })],
    );
    // Closest obs to t=0 is at t=10s (10s away) vs t=-30s (30s away)
    expect(rowFor(r).approvalPriceChangePct).toBeCloseTo(0.7, 5);
  });
});

// ── Dual-source approval detection ───────────────────────────────────────────

describe('dual-source approval detection', () => {
  it('obs-only BUY_APPROVED_PAPER produces a row', () => {
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(rowFor(r).approvalSource).toBe('obs');
  });

  it('file-only BUY_APPROVED_PAPER produces a row', () => {
    const r = run(
      [makeObs({ capturedAt: at(0) })],
      [makeApproval({ capturedAt: at(0) })],
    );
    expect(r.rows).toHaveLength(1);
    expect(rowFor(r).approvalSource).toBe('file');
  });

  it('both sources: approvalSource is "both" and uses earliest timestamp', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0), priceChangePct: 0.5 }),
        makeObs({ capturedAt: at(2 * MS.m), buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.8 }),  // obs at +2m
      ],
      [makeApproval({ capturedAt: at(1 * MS.m) })],   // file at +1m (earlier)
    );
    const row = rowFor(r);
    expect(row.approvalSource).toBe('both');
    expect(row.approvedAt).toBe(at(1 * MS.m));   // earliest
  });

  it('per-contract dedup: same contract approved in multiple cycle files only creates one row', () => {
    const r = run(
      [],
      [
        makeApproval({ contract: CONTRACT_A, capturedAt: at(0) }),
        makeApproval({ contract: CONTRACT_A, capturedAt: at(0) }),  // duplicate
      ],
    );
    expect(r.rows).toHaveLength(1);
  });
});

// ── Multi-contract ────────────────────────────────────────────────────────────

describe('multi-contract', () => {
  it('one row per approved contract', () => {
    const r = run(
      [
        makeObs({ contract: CONTRACT_A, capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
        makeObs({ contract: CONTRACT_B, capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ],
    );
    expect(r.rows).toHaveLength(2);
  });

  it('rows sorted by approvedAt ascending', () => {
    const r = run(
      [
        makeObs({ contract: CONTRACT_B, capturedAt: at(5 * MS.m), buyGateDecision: 'BUY_APPROVED_PAPER' }),
        makeObs({ contract: CONTRACT_A, capturedAt: at(0),        buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ],
    );
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
    expect(r.rows[1].contractKey).toBe(CONTRACT_B);
  });

  it('unapproved contracts do not appear in rows', () => {
    const r = run(
      [
        makeObs({ contract: CONTRACT_A, capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
        makeObs({ contract: CONTRACT_B, capturedAt: at(0) }),   // no approval
      ],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

describe('summary', () => {
  it('label counts sum correctly', () => {
    // CONTRACT_A: INSTANT_RIP
    // CONTRACT_B: NO_AFTER_DATA
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(30 * MS.s), priceChangePct: 2.0 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
    ]);
    const { summary } = r;
    expect(summary.totalApproved).toBe(2);
    expect(summary.instantRipCount).toBe(1);
    expect(summary.noAfterDataCount).toBe(1);
    expect(summary.fastRip5mCount).toBe(0);
  });

  it('avg move1m uses only rows with non-null move1m', () => {
    // CONTRACT_A: move1m = 2.0 - 0.5 = 1.5
    // CONTRACT_B: no obs in 1m → move1m = null (excluded from avg)
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(30 * MS.s), priceChangePct: 2.0 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(3 * MS.m),  priceChangePct: 2.0 }),   // only in 5m window
    ]);
    expect(r.summary.avgMove1m).toBeCloseTo(1.5, 5);   // only CONTRACT_A
    expect(r.summary.avgMove5m).toBeCloseTo(1.5, 5);   // both have 1.5
  });

  it('median move1m of two values is their average', () => {
    // A: move1m = 1.0, B: move1m = 2.0 → median = 1.5
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(30 * MS.s), priceChangePct: 1.5 }),   // move = 1.0
      makeObs({ contract: CONTRACT_B, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(30 * MS.s), priceChangePct: 2.5 }),   // move = 2.0
    ]);
    expect(r.summary.medianMove1m).toBeCloseTo(1.5, 5);
  });

  it('maxDrawdown is the worst drawdown across all rows', () => {
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),        buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 1.0 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(1 * MS.m), priceChangePct: 0.3 }),  // drawdown = 0.7
      makeObs({ contract: CONTRACT_B, capturedAt: at(0),        buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 1.0 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(1 * MS.m), priceChangePct: 0.1 }),  // drawdown = 0.9 (max)
    ]);
    expect(r.summary.maxDrawdown).toBeCloseTo(0.9, 5);
    expect(r.summary.avgDrawdown).toBeCloseTo((0.7 + 0.9) / 2, 5);
  });
});

// ── Cadence recommendation ────────────────────────────────────────────────────

describe('cadence recommendation', () => {
  it('recommends sub-minute when >= 30% INSTANT_RIP', () => {
    // 2 INSTANT_RIP out of 2 total = 100%
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),         buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(30 * MS.s), priceChangePct: 2.0 }),
    ]);
    expect(r.summary.cadenceRecommendation).toContain('Sub-minute');
  });

  it('recommends 1-minute loop when >= 50% instant+fast but <30% instant', () => {
    // A: FAST_RIP_5M, B: FAST_RIP_5M → 0% instant, 100% combined → 1-minute loop
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),        buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(2 * MS.m), priceChangePct: 2.0 }),  // fast 5m
      makeObs({ contract: CONTRACT_B, capturedAt: at(0),        buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(3 * MS.m), priceChangePct: 2.0 }),  // fast 5m
    ]);
    expect(r.summary.cadenceRecommendation).toContain('1-minute loop');
  });

  it('recommends alert/refresh when rips are slow or absent', () => {
    // A: LATE_RIP → 0% instant+fast
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0),          buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.5 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(30 * MS.m),  priceChangePct: 2.0 }),  // late rip
    ]);
    expect(r.summary.cadenceRecommendation).toContain('refresh lane');
  });

  it('returns no-data message when no approved contracts', () => {
    expect(run([]).summary.cadenceRecommendation).toContain('No approved');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('contains REPORT ONLY banner', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('REPORT ONLY');
  });

  it('contains APPROVED CONTRACT ROWS section', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('APPROVED CONTRACT ROWS');
  });

  it('contains SUMMARY section with label counts', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('SUMMARY');
    expect(out).toContain('INSTANT_RIP');
    expect(out).toContain('FAST_RIP_5M');
    expect(out).toContain('SLOW_RIP_15M');
    expect(out).toContain('LATE_RIP');
    expect(out).toContain('NO_RIP_AFTER_APPROVAL');
    expect(out).toContain('NO_AFTER_DATA');
  });

  it('contains LABEL KEY section', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('LABEL KEY');
  });

  it('contains Cadence line in summary', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('Cadence:');
  });

  it('contains safety footer', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('DO NOT ENABLE REAL TRADING');
    expect(out).toContain('DO NOT CALL AUTO-PAPER');
  });

  it('renders symbol in row', () => {
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER', symbol: 'TESTTK' }),
    ]);
    expect(renderRipperApprovalTriggerLagReport(r)).toContain('$TESTTK');
  });

  it('shows no-contracts message when empty', () => {
    const out = renderRipperApprovalTriggerLagReport(run([]));
    expect(out).toContain('no approved contracts found');
  });
});
