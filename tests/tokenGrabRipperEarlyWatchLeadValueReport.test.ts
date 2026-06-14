import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  runRipperEarlyWatchLeadValueReport,
  renderRipperEarlyWatchLeadValueReport,
  type LeadValueLabel,
} from '../src/token-grab/ripperEarlyWatchLeadValueReport';

// ── Fixture constants ─────────────────────────────────────────────────────────

const BASE_MS   = 1_750_000_000_000;
const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

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
      priceChangePct: opts.priceChangePct !== undefined ? opts.priceChangePct : 0.1,
      liquidityUsd:   opts.liquidityUsd  !== undefined ? opts.liquidityUsd   : 35_000,
      volumeUsd:      opts.volumeUsd     !== undefined ? opts.volumeUsd      : 25_000,
      symbol:         opts.symbol,
    },
  };
}

function makeApproval(opts: {
  contract?:       string;
  capturedAt?:     string;
  priceChangePct?: number;
}) {
  return {
    buyGateDecision: 'BUY_APPROVED_PAPER',
    capturedAt:      opts.capturedAt ?? at(0),
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? 0.5,
      liquidityUsd:   40_000,
      volumeUsd:      25_000,
    },
  };
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewlvr-')); });
afterEach(()  => { fs.rmSync(tmpDir, { recursive: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n');
  return p;
}

// Helper: run with obs + optional approval fixtures
function run(
  obsFixtures:      object[],
  approvalFixtures: object[] = [],
) {
  const op = writeJsonl('o.jsonl', obsFixtures);
  const ap = writeJsonl('a.jsonl', approvalFixtures);
  return runRipperEarlyWatchLeadValueReport({
    observationPaths: [op],
    approvalPaths:    [ap],
  });
}

function rowFor(result: ReturnType<typeof run>, contract = CONTRACT_A) {
  const row = result.rows.find(r => r.contractKey === contract);
  if (!row) throw new Error(`No row found for ${contract}`);
  return row;
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('reportOnly is true', () => {
    expect(run([], []).reportOnly).toBe(true);
  });
  it('readOnly is true', () => {
    expect(run([], []).readOnly).toBe(true);
  });
  it('tradingExecuted is 0', () => {
    expect(run([], []).tradingExecuted).toBe(0);
  });
  it('realTradingLocked is true', () => {
    expect(run([], []).realTradingLocked).toBe(true);
  });
  it('paperOnly is true', () => {
    expect(run([], []).paperOnly).toBe(true);
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns 0 rows when no observations', () => {
    expect(run([], []).rows).toHaveLength(0);
  });

  it('summary is all-zero when no candidates', () => {
    const { summary } = run([], []);
    expect(summary.totalCandidates).toBe(0);
    expect(summary.approvedCount).toBe(0);
    expect(summary.sameObsCount).toBe(0);
    expect(summary.positiveLeadCount).toBe(0);
    expect(summary.usefulPreMoveCount).toBe(0);
    expect(summary.noPreMoveCount).toBe(0);
    expect(summary.avgPreApprovalMovePct).toBeNull();
    expect(summary.medianPreApprovalMovePct).toBeNull();
  });
});

// ── Value labels ──────────────────────────────────────────────────────────────

describe('value labels', () => {
  it('NO_APPROVAL when no approval exists', () => {
    const r = run([makeObs({ capturedAt: at(0) })]);
    expect(rowFor(r).label).toBe<LeadValueLabel>('NO_APPROVAL');
  });

  it('SAME_OBS_APPROVAL when minToApp is 0 (obs and approval at same time)', () => {
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const row = rowFor(r);
    expect(row.label).toBe<LeadValueLabel>('SAME_OBS_APPROVAL');
    expect(row.minToApp).toBeCloseTo(0, 5);
  });

  it('SAME_OBS_APPROVAL when minToApp <= 0.5m via file approval', () => {
    const r = run(
      [makeObs({ capturedAt: at(0) })],
      [makeApproval({ capturedAt: at(20_000) })], // +20s = 0.33m <= 0.5m
    );
    expect(rowFor(r).label).toBe<LeadValueLabel>('SAME_OBS_APPROVAL');
  });

  it('USEFUL_PRE_APPROVAL_MOVE when preApprovalMovePct >= 0.5', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),        priceChangePct: 0.1 }),            // firstWatch
        makeObs({ capturedAt: at(120_000),  priceChangePct: 1.0 }),            // before approval: move = 0.9
      ],
      [makeApproval({ capturedAt: at(180_000), priceChangePct: 1.0 })],
    );
    const row = rowFor(r);
    expect(row.label).toBe<LeadValueLabel>('USEFUL_PRE_APPROVAL_MOVE');
    expect(row.preApprovalMovePct).toBeGreaterThanOrEqual(0.5);
  });

  it('LEAD_TIME_BUT_NO_PRE_MOVE when minToApp > 0.5m but preApprovalMovePct < 0.5', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),        priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(120_000),  priceChangePct: 0.2 }),            // move = 0.1 < 0.5
      ],
      [makeApproval({ capturedAt: at(180_000) })],
    );
    const row = rowFor(r);
    expect(row.label).toBe<LeadValueLabel>('LEAD_TIME_BUT_NO_PRE_MOVE');
    expect(row.minToApp).toBeGreaterThan(0.5);
  });

  it('LEAD_TIME_BUT_NO_PRE_MOVE when no obs between firstWatch and approval', () => {
    // minToApp > 0.5 but no intermediate obs → preApprovalMovePct = null
    const r = run(
      [makeObs({ capturedAt: at(0), priceChangePct: 0.1 })],
      [makeApproval({ capturedAt: at(120_000) })],
    );
    const row = rowFor(r);
    expect(row.label).toBe<LeadValueLabel>('LEAD_TIME_BUT_NO_PRE_MOVE');
    expect(row.bestBeforeApprovalPct).toBeNull();
    expect(row.preApprovalMovePct).toBeNull();
  });
});

