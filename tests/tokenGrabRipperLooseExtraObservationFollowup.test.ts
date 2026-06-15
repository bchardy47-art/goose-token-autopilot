import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperLooseExtraObservationFollowup,
  renderRipperLooseExtraObservationFollowup,
  type FollowupRow,
} from '../src/token-grab/ripperLooseExtraObservationFollowup';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rleof-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const T0   = '2025-01-01T00:00:00.000Z';
const T0MS = Date.parse(T0);
function at(ms: number): string { return new Date(T0MS + ms).toISOString(); }

const CP5M   = at(5  * 60_000);
const CP15M  = at(15 * 60_000);
const CP30M  = at(30 * 60_000);
const CP60M  = at(60 * 60_000);
const CP120M = at(120 * 60_000);

function makeCandidate(contract: string, opts: {
  symbol?:          string | null;
  score?:           number | null;
  clusterRisk?:     string;
  launchAgeBucket?: string | null;
  entryDecision?:   string | null;
  firstSeenAt?:     string;
} = {}): object {
  const firstSeenAt = opts.firstSeenAt ?? T0;
  const base = Date.parse(firstSeenAt);
  return {
    symbol:          opts.symbol          ?? null,
    contract,
    contractShort:   contract.slice(0, 14) + '…',
    score:           opts.score           ?? 70,
    launchAgeBucket: opts.launchAgeBucket ?? 'PRIME_WINDOW',
    entryDecision:   opts.entryDecision   ?? 'WATCH',
    clusterRisk:     opts.clusterRisk     ?? 'CLEAN',
    firstSeenAt,
    policyName:      'LOOSE_60_WATCH',
    status:          'PLANNED_OBSERVATION_ONLY',
    checkpoints: [
      { label: '+5m',   targetAt: new Date(base + 5   * 60_000).toISOString() },
      { label: '+15m',  targetAt: new Date(base + 15  * 60_000).toISOString() },
      { label: '+30m',  targetAt: new Date(base + 30  * 60_000).toISOString() },
      { label: '+60m',  targetAt: new Date(base + 60  * 60_000).toISOString() },
      { label: '+120m', targetAt: new Date(base + 120 * 60_000).toISOString() },
    ],
  };
}

function writePlan(candidates: object[], name = 'plan.json'): string {
  const plan = {
    generatedAt:       T0,
    policyName:        'LOOSE_60_WATCH',
    totalExtras:       candidates.length,
    candidates,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(plan));
  return p;
}

function makeObsRow(opts: {
  contract?:     string;
  capturedAt?:   string;
  priceChangePct?: number | null;
  useRaw?:       boolean;
}): object {
  const contract   = opts.contract   ?? 'CONTRACTA';
  const capturedAt = opts.capturedAt ?? at(6 * 60_000);
  const pct        = opts.priceChangePct;
  const ns: Record<string, unknown>  = { contract };
  const raw: Record<string, unknown> = {};
  if (typeof pct === 'number') {
    if (opts.useRaw) raw['priceChangePct'] = pct;
    else ns['priceChangePct'] = pct;
  }
  return { id: `obs-test`, capturedAt, source: 'test', sourceKind: 'test', normalizedSignal: ns, raw };
}

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function outPath(name = 'followup.jsonl'): string {
  return path.join(tmpDir, name);
}

function readRows(p: string): FollowupRow[] {
  const content = fs.readFileSync(p, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(l => JSON.parse(l) as FollowupRow);
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', () => {
    const plan = writePlan([]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });

  it('summary has all required safety fields', () => {
    const plan = writePlan([]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.summary.reportOnly).toBe(true);
    expect(r.summary.readOnly).toBe(true);
    expect(r.summary.tradingExecuted).toBe(0);
    expect(r.summary.realTradingLocked).toBe(true);
    expect(r.summary.paperOnly).toBe(true);
  });

  it('safety fields are never absent even with missing plan', () => {
    const r = runRipperLooseExtraObservationFollowup({
      planPath: '/no/such/plan.json', observationPaths: [], outPath: outPath(),
    });
    expect(r.reportOnly).toBe(true);
    expect(r.summary.reportOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });
});

// ── Empty / missing inputs ────────────────────────────────────────────────────

