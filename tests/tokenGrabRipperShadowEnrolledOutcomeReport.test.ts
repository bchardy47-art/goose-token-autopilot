import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runShadowEnrolledOutcomeReport,
  renderShadowEnrolledOutcomeReport,
} from '../src/token-grab/ripperShadowEnrolledOutcomeReport';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

const CA = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CB = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CC = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seor-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function outPath(): string { return path.join(tmpDir, 'report.jsonl'); }

function writeEnrollments(rows: object[], name = 'enrollments.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function writeObs(rows: object[], name = 'obs.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeEnrollment(opts: {
  contract?:             string;
  capturedAt?:           string;
  wouldRejectByBestCombo?: boolean;
  ageGte10m?:            boolean;
  liqLt10k?:             boolean;
  liqOrAge?:             boolean;
  ageMinutes?:           number | null;
  liquidityUsd?:         number | null;
} = {}) {
  const contract   = opts.contract ?? CA;
  const ageGte10m  = opts.ageGte10m  ?? false;
  const liqLt10k   = opts.liqLt10k   ?? false;
  const liqOrAge   = opts.liqOrAge   ?? (ageGte10m || liqLt10k);
  const wouldRejectByBestCombo = opts.wouldRejectByBestCombo ?? liqOrAge;
  return {
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    cycleFile:       'cycle-test.jsonl',
    contract,
    symbol:          'TOK',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    ripperScore:     100,
    ageMinutes:      opts.ageMinutes !== undefined ? opts.ageMinutes : 3,
    liquidityUsd:    opts.liquidityUsd !== undefined ? opts.liquidityUsd : 20_000,
    shadowRejectFlags: { age_gte10m: ageGte10m, liq_lt10k: liqLt10k, liq_OR_age: liqOrAge },
    wouldRejectByBestCombo,
    wouldRejectReason: liqOrAge ? 'test' : null,
    actualDecisionPreserved: true,
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number | null } = {}) {
  return {
    capturedAt: opts.capturedAt ?? at(10_000),
    normalizedSignal: {
      contract:       opts.contract ?? CA,
      priceChangePct: opts.priceChangePct ?? null,
      id: 'o', source: 'test', sourceKind: 'x', discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {},
  };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets all safety flags', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns zero counts with no files', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.enrollmentsRead).toBe(0);
    expect(result.observedEnrollments).toBe(0);
    expect(result.unobservedEnrollments).toBe(0);
    expect(result.bestComboCount).toBe(0);
    expect(result.bestComboObserved).toBe(0);
  });
});

// ── Reads enrollment rows ─────────────────────────────────────────────────────

describe('reads enrollment rows', () => {
  it('counts enrollments read from file', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA }),
      makeEnrollment({ contract: CB }),
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.enrollmentsRead).toBe(2);
  });

  it('deduplicates enrollment rows by contract+capturedAt', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA, capturedAt: BASE_ISO }),
      makeEnrollment({ contract: CA, capturedAt: BASE_ISO }), // duplicate
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.enrollmentsRead).toBe(1);
  });
});

// ── Observation matching ──────────────────────────────────────────────────────

