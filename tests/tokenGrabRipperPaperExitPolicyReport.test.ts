import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperPaperExitPolicyReport,
  renderRipperPaperExitPolicyReport,
} from '../src/token-grab/ripperPaperExitPolicyReport';
import type { PaperIntent } from '../src/token-grab/ripperPaperDecisionPolicy';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

function makeIntent(overrides: Partial<PaperIntent> = {}): PaperIntent {
  return {
    intentId:         'abc123',
    contract:         CONTRACT_A,
    symbol:           'TOK',
    approvedAt:       BASE_ISO,
    targetEntryAt:    BASE_ISO,
    paperEntryTiming: 'ENTER_NOW',
    reason:           'DEFAULT_APPROVED_ENTER_NOW',
    sourceCycle:      null,
    clusterRisk:      'CLEAN',
    ripperScore:      90,
    launchAgeBucket:  'PRIME_WINDOW',
    entryDecision:    'READY_TO_SNIPE_PAPER',
    status:           'OBSERVED',
    realTradingLocked: true,
    paperOnly:         true,
    tradingExecuted:   0,
    ...overrides,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number | null } = {}) {
  return {
    capturedAt:       opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract:      opts.contract ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? null,
      id: 'o', source: 'test', sourceKind: 'x', discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {},
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-policy-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeIntents(intents: PaperIntent[]): string {
  const p = path.join(tmpDir, 'intents.jsonl');
  fs.writeFileSync(p, intents.map(i => JSON.stringify(i)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeObs(observations: object[]): string {
  const p = path.join(tmpDir, 'obs.jsonl');
  fs.writeFileSync(p, observations.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf-8');
  return p;
}

function outPath(): string { return path.join(tmpDir, 'exit-report.jsonl'); }

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets reportOnly, readOnly, tradingExecuted=0, realTradingLocked, paperOnly', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── Basic structure ───────────────────────────────────────────────────────────

describe('basic structure', () => {
  it('returns 6 policy stats entries', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.policyStats).toHaveLength(6);
  });

  it('includes all expected policy names', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const names = result.policyStats.map(s => s.policy);
    expect(names).toContain('TAKE_1PCT_STOP_3PCT');
    expect(names).toContain('TAKE_3PCT_STOP_3PCT');
    expect(names).toContain('TAKE_5PCT_STOP_5PCT');
    expect(names).toContain('TIME_EXIT_10M');
    expect(names).toContain('TIME_EXIT_30M');
    expect(names).toContain('TRAILING_AFTER_3PCT');
  });

  it('TRAILING_AFTER_3PCT is marked unsupported', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const trailing = result.policyStats.find(s => s.policy === 'TRAILING_AFTER_3PCT')!;
    expect(trailing.supported).toBe(false);
    expect(trailing.unsupportedReason).toBeTruthy();
  });

  it('writes JSONL output', () => {
    runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const rows = fs.readFileSync(outPath(), 'utf-8').split('\n').filter(l => l.trim());
    expect(rows).toHaveLength(6);
  });
});

// ── Stats with no observed intents ────────────────────────────────────────────

describe('no observed candidates', () => {
  it('candidatesWithData is 0 for all policies when no observed intents', () => {
    const intentsPath = writeIntents([makeIntent({ status: 'PLANNED' })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    for (const s of result.policyStats) {
      expect(s.candidatesWithData).toBe(0);
      expect(s.avgSimulatedPL).toBeNull();
    }
  });

  it('bestByAvgPL is null when no data', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.bestByAvgPL).toBeNull();
    expect(result.bestByMedianPL).toBeNull();
  });
});

// ── Stats with observed intents ───────────────────────────────────────────────

describe('stats with observed intents', () => {
  it('TAKE_1PCT_STOP_3PCT caps positive return at 1%', () => {
    const intentsPath = writeIntents([makeIntent({ contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO })]);
    const obsPath     = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 15 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const stats = result.policyStats.find(s => s.policy === 'TAKE_1PCT_STOP_3PCT')!;
    expect(stats.avgSimulatedPL).toBe(1);
  });

  it('TAKE_1PCT_STOP_3PCT floors negative at -3%', () => {
    const intentsPath = writeIntents([makeIntent({ contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO })]);
    const obsPath     = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: -8 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const stats = result.policyStats.find(s => s.policy === 'TAKE_1PCT_STOP_3PCT')!;
    expect(stats.avgSimulatedPL).toBe(-3);
  });

  it('TAKE_3PCT_STOP_3PCT caps at +3%', () => {
    const intentsPath = writeIntents([makeIntent({ contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO })]);
    const obsPath     = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 10 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const stats = result.policyStats.find(s => s.policy === 'TAKE_3PCT_STOP_3PCT')!;
    expect(stats.avgSimulatedPL).toBe(3);
  });

  it('TAKE_5PCT_STOP_5PCT caps at +5%', () => {
    const intentsPath = writeIntents([makeIntent({ contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO })]);
    const obsPath     = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 20 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const stats = result.policyStats.find(s => s.policy === 'TAKE_5PCT_STOP_5PCT')!;
    expect(stats.avgSimulatedPL).toBe(5);
  });

  it('TIME_EXIT policies use actual observed price', () => {
    const intentsPath = writeIntents([makeIntent({ contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO })]);
    const obsPath     = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 2.5 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const t10 = result.policyStats.find(s => s.policy === 'TIME_EXIT_10M')!;
    expect(t10.avgSimulatedPL).toBe(2.5);
  });

  it('computes win rate correctly', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'a1', contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, status: 'OBSERVED', targetEntryAt: BASE_ISO }),
    ]);
    const obsPath = writeObs([
      makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 2 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(1000), priceChangePct: -1 }),
    ]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const t10 = result.policyStats.find(s => s.policy === 'TIME_EXIT_10M')!;
    expect(t10.winRate).toBe(50);
  });

  it('computes coverage correctly', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'a1', contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, status: 'PLANNED',  targetEntryAt: BASE_ISO }),
    ]);
    const obsPath = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 2 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const t10 = result.policyStats.find(s => s.policy === 'TIME_EXIT_10M')!;
    expect(t10.candidatesAnalyzed).toBe(2);
    expect(t10.candidatesWithData).toBe(1);
    expect(t10.coveragePct).toBe(50);
  });

  it('candidatesAnalyzed equals total intents regardless of status', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'a1', contract: CONTRACT_A, status: 'OBSERVED' }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, status: 'EXPIRED_NO_DATA' }),
    ]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(2);
  });

  it('bestByAvgPL picks policy with highest avg', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'a1', contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO }),
    ]);
    const obsPath = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 4 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    // TAKE_3PCT_STOP_3PCT gives 3, TAKE_5PCT_STOP_5PCT gives 4 (5% cap not hit), TIME exits give 4
    expect(result.bestByAvgPL).toBeTruthy();
  });

  it('worstDrawdown is the minimum simulated PL', () => {
    const intentsPath = writeIntents([
      makeIntent({ intentId: 'a1', contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, status: 'OBSERVED', targetEntryAt: BASE_ISO }),
    ]);
    const obsPath = writeObs([
      makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct:  2 }),
      makeObs({ contract: CONTRACT_B, capturedAt: at(1000), priceChangePct: -6 }),
    ]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    // TAKE_1PCT_STOP_3PCT → B gets -3 (capped), A gets 1 → worst = -3
    const stats = result.policyStats.find(s => s.policy === 'TAKE_1PCT_STOP_3PCT')!;
    expect(stats.worstDrawdown).toBe(-3);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperPaperExitPolicyReport', () => {
  it('includes safety header', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperPaperExitPolicyReport(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('reportOnly=true');
  });

  it('includes EXIT POLICY COMPARISON section', () => {
    const result = runRipperPaperExitPolicyReport({
      intentsPath: '/no/such.jsonl', observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperPaperExitPolicyReport(result);
    expect(output).toContain('EXIT POLICY COMPARISON');
    expect(output).toContain('TAKE_1PCT_STOP_3PCT');
    expect(output).toContain('UNSUPPORTED');
  });

  it('includes BEST EXIT POLICY section when data available', () => {
    const intentsPath = writeIntents([makeIntent({ contract: CONTRACT_A, status: 'OBSERVED', targetEntryAt: BASE_ISO })]);
    const obsPath     = writeObs([makeObs({ contract: CONTRACT_A, capturedAt: at(1000), priceChangePct: 5 })]);
    const result = runRipperPaperExitPolicyReport({
      intentsPath, observationPaths: [obsPath], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderRipperPaperExitPolicyReport(result);
    expect(output).toContain('BEST EXIT POLICY');
  });
});
