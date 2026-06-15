import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperPaperObservationDiagnostic,
  renderRipperPaperObservationDiagnostic,
} from '../src/token-grab/ripperPaperObservationDiagnostic';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-diag-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeIntents(rows: object[]): string {
  const p = path.join(tmpDir, 'paper-intents.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeObsFile(rows: object[], name = 'obs.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeCycleFile(rows: object[], name = 'cycle-2026-06-15-120000.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function makeIntent(overrides: Partial<Record<string, unknown>> = {}): object {
  return {
    intentId:         'testid123456789',
    contract:         CONTRACT_A,
    symbol:           'TOK',
    approvedAt:       at(-10 * 60_000),
    targetEntryAt:    at(-5 * 60_000),
    paperEntryTiming: 'ENTER_NOW',
    reason:           'DEFAULT_APPROVED_ENTER_NOW',
    sourceCycle:      null,
    clusterRisk:      'WATCH',
    ripperScore:      90,
    launchAgeBucket:  'PRIME_WINDOW',
    entryDecision:    'READY_TO_SNIPE_PAPER',
    status:           'ENTRY_DUE',
    realTradingLocked: true,
    paperOnly:         true,
    tradingExecuted:   0,
    ...overrides,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number } = {}): object {
  return {
    capturedAt: opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract: opts.contract ?? CONTRACT_A,
      id: 'o', source: 'test', sourceKind: 'DEX_NEW_POOL',
      discoveredAt: BASE_ISO, warnings: [],
      priceChangePct: opts.priceChangePct ?? null,
    },
    raw: {},
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeCycleRow(opts: { contract?: string; capturedAt?: string; priceChangePct?: number; approved?: boolean } = {}): object {
  return {
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    buyGateDecision: opts.approved !== false ? 'BUY_APPROVED_PAPER' : 'BUY_REJECTED',
    ripperScore:     90,
    normalizedSignal: {
      contract: opts.contract ?? CONTRACT_A,
      id: 'c', source: 'test', sourceKind: 'DEX_NEW_POOL',
      discoveredAt: BASE_ISO, warnings: [],
      priceChangePct: opts.priceChangePct ?? null,
    },
    raw: { clusterRisk: 'CLEAN', priceChangePct: opts.priceChangePct ?? null },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets all safety flags', () => {
    const p = writeIntents([]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
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
  it('returns zeros when intents file is empty', () => {
    const p = writeIntents([]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
    });
    expect(result.intentsRead).toBe(0);
    expect(result.openIntents).toBe(0);
    expect(result.dueIntents).toBe(0);
    expect(result.observedIntents).toBe(0);
    expect(result.expiredIntents).toBe(0);
    expect(result.uniqueObsContracts).toBe(0);
    expect(result.matchingContracts).toBe(0);
  });

  it('obsFilesRead is 0 when no paths given', () => {
    const p = writeIntents([makeIntent()]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
    });
    expect(result.obsFilesRead).toBe(0);
    expect(result.obsRowsRead).toBe(0);
  });
});

// ── Intent status counts ──────────────────────────────────────────────────────

describe('intent status counts', () => {
  it('counts PLANNED, ENTRY_DUE, OBSERVED, EXPIRED_NO_DATA separately', () => {
    const p = writeIntents([
      makeIntent({ intentId: 'p1', status: 'PLANNED',          targetEntryAt: at(10 * 60_000) }),
      makeIntent({ intentId: 'd1', status: 'ENTRY_DUE',        targetEntryAt: at(-5 * 60_000) }),
      makeIntent({ intentId: 'd2', status: 'ENTRY_DUE',        targetEntryAt: at(-3 * 60_000), contract: CONTRACT_B }),
      makeIntent({ intentId: 'o1', status: 'OBSERVED',         targetEntryAt: at(-5 * 60_000), contract: CONTRACT_C }),
      makeIntent({ intentId: 'e1', status: 'EXPIRED_NO_DATA',  targetEntryAt: at(-30 * 60_000), contract: 'CCC' }),
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
    });
    expect(result.intentsRead).toBe(5);
    expect(result.openIntents).toBe(3); // PLANNED + 2 ENTRY_DUE
    expect(result.dueIntents).toBe(2);
    expect(result.observedIntents).toBe(1);
    expect(result.expiredIntents).toBe(1);
  });
});

// ── Obs matching ──────────────────────────────────────────────────────────────

describe('obs matching', () => {
  it('dueIntentsWithObsAfterTarget counts only matching obs after targetEntryAt', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'd1', contract: CONTRACT_A, targetEntryAt: at(-5 * 60_000), status: 'ENTRY_DUE' }),
      makeIntent({ intentId: 'd2', contract: CONTRACT_B, targetEntryAt: at(-5 * 60_000), status: 'ENTRY_DUE' }),
    ]);
    // CONTRACT_A: obs exists AFTER targetEntryAt with priceChangePct
    const obsPath = writeObsFile([
      makeObs({ contract: CONTRACT_A, capturedAt: at(-1 * 60_000), priceChangePct: 7 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(-7 * 60_000), priceChangePct: 3 }), // BEFORE targetEntryAt
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath,
      observationPaths: [obsPath],
      cyclePaths:       [],
    });
    expect(result.dueIntentsWithAnyObs).toBe(2);
    expect(result.dueIntentsWithObsAfterTarget).toBe(1);
    expect(result.matchingContracts).toBe(1);
    expect(result.topMatchingContracts).toContain(CONTRACT_A);
    expect(result.topMissingDue).toContain(CONTRACT_B);
  });

  it('matches obs from cycle files (not only obs dir)', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'd1', contract: CONTRACT_A, targetEntryAt: at(-5 * 60_000), status: 'ENTRY_DUE' }),
    ]);
    const cyclePath = writeCycleFile([
      makeCycleRow({ contract: CONTRACT_A, capturedAt: at(-1 * 60_000), priceChangePct: 5 }),
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath,
      observationPaths: [],
      cyclePaths:       [cyclePath],
    });
    expect(result.dueIntentsWithObsAfterTarget).toBe(1);
  });

  it('uniqueObsContracts merges obs dir and cycle files', () => {
    const intentsPath = writeIntents([]);
    const obsPath = writeObsFile([
      makeObs({ contract: CONTRACT_A }),
    ]);
    const cyclePath = writeCycleFile([
      makeCycleRow({ contract: CONTRACT_B }),
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath,
      observationPaths: [obsPath],
      cyclePaths:       [cyclePath],
    });
    expect(result.uniqueObsContracts).toBe(2);
  });
});