// ── Price field correctness ───────────────────────────────────────────────────

describe('price field correctness', () => {
  it('watchPriceChangePct is pct from firstWatchAt obs', () => {
    const r = run([makeObs({ capturedAt: at(0), priceChangePct: 0.15 })]);
    expect(rowFor(r).watchPriceChangePct).toBeCloseTo(0.15, 5);
  });

  it('bestBeforeApprovalPct is max pct strictly between firstWatch and approval', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),       priceChangePct: 0.1 }),   // firstWatch
        makeObs({ capturedAt: at(60_000),  priceChangePct: 0.4 }),   // before — lower
        makeObs({ capturedAt: at(120_000), priceChangePct: 0.8 }),   // before — higher
        makeObs({ capturedAt: at(240_000), priceChangePct: 2.0 }),   // after approval
      ],
      [makeApproval({ capturedAt: at(180_000), priceChangePct: 0.9 })],
    );
    const row = rowFor(r);
    expect(row.bestBeforeApprovalPct).toBeCloseTo(0.8, 5);
  });

  it('bestBeforeApprovalPct excludes obs at exactly firstWatchAt', () => {
    // Only obs at firstWatchAt — nothing strictly after firstWatch and before approval
    const r = run(
      [makeObs({ capturedAt: at(0), priceChangePct: 0.1 })],
      [makeApproval({ capturedAt: at(120_000) })],
    );
    expect(rowFor(r).bestBeforeApprovalPct).toBeNull();
  });

  it('approvalPriceChangePct is pct from obs closest to approvedAt', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),       priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(100_000), priceChangePct: 0.7 }),   // closest to 90s approval
      ],
      [makeApproval({ capturedAt: at(90_000), priceChangePct: 0.65 })],
    );
    // Closest obs to t=90s is t=100s (10s away) vs t=0 (90s away)
    expect(rowFor(r).approvalPriceChangePct).toBeCloseTo(0.7, 5);
  });

  it('approvalPriceChangePct uses obs fixture pct for same-obs approvals', () => {
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER', priceChangePct: 0.2 }),
    ]);
    expect(rowFor(r).approvalPriceChangePct).toBeCloseTo(0.2, 5);
  });

  it('bestAfterApprovalPct is max pct strictly after approvedAt', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),       priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(120_000), priceChangePct: 0.5 }),  // at/before approval
        makeObs({ capturedAt: at(300_000), priceChangePct: 1.5 }),  // after
        makeObs({ capturedAt: at(600_000), priceChangePct: 3.0 }),  // after, highest
      ],
      [makeApproval({ capturedAt: at(180_000) })],
    );
    expect(rowFor(r).bestAfterApprovalPct).toBeCloseTo(3.0, 5);
  });

  it('bestAfterApprovalPct is null when no obs after approval', () => {
    const r = run(
      [makeObs({ capturedAt: at(0), priceChangePct: 0.1 })],
      [makeApproval({ capturedAt: at(120_000) })],
    );
    expect(rowFor(r).bestAfterApprovalPct).toBeNull();
  });

  it('preApprovalMovePct = bestBeforeApprovalPct - watchPriceChangePct', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),       priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(120_000), priceChangePct: 0.7 }),
      ],
      [makeApproval({ capturedAt: at(180_000) })],
    );
    const row = rowFor(r);
    expect(row.preApprovalMovePct).toBeCloseTo(0.7 - 0.1, 5);
  });

  it('postApprovalMovePct = bestAfterApprovalPct - approvalPriceChangePct', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0),       priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(180_000), priceChangePct: 0.6 }),   // closest to approval
        makeObs({ capturedAt: at(360_000), priceChangePct: 2.5 }),   // after
      ],
      [makeApproval({ capturedAt: at(180_000), priceChangePct: 0.6 })],
    );
    const row = rowFor(r);
    // approvalPriceChangePct = closest obs to 180s = obs at 180s pct 0.6
    // postApprovalMovePct = 2.5 - 0.6 = 1.9
    expect(row.postApprovalMovePct).toBeCloseTo(2.5 - 0.6, 4);
  });

  it('minToApp is null when no approval', () => {
    const r = run([makeObs({ capturedAt: at(0) })]);
    expect(rowFor(r).minToApp).toBeNull();
  });

  it('minToApp computed correctly in minutes', () => {
    const r = run(
      [makeObs({ capturedAt: at(0) })],
      [makeApproval({ capturedAt: at(300_000) })], // +5m
    );
    expect(rowFor(r).minToApp).toBeCloseTo(5.0, 5);
  });
});

