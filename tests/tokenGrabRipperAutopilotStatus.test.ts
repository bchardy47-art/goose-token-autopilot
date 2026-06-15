import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperAutopilotStatus,
  renderRipperAutopilotStatus,
} from '../src/token-grab/ripperAutopilotStatus';
import type { PaperIntent } from '../src/token-grab/ripperPaperDecisionPolicy';
import { appendPaperIntents } from '../src/token-grab/ripperPaperIntentLedger';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();
const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeIntent(overrides: Partial<PaperIntent> = {}): PaperIntent {
  return {
    intentId:         'abc',
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
    status:           'PLANNED',
    realTradingLocked: true,
    paperOnly:         true,
    tradingExecuted:   0,
    ...overrides,
  };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeCyclesDir(fixtures: object[] = [], slug = 'cycle-2026-06-15-120000'): string {
  const cyclesDir = path.join(tmpDir, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  if (fixtures.length > 0) {
    const p = path.join(cyclesDir, `${slug}.jsonl`);
    fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  }
  return cyclesDir;
}

function makeFixture(opts: { buyGateDecision?: string; contract?: string } = {}) {
  return {
    capturedAt:      BASE_ISO,
    buyGateDecision: opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    ripperScore:     90,
    normalizedSignal: { contract: opts.contract ?? CONTRACT_A, symbol: 'TOK', id: 's', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [] },
    raw: { clusterRisk: 'CLEAN' },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeOptions(opts: {
  cyclesDir?: string;
  intentsPath?: string;
  timingReportPath?: string;
  exitPolicyPath?: string;
  realVsFakePath?: string;
  nowMs?: number;
} = {}) {
  return {
    cyclesDir:        opts.cyclesDir        ?? path.join(tmpDir, 'cycles'),
    intentsPath:      opts.intentsPath      ?? path.join(tmpDir, 'paper-intents.jsonl'),
    timingReportPath: opts.timingReportPath ?? path.join(tmpDir, 'timing.jsonl'),
    exitPolicyPath:   opts.exitPolicyPath   ?? path.join(tmpDir, 'exit.jsonl'),
    realVsFakePath:   opts.realVsFakePath   ?? path.join(tmpDir, 'rvf.jsonl'),
    nowMs:            opts.nowMs            ?? BASE_MS,
  };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('mode is PAPER_ONLY', () => {
    expect(runRipperAutopilotStatus(makeOptions()).mode).toBe('PAPER_ONLY');
  });

  it('realTradingLocked is true', () => {
    expect(runRipperAutopilotStatus(makeOptions()).realTradingLocked).toBe(true);
  });

  it('tradingExecuted is 0', () => {
    expect(runRipperAutopilotStatus(makeOptions()).tradingExecuted).toBe(0);
  });

  it('paperOnly is true', () => {
    expect(runRipperAutopilotStatus(makeOptions()).paperOnly).toBe(true);
  });

  it('reportOnly is true', () => {
    expect(runRipperAutopilotStatus(makeOptions()).reportOnly).toBe(true);
  });

  it('readOnly is true', () => {
    expect(runRipperAutopilotStatus(makeOptions()).readOnly).toBe(true);
  });
});

// ── Cycle state ───────────────────────────────────────────────────────────────

describe('cycle state', () => {
  it('latestCycleTime is null when no cycles dir', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    expect(result.latestCycleTime).toBeNull();
  });

  it('latestCycleTime reflects latest cycle file', () => {
    makeCyclesDir([], 'cycle-2026-06-15-120000');
    const cyclesDir = path.join(tmpDir, 'cycles');
    fs.writeFileSync(path.join(cyclesDir, 'cycle-2026-06-15-120000.jsonl'), '', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ cyclesDir }));
    expect(result.latestCycleTime).toContain('2026-06-15');
  });

  it('approvedCount counts BUY_APPROVED_PAPER from latest cycle', () => {
    const cyclesDir = makeCyclesDir([
      makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperAutopilotStatus(makeOptions({ cyclesDir }));
    expect(result.approvedCount).toBe(2);
    expect(result.rejectedCount).toBe(1);
  });
});

// ── Paper intents ─────────────────────────────────────────────────────────────

describe('paper intents', () => {
  it('openPaperIntents counts PLANNED and ENTRY_DUE intents', () => {
    const intentsPath = path.join(tmpDir, 'intents.jsonl');
    appendPaperIntents(intentsPath, [
      makeIntent({ intentId: 'a1', status: 'PLANNED'          }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, status: 'ENTRY_DUE' }),
      makeIntent({ intentId: 'c1', contract: 'CCC', status: 'OBSERVED' }),
    ]);
    const result = runRipperAutopilotStatus(makeOptions({ intentsPath }));
    expect(result.openPaperIntents).toBe(2);
  });

  it('wait10mIntents counts WAIT_10M open intents', () => {
    const intentsPath = path.join(tmpDir, 'intents.jsonl');
    appendPaperIntents(intentsPath, [
      makeIntent({ intentId: 'a1', paperEntryTiming: 'WAIT_10M', reason: 'HIGH_QUALITY_WAIT10_SUBGROUP', status: 'PLANNED' }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, paperEntryTiming: 'ENTER_NOW', status: 'PLANNED' }),
    ]);
    const result = runRipperAutopilotStatus(makeOptions({ intentsPath }));
    expect(result.wait10mIntents).toBe(1);
    expect(result.enterNowIntents).toBe(1);
  });

  it('dueObservations counts ENTRY_DUE intents', () => {
    const intentsPath = path.join(tmpDir, 'intents.jsonl');
    appendPaperIntents(intentsPath, [
      makeIntent({ intentId: 'a1', status: 'ENTRY_DUE' }),
      makeIntent({ intentId: 'b1', contract: CONTRACT_B, status: 'PLANNED'  }),
    ]);
    const result = runRipperAutopilotStatus(makeOptions({ intentsPath }));
    expect(result.dueObservations).toBe(1);
  });
});

