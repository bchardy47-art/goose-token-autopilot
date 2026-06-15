import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovedEntryTimingReport,
  renderRipperApprovedEntryTimingReport,
} from '../src/token-grab/ripperApprovedEntryTimingReport';

// ── Time anchors ──────────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

// ── Contract helpers ──────────────────────────────────────────────────────────

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeApproval(opts: {
  contract?:       string;
  symbol?:         string;
  capturedAt?:     string;
  priceChangePct?: number | null;
  buyGateDecision?: string;
} = {}) {
  return {
    id:              'fix-id',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    source:          'test',
    sourceKind:      'DEX_NEW_POOL',
    normalizedSignal: {
      id:           'sig-id',
      source:       'test',
      sourceKind:   'DEX_NEW_POOL',
      contract:     opts.contract ?? CONTRACT_A,
      symbol:       opts.symbol ?? 'TOK',
      discoveredAt: BASE_ISO,
      warnings:     [],
      priceChangePct: opts.priceChangePct ?? 5,
    },
    raw:              { clusterRisk: 'CLEAN', priceChangePct: opts.priceChangePct ?? 5 },
    ripperInput:      null,
    ripperScore:      90,
    ageMinutes:       10,
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

function makeObs(opts: {
  contract?:       string;
  capturedAt?:     string;
  priceChangePct?: number | null;
} = {}) {
  return {
    id:              'obs-id',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    source:          'test',
    sourceKind:      'DEX_NEW_POOL',
    normalizedSignal: {
      id:           'obs-sig-id',
      source:       'test',
      sourceKind:   'DEX_NEW_POOL',
      contract:     opts.contract ?? CONTRACT_A,
      discoveredAt: BASE_ISO,
      warnings:     [],
      priceChangePct: opts.priceChangePct ?? null,
    },
    ripperInput:      null,
    ripperScore:      70,
    ageMinutes:       20,
    buyGateDecision:  'WATCH',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raetr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

function outPath(): string {
  return path.join(tmpDir, 'out.jsonl');
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets reportOnly, readOnly, tradingExecuted=0, realTradingLocked, paperOnly', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── Data loading ──────────────────────────────────────────────────────────────

describe('data loading', () => {
  it('returns zero candidates when no approval files given', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(0);
    expect(result.approvalFilesRead).toBe(0);
  });

  it('counts missing approval files', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: ['/no/such.jsonl'], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.approvalFilesRead).toBe(0);
    expect(result.candidatesAnalyzed).toBe(0);
  });

  it('loads only BUY_APPROVED_PAPER fixtures', () => {
    const ap = writeJsonl('approvals.jsonl', [
      makeApproval({ contract: CONTRACT_A }),
      makeApproval({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
      makeApproval({ contract: CONTRACT_C, buyGateDecision: 'WATCH' }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });

  it('deduplicates same contract+capturedAt across approval files', () => {
    const ap = writeJsonl('approvals.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });

  it('keeps same contract with different capturedAt as separate candidates', () => {
    const ap = writeJsonl('approvals.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_A, capturedAt: at(5 * 60_000) }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(2);
  });

  it('counts missing observation files', () => {
    const ap = writeJsonl('approvals.jsonl', [makeApproval()]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: ['/no/obs.jsonl'], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.observationFilesMissing).toBe(1);
    expect(result.observationFilesRead).toBe(0);
  });

  it('reads observation files successfully', () => {
    const ap  = writeJsonl('approvals.jsonl', [makeApproval()]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ priceChangePct: 5 })]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.observationFilesRead).toBe(1);
  });

  it('skips malformed lines in approval files gracefully', () => {
    const p = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(p, '{"buyGateDecision":"BUY_APPROVED_PAPER","capturedAt":"' + BASE_ISO + '","normalizedSignal":{"contract":"' + CONTRACT_A + '","id":"x","source":"t","sourceKind":"d","discoveredAt":"' + BASE_ISO + '","warnings":[]}}\nnot-json\n', 'utf-8');
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [p], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });

  it('extracts symbol from normalizedSignal', () => {
    const ap = writeJsonl('approvals.jsonl', [makeApproval({ contract: CONTRACT_A, symbol: 'MYSYM' })]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(path.join(tmpDir, 'out.jsonl'), 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    expect(rows[0].symbol).toBe('MYSYM');
  });
});

// ── JSONL output ──────────────────────────────────────────────────────────────

describe('JSONL output', () => {
  it('writes one row per candidate per timing window (5 windows × N candidates)', () => {
    const ap = writeJsonl('approvals.jsonl', [
      makeApproval({ contract: CONTRACT_A }),
      makeApproval({ contract: CONTRACT_B }),
    ]);
    const out = outPath();
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: out, nowMs: BASE_MS,
    });
    expect(result.rowsWritten).toBe(10); // 2 × 5
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim());
    expect(rows).toHaveLength(10);
  });

  it('writes empty file when no candidates', () => {
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: out, nowMs: BASE_MS,
    });
    expect(fs.readFileSync(out, 'utf-8')).toBe('');
  });

  it('each row has required fields: contract, symbol, approvedAt, window, offsetMs, targetAt, status', () => {
    const ap = writeJsonl('approvals.jsonl', [makeApproval({ contract: CONTRACT_A, symbol: 'AAA' })]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    for (const row of rows) {
      expect(row).toHaveProperty('contract');
      expect(row).toHaveProperty('approvedAt');
      expect(row).toHaveProperty('window');
      expect(row).toHaveProperty('offsetMs');
      expect(row).toHaveProperty('targetAt');
      expect(row).toHaveProperty('status');
    }
  });

  it('row windows are exactly the 5 expected values', () => {
    const ap = writeJsonl('approvals.jsonl', [makeApproval()]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const windows = rows.map((r: { window: string }) => r.window);
    expect(windows).toContain('ENTER_NOW');
    expect(windows).toContain('WAIT_1M');
    expect(windows).toContain('WAIT_3M');
    expect(windows).toContain('WAIT_5M');
    expect(windows).toContain('WAIT_10M');
  });
});

// ── Timing window matching ────────────────────────────────────────────────────

describe('timing window matching', () => {
  it('ENTER_NOW matches first obs at or after approvedAt', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(30_000), priceChangePct: 8 })]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row = rows.find((r: { window: string }) => r.window === 'ENTER_NOW');
    expect(row.status).toBe('COVERED');
    expect(row.priceChangePct).toBe(8);
  });

  it('ENTER_NOW is MISSING when obs is before approvedAt', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(-1000), priceChangePct: 8 })]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row = rows.find((r: { window: string }) => r.window === 'ENTER_NOW');
    expect(row.status).toBe('MISSING');
  });

  it('WAIT_1M matches first obs >= approvedAt + 60s', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ capturedAt: at(30_000),  priceChangePct: 2 }),  // too early for WAIT_1M
      makeObs({ capturedAt: at(90_000),  priceChangePct: 5 }),  // covers WAIT_1M
    ]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row1m = rows.find((r: { window: string }) => r.window === 'WAIT_1M');
    expect(row1m.status).toBe('COVERED');
    expect(row1m.priceChangePct).toBe(5);
  });

  it('WAIT_3M matches first obs >= approvedAt + 180s', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ capturedAt: at(90_000),  priceChangePct: 3 }),
      makeObs({ capturedAt: at(200_000), priceChangePct: 9 }),  // covers WAIT_3M
    ]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row3m = rows.find((r: { window: string }) => r.window === 'WAIT_3M');
    expect(row3m.status).toBe('COVERED');
    expect(row3m.priceChangePct).toBe(9);
  });

  it('WAIT_5M matches first obs >= approvedAt + 300s', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ capturedAt: at(350_000), priceChangePct: 12 }),
    ]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row5m = rows.find((r: { window: string }) => r.window === 'WAIT_5M');
    expect(row5m.status).toBe('COVERED');
    expect(row5m.priceChangePct).toBe(12);
  });

  it('WAIT_10M matches first obs >= approvedAt + 600s', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ capturedAt: at(650_000), priceChangePct: 15 }),
    ]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row10m = rows.find((r: { window: string }) => r.window === 'WAIT_10M');
    expect(row10m.status).toBe('COVERED');
    expect(row10m.priceChangePct).toBe(15);
  });

  it('WAIT_10M is MISSING when only early obs exist', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(30_000), priceChangePct: 5 })]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const row10m = rows.find((r: { window: string }) => r.window === 'WAIT_10M');
    expect(row10m.status).toBe('MISSING');
    expect(row10m.priceChangePct).toBeNull();
    expect(row10m.observedAt).toBeNull();
  });

  it('earlier obs covers ENTER_NOW but not WAIT_1M; later obs covers WAIT_1M', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ capturedAt: at(10_000),  priceChangePct: 1 }),
      makeObs({ capturedAt: at(120_000), priceChangePct: 7 }),
    ]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const enterNow = rows.find((r: { window: string }) => r.window === 'ENTER_NOW');
    const wait1m   = rows.find((r: { window: string }) => r.window === 'WAIT_1M');
    expect(enterNow.priceChangePct).toBe(1);
    expect(wait1m.priceChangePct).toBe(7);
  });

  it('obs without priceChangePct gets null', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(10_000), priceChangePct: null })]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const enterNow = rows.find((r: { window: string }) => r.window === 'ENTER_NOW');
    expect(enterNow.status).toBe('COVERED');
    expect(enterNow.priceChangePct).toBeNull();
  });

  it('obs are matched per contract — contract B obs does not cover contract A', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ contract: CONTRACT_A })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct: 99 })]);
    const out = outPath();
    runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: out, nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    expect(rows.every((r: { status: string }) => r.status === 'MISSING')).toBe(true);
  });
});