describe('empty / missing inputs', () => {
  it('writes empty JSONL for empty plan', () => {
    const plan = writePlan([]);
    const op   = outPath();
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: op,
    });
    expect(r.rowsWritten).toBe(0);
    expect(fs.existsSync(op)).toBe(true);
    expect(readRows(op)).toHaveLength(0);
  });

  it('handles missing plan file gracefully (zero rows)', () => {
    const r = runRipperLooseExtraObservationFollowup({
      planPath: '/no/such/plan.json', observationPaths: [], outPath: outPath(),
    });
    expect(r.rowsWritten).toBe(0);
    expect(r.summary.candidatesInPlan).toBe(0);
  });

  it('skips missing observation files gracefully', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: ['/no/such/obs.jsonl'], outPath: outPath(),
    });
    expect(r.rowsWritten).toBe(5); // 5 checkpoints, all MISSING_OBSERVATION
    const rows = readRows(outPath());
    expect(rows.every(row => row.status === 'MISSING_OBSERVATION')).toBe(true);
  });
});

// ── Observation matching — OBSERVED ───────────────────────────────────────────

describe('observation matching — OBSERVED', () => {
  it('marks OBSERVED when observation capturedAt equals targetAt exactly', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 2.5 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const rows = readRows(op);
    const row5 = rows.find(r => r.checkpointLabel === '+5m');
    expect(row5?.status).toBe('OBSERVED');
    expect(row5?.observedAt).toBe(CP5M);
  });

  it('marks OBSERVED when observation capturedAt is after targetAt', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const afterTarget = at(6 * 60_000); // 1 min after +5m
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: afterTarget, priceChangePct: 3.0 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const rows = readRows(op);
    const row5 = rows.find(r => r.checkpointLabel === '+5m');
    expect(row5?.status).toBe('OBSERVED');
  });

  it('uses the earliest qualifying observation per checkpoint', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const early = at(6  * 60_000);  // after +5m
    const later = at(10 * 60_000);  // also after +5m
    const obs = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: later, priceChangePct: 99 }),
      makeObsRow({ contract: 'AAAA', capturedAt: early, priceChangePct: 1  }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const rows = readRows(op);
    const row5 = rows.find(r => r.checkpointLabel === '+5m');
    expect(row5?.observedAt).toBe(early);
    expect(row5?.priceChangePct).toBe(1);
  });

  it('records observedAt and priceChangePct on OBSERVED rows', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obsAt = at(7 * 60_000);
    const obs   = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: obsAt, priceChangePct: 5.5 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const row = readRows(op).find(r => r.checkpointLabel === '+5m')!;
    expect(row.observedAt).toBe(obsAt);
    expect(row.priceChangePct).toBe(5.5);
  });
});

// ── Observation matching — MISSING_OBSERVATION ────────────────────────────────

describe('observation matching — MISSING_OBSERVATION', () => {
  it('marks MISSING_OBSERVATION when no obs at or after targetAt', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    // observation before the +5m checkpoint
    const obs = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: at(4 * 60_000), priceChangePct: 10 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const rows = readRows(op);
    expect(rows.every(r => r.status === 'MISSING_OBSERVATION')).toBe(true);
  });

  it('marks MISSING_OBSERVATION for different contract', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'BBBB', capturedAt: CP5M, priceChangePct: 8 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const rows = readRows(op);
    expect(rows.every(r => r.status === 'MISSING_OBSERVATION')).toBe(true);
  });
});

// ── priceChangePct extraction ─────────────────────────────────────────────────

describe('priceChangePct extraction', () => {
  it('reads priceChangePct from normalizedSignal', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 7.2 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const row = readRows(op).find(r => r.checkpointLabel === '+5m')!;
    expect(row.priceChangePct).toBe(7.2);
  });

  it('falls back to raw.priceChangePct when normalizedSignal lacks it', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: -4.1, useRaw: true }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const row = readRows(op).find(r => r.checkpointLabel === '+5m')!;
    expect(row.priceChangePct).toBe(-4.1);
  });

  it('priceChangePct is null when absent in both normalizedSignal and raw', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      { id: 'x', capturedAt: CP5M, source: 'test', sourceKind: 'test',
        normalizedSignal: { contract: 'AAAA' }, raw: {} },
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const row = readRows(op).find(r => r.checkpointLabel === '+5m')!;
    expect(row.status).toBe('OBSERVED');
    expect(row.priceChangePct ?? null).toBeNull();
  });
});