// ── Decision logic ────────────────────────────────────────────────────────────

describe('decision logic', () => {
  it('decision is HOLD_CURRENT_GATES when no WAIT_10M intents', () => {
    const intentsPath = path.join(tmpDir, 'intents.jsonl');
    appendPaperIntents(intentsPath, [
      makeIntent({ intentId: 'a1', paperEntryTiming: 'ENTER_NOW', status: 'PLANNED' }),
    ]);
    const result = runRipperAutopilotStatus(makeOptions({ intentsPath }));
    expect(result.decision).toBe('HOLD_CURRENT_GATES');
  });

  it('decision is PAPER_ONLY_WAIT10_FOR_HIGH_QUALITY_SUBGROUP when WAIT_10M intents exist', () => {
    const intentsPath = path.join(tmpDir, 'intents.jsonl');
    appendPaperIntents(intentsPath, [
      makeIntent({ intentId: 'a1', paperEntryTiming: 'WAIT_10M', reason: 'HIGH_QUALITY_WAIT10_SUBGROUP' }),
    ]);
    const result = runRipperAutopilotStatus(makeOptions({ intentsPath }));
    expect(result.decision).toBe('PAPER_ONLY_WAIT10_FOR_HIGH_QUALITY_SUBGROUP');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperAutopilotStatus', () => {
  it('includes PAPER ONLY mode header', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    const output = renderRipperAutopilotStatus(result);
    expect(output).toContain('PAPER ONLY');
    expect(output).toContain('NO REAL TRADING');
  });

  it('includes DO_NOT_ENABLE_REAL_TRADING', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    const output = renderRipperAutopilotStatus(result);
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('includes DECISION section', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    const output = renderRipperAutopilotStatus(result);
    expect(output).toContain('DECISION');
    expect(output).toContain('HOLD_CURRENT_GATES');
  });

  it('includes safety fields line', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    const output = renderRipperAutopilotStatus(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
    expect(output).toContain('paperOnly=true');
  });

  it('includes PAPER INTENTS section', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    const output = renderRipperAutopilotStatus(result);
    expect(output).toContain('PAPER INTENTS');
  });
});

// ── Exit policy leader ────────────────────────────────────────────────────────

