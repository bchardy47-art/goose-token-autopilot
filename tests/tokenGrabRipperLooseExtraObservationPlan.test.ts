import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperLooseExtraObservationPlan,
  renderRipperLooseExtraObservationPlan,
  type LooseExtraObservationPlan,
} from '../src/token-grab/ripperLooseExtraObservationPlan';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rleop-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function outPath(name = 'plan.json'): string {
  return path.join(tmpDir, name);
}

function readPlan(p: string): LooseExtraObservationPlan {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as LooseExtraObservationPlan;
}

function makeFixture(opts: {
  contract?:        string;
  capturedAt?:      string;
  symbol?:          string;
  ripperScore?:     number;
  entryDecision?:   string;
  buyGateDecision?: string;
  launchAgeBucket?: string;
  clusterRisk?:     string;
  blockers?:        string[];
  warnings?:        string[];
}): object {
  const contract = opts.contract ?? 'AAAA';
  const sig: Record<string, unknown> = { contract };
  if (opts.symbol != null) sig['symbol'] = opts.symbol;
  const raw: Record<string, unknown> = {};
  if (opts.clusterRisk != null) raw['clusterRisk'] = opts.clusterRisk;
  return {
    id:               `f-${Math.random()}`,
    capturedAt:       opts.capturedAt      ?? '2025-01-01T00:00:00.000Z',
    source:           'test',
    sourceKind:       'test',
    normalizedSignal: sig,
    ripperInput:      null,
    ripperScore:      opts.ripperScore,
    entryDecision:    opts.entryDecision,
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_REJECTED',
    launchAgeBucket:  opts.launchAgeBucket,
    blockers:         opts.blockers        ?? [],
    topReasons:       [],
    warnings:         opts.warnings        ?? [],
    raw,
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

const T0   = '2025-01-01T00:00:00.000Z';
const T0MS = Date.parse(T0);
function at(ms: number): string { return new Date(T0MS + ms).toISOString(); }

function loose60Fixture(contract: string, capturedAt = T0, extra: Partial<Parameters<typeof makeFixture>[0]> = {}): object {
  return makeFixture({
    contract, capturedAt,
    ripperScore:     65,
    entryDecision:   'WATCH',
    launchAgeBucket: 'PRIME_WINDOW',
    clusterRisk:     'CLEAN',
    ...extra,
  });
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', () => {
    const r = runRipperLooseExtraObservationPlan({
      approvalPaths: [], observationPaths: [], outPath: outPath(),
    });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });

  it('plan JSON has safety fields', () => {
    const out = outPath();
    runRipperLooseExtraObservationPlan({
      approvalPaths: [], observationPaths: [], outPath: out,
    });
    const plan = readPlan(out);
    expect(plan.reportOnly).toBe(true);
    expect(plan.readOnly).toBe(true);
    expect(plan.tradingExecuted).toBe(0);
    expect(plan.realTradingLocked).toBe(true);
    expect(plan.paperOnly).toBe(true);
  });
});

// ── Empty / missing ───────────────────────────────────────────────────────────

describe('empty / missing inputs', () => {
  it('writes plan with zero candidates for empty inputs', () => {
    const out = outPath();
    const r = runRipperLooseExtraObservationPlan({
      approvalPaths: [], observationPaths: [], outPath: out,
    });
    expect(r.totalExtras).toBe(0);
    expect(r.written).toBe(true);
    const plan = readPlan(out);
    expect(plan.candidates).toHaveLength(0);
  });

  it('skips missing input files gracefully', () => {
    const out = outPath();
    const r = runRipperLooseExtraObservationPlan({
      approvalPaths:    ['/no/such/cycle.jsonl'],
      observationPaths: ['/no/such/obs.jsonl'],
      outPath:          out,
    });
    expect(r.totalExtras).toBe(0);
  });
});

// ── LOOSE_60_WATCH filter ─────────────────────────────────────────────────────

