import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperGateLoosenShadowReport,
  renderRipperGateLoosenShadowReport,
} from '../src/token-grab/ripperGateLoosenShadowReport';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rglsr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeFixture(opts: {
  contract?: string;
  capturedAt?: string;
  pct?: number | null;
  symbol?: string;
  ripperScore?: number;
  entryDecision?: string;
  buyGateDecision?: string;
  launchAgeBucket?: string;
  clusterRisk?: string;
  blockers?: string[];
  warnings?: string[];
}): object {
  const contract = opts.contract ?? 'AAAA';
  const sig: Record<string, unknown> = { contract };
  if (opts.pct != null) sig['priceChangePct'] = opts.pct;
  if (opts.symbol != null) sig['symbol'] = opts.symbol;
  const raw: Record<string, unknown> = {};
  if (opts.clusterRisk != null) raw['clusterRisk'] = opts.clusterRisk;
  return {
    id:                `f-${Math.random()}`,
    capturedAt:        opts.capturedAt ?? '2025-01-01T00:00:00.000Z',
    source:            'test',
    sourceKind:        'test',
    normalizedSignal:  sig,
    ripperInput:       null,
    ripperScore:       opts.ripperScore,
    entryDecision:     opts.entryDecision,
    buyGateDecision:   opts.buyGateDecision ?? 'BUY_REJECTED',
    launchAgeBucket:   opts.launchAgeBucket,
    blockers:          opts.blockers ?? [],
    topReasons:        [],
    warnings:          opts.warnings ?? [],
    raw,
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

const T0 = '2025-01-01T00:00:00.000Z';
const T0MS = Date.parse(T0);
function at(ms: number): string { return new Date(T0MS + ms).toISOString(); }

function loose60(contract: string, capturedAt = T0, extra: Partial<Parameters<typeof makeFixture>[0]> = {}): object {
  return makeFixture({
    contract, capturedAt,
    ripperScore: 65,
    entryDecision: 'WATCH',
    launchAgeBucket: 'PRIME_WINDOW',
    clusterRisk: 'CLEAN',
    ...extra,
  });
}

function agg55(contract: string, capturedAt = T0, extra: Partial<Parameters<typeof makeFixture>[0]> = {}): object {
  return makeFixture({
    contract, capturedAt,
    ripperScore: 57,
    entryDecision: 'WATCH',
    launchAgeBucket: 'LATE',
    clusterRisk: 'CLEAN',
    ...extra,
  });
}

function obs(contract: string, capturedAt: string, pct: number | null): object {
  return makeFixture({ contract, capturedAt, pct });
}

describe('safety fields', () => {
  it('has all required safety fields', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });
});

describe('policy matching basics', () => {
  it('counts BUY_APPROVED_PAPER fixtures for current policy', () => {
    const p = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'BBBB', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'CCCC', buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [p], observationPaths: [] });
    expect(r.current.totalCandidates).toBe(2);
  });

  it('passes loose60 and aggressive55 appropriately', () => {
    const p = writeJsonl('obs.jsonl', [loose60('AAAA'), agg55('BBBB')]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(1);
    expect(r.aggressive55.totalCandidates).toBe(2);
  });
});

describe('later move stats and verdicts', () => {
  it('counts moves and dump risk', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0), obs('AAAA', at(60_000), 4.0),
      loose60('BBBB', T0), obs('BBBB', at(60_000), -4.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.movedPlus3).toBe(1);
    expect(r.loose60.dumpedMinus3).toBe(1);
  });

  it('NO_LATER_DATA when no obs after first seen', () => {
    const p = writeJsonl('obs.jsonl', [loose60('EXTRA', T0)]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.topExtras[0].verdict).toBe('NO_LATER_DATA');
  });
});