function makeExitPolicyRow(opts: {
  policy?: string;
  supported?: boolean;
  candidatesWithData?: number;
  avgSimulatedPL?: number | null;
} = {}): object {
  return {
    policy:            opts.policy             ?? 'TIME_EXIT_10M',
    supported:         opts.supported          ?? true,
    candidatesWithData: opts.candidatesWithData ?? 0,
    candidatesAnalyzed: 5,
    coveragePct:       0,
    avgSimulatedPL:    opts.avgSimulatedPL     ?? null,
    medianSimulatedPL: null,
    winRate:           null,
    dumpRate:          null,
    worstDrawdown:     null,
    generatedAt:       BASE_ISO,
  };
}

describe('exit policy leader', () => {
  it('returns null when no exit policy file exists', () => {
    const result = runRipperAutopilotStatus(makeOptions());
    expect(result.latestExitPolicyLeader).toBeNull();
  });

  it('returns INSUFFICIENT_DATA when exit policy file exists but all coverage is 0', () => {
    const exitPath = path.join(tmpDir, 'exit.jsonl');
    fs.writeFileSync(exitPath, [
      makeExitPolicyRow({ policy: 'TAKE_1PCT_STOP_3PCT', candidatesWithData: 0 }),
      makeExitPolicyRow({ policy: 'TIME_EXIT_10M',       candidatesWithData: 0 }),
      makeExitPolicyRow({ policy: 'TRAILING_AFTER_3PCT', supported: false, candidatesWithData: 0 }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ exitPolicyPath: exitPath }));
    expect(result.latestExitPolicyLeader).toBe('INSUFFICIENT_DATA');
  });

  it('returns INSUFFICIENT_DATA when only unsupported policies have coverage', () => {
    const exitPath = path.join(tmpDir, 'exit.jsonl');
    fs.writeFileSync(exitPath, [
      makeExitPolicyRow({ policy: 'TRAILING_AFTER_3PCT', supported: false, candidatesWithData: 10, avgSimulatedPL: 5 }),
      makeExitPolicyRow({ policy: 'TIME_EXIT_10M',       supported: true,  candidatesWithData: 0  }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ exitPolicyPath: exitPath }));
    expect(result.latestExitPolicyLeader).toBe('INSUFFICIENT_DATA');
  });

  it('returns named leader when a supported policy has coverage', () => {
    const exitPath = path.join(tmpDir, 'exit.jsonl');
    fs.writeFileSync(exitPath, [
      makeExitPolicyRow({ policy: 'TAKE_1PCT_STOP_3PCT', candidatesWithData: 5,  avgSimulatedPL: 0.5 }),
      makeExitPolicyRow({ policy: 'TIME_EXIT_10M',       candidatesWithData: 5,  avgSimulatedPL: 1.2 }),
      makeExitPolicyRow({ policy: 'TRAILING_AFTER_3PCT', supported: false, candidatesWithData: 0 }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ exitPolicyPath: exitPath }));
    // TIME_EXIT_10M has better avg → should be the leader
    expect(result.latestExitPolicyLeader).toContain('TIME_EXIT_10M');
    expect(result.latestExitPolicyLeader).not.toBe('INSUFFICIENT_DATA');
  });

  it('leader string includes avg P/L when available', () => {
    const exitPath = path.join(tmpDir, 'exit.jsonl');
    fs.writeFileSync(exitPath, [
      makeExitPolicyRow({ policy: 'TIME_EXIT_10M', candidatesWithData: 5, avgSimulatedPL: 2.3 }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ exitPolicyPath: exitPath }));
    expect(result.latestExitPolicyLeader).toContain('+2.3%');
  });

  it('dashboard renders INSUFFICIENT_DATA when coverage is 0', () => {
    const exitPath = path.join(tmpDir, 'exit.jsonl');
    fs.writeFileSync(exitPath, [
      makeExitPolicyRow({ policy: 'TIME_EXIT_10M', candidatesWithData: 0 }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ exitPolicyPath: exitPath }));
    const output = renderRipperAutopilotStatus(result);
    expect(output).toContain('INSUFFICIENT_DATA');
  });

  it('safety fields are unchanged regardless of exit policy state', () => {
    const exitPath = path.join(tmpDir, 'exit.jsonl');
    fs.writeFileSync(exitPath, [
      makeExitPolicyRow({ policy: 'TIME_EXIT_10M', candidatesWithData: 5, avgSimulatedPL: 1.0 }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const result = runRipperAutopilotStatus(makeOptions({ exitPolicyPath: exitPath }));
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});