describe('observation matching', () => {
  it('matches observation by contract', () => {
    const enroll = writeEnrollments([makeEnrollment({ contract: CA })]);
    const obs    = writeObs([
      makeObs({ contract: CB, capturedAt: at(5_000), priceChangePct: 10 }), // wrong contract
      makeObs({ contract: CA, capturedAt: at(5_000), priceChangePct: 5  }), // correct
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestComboGroup.win5Count).toBe(0); // wouldRejectByBestCombo=false by default
    expect(result.controlGroup.win5Count).toBe(1);   // CA is in control (no flags set)
  });

  it('ignores observation before enrollment capturedAt', () => {
    const enroll = writeEnrollments([makeEnrollment({ contract: CA, capturedAt: at(10_000) })]);
    const obs    = writeObs([
      makeObs({ contract: CA, capturedAt: at(5_000),  priceChangePct: 10 }), // before enrollment
      makeObs({ contract: CA, capturedAt: at(15_000), priceChangePct: -5 }), // after
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    // Should use obs at 15_000 (priceChangePct=-5 → DUMP), not 5_000 (win)
    expect(result.controlGroup.dumpCount).toBe(1);
    expect(result.controlGroup.win5Count).toBe(0);
  });

  it('uses first observation at or after enrollment capturedAt', () => {
    const enroll = writeEnrollments([makeEnrollment({ contract: CA, capturedAt: at(10_000) })]);
    const obs    = writeObs([
      makeObs({ contract: CA, capturedAt: at(10_000), priceChangePct: 2  }), // exactly at enrollment
      makeObs({ contract: CA, capturedAt: at(20_000), priceChangePct: 10 }), // later — should not be used
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    // priceChangePct=2 → WIN_1PCT (not WIN_5PCT)
    expect(result.controlGroup.win1Count).toBe(1);
    expect(result.controlGroup.win5Count).toBe(0);
  });
});

// ── Outcome classification ────────────────────────────────────────────────────

describe('outcome classification', () => {
  function makeCase(pct: number | null, opts = {}) {
    const enroll = writeEnrollments([makeEnrollment({ contract: CA, ...opts })]);
    const obsList = pct != null
      ? [makeObs({ contract: CA, capturedAt: at(5_000), priceChangePct: pct })]
      : [];
    const obs = writeObs(obsList);
    return runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: pct != null ? [obs] : [], outPath: outPath(), nowMs: BASE_MS,
    });
  }

  it('classifies WIN_5PCT for pct >= 5', () => {
    const r = makeCase(6);
    expect(r.controlGroup.win5Count).toBe(1);
    expect(r.controlGroup.win1Count).toBe(1);
  });

  it('classifies WIN_3PCT for pct >= 3 and < 5', () => {
    const r = makeCase(4);
    expect(r.controlGroup.win3Count).toBe(1);
    expect(r.controlGroup.win5Count).toBe(0);
    expect(r.controlGroup.win1Count).toBe(1);
  });

  it('classifies WIN_1PCT for pct >= 1 and < 3', () => {
    const r = makeCase(1.5);
    expect(r.controlGroup.win1Count).toBe(1);
    expect(r.controlGroup.win3Count).toBe(0);
  });

  it('classifies DUMP for pct <= -3', () => {
    const r = makeCase(-5);
    expect(r.controlGroup.dumpCount).toBe(1);
    expect(r.controlGroup.win1Count).toBe(0);
  });

  it('classifies FLAT_JUNK for pct between -3 and 1', () => {
    const r = makeCase(0.5);
    expect(r.controlGroup.flatJunkCount).toBe(1);
    expect(r.controlGroup.win1Count).toBe(0);
    expect(r.controlGroup.dumpCount).toBe(0);
  });

  it('classifies UNOBSERVED when no matching observation', () => {
    const r = makeCase(null);
    expect(r.unobservedEnrollments).toBe(1);
    expect(r.observedEnrollments).toBe(0);
  });
});

// ── Group segregation ─────────────────────────────────────────────────────────

describe('group stats', () => {
  it('wouldRejectByBestCombo group contains only combo=true rows', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA, ageGte10m: true, liqOrAge: true }),
      makeEnrollment({ contract: CB }),
    ]);
    const obs = writeObs([
      makeObs({ contract: CA, capturedAt: at(5_000), priceChangePct: 0 }),
      makeObs({ contract: CB, capturedAt: at(5_000), priceChangePct: 5 }),
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestComboGroup.enrolledCount).toBe(1);
    expect(result.bestComboGroup.flatJunkCount).toBe(1);
    expect(result.controlGroup.enrolledCount).toBe(1);
    expect(result.controlGroup.win5Count).toBe(1);
  });

  it('control group contains only combo=false rows', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA, wouldRejectByBestCombo: false }),
      makeEnrollment({ contract: CB, wouldRejectByBestCombo: false }),
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.controlGroup.enrolledCount).toBe(2);
    expect(result.bestComboGroup.enrolledCount).toBe(0);
  });

  it('age_gte10m group contains only rows with age_gte10m=true', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA, ageGte10m: true,  liqOrAge: true }),
      makeEnrollment({ contract: CB, ageGte10m: false }),
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.ageGte10mGroup.enrolledCount).toBe(1);
  });

  it('liq_lt10k group contains only rows with liq_lt10k=true', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA, liqLt10k: true, liqOrAge: true }),
      makeEnrollment({ contract: CB, liqLt10k: false }),
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.liqLt10kGroup.enrolledCount).toBe(1);
  });
});

// ── Recommendation logic ──────────────────────────────────────────────────────