describe('extra candidate observation coverage', () => {
  it('reports totals, coverage %, and HOLD_CURRENT_GATES when extra coverage is below threshold', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('A', T0),
      loose60('B', T0), obs('B', at(60_000), 2.0),
      loose60('C', T0),
      loose60('D', T0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    const c = r.loose60.extraObservationCoverage;
    expect(c.totalExtras).toBe(4);
    expect(c.extrasWithLaterObs).toBe(1);
    expect(c.extrasWithoutLaterObs).toBe(3);
    expect(c.percentCovered).toBeCloseTo(25, 5);
    expect(c.decision).toBe('HOLD_CURRENT_GATES');
  });

  it('detects missing reasons for no observation rows, no strictly later obs, and missing later pct', () => {
    const approvals = writeJsonl('approvals.jsonl', [
      loose60('NOOBS', T0),
      loose60('SAMETIME', T0),
      loose60('NOPCT', T0),
    ]);
    const obsFile = writeJsonl('obs.jsonl', [
      obs('SAMETIME', T0, 0.1),
      obs('NOPCT', at(60_000), null),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [approvals], observationPaths: [obsFile] });
    const c = r.loose60.extraObservationCoverage;
    expect(c.missingReasonCounts.NO_OBSERVATION_ROWS).toBe(1);
    expect(c.missingReasonCounts.NO_STRICTLY_LATER_OBSERVATIONS).toBe(1);
    expect(c.missingReasonCounts.LATER_OBSERVATIONS_WITHOUT_PRICE_CHANGE).toBe(1);
  });

  it('tracks oldest/newest extra timestamps when available', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('OLD', at(0)),
      loose60('NEW', at(120_000)),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    const c = r.loose60.extraObservationCoverage;
    expect(c.oldestExtraCandidateAt).toBe(at(0));
    expect(c.newestExtraCandidateAt).toBe(at(120_000));
  });

  it('decision is CURRENT_BASELINE_ONLY for current policy', () => {
    const approvals = writeJsonl('approvals.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: T0 }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [approvals], observationPaths: [] });
    expect(r.current.extraObservationCoverage.decision).toBe('CURRENT_BASELINE_ONLY');
  });
});

describe('extra observation tracker', () => {
  it('builds DRY-RUN tracker rows for extras missing later observations', () => {
    const approvals = writeJsonl('approvals.jsonl', [makeFixture({ contract: 'CUR', buyGateDecision: 'BUY_APPROVED_PAPER' })]);
    const obsFile = writeJsonl('obs.jsonl', [
      loose60('MISS1', T0, { symbol: 'MISS1', ripperScore: 66 }),
      agg55('MISS2', at(60_000), { symbol: 'MISS2', ripperScore: 58 }),
      obs('MISS2', at(60_000), 0.1),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [approvals], observationPaths: [obsFile] });
    expect(r.extraObservationTracker.totalMissingExtrasShown).toBe(2);
    expect(r.extraObservationTracker.totalMissingExtrasLoose60).toBe(2);
    expect(r.extraObservationTracker.dryRunEnrollmentShownCount).toBe(2);
    expect(r.extraObservationTracker.displayLimit).toBe(15);
    expect(r.extraObservationTracker.decision).toBe('OBSERVATION_COVERAGE_REQUIRED');
    expect(r.extraObservationTracker.rows[0].suggestedCadenceMins).toEqual([5, 15, 30, 60, 120]);
  });
});

describe('renderer', () => {
  it('includes EXTRA CANDIDATE OBSERVATION COVERAGE and DECISION sections', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('A', T0),
      loose60('B', T0), obs('B', at(60_000), 2.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('EXTRA CANDIDATE OBSERVATION COVERAGE');
    expect(out).toContain('DECISION');
    expect(out).toContain('HOLD_CURRENT_GATES');
    expect(out).toContain('No threshold decision can be made from NO_LATER_DATA extras.');
  });

  it('includes extra observation tracker dry-run section with shown/of clarity', () => {
    const approvals = writeJsonl('approvals.jsonl', [makeFixture({ contract: 'CUR', buyGateDecision: 'BUY_APPROVED_PAPER' })]);
    const obsRows: object[] = [];
    for (let i = 0; i < 20; i++) obsRows.push(loose60(`MISS${i}`, at(i * 60_000), { symbol: `M${i}` }));
    const obsFile = writeJsonl('obs.jsonl', obsRows);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [approvals], observationPaths: [obsFile] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('EXTRA OBSERVATION TRACKER (DRY RUN ONLY)');
    expect(out).toContain('Missing loosen-shadow extras shown : 15 of 20');
    expect(out).toContain('Dry-run enroll shown              : 15 of 20');
    expect(out).toContain('Display limit                     : 15');
    expect(out).toContain('OBSERVATION_COVERAGE_REQUIRED');
    expect(out).toContain('HOLD_CURRENT_GATES');
  });

  it('includes missing later observation reasons when present', () => {
    const approvals = writeJsonl('approvals.jsonl', [loose60('NOOBS', T0)]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [approvals], observationPaths: [] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('no observation rows for contract');
  });

  it('retains safety footer', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('DO NOT CHANGE APPROVAL THRESHOLDS');
    expect(out).toContain('tradingExecuted=0');
  });
});
