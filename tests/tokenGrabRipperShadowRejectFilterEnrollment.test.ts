import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runShadowRejectFilterEnrollment,
  renderShadowRejectFilterEnrollment,
  type ShadowRejectEnrollmentRow,
} from '../src/token-grab/ripperShadowRejectFilterEnrollment';

const BASE_ISO = '2026-06-15T18:00:00.000Z';
const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srfe-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function cyclesDir(): string { return path.join(tmpDir, 'cycles'); }
function outPath():   string { return path.join(tmpDir, 'enrollments.jsonl'); }

function makeCyclesDir(): string {
  const d = cyclesDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeCycleFile(
  rows: object[],
  name = 'cycle-2026-06-15-180000.jsonl',
): string {
  const d = makeCyclesDir();
  const p = path.join(d, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function makeApproved(opts: {
  contract?:            string;
  capturedAt?:          string;
  ageMinutes?:          number | null;
  liquidityUsd?:        number | null;
  volumeLiquidityRatio?: number | null;
  symbol?:              string;
} = {}) {
  const contract = opts.contract ?? CONTRACT_A;
  return {
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    ripperScore:     100,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes:      opts.ageMinutes !== undefined ? opts.ageMinutes : 3,
    entryDecision:   'READY_TO_SNIPE_PAPER',
    normalizedSignal: {
      contract,
      symbol:               opts.symbol ?? 'TOK',
      id: 's', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [],
      liquidityUsd:         opts.liquidityUsd !== undefined ? opts.liquidityUsd : 20_000,
      volumeLiquidityRatio: opts.volumeLiquidityRatio !== undefined ? opts.volumeLiquidityRatio : 0.5,
    },
    raw: { clusterRisk: 'CLEAN', clusterNotes: [] },
  };
}

function makeRejected(contract = CONTRACT_B) {
  return {
    capturedAt:      BASE_ISO,
    buyGateDecision: 'BUY_REJECTED',
    ripperScore:     50,
    normalizedSignal: { contract, id: 'r', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [] },
    raw:             { clusterRisk: 'WATCH' },
  };
}

function readEnrollments(): ShadowRejectEnrollmentRow[] {
  const p = outPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as ShadowRejectEnrollmentRow);
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result always has all safety flags set', () => {
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.actualDecisionsChanged).toBe(0);
  });

  it('each enrolled row has all safety fields set', () => {
    writeCycleFile([makeApproved()]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const rows = readEnrollments();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.reportOnly).toBe(true);
    expect(row.readOnly).toBe(true);
    expect(row.tradingExecuted).toBe(0);
    expect(row.realTradingLocked).toBe(true);
    expect(row.paperOnly).toBe(true);
    expect(row.actualDecisionPreserved).toBe(true);
  });
});

// ── Empty / missing cycles dir ────────────────────────────────────────────────

describe('empty cycles dir', () => {
  it('returns zero counts when dir does not exist', () => {
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.cycleFilesRead).toBe(0);
    expect(result.approvedAnalyzed).toBe(0);
    expect(result.enrollmentsAppended).toBe(0);
    expect(result.latestCycleFile).toBeNull();
  });

  it('returns zero counts when dir is empty', () => {
    makeCyclesDir();
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.cycleFilesRead).toBe(0);
    expect(result.approvedAnalyzed).toBe(0);
  });
});

// ── Feed file exclusion ───────────────────────────────────────────────────────

describe('excludes feed files', () => {
  it('ignores *-feed.json files', () => {
    const d = makeCyclesDir();
    fs.writeFileSync(
      path.join(d, 'cycle-2026-06-15-180000-feed.json'),
      JSON.stringify([makeApproved()]),
    );
    writeCycleFile([makeApproved({ contract: CONTRACT_B })]);
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.cycleFilesRead).toBe(1); // only the .jsonl
    expect(result.approvedAnalyzed).toBe(1);
  });
});

// ── Gate filtering ────────────────────────────────────────────────────────────

describe('gate filtering', () => {
  it('only enrolls BUY_APPROVED_PAPER candidates', () => {
    writeCycleFile([
      makeApproved({ contract: CONTRACT_A }),
      makeRejected(CONTRACT_B),
    ]);
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.approvedAnalyzed).toBe(1);
    expect(result.enrollmentsAppended).toBe(1);
    const rows = readEnrollments();
    expect(rows[0]!.contract).toBe(CONTRACT_A);
    expect(rows[0]!.buyGateDecision).toBe('BUY_APPROVED_PAPER');
  });
});

// ── Filter flag: age_gte10m ───────────────────────────────────────────────────