// ── Multi-contract ────────────────────────────────────────────────────────────

describe('multi-contract', () => {
  it('produces one row per WATCH_EARLY_RIP contract', () => {
    const r = run([
      makeObs({ contract: CONTRACT_A, capturedAt: at(0) }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(0) }),
    ]);
    expect(r.rows).toHaveLength(2);
  });

  it('rows sorted by firstWatchAt ascending', () => {
    const r = run([
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000) }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(0) }),
    ]);
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
    expect(r.rows[1].contractKey).toBe(CONTRACT_B);
  });
});

// ── Dual-source approval ──────────────────────────────────────────────────────

describe('dual-source approval', () => {
  it('obs-only BUY_APPROVED_PAPER counts as approved', () => {
    const r = run([
      makeObs({ capturedAt: at(0) }),
      makeObs({ capturedAt: at(120_000), buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const row = rowFor(r);
    expect(row.approvalSource).toBe('obs');
    expect(row.label).not.toBe<LeadValueLabel>('NO_APPROVAL');
  });

  it('file-only approval counts as approved', () => {
    const r = run(
      [makeObs({ capturedAt: at(0) })],
      [makeApproval({ capturedAt: at(120_000) })],
    );
    const row = rowFor(r);
    expect(row.approvalSource).toBe('file');
    expect(row.label).not.toBe<LeadValueLabel>('NO_APPROVAL');
  });

  it('both sources uses earliest approvedAt', () => {
    const r = run(
      [
        makeObs({ capturedAt: at(0) }),
        makeObs({ capturedAt: at(180_000), buyGateDecision: 'BUY_APPROVED_PAPER' }), // obs at +3m
      ],
      [makeApproval({ capturedAt: at(120_000) })], // file at +2m (earlier)
    );
    const row = rowFor(r);
    expect(row.approvalSource).toBe('both');
    expect(row.approvedAt).toBe(at(120_000));
    expect(row.minToApp).toBeCloseTo(2.0, 5);
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

describe('summary', () => {
  it('counts all four label types correctly', () => {
    // CONTRACT_A: NO_APPROVAL
    // CONTRACT_B: SAME_OBS_APPROVAL (approved at firstWatch)
    // We need a third contract for other labels — use inline extra contract
    const CONTRACT_C = 'ContractCCCC';
    const r = run(
      [
        makeObs({ contract: CONTRACT_A, capturedAt: at(0) }),
        makeObs({ contract: CONTRACT_B, capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
        makeObs({ contract: CONTRACT_C, capturedAt: at(0), priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
        makeObs({ contract: CONTRACT_C, capturedAt: at(120_000), priceChangePct: 0.8 }),
      ],
      [makeApproval({ contract: CONTRACT_C, capturedAt: at(180_000) })],
    );
    const { summary } = r;
    expect(summary.totalCandidates).toBe(3);
    expect(summary.approvedCount).toBe(2);
    expect(summary.sameObsCount).toBe(1);
    expect(summary.usefulPreMoveCount).toBe(1); // CONTRACT_C: preMove = 0.8 - 0.1 = 0.7 >= 0.5
  });

  it('positiveLeadCount counts rows with minToApp > 0.5', () => {
    const r = run(
      [
        makeObs({ contract: CONTRACT_A, capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }), // same-obs
        makeObs({ contract: CONTRACT_B, capturedAt: at(0) }),
      ],
      [makeApproval({ contract: CONTRACT_B, capturedAt: at(120_000) })],
    );
    expect(r.summary.positiveLeadCount).toBe(1); // only CONTRACT_B has minToApp > 0.5
    expect(r.summary.sameObsCount).toBe(1);
  });

  it('avg/median preApprovalMovePct uses only positive-lead candidates with non-null preMove', () => {
    // CONTRACT_A: 2m lead, preMove = 0.7 - 0.1 = 0.6
    // CONTRACT_B: 4m lead, preMove = 0.5 - 0.1 = 0.4
    const r = run(
      [
        makeObs({ contract: CONTRACT_A, capturedAt: at(0),       priceChangePct: 0.1 }),
        makeObs({ contract: CONTRACT_A, capturedAt: at(60_000),  priceChangePct: 0.7 }),  // before approval
        makeObs({ contract: CONTRACT_B, capturedAt: at(0),       priceChangePct: 0.1 }),
        makeObs({ contract: CONTRACT_B, capturedAt: at(120_000), priceChangePct: 0.5 }),  // before approval
      ],
      [
        makeApproval({ contract: CONTRACT_A, capturedAt: at(120_000) }),
        makeApproval({ contract: CONTRACT_B, capturedAt: at(240_000) }),
      ],
    );
    const { summary } = r;
    expect(summary.positiveLeadCount).toBe(2);
    expect(summary.avgPreApprovalMovePct).toBeCloseTo((0.6 + 0.4) / 2, 4);
    expect(summary.medianPreApprovalMovePct).toBeCloseTo((0.6 + 0.4) / 2, 4); // 2-item median = mean
  });

  it('avg/median are null when no positive-lead candidates with preMove data', () => {
    // one candidate with same-obs approval
    const r = run([
      makeObs({ capturedAt: at(0), buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    expect(r.summary.avgPreApprovalMovePct).toBeNull();
    expect(r.summary.medianPreApprovalMovePct).toBeNull();
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('contains REPORT ONLY banner', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('REPORT ONLY');
  });

  it('contains LEAD VALUE ROWS section', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('LEAD VALUE ROWS');
  });

  it('contains SUMMARY section', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('SUMMARY');
  });

  it('contains LABEL KEY section with all four labels', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('LABEL KEY');
    expect(out).toContain('SAME_OBS_APPROVAL');
    expect(out).toContain('USEFUL_PRE_APPROVAL_MOVE');
    expect(out).toContain('LEAD_TIME_BUT_NO_PRE_MOVE');
    expect(out).toContain('NO_APPROVAL');
  });

  it('contains safety footer with all required flags', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('readOnly=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('paperOnly=true');
  });

  it('contains DO NOT ENABLE REAL TRADING warning', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('contains DO NOT CALL AUTO-PAPER warning', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('DO NOT CALL AUTO-PAPER');
  });

  it('shows no-candidates message when empty', () => {
    const out = renderRipperEarlyWatchLeadValueReport(run([], []));
    expect(out).toContain('no WATCH_EARLY_RIP candidates');
  });

  it('renders symbol and label in row table', () => {
    const r   = run([makeObs({ capturedAt: at(0), symbol: 'TKNX' })]);
    const out = renderRipperEarlyWatchLeadValueReport(r);
    expect(out).toContain('$TKNX');
    expect(out).toContain('NO_APPROVAL');
  });
});
