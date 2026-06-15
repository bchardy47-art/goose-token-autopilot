import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperRealVsFakeAutopsy,
  renderRipperRealVsFakeAutopsy,
} from '../src/token-grab/ripperRealVsFakeAutopsy';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

function makeFixture(opts: {
  contract?:       string;
  capturedAt?:     string;
  clusterRisk?:    string;
  ripperScore?:    number | null;
  launchAgeBucket?: string | null;
  entryDecision?:  string | null;
  sourceKind?:     string;
  warnings?:       string[];
  blockers?:       string[];
} = {}) {
  return {
    capturedAt:       opts.capturedAt     ?? BASE_ISO,
    buyGateDecision:  'BUY_APPROVED_PAPER',
    ripperScore:      opts.ripperScore     !== undefined ? opts.ripperScore : 90,
    launchAgeBucket:  opts.launchAgeBucket !== undefined ? opts.launchAgeBucket : 'PRIME_WINDOW',
    entryDecision:    opts.entryDecision   !== undefined ? opts.entryDecision   : 'READY_TO_SNIPE_PAPER',
    warnings:         opts.warnings  ?? [],
    blockers:         opts.blockers  ?? [],
    normalizedSignal: {
      contract:  opts.contract   ?? CONTRACT_A,
      symbol:    'TOK',
      sourceKind: opts.sourceKind ?? 'DEX_NEW_POOL',
      id: 's', source: 'test', discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {
      clusterRisk: opts.clusterRisk ?? 'CLEAN',
    },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number | null } = {}) {
  return {
    capturedAt: opts.capturedAt ?? at(10_000),
    normalizedSignal: {
      contract: opts.contract ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? null,
      id: 'o', source: 'test', sourceKind: 'x', discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {},
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeCycle(fixtures: object[], name = 'cycle-test.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeObs(observations: object[], name = 'obs.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, observations.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf-8');
  return p;
}

function outPath(): string { return path.join(tmpDir, 'autopsy.jsonl'); }

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('sets reportOnly, readOnly, tradingExecuted=0, realTradingLocked, paperOnly, doNotChangeGatesYet', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.doNotChangeGatesYet).toBe(true);
  });
});

// ── Data loading ──────────────────────────────────────────────────────────────

describe('data loading', () => {
  it('returns 0 candidates when no cycle files given', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(0);
  });

  it('loads only BUY_APPROVED_PAPER fixtures', () => {
    const cycle = writeCycle([
      makeFixture({ contract: CONTRACT_A }),
      { ...makeFixture({ contract: CONTRACT_B }), buyGateDecision: 'BUY_REJECTED' },
    ]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });

  it('deduplicates same contract+capturedAt', () => {
    const cycle = writeCycle([
      makeFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
    ]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });

  it('handles missing cycle file gracefully', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: ['/no/such.jsonl'], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(0);
  });
});

// ── Winner / fake classification ──────────────────────────────────────────────

describe('winner and fake classification', () => {
  it('classifies winner >= 1%', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 2 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.winners1).toBe(1);
  });

  it('classifies winner >= 3%', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 5 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.winners3).toBe(1);
  });

  it('classifies winner >= 5%', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 7 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.winners5).toBe(1);
  });

  it('classifies fake when price <= -3%', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: -5 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.fakes).toBe(1);
  });

  it('classifies flat as fake when < ±1%', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 0.5 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.fakes).toBe(1);
  });

  it('unobserved candidates are not counted in winners/fakes', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
    expect(result.observedCandidates).toBe(0);
    expect(result.winners1).toBe(0);
  });
});

// ── Dimension breakdowns ──────────────────────────────────────────────────────

describe('dimension breakdowns', () => {
  it('includes clusterRisk breakdown', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A, clusterRisk: 'CLEAN' })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const bd = result.breakdowns.find(b => b.dimension === 'clusterRisk' && b.value === 'CLEAN');
    expect(bd).toBeTruthy();
    expect(bd!.total).toBe(1);
  });

  it('includes scoreBand breakdown', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A, ripperScore: 100 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const bd = result.breakdowns.find(b => b.dimension === 'scoreBand' && b.value === '100');
    expect(bd).toBeTruthy();
  });

  it('includes launchAgeBucket breakdown', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A, launchAgeBucket: 'PRIME_WINDOW' })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const bd = result.breakdowns.find(b => b.dimension === 'launchAgeBucket' && b.value === 'PRIME_WINDOW');
    expect(bd).toBeTruthy();
  });

  it('computes winRate1 correctly in breakdowns', () => {
    const cycle = writeCycle([
      makeFixture({ contract: CONTRACT_A, clusterRisk: 'CLEAN' }),
      makeFixture({ contract: CONTRACT_B, clusterRisk: 'CLEAN' }),
    ]);
    const obs = writeObs([
      makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct:  5 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(5_000), priceChangePct: -5 }),
    ]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const bd = result.breakdowns.find(b => b.dimension === 'clusterRisk' && b.value === 'CLEAN')!;
    expect(bd.winRate1).toBe(50);
    expect(bd.fakeRate).toBe(50);
  });
});

// ── Patterns and rules ────────────────────────────────────────────────────────

describe('patterns and rules', () => {
  it('returns INSUFFICIENT_DATA when no observations', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.realSignalPatterns[0]).toContain('INSUFFICIENT_DATA');
  });

  it('includes keep rule about CLEAN cluster path', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 5 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.recommendedKeepRules.join(' ')).toContain('CLEAN');
  });

  it('includes reject rule about current gates', () => {
    const cycle = writeCycle([makeFixture({ contract: CONTRACT_A })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 5 })]);
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.recommendedRejectRules.join(' ')).toContain('current gates');
  });

  it('doNotChangeGatesYet is always true', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.doNotChangeGatesYet).toBe(true);
  });
});

// ── Output file ───────────────────────────────────────────────────────────────

describe('output file', () => {
  it('writes one row per candidate', () => {
    const cycle = writeCycle([
      makeFixture({ contract: CONTRACT_A }),
      makeFixture({ contract: CONTRACT_B }),
    ]);
    runRipperRealVsFakeAutopsy({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(outPath(), 'utf-8').split('\n').filter(l => l.trim());
    expect(rows).toHaveLength(2);
  });

  it('writes empty file when no candidates', () => {
    runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(fs.readFileSync(outPath(), 'utf-8')).toBe('');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperRealVsFakeAutopsy', () => {
  it('includes REPORT ONLY safety header', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperRealVsFakeAutopsy(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('DO NOT ENABLE REAL TRADING');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('includes WHAT REAL LOOKED LIKE section', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperRealVsFakeAutopsy(result);
    expect(output).toContain('WHAT REAL LOOKED LIKE');
  });

  it('includes WHAT FAKE LOOKED LIKE section', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperRealVsFakeAutopsy(result);
    expect(output).toContain('WHAT FAKE LOOKED LIKE');
  });

  it('includes RULES TO TEST NEXT section', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperRealVsFakeAutopsy(result);
    expect(output).toContain('RULES TO TEST NEXT');
  });

  it('includes safety fields line', () => {
    const result = runRipperRealVsFakeAutopsy({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperRealVsFakeAutopsy(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('doNotChangeGatesYet=true');
  });
});