// ── Window stats ──────────────────────────────────────────────────────────────

describe('window stats', () => {
  it('coverage is 0% when no observations', () => {
    const ap = writeJsonl('ap.jsonl', [makeApproval()]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    for (const s of result.windowStats) {
      expect(s.coveragePct).toBe(0);
      expect(s.candidatesWithData).toBe(0);
    }
  });

  it('coverage is 100% when all candidates have obs for all windows', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(700_000), priceChangePct: 10 })]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    for (const s of result.windowStats) {
      expect(s.coveragePct).toBe(100);
    }
  });

  it('partial coverage when some windows have no late-enough obs', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    // Only covers ENTER_NOW and WAIT_1M (obs at +90s)
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(90_000), priceChangePct: 5 })]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.windowStats.find(s => s.window === 'ENTER_NOW')!.coveragePct).toBe(100);
    expect(result.windowStats.find(s => s.window === 'WAIT_1M')!.coveragePct).toBe(100);
    expect(result.windowStats.find(s => s.window === 'WAIT_3M')!.coveragePct).toBe(0);
    expect(result.windowStats.find(s => s.window === 'WAIT_5M')!.coveragePct).toBe(0);
    expect(result.windowStats.find(s => s.window === 'WAIT_10M')!.coveragePct).toBe(0);
  });

  it('avgMove is null when no candidates with data', () => {
    const ap = writeJsonl('ap.jsonl', [makeApproval()]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    for (const s of result.windowStats) {
      expect(s.avgMove).toBeNull();
      expect(s.medianMove).toBeNull();
    }
  });

  it('computes correct avgMove across candidates', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000), priceChangePct: 4 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct: 8 }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const enterNow = result.windowStats.find(s => s.window === 'ENTER_NOW')!;
    expect(enterNow.avgMove).toBe(6); // (4 + 8) / 2
  });

  it('computes correct medianMove (odd count)', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_C, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000), priceChangePct: 2 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct: 6 }),
      makeObs({ contract: CONTRACT_C, capturedAt: at(10_000), priceChangePct: 10 }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const enterNow = result.windowStats.find(s => s.window === 'ENTER_NOW')!;
    expect(enterNow.medianMove).toBe(6);
  });

  it('computes correct medianMove (even count)', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000), priceChangePct: 4 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct: 8 }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const enterNow = result.windowStats.find(s => s.window === 'ENTER_NOW')!;
    expect(enterNow.medianMove).toBe(6); // (4 + 8) / 2
  });

  it('computes win rate >= 1%', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000), priceChangePct: 5 }),   // win
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct: -1 }),  // not win
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const enterNow = result.windowStats.find(s => s.window === 'ENTER_NOW')!;
    expect(enterNow.winRatePlus1Pct).toBe(50);
  });

  it('computes win rate >= 3%', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_C, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000), priceChangePct: 5 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct: 1.5 }),
      makeObs({ contract: CONTRACT_C, capturedAt: at(10_000), priceChangePct: -2 }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const enterNow = result.windowStats.find(s => s.window === 'ENTER_NOW')!;
    // only CONTRACT_A >= 3
    expect(Math.round(enterNow.winRatePlus3Pct!)).toBe(33);
  });

  it('computes dump rate <= -3%', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000), priceChangePct: -5 }),  // dump
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000), priceChangePct:  2 }),  // not dump
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const enterNow = result.windowStats.find(s => s.window === 'ENTER_NOW')!;
    expect(enterNow.dumpRateMinus3Pct).toBe(50);
  });

  it('windowStats has exactly 5 entries', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.windowStats).toHaveLength(5);
  });

  it('windowStats entries are in correct order', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const names = result.windowStats.map(s => s.window);
    expect(names).toEqual(['ENTER_NOW', 'WAIT_1M', 'WAIT_3M', 'WAIT_5M', 'WAIT_10M']);
  });

  it('totalCandidates in windowStats equals candidatesAnalyzed', () => {
    const ap = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A }),
      makeApproval({ contract: CONTRACT_B }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    for (const s of result.windowStats) {
      expect(s.totalCandidates).toBe(2);
    }
  });
});