// ── Coverage calculation ──────────────────────────────────────────────────────

describe('coverage calculation', () => {
  it('0% coverage when no observations match', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.summary.coveragePct).toBe(0);
  });

  it('100% coverage when all checkpoints have observations', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct: 1 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct: 2 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct: 3 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct: 4 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP120M, priceChangePct: 5 }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    expect(r.summary.coveragePct).toBe(100);
    expect(r.summary.checkpointsObserved).toBe(5);
    expect(r.summary.checkpointsMissing).toBe(0);
  });

  it('partial coverage reflects checkpoints planned vs observed', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    // only +5m and +15m will be covered; rest MISSING
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,  priceChangePct: 2 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M, priceChangePct: 3 }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    // 2 out of 5 = 40%
    expect(r.summary.coveragePct).toBe(40);
    expect(r.summary.checkpointsPlanned).toBe(5);
    expect(r.summary.checkpointsObserved).toBe(2);
    expect(r.summary.checkpointsMissing).toBe(3);
  });
});

// ── Decision thresholds ───────────────────────────────────────────────────────

describe('decision thresholds', () => {
  it('INSUFFICIENT_COVERAGE when coverage < 70%', () => {
    const plan = writePlan([makeCandidate('AAAA'), makeCandidate('BBBB')]);
    // 0 observations → 0% coverage
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.summary.decision).toBe('INSUFFICIENT_COVERAGE');
  });

  it('HOLD_CURRENT_GATES when dump rate > 30% even with coverage >= 70%', () => {
    // 1 candidate, 5 checkpoints → need at least 4 observed for 80% coverage
    // Make 4 observed — 3 are dumps, 1 is neutral → dump rate 75%
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct: -5  }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct: -4  }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct: -3  }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct:  1  }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    expect(r.summary.coveragePct).toBeGreaterThanOrEqual(70);
    expect(r.summary.decision).toBe('HOLD_CURRENT_GATES');
  });

  it('HOLD_CURRENT_GATES when no +5% movers even with coverage >= 70%', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct: 1 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct: 2 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct: 3 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct: 4 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP120M, priceChangePct: 4.9 }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    expect(r.summary.coveragePct).toBe(100);
    expect(r.summary.observedMovedPlus5).toBe(0);
    expect(r.summary.decision).toBe('HOLD_CURRENT_GATES');
  });

  it('LOOSE_EXTRA_SHADOW_PROMISING when coverage >= 70%, has +5% movers, acceptable dump rate', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct: 10  }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct: 8   }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct: 6   }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct: 5   }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP120M, priceChangePct: 7   }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    expect(r.summary.coveragePct).toBe(100);
    expect(r.summary.observedMovedPlus5).toBeGreaterThan(0);
    expect(r.summary.decision).toBe('LOOSE_EXTRA_SHADOW_PROMISING');
  });
});

// ── Move counts ───────────────────────────────────────────────────────────────

describe('move counts', () => {
  it('counts observedMovedPlus1, Plus3, Plus5 and observedDumpedMinus3 correctly', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct:  6   }),  // +5
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct:  3   }),  // +3
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct:  1   }),  // +1
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct: -3   }),  // dump
      makeObsRow({ contract: 'AAAA', capturedAt: CP120M, priceChangePct:  0.5 }),  // none
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    expect(r.summary.observedMovedPlus1).toBe(3);
    expect(r.summary.observedMovedPlus3).toBe(2);
    expect(r.summary.observedMovedPlus5).toBe(1);
    expect(r.summary.observedDumpedMinus3).toBe(1);
  });
});

// ── Top winners / dump risks ──────────────────────────────────────────────────