describe('recommendation', () => {
  it('WATCH_MORE_DATA when observed < 20', () => {
    const enroll = writeEnrollments([
      makeEnrollment({ contract: CA, ageGte10m: true, liqOrAge: true }),
    ]);
    const obs = writeObs([
      makeObs({ contract: CA, capturedAt: at(5_000), priceChangePct: 0 }),
    ]);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestComboGroup.recommendation).toBe('WATCH_MORE_DATA');
  });

  it('PROMISING_SHADOW_FILTER when observed >= 20, flatJunkRate >= 70%, win1Rate <= 5%', () => {
    const rows: object[] = [];
    const obsList: object[] = [];
    // 20 observed, 16 flat junk (80%), 0 winners
    for (let i = 0; i < 16; i++) {
      const c = `CFJ${i}`.padEnd(44, '0');
      rows.push(makeEnrollment({ contract: c, capturedAt: new Date(BASE_MS + i * 1000).toISOString(), ageGte10m: true, liqOrAge: true }));
      obsList.push(makeObs({ contract: c, capturedAt: new Date(BASE_MS + i * 1000 + 5_000).toISOString(), priceChangePct: 0 }));
    }
    for (let i = 0; i < 4; i++) {
      const c = `CDump${i}`.padEnd(44, '0');
      rows.push(makeEnrollment({ contract: c, capturedAt: new Date(BASE_MS + (i + 16) * 1000).toISOString(), ageGte10m: true, liqOrAge: true }));
      obsList.push(makeObs({ contract: c, capturedAt: new Date(BASE_MS + (i + 16) * 1000 + 5_000).toISOString(), priceChangePct: -5 }));
    }
    const enroll = writeEnrollments(rows);
    const obs    = writeObs(obsList);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestComboGroup.observedCount).toBe(20);
    expect(result.bestComboGroup.win1Count).toBe(0);
    expect(result.bestComboGroup.flatJunkRate).toBeGreaterThanOrEqual(70);
    expect(result.bestComboGroup.recommendation).toBe('PROMISING_SHADOW_FILTER');
  });

  it('TOO_MANY_WINNERS_KILLED when win1Rate > 10%', () => {
    const rows: object[] = [];
    const obsList: object[] = [];
    // 20 observed, 3 winners (~15%), 17 flat junk
    for (let i = 0; i < 3; i++) {
      const c = `CWin${i}`.padEnd(44, '0');
      rows.push(makeEnrollment({ contract: c, capturedAt: new Date(BASE_MS + i * 1000).toISOString(), ageGte10m: true, liqOrAge: true }));
      obsList.push(makeObs({ contract: c, capturedAt: new Date(BASE_MS + i * 1000 + 5_000).toISOString(), priceChangePct: 5 }));
    }
    for (let i = 0; i < 17; i++) {
      const c = `CFlat${i}`.padEnd(44, '0');
      rows.push(makeEnrollment({ contract: c, capturedAt: new Date(BASE_MS + (i + 3) * 1000).toISOString(), ageGte10m: true, liqOrAge: true }));
      obsList.push(makeObs({ contract: c, capturedAt: new Date(BASE_MS + (i + 3) * 1000 + 5_000).toISOString(), priceChangePct: 0 }));
    }
    const enroll = writeEnrollments(rows);
    const obs    = writeObs(obsList);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestComboGroup.recommendation).toBe('TOO_MANY_WINNERS_KILLED');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes Best combo outcome section', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('BEST COMBO OUTCOME');
  });

  it('includes Control group outcome section', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('CONTROL GROUP OUTCOME');
  });

  it('includes HOLD_CURRENT_GATES', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('HOLD_CURRENT_GATES');
  });

  it('includes DO_NOT_ENABLE_REAL_TRADING', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('includes safety fields line', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('shows KEEP_SHADOW_TESTING when no filter is promising', () => {
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.overallDecision).toBe('KEEP_SHADOW_TESTING');
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('KEEP_SHADOW_TESTING');
  });

  it('shows READY_FOR_PAPER_POLICY_TEST when best combo is promising', () => {
    const rows: object[] = [];
    const obsList: object[] = [];
    for (let i = 0; i < 20; i++) {
      const c = `CProm${i}`.padEnd(44, '0');
      rows.push(makeEnrollment({ contract: c, capturedAt: new Date(BASE_MS + i * 1000).toISOString(), ageGte10m: true, liqOrAge: true }));
      obsList.push(makeObs({ contract: c, capturedAt: new Date(BASE_MS + i * 1000 + 5_000).toISOString(), priceChangePct: 0 }));
    }
    const enroll = writeEnrollments(rows);
    const obs    = writeObs(obsList);
    const result = runShadowEnrolledOutcomeReport({
      enrollmentPaths: [enroll], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.overallDecision).toBe('READY_FOR_PAPER_POLICY_TEST');
    const output = renderShadowEnrolledOutcomeReport(result);
    expect(output).toContain('READY_FOR_PAPER_POLICY_TEST');
  });
});