describe('LOOSE_60_WATCH filter', () => {
  it('includes candidates with score>=60, WATCH entry, PRIME_WINDOW launch, CLEAN cluster', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA')]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(1);
  });

  it('excludes score < 60', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { ripperScore: 59 })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('excludes LATE launchAgeBucket', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { launchAgeBucket: 'LATE' })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('includes TOO_EARLY launchAgeBucket', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { launchAgeBucket: 'TOO_EARLY' })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(1);
  });

  it('excludes non-WATCH/READY_TO_SNIPE_PAPER entryDecision', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { entryDecision: 'SKIP' })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('includes READY_TO_SNIPE_PAPER entryDecision', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { entryDecision: 'READY_TO_SNIPE_PAPER' })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(1);
  });

  it('excludes RISKY cluster risk', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { clusterRisk: 'RISKY' })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('includes WATCH cluster risk', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { clusterRisk: 'WATCH' })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(1);
  });
});

// ── Danger filter ─────────────────────────────────────────────────────────────

describe('danger filter', () => {
  it('excludes honeypot in blockers', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { blockers: ['honeypot detected'] })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('excludes rug in warnings', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { warnings: ['possible rug'] })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('excludes blacklist in blockers', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { blockers: ['on blacklist'] })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('excludes mint authority in warnings', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { warnings: ['mint authority not renounced'] })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });

  it('excludes freeze authority', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0, { warnings: ['freeze authority active'] })]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates).toHaveLength(0);
  });
});

// ── CURRENT_APPROVAL exclusion ────────────────────────────────────────────────

describe('CURRENT_APPROVAL exclusion', () => {
  it('excludes contracts already in CURRENT_APPROVAL', () => {
    const cycles = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      loose60Fixture('AAAA'), // also passes loose60 but is current
      loose60Fixture('BBBB'), // new extra
    ]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({
      approvalPaths:    [cycles],
      observationPaths: [obs],
      outPath:          out,
    });
    const plan = readPlan(out);
    expect(plan.candidates.map(c => c.contract)).not.toContain('AAAA');
    expect(plan.candidates.map(c => c.contract)).toContain('BBBB');
  });

  it('detects BUY_APPROVED_PAPER from obs fixtures too (dual-source)', () => {
    const obs = writeJsonl('obs.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      loose60Fixture('AAAA'), // same contract, also passes loose60 — but should be excluded
      loose60Fixture('BBBB'),
    ]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({
      approvalPaths:    [],
      observationPaths: [obs],
      outPath:          out,
    });
    const plan = readPlan(out);
    expect(plan.candidates.map(c => c.contract)).not.toContain('AAAA');
    expect(plan.candidates.map(c => c.contract)).toContain('BBBB');
  });
});

// ── Checkpoints ───────────────────────────────────────────────────────────────

describe('checkpoints', () => {
  it('each candidate has exactly 5 checkpoints', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0)]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const plan = readPlan(out);
    expect(plan.candidates[0].checkpoints).toHaveLength(5);
  });

  it('checkpoint labels are +5m, +15m, +30m, +60m, +120m', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0)]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const plan = readPlan(out);
    expect(plan.candidates[0].checkpoints.map(c => c.label)).toEqual([
      '+5m', '+15m', '+30m', '+60m', '+120m',
    ]);
  });

  it('+5m targetAt is firstSeenAt + 5 minutes', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', T0)]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const plan = readPlan(out);
    expect(plan.candidates[0].checkpoints[0].targetAt).toBe(at(5 * 60_000));
  });

  it('+120m targetAt is firstSeenAt + 120 minutes', () => {
    const capturedAt = at(30 * 60_000); // some offset
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA', capturedAt)]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const plan = readPlan(out);
    const firstSeenMs = Date.parse(capturedAt);
    expect(plan.candidates[0].checkpoints[4].targetAt).toBe(
      new Date(firstSeenMs + 120 * 60_000).toISOString(),
    );
  });
});

// ── Candidate fields ──────────────────────────────────────────────────────────