describe('filter flag: age_gte10m', () => {
  it('sets age_gte10m true for ageMinutes >= 10', () => {
    writeCycleFile([makeApproved({ ageMinutes: 15 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.age_gte10m).toBe(true);
  });

  it('sets age_gte10m false for ageMinutes < 10', () => {
    writeCycleFile([makeApproved({ ageMinutes: 3 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.age_gte10m).toBe(false);
  });

  it('sets age_gte10m false for null ageMinutes', () => {
    writeCycleFile([makeApproved({ ageMinutes: null })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.age_gte10m).toBe(false);
  });
});

// ── Filter flag: liq_lt10k ────────────────────────────────────────────────────

describe('filter flag: liq_lt10k', () => {
  it('sets liq_lt10k true for liquidityUsd < 10000', () => {
    writeCycleFile([makeApproved({ liquidityUsd: 5_000 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_lt10k).toBe(true);
  });

  it('sets liq_lt10k false for liquidityUsd >= 10000', () => {
    writeCycleFile([makeApproved({ liquidityUsd: 20_000 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_lt10k).toBe(false);
  });

  it('sets liq_lt10k false for null liquidityUsd', () => {
    writeCycleFile([makeApproved({ liquidityUsd: null })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_lt10k).toBe(false);
  });
});

// ── Filter flag: liq_OR_age ───────────────────────────────────────────────────

describe('filter flag: liq_OR_age', () => {
  it('true when only age matches', () => {
    writeCycleFile([makeApproved({ ageMinutes: 12, liquidityUsd: 20_000 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_OR_age).toBe(true);
    expect(row.wouldRejectByBestCombo).toBe(true);
  });

  it('true when only liq matches', () => {
    writeCycleFile([makeApproved({ ageMinutes: 3, liquidityUsd: 5_000 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_OR_age).toBe(true);
    expect(row.wouldRejectByBestCombo).toBe(true);
  });

  it('false when neither matches', () => {
    writeCycleFile([makeApproved({ ageMinutes: 3, liquidityUsd: 20_000 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_OR_age).toBe(false);
    expect(row.wouldRejectByBestCombo).toBe(false);
  });

  it('true when both match', () => {
    writeCycleFile([makeApproved({ ageMinutes: 15, liquidityUsd: 5_000 })]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readEnrollments()[0]!;
    expect(row.shadowRejectFlags.liq_OR_age).toBe(true);
    expect(row.wouldRejectByBestCombo).toBe(true);
  });
});

// ── actualDecisionPreserved / tradingExecuted ─────────────────────────────────

describe('actualDecisionPreserved', () => {
  it('actualDecisionPreserved is always true on enrolled rows', () => {
    writeCycleFile([
      makeApproved({ ageMinutes: 15 }), // would be shadow-rejected
      makeApproved({ contract: CONTRACT_B, ageMinutes: 3 }), // would not be
    ]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const rows = readEnrollments();
    for (const row of rows) {
      expect(row.actualDecisionPreserved).toBe(true);
      expect(row.buyGateDecision).toBe('BUY_APPROVED_PAPER');
    }
  });

  it('tradingExecuted is always 0', () => {
    writeCycleFile([makeApproved()]);
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const rows = readEnrollments();
    for (const row of rows) {
      expect(row.tradingExecuted).toBe(0);
    }
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('deduplication', () => {
  it('skips duplicate enrollment rows on second run', () => {
    writeCycleFile([makeApproved()]);
    const r1 = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r1.enrollmentsAppended).toBe(1);
    expect(r1.duplicatesSkipped).toBe(0);

    const r2 = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r2.enrollmentsAppended).toBe(0);
    expect(r2.duplicatesSkipped).toBe(1);

    // File should still have exactly 1 row
    expect(readEnrollments().length).toBe(1);
  });

  it('enrolls new candidates from a new cycle file without re-enrolling old ones', () => {
    writeCycleFile([makeApproved({ contract: CONTRACT_A })], 'cycle-2026-06-15-170000.jsonl');
    runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });

    // Add second cycle file with a new contract
    const d = cyclesDir();
    fs.writeFileSync(
      path.join(d, 'cycle-2026-06-15-180000.jsonl'),
      JSON.stringify(makeApproved({ contract: CONTRACT_B })) + '\n',
    );

    const r2 = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r2.enrollmentsAppended).toBe(1);
    expect(r2.duplicatesSkipped).toBe(1);
    expect(readEnrollments().length).toBe(2);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes SHADOW_ONLY — NO DECISION CHANGES', () => {
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const output = renderShadowRejectFilterEnrollment(result);
    expect(output).toContain('SHADOW_ONLY');
    expect(output).toContain('NO DECISION CHANGES');
  });

  it('shows actual decisions changed: 0', () => {
    writeCycleFile([makeApproved({ ageMinutes: 15 })]);
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const output = renderShadowRejectFilterEnrollment(result);
    expect(output).toContain('Actual decisions changed');
    expect(output).toContain(': 0');
  });

  it('includes DO_NOT_ENABLE_REAL_TRADING', () => {
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    const output = renderShadowRejectFilterEnrollment(result);
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('shows shadow reject counts', () => {
    writeCycleFile([
      makeApproved({ contract: CONTRACT_A, ageMinutes: 15, liquidityUsd: 20_000 }),
      makeApproved({ contract: CONTRACT_B, ageMinutes: 3,  liquidityUsd: 5_000  }),
    ]);
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.ageGte10mCount).toBe(1);
    expect(result.liqLt10kCount).toBe(1);
    expect(result.liqOrAgeCount).toBe(2);
    const output = renderShadowRejectFilterEnrollment(result);
    expect(output).toContain('age_gte10m');
    expect(output).toContain('liq_lt10k');
    expect(output).toContain('liq_OR_age');
  });

  it('shows latest cycle file in summary', () => {
    writeCycleFile([makeApproved()], 'cycle-2026-06-15-180000.jsonl');
    const result = runShadowRejectFilterEnrollment({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(result.latestCycleFile).toBe('cycle-2026-06-15-180000.jsonl');
    const output = renderShadowRejectFilterEnrollment(result);
    expect(output).toContain('cycle-2026-06-15-180000.jsonl');
  });
});