describe('top winners and dump risks', () => {
  it('top15Winners are sorted descending by priceChangePct', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct: 3 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct: 7 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct: 1 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct: 9 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP120M, priceChangePct: 5 }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    const pcts = r.summary.top15Winners.map(w => w.priceChangePct as number);
    expect(pcts[0]).toBe(9);
    expect(pcts[pcts.length - 1]).toBeLessThanOrEqual(pcts[0]);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeLessThanOrEqual(pcts[i - 1]);
    }
  });

  it('top15DumpRisks are sorted ascending by priceChangePct', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M,   priceChangePct: -5 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP15M,  priceChangePct: -2 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP30M,  priceChangePct: -8 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP60M,  priceChangePct:  1 }),
      makeObsRow({ contract: 'AAAA', capturedAt: CP120M, priceChangePct: -1 }),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    const pcts = r.summary.top15DumpRisks.map(w => w.priceChangePct as number);
    expect(pcts[0]).toBe(-8);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
  });

  it('top15Winners capped at 15 entries', () => {
    // Create 3 candidates × 5 checkpoints = 15 rows (edge of cap)
    const plan = writePlan([
      makeCandidate('A1'), makeCandidate('A2'), makeCandidate('A3'),
    ]);
    const obsRows: object[] = [];
    for (const contract of ['A1', 'A2', 'A3']) {
      for (const cap of [CP5M, CP15M, CP30M, CP60M, CP120M]) {
        obsRows.push(makeObsRow({ contract, capturedAt: cap, priceChangePct: Math.random() * 10 }));
      }
    }
    const obs = writeJsonl('obs.jsonl', obsRows);
    const r   = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: outPath(),
    });
    expect(r.summary.top15Winners.length).toBeLessThanOrEqual(15);
    expect(r.summary.top15DumpRisks.length).toBeLessThanOrEqual(15);
  });
});

// ── JSONL output ──────────────────────────────────────────────────────────────

describe('JSONL output', () => {
  it('creates output file at outPath', () => {
    const plan = writePlan([]);
    const op   = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [], outPath: op });
    expect(fs.existsSync(op)).toBe(true);
  });

  it('each line is valid JSON', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 2 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const lines = fs.readFileSync(op, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rowsWritten equals candidates × checkpoints', () => {
    const plan = writePlan([makeCandidate('AAAA'), makeCandidate('BBBB')]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.rowsWritten).toBe(10); // 2 candidates × 5 checkpoints
  });

  it('OBSERVED rows include all identity fields from candidate', () => {
    const plan = writePlan([makeCandidate('AAAA', { symbol: 'TOK', score: 72, clusterRisk: 'WATCH' })]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 3 }),
    ]);
    const op  = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const row = readRows(op).find(r => r.checkpointLabel === '+5m' && r.status === 'OBSERVED')!;
    expect(row.symbol).toBe('TOK');
    expect(row.contract).toBe('AAAA');
    expect(row.score).toBe(72);
    expect(row.clusterRisk).toBe('WATCH');
    expect(row.policyName).toBe('LOOSE_60_WATCH');
    expect(row.targetAt).toBe(CP5M);
  });

  it('creates parent directory if missing', () => {
    const plan   = writePlan([]);
    const nested = path.join(tmpDir, 'nested', 'dir', 'followup.jsonl');
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [], outPath: nested });
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ── Multiple candidates ───────────────────────────────────────────────────────