// ── Approved cycle candidates ─────────────────────────────────────────────────

describe('approved cycle candidates', () => {
  it('counts approved candidates in cycle files', () => {
    const intentsPath = writeIntents([]);
    const cyclePath = writeCycleFile([
      makeCycleRow({ contract: CONTRACT_A, capturedAt: at(-3 * 60_000), approved: true }),
      makeCycleRow({ contract: CONTRACT_B, capturedAt: at(-3 * 60_000), approved: false }),
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath,
      observationPaths: [],
      cyclePaths:       [cyclePath],
    });
    expect(result.approvedCycleCandidates).toBe(1);
  });

  it('approvedWithObsAfterApproved counts approved candidates with later obs', () => {
    const intentsPath = writeIntents([]);
    const cyclePath = writeCycleFile([
      makeCycleRow({ contract: CONTRACT_A, capturedAt: at(-10 * 60_000), approved: true }),
    ]);
    const obsPath = writeObsFile([
      makeObs({ contract: CONTRACT_A, capturedAt: at(-1 * 60_000), priceChangePct: 8 }),
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath,
      observationPaths: [obsPath],
      cyclePaths:       [cyclePath],
    });
    expect(result.approvedWithAnyObs).toBe(1);
    expect(result.approvedWithObsAfterApproved).toBe(1);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperPaperObservationDiagnostic', () => {
  it('includes safety header', () => {
    const p = writeIntents([]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
    });
    const output = renderRipperPaperObservationDiagnostic(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('includes safety field line', () => {
    const p = writeIntents([]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
    });
    const output = renderRipperPaperObservationDiagnostic(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('shows INTENTS section', () => {
    const p = writeIntents([makeIntent()]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath:      p,
      observationPaths: [],
      cyclePaths:       [],
    });
    const output = renderRipperPaperObservationDiagnostic(result);
    expect(output).toContain('INTENTS');
    expect(output).toContain('OBSERVATIONS');
    expect(output).toContain('MATCHING');
  });

  it('shows matching contract in output', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'd1', contract: CONTRACT_A, targetEntryAt: at(-5 * 60_000), status: 'ENTRY_DUE' }),
    ]);
    const obsPath = writeObsFile([
      makeObs({ contract: CONTRACT_A, capturedAt: at(-1 * 60_000), priceChangePct: 5 }),
    ]);
    const result = runRipperPaperObservationDiagnostic({
      intentsPath,
      observationPaths: [obsPath],
      cyclePaths:       [],
    });
    const output = renderRipperPaperObservationDiagnostic(result);
    expect(output).toContain(CONTRACT_A);
    expect(output).toContain('TOP MATCHING');
  });
});