describe('candidate fields', () => {
  it('includes all required candidate fields', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60Fixture('AAAA', T0, { symbol: 'TOKEN', ripperScore: 72 }),
    ]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const c = readPlan(out).candidates[0];
    expect(c.contract).toBe('AAAA');
    expect(c.symbol).toBe('TOKEN');
    expect(c.score).toBe(72);
    expect(c.launchAgeBucket).toBe('PRIME_WINDOW');
    expect(c.entryDecision).toBe('WATCH');
    expect(c.clusterRisk).toBe('CLEAN');
    expect(c.firstSeenAt).toBe(T0);
    expect(c.policyName).toBe('LOOSE_60_WATCH');
    expect(c.status).toBe('PLANNED_OBSERVATION_ONLY');
  });

  it('symbol is null when not present', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA')]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(readPlan(out).candidates[0].symbol).toBeNull();
  });

  it('deduplicates by contract key (first seen wins)', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60Fixture('AAAA', T0,          { ripperScore: 65 }),
      loose60Fixture('AAAA', at(60_000),  { ripperScore: 70 }), // duplicate
    ]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const plan = readPlan(out);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].score).toBe(65); // first seen wins
  });
});

// ── Plan file ─────────────────────────────────────────────────────────────────

describe('plan file', () => {
  it('writes valid JSON to outPath', () => {
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: out });
    expect(() => JSON.parse(fs.readFileSync(out, 'utf-8'))).not.toThrow();
  });

  it('plan policyName is LOOSE_60_WATCH', () => {
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: out });
    expect(readPlan(out).policyName).toBe('LOOSE_60_WATCH');
  });

  it('plan totalExtras matches candidates length', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60Fixture('AAAA'),
      loose60Fixture('BBBB'),
    ]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const plan = readPlan(out);
    expect(plan.totalExtras).toBe(plan.candidates.length);
    expect(plan.totalExtras).toBe(2);
  });

  it('plan has generatedAt', () => {
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: out });
    const plan = readPlan(out);
    expect(typeof plan.generatedAt).toBe('string');
    expect(plan.generatedAt.length).toBeGreaterThan(0);
  });

  it('creates parent directory if needed', () => {
    const nestedOut = path.join(tmpDir, 'nested', 'dir', 'plan.json');
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: nestedOut });
    expect(fs.existsSync(nestedOut)).toBe(true);
  });

  it('candidates are sorted by firstSeenAt ascending', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60Fixture('BBBB', at(60_000)),
      loose60Fixture('AAAA', T0),
    ]);
    const out = outPath();
    runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    const contracts = readPlan(out).candidates.map(c => c.contract);
    expect(contracts[0]).toBe('AAAA');
    expect(contracts[1]).toBe('BBBB');
  });
});

// ── Result fields ─────────────────────────────────────────────────────────────

describe('result fields', () => {
  it('result.outPath matches the provided outPath', () => {
    const out = outPath('my-plan.json');
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: out });
    expect(r.outPath).toBe(out);
  });

  it('result.written is true when file written', () => {
    const out = outPath();
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: out });
    expect(r.written).toBe(true);
  });

  it('result.totalExtras matches candidate count', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA'), loose60Fixture('BBBB')]);
    const out = outPath();
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: out });
    expect(r.totalExtras).toBe(2);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and observation-only header', () => {
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: outPath() });
    const out = renderRipperLooseExtraObservationPlan(r);
    expect(out).toContain('LOOSE EXTRA OBSERVATION PLAN');
    expect(out).toContain('OBSERVATION PLAN ONLY');
    expect(out).toContain('NO TRADES');
  });

  it('includes safety footer', () => {
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: outPath() });
    const out = renderRipperLooseExtraObservationPlan(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('DO NOT CHANGE APPROVAL GATES');
    expect(out).toContain('DO NOT WIRE INTO RIPPER-AUTOPILOT');
  });

  it('shows output path and total extras', () => {
    const p = writeJsonl('obs.jsonl', [loose60Fixture('AAAA')]);
    const op = outPath();
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [p], outPath: op });
    const out = renderRipperLooseExtraObservationPlan(r);
    expect(out).toContain(op);
    expect(out).toContain('1');
  });

  it('shows checkpoint summary', () => {
    const r = runRipperLooseExtraObservationPlan({ approvalPaths: [], observationPaths: [], outPath: outPath() });
    const out = renderRipperLooseExtraObservationPlan(r);
    expect(out).toContain('+5m');
    expect(out).toContain('+120m');
  });
});