describe('multiple candidates', () => {
  it('matches observations independently per contract', () => {
    const plan = writePlan([makeCandidate('AAAA'), makeCandidate('BBBB')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 5 }),
      // BBBB has no observation
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({ planPath: plan, observationPaths: [obs], outPath: op });
    const rows = readRows(op);
    const aaa5 = rows.find(r => r.contract === 'AAAA' && r.checkpointLabel === '+5m')!;
    const bbb5 = rows.find(r => r.contract === 'BBBB' && r.checkpointLabel === '+5m')!;
    expect(aaa5.status).toBe('OBSERVED');
    expect(bbb5.status).toBe('MISSING_OBSERVATION');
  });

  it('candidatesInPlan reflects plan count', () => {
    const plan = writePlan([makeCandidate('AAAA'), makeCandidate('BBBB'), makeCandidate('CCCC')]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.summary.candidatesInPlan).toBe(3);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and report-only header', () => {
    const plan = writePlan([]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    const out = renderRipperLooseExtraObservationFollowup(r);
    expect(out).toContain('LOOSE EXTRA OBSERVATION FOLLOWUP');
    expect(out).toContain('REPORT ONLY');
    expect(out).toContain('NO TRADES');
  });

  it('includes coverage section', () => {
    const plan = writePlan([]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    const out = renderRipperLooseExtraObservationFollowup(r);
    expect(out).toContain('COVERAGE SUMMARY');
    expect(out).toContain('Coverage');
  });

  it('includes move distribution section', () => {
    const plan = writePlan([]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    const out = renderRipperLooseExtraObservationFollowup(r);
    expect(out).toContain('MOVE DISTRIBUTION');
    expect(out).toContain('+1%');
    expect(out).toContain('+5%');
  });

  it('includes decision and safety footer', () => {
    const plan = writePlan([]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    const out = renderRipperLooseExtraObservationFollowup(r);
    expect(out).toContain('DECISION');
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('DO NOT CHANGE APPROVAL GATES');
    expect(out).toContain('DO NOT WIRE INTO RIPPER-AUTOPILOT');
    expect(out).toContain('DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  });

  it('shows the decision string', () => {
    const plan = writePlan([]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    const out = renderRipperLooseExtraObservationFollowup(r);
    expect(out).toContain('INSUFFICIENT_COVERAGE');
  });

  it('shows winners table when observations exist', () => {
    const plan = writePlan([makeCandidate('AAAA', { symbol: 'WINNER' })]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 12 }),
    ]);
    const op = outPath();
    const r  = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: op,
    });
    const out = renderRipperLooseExtraObservationFollowup(r);
    expect(out).toContain('TOP 15 OBSERVED WINNERS');
    expect(out).toContain('WINNER');
  });
});

// ── JSONL forward-enroll plan support ────────────────────────────────────────

function makeEnrollRow(contract: string, opts: {
  symbol?:          string | null;
  score?:           number | null;
  clusterRisk?:     string;
  launchAgeBucket?: string | null;
  entryDecision?:   string | null;
  firstSeenAt?:     string;
}= {}): object {
  const firstSeenAt = opts.firstSeenAt ?? T0;
  const base = Date.parse(firstSeenAt);
  return {
    symbol:          opts.symbol          ?? null,
    contract,
    score:           opts.score           ?? 70,
    launchAgeBucket: opts.launchAgeBucket ?? 'PRIME_WINDOW',
    entryDecision:   opts.entryDecision   ?? 'WATCH',
    clusterRisk:     opts.clusterRisk     ?? 'CLEAN',
    firstSeenAt,
    enrolledAt:      T0,
    policyName:      'LOOSE_60_WATCH',
    status:          'FORWARD_OBSERVATION_ENROLLED',
    checkpoints: [
      { label: '+5m',   targetAt: new Date(base + 5   * 60_000).toISOString() },
      { label: '+15m',  targetAt: new Date(base + 15  * 60_000).toISOString() },
      { label: '+30m',  targetAt: new Date(base + 30  * 60_000).toISOString() },
      { label: '+60m',  targetAt: new Date(base + 60  * 60_000).toISOString() },
      { label: '+120m', targetAt: new Date(base + 120 * 60_000).toISOString() },
    ],
  };
}

function writeEnrollJsonl(name: string, rows: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

describe('JSONL forward-enroll plan', () => {
  it('parses a JSONL enroll file and produces followup rows', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [makeEnrollRow('AAAA')]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [], outPath: outPath(),
    });
    expect(r.rowsWritten).toBe(5); // 1 candidate × 5 checkpoints
    expect(r.summary.candidatesInPlan).toBe(1);
  });

  it('enroll rows produce correct checkpoint labels', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [makeEnrollRow('AAAA')]);
    const op     = outPath();
    runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [], outPath: op,
    });
    const labels = readRows(op).map(r => r.checkpointLabel);
    expect(labels).toEqual(['+5m', '+15m', '+30m', '+60m', '+120m']);
  });

  it('carries identity fields from enroll row into followup rows', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [
      makeEnrollRow('AAAA', { symbol: 'ENRTOK', score: 77, clusterRisk: 'WATCH' }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [], outPath: op,
    });
    const row = readRows(op)[0];
    expect(row.contract).toBe('AAAA');
    expect(row.symbol).toBe('ENRTOK');
    expect(row.score).toBe(77);
    expect(row.clusterRisk).toBe('WATCH');
    expect(row.policyName).toBe('LOOSE_60_WATCH');
  });

  it('JSONL enroll plan finds OBSERVED when matching observation exists', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [makeEnrollRow('AAAA')]);
    const obs    = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 6.5 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [obs], outPath: op,
    });
    const row = readRows(op).find(r => r.checkpointLabel === '+5m')!;
    expect(row.status).toBe('OBSERVED');
    expect(row.priceChangePct).toBe(6.5);
  });

  it('JSONL enroll plan marks MISSING_OBSERVATION when no obs', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [makeEnrollRow('AAAA')]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [], outPath: outPath(),
    });
    expect(r.summary.checkpointsMissing).toBe(5);
  });

  it('handles multiple enroll rows', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [
      makeEnrollRow('AAAA'), makeEnrollRow('BBBB'),
    ]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [], outPath: outPath(),
    });
    expect(r.rowsWritten).toBe(10); // 2 × 5
    expect(r.summary.candidatesInPlan).toBe(2);
  });

  it('safety fields are present when using JSONL plan', () => {
    const enroll = writeEnrollJsonl('enroll.jsonl', [makeEnrollRow('AAAA')]);
    const r = runRipperLooseExtraObservationFollowup({
      planPath: enroll, observationPaths: [], outPath: outPath(),
    });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });
});