// ── Best timing ───────────────────────────────────────────────────────────────

describe('bestByAvgMove and bestByMedianMove', () => {
  it('both null when no candidates with data', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestByAvgMove).toBeNull();
    expect(result.bestByMedianMove).toBeNull();
  });

  it('picks window with highest avg move', () => {
    // ENTER_NOW gets 2%, WAIT_1M gets 10% — WAIT_1M should win
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ capturedAt: at(10_000),  priceChangePct: 2 }),  // ENTER_NOW
      makeObs({ capturedAt: at(90_000),  priceChangePct: 10 }), // WAIT_1M
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestByAvgMove).toBe('WAIT_1M');
  });

  it('picks window with highest median move', () => {
    const ap  = writeJsonl('ap.jsonl', [
      makeApproval({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApproval({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObs({ contract: CONTRACT_A, capturedAt: at(10_000),  priceChangePct: 1 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(10_000),  priceChangePct: 3 }),
      makeObs({ contract: CONTRACT_A, capturedAt: at(90_000),  priceChangePct: 8 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(90_000),  priceChangePct: 12 }),
    ]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    // ENTER_NOW median=(1+3)/2=2, WAIT_1M median=(8+12)/2=10
    expect(result.bestByMedianMove).toBe('WAIT_1M');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperApprovedEntryTimingReport', () => {
  it('includes REPORT ONLY safety header', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperApprovedEntryTimingReport(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
  });

  it('includes safety lock fields in output', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperApprovedEntryTimingReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('includes TIMING WINDOW COMPARISON section', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperApprovedEntryTimingReport(result);
    expect(output).toContain('TIMING WINDOW COMPARISON');
    expect(output).toContain('ENTER_NOW');
    expect(output).toContain('WAIT_10M');
  });

  it('includes BEST TIMING section when data available', () => {
    const ap  = writeJsonl('ap.jsonl', [makeApproval({ capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObs({ capturedAt: at(10_000), priceChangePct: 5 })]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperApprovedEntryTimingReport(result);
    expect(output).toContain('BEST TIMING');
  });

  it('omits BEST TIMING section when no data', () => {
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperApprovedEntryTimingReport(result);
    expect(output).not.toContain('BEST TIMING');
  });

  it('includes candidates analyzed count', () => {
    const ap = writeJsonl('ap.jsonl', [makeApproval(), makeApproval({ contract: CONTRACT_B })]);
    const result = runRipperApprovedEntryTimingReport({
      approvalPaths: [ap], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperApprovedEntryTimingReport(result);
    expect(output).toContain('2');
  });
});
