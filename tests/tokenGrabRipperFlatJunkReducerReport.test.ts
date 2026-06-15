import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runFlatJunkReducerReport,
  renderFlatJunkReducerReport,
} from '../src/token-grab/ripperFlatJunkReducerReport';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fjr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeCycle(rows: object[], name = 'cycle-test.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeObs(rows: object[], name = 'obs.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function outPath(): string { return path.join(tmpDir, 'report.jsonl'); }

function makeApproved(opts: {
  contract?:        string;
  capturedAt?:      string;
  clusterRisk?:     string;
  ripperScore?:     number;
  launchAgeBucket?: string;
  ageMinutes?:      number;
  entryDecision?:   string;
  priceChangePct?:  number;
  liquidityUsd?:    number;
  volumeUsd?:       number;
  warnings?:        string[];
} = {}) {
  const contract = opts.contract ?? CONTRACT_A;
  const pct      = opts.priceChangePct ?? 10;
  return {
    capturedAt:      opts.capturedAt     ?? BASE_ISO,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    ripperScore:     opts.ripperScore    ?? 100,
    launchAgeBucket: opts.launchAgeBucket ?? 'PRIME_WINDOW',
    ageMinutes:      opts.ageMinutes     ?? 3,
    entryDecision:   opts.entryDecision  ?? 'READY_TO_SNIPE_PAPER',
    warnings:        opts.warnings       ?? [],
    blockers:        [],
    normalizedSignal: {
      contract,
      symbol:       'TOK',
      sourceKind:   'DEX_NEW_POOL',
      id: 's', source: 'test', discoveredAt: BASE_ISO, warnings: [],
      priceChangePct: pct,
      liquidityUsd:   opts.liquidityUsd ?? null,
      volumeUsd:      opts.volumeUsd    ?? null,
      volumeLiquidityRatio: null,
      liquidityChangePct:   null,
    },
    raw: {
      clusterRisk:        opts.clusterRisk ?? 'CLEAN',
      clusterProvider:    'bubblemaps',
      clusterConfidence:  'HIGH',
      clusterNotes:       ['bubbleMapsScore 96.1'],
      priceChangePct:     pct,
    },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeRejected(contract = CONTRACT_B, capturedAt = BASE_ISO) {
  return {
    capturedAt,
    buyGateDecision: 'BUY_REJECTED',
    ripperScore: 80,
    normalizedSignal: { contract, id: 'r', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [] },
    raw: { clusterRisk: 'WATCH' },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number | null } = {}) {
  return {
    capturedAt: opts.capturedAt ?? at(10_000),
    normalizedSignal: {
      contract:      opts.contract ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? null,
      id: 'o', source: 'test', sourceKind: 'x', discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {},
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets all safety flags', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
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
  it('returns zero counts with no cycle files', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(0);
    expect(result.observedCandidates).toBe(0);
    expect(result.winnerCount).toBe(0);
    expect(result.flatJunkCount).toBe(0);
    expect(result.dumpCount).toBe(0);
    expect(result.winRate).toBeNull();
  });
});

// ── Gate filtering ────────────────────────────────────────────────────────────

describe('gate filtering', () => {
  it('only analyzes BUY_APPROVED_PAPER candidates', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A }),
      makeRejected(CONTRACT_B),
    ]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });
});

// ── Outcome classification ────────────────────────────────────────────────────

describe('outcome classification', () => {
  it('classifies +1.2% as WIN_1PCT', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 1.2 })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.win1Count).toBe(1);
    expect(result.win3Count).toBe(0);
    expect(result.win5Count).toBe(0);
    expect(result.winnerCount).toBe(1);
  });

  it('classifies +3.2% as WIN_3PCT', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 3.2 })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.win3Count).toBe(1);
    expect(result.win1Count).toBe(0);
    expect(result.winnerCount).toBe(1);
  });

  it('classifies +5.2% as WIN_5PCT', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 5.2 })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.win5Count).toBe(1);
    expect(result.win3Count).toBe(0);
    expect(result.winnerCount).toBe(1);
  });

  it('classifies -4% as DUMP', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: -4 })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.dumpCount).toBe(1);
    expect(result.winnerCount).toBe(0);
  });

  it('classifies 0% as FLAT_JUNK', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 0 })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.flatJunkCount).toBe(1);
  });

  it('classifies unobserved candidate as UNOBSERVED', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.unobservedCount).toBe(1);
    expect(result.observedCandidates).toBe(0);
  });
});