// ── JSON plan still works ─────────────────────────────────────────────────────

describe('JSON plan backward compatibility', () => {
  it('existing JSON plan file still parses correctly', () => {
    const plan = writePlan([makeCandidate('AAAA', { symbol: 'JSONTOK', score: 68 })]);
    const r    = runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: outPath(),
    });
    expect(r.rowsWritten).toBe(5);
    expect(r.summary.candidatesInPlan).toBe(1);
  });

  it('JSON plan candidate fields are preserved', () => {
    const plan = writePlan([makeCandidate('AAAA', { symbol: 'JSONTOK', score: 68, clusterRisk: 'WATCH' })]);
    const op   = outPath();
    runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [], outPath: op,
    });
    const row = readRows(op)[0];
    expect(row.symbol).toBe('JSONTOK');
    expect(row.score).toBe(68);
    expect(row.clusterRisk).toBe('WATCH');
  });

  it('JSON plan with observation finds OBSERVED', () => {
    const plan = writePlan([makeCandidate('AAAA')]);
    const obs  = writeJsonl('obs.jsonl', [
      makeObsRow({ contract: 'AAAA', capturedAt: CP5M, priceChangePct: 4.2 }),
    ]);
    const op = outPath();
    runRipperLooseExtraObservationFollowup({
      planPath: plan, observationPaths: [obs], outPath: op,
    });
    expect(readRows(op).find(r => r.checkpointLabel === '+5m')?.status).toBe('OBSERVED');
  });
});

// ── Malformed JSONL plan ──────────────────────────────────────────────────────

describe('malformed JSONL plan', () => {
  it('throws a clear error with line number for malformed JSONL line', () => {
    const p = path.join(tmpDir, 'bad.jsonl');
    // Line 1 valid, line 2 malformed
    fs.writeFileSync(p,
      JSON.stringify(makeEnrollRow('AAAA')) + '\n' +
      'NOT_VALID_JSON\n',
    );
    expect(() =>
      runRipperLooseExtraObservationFollowup({
        planPath: p, observationPaths: [], outPath: outPath(),
      })
    ).toThrow(/line 2/i);
  });

  it('error message identifies the command context', () => {
    const p = path.join(tmpDir, 'bad2.jsonl');
    fs.writeFileSync(p, 'BROKEN\n');
    expect(() =>
      runRipperLooseExtraObservationFollowup({
        planPath: p, observationPaths: [], outPath: outPath(),
      })
    ).toThrow(/ripper-loose-extra-observation-followup/);
  });

  it('single malformed line on line 1 throws with line 1 in message', () => {
    const p = path.join(tmpDir, 'bad3.jsonl');
    fs.writeFileSync(p, '{broken\n');
    expect(() =>
      runRipperLooseExtraObservationFollowup({
        planPath: p, observationPaths: [], outPath: outPath(),
      })
    ).toThrow(/line 1/i);
  });
});