// ── Contract/field extraction ─────────────────────────────────────────────────

describe('contract and field extraction', () => {
  it('matches obs via nested normalizedSignal.contract', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_B, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_B, capturedAt: at(5_000), priceChangePct: 2 })]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.win1Count).toBe(1);
  });

  it('uses nested normalizedSignal.priceChangePct for outcome classification', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([{
      capturedAt: at(5_000),
      normalizedSignal: {
        contract:      CONTRACT_A,
        priceChangePct: 6,  // nested field
        id: 'o', source: 'test', sourceKind: 'x', discoveredAt: BASE_ISO, warnings: [],
      },
      raw: {},
      realTradingLocked: true, paperOnly: true, readOnly: true,
    }]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.win5Count).toBe(1);
  });
});

// ── Multiple paths ────────────────────────────────────────────────────────────

describe('multiple paths', () => {
  it('accepts multiple cycle paths', () => {
    const cycle1 = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })], 'cycle1.jsonl');
    const cycle2 = writeCycle([makeApproved({ contract: CONTRACT_B, capturedAt: BASE_ISO })], 'cycle2.jsonl');
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle1, cycle2], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(2);
  });

  it('accepts multiple observation paths and merges them', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproved({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs1 = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 5 })], 'obs1.jsonl');
    const obs2 = writeObs([makeObs({ contract: CONTRACT_B, capturedAt: at(5_000), priceChangePct: 2 })], 'obs2.jsonl');
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs1, obs2], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.observedCandidates).toBe(2);
    expect(result.obsFilesRead).toBe(2);
  });
});

// ── Counts and rates ──────────────────────────────────────────────────────────

describe('counts and rates', () => {
  it('winRate reflects observed candidates only', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproved({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
      makeApproved({ contract: CONTRACT_C, capturedAt: BASE_ISO }),
    ]);
    const obs = writeObs([
      makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct:  5 }), // WIN
      makeObs({ contract: CONTRACT_B, capturedAt: at(5_000), priceChangePct:  0 }), // FLAT
      makeObs({ contract: CONTRACT_C, capturedAt: at(5_000), priceChangePct: -5 }), // DUMP
    ]);
    const result = runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.observedCandidates).toBe(3);
    expect(result.winnerCount).toBe(1);
    expect(result.winRate).toBeCloseTo(33.3, 0);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes REPORT ONLY safety header', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderFlatJunkReducerReport(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('includes Winner profile section', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderFlatJunkReducerReport(result);
    expect(output).toContain('WINNER PROFILE');
  });

  it('includes Flat junk profile section', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderFlatJunkReducerReport(result);
    expect(output).toContain('FLAT JUNK PROFILE');
  });

  it('includes HOLD_CURRENT_GATES when no strong filter', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.gateDecision).toBe('HOLD_CURRENT_GATES');
    const output = renderFlatJunkReducerReport(result);
    expect(output).toContain('HOLD_CURRENT_GATES');
  });

  it('includes DO_NOT_ENABLE_REAL_TRADING in footer', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderFlatJunkReducerReport(result);
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('includes safety fields line', () => {
    const result = runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderFlatJunkReducerReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });
});

// ── Output file ───────────────────────────────────────────────────────────────

describe('output file', () => {
  it('writes one row per candidate', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A }),
      makeApproved({ contract: CONTRACT_B }),
    ]);
    runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(outPath(), 'utf-8').split('\n').filter(l => l.trim());
    expect(rows).toHaveLength(2);
  });

  it('writes empty file when no candidates', () => {
    runFlatJunkReducerReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(fs.readFileSync(outPath(), 'utf-8')).toBe('');
  });

  it('each row contains outcome field', () => {
    const cycle = writeCycle([makeApproved({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs   = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 3 })]);
    runFlatJunkReducerReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const row = JSON.parse(fs.readFileSync(outPath(), 'utf-8').split('\n')[0]!);
    expect(row.outcome).toBe('WIN_3PCT');
  });
});
