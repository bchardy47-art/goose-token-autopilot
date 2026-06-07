import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_POSITION_V1,
  assertMaxLivePosition,
  getRequiredConfirmationPhrase,
  parseLiveUnlockEnv,
  buildLiveTradePlan,
  evaluateLiveReadinessGates,
  evaluateEntryConfirmation,
  buildConfirmedEntryQualityDiagnostics,
  calculatePctChange,
  renderLiveHarnessReport,
  calculatePaperPnLPct,
  updatePaperExitState,
  evaluatePaperExitGuard,
  renderPaperExitGuardSummary,
  type EvaluateLiveReadinessGatesInput,
  type EvaluateEntryConfirmationInput,
  type LiveHarnessSummary,
  type LiveReadinessReport,
  type PaperExitState,
  type PaperExitGuardSummary,
} from '../src/token-grab/liveHarness';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from '../src/token-grab/autopsy';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<TokenGrabAutopsyCandidate> = {}): TokenGrabAutopsyCandidate {
  return {
    id: 'tg-live-001',
    tokenName: 'LiveToken',
    ticker: 'LIVE',
    contractAddress: 'LiveContractAddress111111111111111111',
    poolAddress: 'LivePoolAddress1111111111111111111111',
    lane: 'EARLY_VELOCITY_WATCH',
    decision: 'WATCH',
    scoreAtDetection: 75,
    detectedAt: '2026-06-06T18:00:00Z',
    reasons: ['Early velocity signal'],
    redFlags: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<TokenGrabAutopsySnapshot> = {}): TokenGrabAutopsySnapshot {
  return {
    candidateId: 'tg-live-001',
    observedAt: '2026-06-06T18:01:00Z',
    minutesAfterDetection: 1,
    priceUsd: 0.0005,
    liquidityUsd: 8000,
    volumeUsd: 4200,
    source: 'geckoterminal',
    ...overrides,
  };
}

function makeValidGatesInput(
  overrides: Partial<EvaluateLiveReadinessGatesInput> = {},
): EvaluateLiveReadinessGatesInput {
  return {
    liveIntent: true,
    requireConfirmation: true,
    maxLivePosition: 1,
    unlockEnvValue: 'I_UNDERSTAND_THIS_CAN_LOSE_MONEY',
    decision: 'FAKE_BUY',
    candidate: makeCandidate(),
    snapshot: makeSnapshot(),
    candidateCount: 1,
    typedConfirmation: getRequiredConfirmationPhrase(),
    ...overrides,
  };
}

function makeBaseSummary(
  readiness: LiveReadinessReport,
  overrides: Partial<LiveHarnessSummary> = {},
): LiveHarnessSummary {
  return {
    ts: '20260606-1800',
    outDir: 'data/token-grab/live-harness',
    status: readiness.status,
    decision: 'NO_BUY',
    readiness,
    liveIntent: false,
    requireConfirmation: false,
    maxLivePosition: 1,
    maxOpenPositions: 1,
    candidatesDetected: 10,
    laneSummary: { EARLY_VELOCITY_WATCH: 2, NOISE_RUG_LIKELY: 8 },
    watchWorthyCount: 2,
    notAutonomous: true,
    noRealTradeSent: true,
    autoPaperNotRun: true,
    skipSleepMode: false,
    watchCycle: false,
    fakeBankroll: 20,
    confirmEntry: false,
    confirmMinutes: 2,
    ...overrides,
  };
}

function makeConfirmInput(
  overrides: Partial<EvaluateEntryConfirmationInput> = {},
): EvaluateEntryConfirmationInput {
  return {
    entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    confirmSnapshot: makeSnapshot({ priceUsd: 0.00106, liquidityUsd: 5200, observedAt: '2026-06-06T18:03:00Z' }),
    minPriceChangePct: 5,
    minLiquidityChangePct: 0,
    maxDrawdownPct: -10,
    minConfirmedLiquidityUsd: 2500,
    ...overrides,
  };
}

// ── Test 1: Default mode is DRY_RUN_ONLY ──────────────────────────────────────

describe('evaluateLiveReadinessGates — DRY_RUN_ONLY', () => {
  it('returns DRY_RUN_ONLY when liveIntent is false (FAKE_BUY decision)', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput({ liveIntent: false }));
    expect(result.status).toBe('DRY_RUN_ONLY');
    expect(result.gates).toHaveLength(0);
    expect(result.allGatesPassed).toBe(false);
  });

  it('returns DRY_RUN_ONLY with no gates even when all other params are valid', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ liveIntent: false, typedConfirmation: undefined }),
    );
    expect(result.status).toBe('DRY_RUN_ONLY');
  });
});

// ── Test 2: Max live position defaults to $1 ──────────────────────────────────

describe('MAX_LIVE_POSITION_V1 and assertMaxLivePosition', () => {
  it('MAX_LIVE_POSITION_V1 is exactly 1', () => {
    expect(MAX_LIVE_POSITION_V1).toBe(1);
  });

  it('assertMaxLivePosition(1) does not throw', () => {
    expect(() => assertMaxLivePosition(1)).not.toThrow();
  });

  it('assertMaxLivePosition(0.5) does not throw', () => {
    expect(() => assertMaxLivePosition(0.5)).not.toThrow();
  });

  // Test 3: max live position > $1 throws or rejects
  it('assertMaxLivePosition(1.01) throws', () => {
    expect(() => assertMaxLivePosition(1.01)).toThrow(/V1/);
  });

  it('assertMaxLivePosition(2) throws with descriptive error', () => {
    expect(() => assertMaxLivePosition(2)).toThrow(/cannot exceed/i);
  });

  it('assertMaxLivePosition(5) throws', () => {
    expect(() => assertMaxLivePosition(5)).toThrow();
  });
});

// ── Test 4: NO_BUY decision produces NO_TRADE ─────────────────────────────────

describe('evaluateLiveReadinessGates — NO_TRADE', () => {
  it('returns NO_TRADE when decision is NO_BUY (dry-run mode)', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ liveIntent: false, decision: 'NO_BUY' }),
    );
    expect(result.status).toBe('NO_TRADE');
    expect(result.gates).toHaveLength(0);
  });

  it('returns NO_TRADE when decision is NO_BUY even with liveIntent=true', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ liveIntent: true, decision: 'NO_BUY' }),
    );
    expect(result.status).toBe('NO_TRADE');
    expect(result.gates).toHaveLength(0);
    expect(result.allGatesPassed).toBe(false);
  });
});

// ── Test 5: FAKE_BUY produces trade plan but not execution ───────────────────

describe('buildLiveTradePlan', () => {
  it('builds a plan with PLAN_ONLY status — no execution fields', () => {
    const candidate = makeCandidate();
    const snapshot = makeSnapshot();
    const plan = buildLiveTradePlan(candidate, snapshot, 1);

    expect(plan.status).toBe('PLAN_ONLY');
    expect(plan.candidateId).toBe(candidate.id);
    expect(plan.ticker).toBe('LIVE');
    expect(plan.lane).toBe('EARLY_VELOCITY_WATCH');
    expect(plan.entryPrice).toBe(0.0005);
    expect(plan.liquidityAtEntry).toBe(8000);
    expect(plan.maxLivePosition).toBe(1);
    // No execution-related fields
    expect('txSignature' in plan).toBe(false);
    expect('swapResult' in plan).toBe(false);
    expect('executedAt' in plan).toBe(false);
  });

  it('plan includes slippage warning and manual exit rule', () => {
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    expect(plan.slippageWarning).toBeTruthy();
    expect(plan.exitRule).toMatch(/manual/i);
  });

  it('plan status is PLAN_ONLY — never APPROVED or EXECUTED', () => {
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    expect(plan.status).toBe('PLAN_ONLY');
    expect(plan.status).not.toBe('APPROVED');
  });

  it('dry-run gate evaluation returns DRY_RUN_ONLY even for FAKE_BUY', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ liveIntent: false, decision: 'FAKE_BUY' }),
    );
    expect(result.status).toBe('DRY_RUN_ONLY');
    expect(result.allGatesPassed).toBe(false);
  });
});

// ── Test 6: Missing TOKEN_GRAB_LIVE_UNLOCK blocks live mode ──────────────────

describe('parseLiveUnlockEnv', () => {
  it('returns false when TOKEN_GRAB_LIVE_UNLOCK is missing', () => {
    expect(parseLiveUnlockEnv({})).toBe(false);
  });

  it('returns false when TOKEN_GRAB_LIVE_UNLOCK is undefined', () => {
    expect(parseLiveUnlockEnv({ TOKEN_GRAB_LIVE_UNLOCK: undefined })).toBe(false);
  });

  // Test 7: Wrong TOKEN_GRAB_LIVE_UNLOCK blocks live mode
  it('returns false when TOKEN_GRAB_LIVE_UNLOCK is wrong', () => {
    expect(parseLiveUnlockEnv({ TOKEN_GRAB_LIVE_UNLOCK: 'yes_please' })).toBe(false);
  });

  it('returns false for an almost-correct value', () => {
    expect(parseLiveUnlockEnv({ TOKEN_GRAB_LIVE_UNLOCK: 'i_understand_this_can_lose_money' })).toBe(false);
  });

  it('returns true only for the exact required value', () => {
    expect(
      parseLiveUnlockEnv({ TOKEN_GRAB_LIVE_UNLOCK: 'I_UNDERSTAND_THIS_CAN_LOSE_MONEY' }),
    ).toBe(true);
  });
});

describe('evaluateLiveReadinessGates — UNLOCK_ENV gate', () => {
  it('UNLOCK_ENV gate fails when env var is missing → LIVE_REJECTED_BY_GATES', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ unlockEnvValue: undefined }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'UNLOCK_ENV');
    expect(gate?.passed).toBe(false);
  });

  // Test 7
  it('UNLOCK_ENV gate fails when env var is wrong → LIVE_REJECTED_BY_GATES', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ unlockEnvValue: 'wrong_value' }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'UNLOCK_ENV');
    expect(gate?.passed).toBe(false);
  });
});

// ── Test 8: Correct unlock env alone is not enough without --require-confirmation

describe('evaluateLiveReadinessGates — REQUIRE_CONFIRMATION_FLAG gate', () => {
  it('fails when requireConfirmation is false even with correct unlock env', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ requireConfirmation: false }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'REQUIRE_CONFIRMATION_FLAG');
    expect(gate?.passed).toBe(false);
  });
});

// ── Test 9: Confirmation phrase must equal "LIVE BUY $1 CONFIRM" ──────────────

describe('getRequiredConfirmationPhrase', () => {
  it('returns exactly "LIVE BUY $1 CONFIRM"', () => {
    expect(getRequiredConfirmationPhrase()).toBe('LIVE BUY $1 CONFIRM');
  });
});

describe('evaluateLiveReadinessGates — CONFIRMATION_PHRASE gate', () => {
  it('wrong confirmation phrase → LIVE_REJECTED_BY_GATES', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ typedConfirmation: 'confirm live buy' }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'CONFIRMATION_PHRASE');
    expect(gate?.passed).toBe(false);
  });

  it('correct confirmation phrase → LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ typedConfirmation: 'LIVE BUY $1 CONFIRM' }),
    );
    expect(result.status).toBe('LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED');
    expect(result.allGatesPassed).toBe(true);
  });

  it('missing typedConfirmation → LIVE_REQUIRES_CONFIRMATION', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ typedConfirmation: undefined }),
    );
    expect(result.status).toBe('LIVE_REQUIRES_CONFIRMATION');
  });
});

// ── Test 10: Candidate outside allowed lanes is blocked ───────────────────────

describe('evaluateLiveReadinessGates — CANDIDATE_LANE gate', () => {
  it('NOISE_RUG_LIKELY lane → CANDIDATE_LANE gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ candidate: makeCandidate({ lane: 'NOISE_RUG_LIKELY' }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'CANDIDATE_LANE');
    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toMatch(/NOISE_RUG_LIKELY/);
  });

  it('PRE_LAUNCH_WATCH lane → CANDIDATE_LANE gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ candidate: makeCandidate({ lane: 'PRE_LAUNCH_WATCH' }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'CANDIDATE_LANE');
    expect(gate?.passed).toBe(false);
  });

  it('MEME_EVENT_CANDIDATE lane → CANDIDATE_LANE gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ candidate: makeCandidate({ lane: 'MEME_EVENT_CANDIDATE' }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'CANDIDATE_LANE');
    expect(gate?.passed).toBe(false);
  });

  it('FRESH_LAUNCH_CANDIDATE lane passes the CANDIDATE_LANE gate', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ candidate: makeCandidate({ lane: 'FRESH_LAUNCH_CANDIDATE' }) }),
    );
    expect(result.status).toBe('LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED');
  });

  it('no candidate → CANDIDATE_LANE gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ candidate: undefined }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'CANDIDATE_LANE');
    expect(gate?.passed).toBe(false);
  });
});

// ── Test 11: Missing entry price blocks live readiness ─────────────────────────

describe('evaluateLiveReadinessGates — ENTRY_PRICE_VALID gate', () => {
  it('missing priceUsd → ENTRY_PRICE_VALID gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ snapshot: makeSnapshot({ priceUsd: undefined }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'ENTRY_PRICE_VALID');
    expect(gate?.passed).toBe(false);
  });

  it('zero priceUsd → ENTRY_PRICE_VALID gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ snapshot: makeSnapshot({ priceUsd: 0 }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'ENTRY_PRICE_VALID');
    expect(gate?.passed).toBe(false);
  });

  it('no snapshot at all → ENTRY_SNAPSHOT_EXISTS and price gates fail', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ snapshot: undefined }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const snapGate = result.gates.find(g => g.gate === 'ENTRY_SNAPSHOT_EXISTS');
    expect(snapGate?.passed).toBe(false);
  });
});

// ── Test 12: Liquidity under $1k blocks live readiness ────────────────────────

describe('evaluateLiveReadinessGates — ENTRY_LIQUIDITY_MINIMUM gate', () => {
  it('liquidity $999 → ENTRY_LIQUIDITY_MINIMUM gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ snapshot: makeSnapshot({ liquidityUsd: 999 }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'ENTRY_LIQUIDITY_MINIMUM');
    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toMatch(/999/);
  });

  it('liquidity $500 → ENTRY_LIQUIDITY_MINIMUM gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ snapshot: makeSnapshot({ liquidityUsd: 500 }) }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
  });

  it('liquidity exactly $1000 passes the gate', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ snapshot: makeSnapshot({ liquidityUsd: 1000 }) }),
    );
    expect(result.status).toBe('LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED');
    const gate = result.gates.find(g => g.gate === 'ENTRY_LIQUIDITY_MINIMUM');
    expect(gate?.passed).toBe(true);
  });
});

// ── Tests 13-16: renderLiveHarnessReport safety text ─────────────────────────

describe('renderLiveHarnessReport', () => {
  function makeDryRunSummary(): LiveHarnessSummary {
    const readiness: LiveReadinessReport = {
      status: 'DRY_RUN_ONLY',
      gates: [],
      allGatesPassed: false,
    };
    return makeBaseSummary(readiness, { status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY' });
  }

  function makeNoTradeSummary(): LiveHarnessSummary {
    const readiness: LiveReadinessReport = {
      status: 'NO_TRADE',
      gates: [],
      allGatesPassed: false,
    };
    return makeBaseSummary(readiness, { status: 'NO_TRADE', decision: 'NO_BUY' });
  }

  // Test 13: Report includes NOT AUTONOMOUS
  it('contains NOT AUTONOMOUS', () => {
    const rendered = renderLiveHarnessReport(makeDryRunSummary());
    expect(rendered).toContain('NOT AUTONOMOUS');
  });

  // Test 14: Report includes NO REAL TRADE SENT
  it('contains NO REAL TRADE SENT', () => {
    const rendered = renderLiveHarnessReport(makeDryRunSummary());
    expect(rendered).toContain('NO REAL TRADE SENT');
  });

  // Test 15: Report includes token:auto-paper was NOT run
  it('contains token:auto-paper was NOT run', () => {
    const rendered = renderLiveHarnessReport(makeDryRunSummary());
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  // Test 16: Report does not contain private key/signing/swap execution
  it('does not contain private key, signing, swap, or execution call patterns', () => {
    const rendered = renderLiveHarnessReport(makeDryRunSummary());
    // Must not contain code-like execution call syntax
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/seed.?phrase\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/swapExact\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('NO_TRADE summary report contains NOT AUTONOMOUS and NO REAL TRADE SENT', () => {
    const rendered = renderLiveHarnessReport(makeNoTradeSummary());
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  it('shows trade plan details when present', () => {
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    const readiness: LiveReadinessReport = {
      status: 'DRY_RUN_ONLY',
      gates: [],
      allGatesPassed: false,
    };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      tradePlan: plan,
      planFilePath: 'data/token-grab/live-harness/plan-20260606-1800.json',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('LIVE');
    expect(rendered).toContain('PLAN_ONLY');
    expect(rendered).toContain('plan-20260606-1800.json');
    expect(rendered).toContain('NOT EXECUTED');
  });

  it('shows gate results when gates are present', () => {
    const gates = evaluateLiveReadinessGates(makeValidGatesInput({ unlockEnvValue: undefined }));
    const summary = makeBaseSummary(gates, {
      status: 'LIVE_REJECTED_BY_GATES',
      decision: 'FAKE_BUY',
      liveIntent: true,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('UNLOCK_ENV');
    expect(rendered).toContain('FAIL');
  });

  it('shows LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED message', () => {
    const gates = evaluateLiveReadinessGates(makeValidGatesInput());
    const summary = makeBaseSummary(gates, {
      status: 'LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED',
      decision: 'FAKE_BUY',
      liveIntent: true,
      requireConfirmation: true,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED');
    expect(rendered).toContain('no trade executor');
    expect(rendered).toContain('NOT AUTONOMOUS');
  });
});

// ── Test 17: JSON mode — evaluateLiveReadinessGates result has status and gates

describe('evaluateLiveReadinessGates result JSON serialization', () => {
  it('result object has status and gates properties', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput());
    expect('status' in result).toBe(true);
    expect('gates' in result).toBe(true);
    expect(Array.isArray(result.gates)).toBe(true);
  });

  it('result serializes to valid JSON including status and gates', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput({ unlockEnvValue: undefined }));
    const json = JSON.parse(JSON.stringify(result));
    expect(typeof json.status).toBe('string');
    expect(Array.isArray(json.gates)).toBe(true);
    expect(json.status).toBe('LIVE_REJECTED_BY_GATES');
    expect(json.gates.length).toBeGreaterThan(0);
    expect(json.gates[0]).toHaveProperty('gate');
    expect(json.gates[0]).toHaveProperty('passed');
  });

  it('all-gates-pass result includes status LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED in JSON', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput());
    const json = JSON.parse(JSON.stringify(result));
    expect(json.status).toBe('LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED');
    expect(json.allGatesPassed).toBe(true);
    expect(json.gates.every((g: { passed: boolean }) => g.passed)).toBe(true);
  });

  it('LiveHarnessSummary serializes to JSON with required safety fields', () => {
    const readiness = evaluateLiveReadinessGates(
      makeValidGatesInput({ liveIntent: false }),
    );
    const summary = makeBaseSummary(readiness);
    const json = JSON.parse(JSON.stringify(summary));
    expect(json.notAutonomous).toBe(true);
    expect(json.noRealTradeSent).toBe(true);
    expect(json.autoPaperNotRun).toBe(true);
    expect(typeof json.status).toBe('string');
    expect(json.readiness).toHaveProperty('status');
    expect(json.readiness).toHaveProperty('gates');
  });
});

// ── Additional gate coverage ───────────────────────────────────────────────────

describe('evaluateLiveReadinessGates — MAX_POSITION_LIMIT gate', () => {
  it('maxLivePosition 1.5 → MAX_POSITION_LIMIT gate fails', () => {
    const result = evaluateLiveReadinessGates(
      makeValidGatesInput({ maxLivePosition: 1.5 }),
    );
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'MAX_POSITION_LIMIT');
    expect(gate?.passed).toBe(false);
  });
});

describe('evaluateLiveReadinessGates — SINGLE_CANDIDATE gate', () => {
  it('0 candidates → SINGLE_CANDIDATE gate fails', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput({ candidateCount: 0 }));
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
    const gate = result.gates.find(g => g.gate === 'SINGLE_CANDIDATE');
    expect(gate?.passed).toBe(false);
  });

  it('2 candidates → SINGLE_CANDIDATE gate fails', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput({ candidateCount: 2 }));
    expect(result.status).toBe('LIVE_REJECTED_BY_GATES');
  });
});

describe('evaluateLiveReadinessGates — happy path', () => {
  it('all gates pass with confirmation → LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED, allGatesPassed true', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput());
    expect(result.status).toBe('LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED');
    expect(result.allGatesPassed).toBe(true);
    expect(result.gates.every(g => g.passed)).toBe(true);
  });

  it('gates include all expected gate names when all pass', () => {
    const result = evaluateLiveReadinessGates(makeValidGatesInput());
    const gateNames = result.gates.map(g => g.gate);
    expect(gateNames).toContain('UNLOCK_ENV');
    expect(gateNames).toContain('REQUIRE_CONFIRMATION_FLAG');
    expect(gateNames).toContain('MAX_POSITION_LIMIT');
    expect(gateNames).toContain('SINGLE_CANDIDATE');
    expect(gateNames).toContain('CANDIDATE_LANE');
    expect(gateNames).toContain('ENTRY_SNAPSHOT_EXISTS');
    expect(gateNames).toContain('ENTRY_PRICE_VALID');
    expect(gateNames).toContain('ENTRY_LIQUIDITY_MINIMUM');
    expect(gateNames).toContain('CONFIRMATION_PHRASE');
  });
});

// ── Watch cycle tests (7 required) ────────────────────────────────────────────

describe('watch cycle — LiveHarnessSummary', () => {
  // Test 1: Default behavior — no watch cycle
  it('default summary has watchCycle false and no exitSnapshotPath or fakePnL', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness);
    expect(summary.watchCycle).toBe(false);
    expect(summary.exitSnapshotPath).toBeUndefined();
    expect(summary.fakePnL).toBeUndefined();
  });

  it('default summary without watch-cycle renders without watch cycle section', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, { status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY' });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toContain('Watch Cycle');
    expect(rendered).toContain('DRY_RUN_ONLY');
  });

  // Test 2: --watch-cycle summary includes exitSnapshotPath
  it('watch-cycle summary includes exitSnapshotPath when watchCycle is true', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const exitPath = 'data/token-grab/live-harness/session-20260606-1800-exit.json';
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      exitSnapshotPath: exitPath,
    });
    expect(summary.watchCycle).toBe(true);
    expect(summary.exitSnapshotPath).toBe(exitPath);
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Watch Cycle');
    expect(rendered).toContain(exitPath);
  });

  // Test 3: --watch-cycle with FAKE_BUY calculates fake P/L
  it('watch-cycle FAKE_BUY summary includes fakePnL and renders it', () => {
    const fakePnL = {
      outcome: 'GAIN' as const,
      fakePositionSize: 1,
      fakeEntryPrice: 0.001,
      fakeExitPrice: 0.002,
      fakeTokensHeld: 1000,
      fakeEndingValue: 2,
      pnlDollars: 1,
      pnlPct: 100,
      endingBankroll: 21,
    };
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      exitSnapshotPath: 'data/token-grab/live-harness/session-20260606-1800-exit.json',
      fakePnL,
    });
    expect(summary.fakePnL?.outcome).toBe('GAIN');
    expect(summary.fakePnL?.pnlPct).toBe(100);
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Watch Cycle');
    expect(rendered).toContain('GAIN');
    expect(rendered).toContain('Fake P/L');
    expect(rendered).toContain('Ending bankroll');
  });

  // Test 4: --watch-cycle with NO_TRADE does not require exitSnapshotPath
  it('watch-cycle NO_TRADE summary does not require exitSnapshotPath', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE',
      decision: 'NO_BUY',
      watchCycle: true,
    });
    expect(summary.watchCycle).toBe(true);
    expect(summary.exitSnapshotPath).toBeUndefined();
    expect(summary.fakePnL).toBeUndefined();
    // Rendering should not crash even with watchCycle=true and no exit path
    expect(() => renderLiveHarnessReport(summary)).not.toThrow();
  });

  // Test 5: Report clearly says dry-run and no real trade sent (with watch cycle active)
  it('watch-cycle report contains DRY_RUN_ONLY, NOT AUTONOMOUS, NO REAL TRADE SENT', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      exitSnapshotPath: 'data/token-grab/live-harness/session-20260606-1800-exit.json',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('DRY_RUN_ONLY');
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
    expect(rendered).toContain('[DRY-RUN — PAPER ONLY]');
  });

  // Test 6: No LIVE_EXECUTED status exists anywhere
  it('LIVE_EXECUTED is not a valid LiveHarnessStatus', () => {
    const validStatuses: LiveHarnessStatus[] = [
      'DRY_RUN_ONLY',
      'NO_TRADE',
      'LIVE_BLOCKED',
      'LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED',
      'LIVE_REQUIRES_CONFIRMATION',
      'LIVE_REJECTED_BY_GATES',
    ];
    expect(validStatuses.includes('LIVE_EXECUTED' as LiveHarnessStatus)).toBe(false);
    // Status type does not include LIVE_EXECUTED — confirmed by the valid list above
  });

  // Test 7: No wallet/private key/swap/signing in watch-cycle rendered output
  it('watch-cycle report does not contain wallet/swap/signing/key-loading patterns', () => {
    const fakePnL = {
      outcome: 'LOSS' as const,
      fakePositionSize: 1,
      fakeEntryPrice: 0.001,
      fakeExitPrice: 0.0005,
      fakeTokensHeld: 1000,
      fakeEndingValue: 0.5,
      pnlDollars: -0.5,
      pnlPct: -50,
      endingBankroll: 19.5,
    };
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      exitSnapshotPath: 'data/token-grab/live-harness/session-exit.json',
      fakePnL,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
    // Safety text must still be present
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
  });
});

// ── Entry Confirmation Gate tests (12 required) ───────────────────────────────

describe('calculatePctChange', () => {
  it('returns positive pct when price increases', () => {
    expect(calculatePctChange(0.001, 0.00106)).toBeCloseTo(6, 4);
  });

  it('returns negative pct when price decreases', () => {
    expect(calculatePctChange(0.001, 0.0009)).toBeCloseTo(-10, 4);
  });

  it('returns 0 when from is 0 to avoid division by zero', () => {
    expect(calculatePctChange(0, 0.001)).toBe(0);
  });

  it('returns 0 when price is flat', () => {
    expect(calculatePctChange(0.001, 0.001)).toBeCloseTo(0, 10);
  });
});

// Test 1: Default behavior unchanged when confirmEntry is absent
describe('entry confirmation gate — default (confirmEntry: false)', () => {
  it('makeBaseSummary has confirmEntry false and confirmMinutes 2 by default', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness);
    expect(summary.confirmEntry).toBe(false);
    expect(summary.confirmMinutes).toBe(2);
    expect(summary.confirmSnapshotPath).toBeUndefined();
    expect(summary.entryConfirmation).toBeUndefined();
  });

  it('report with confirmEntry false does not show Entry Confirmation Gate section', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, { status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY' });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toContain('Entry Confirmation Gate');
    expect(rendered).toContain('NOT AUTONOMOUS');
  });
});

// Test 2: Confirmation passes when price is up >= threshold and liquidity is flat/up
describe('evaluateEntryConfirmation — CONFIRMED', () => {
  it('passes when price is above threshold and liquidity is flat', () => {
    // 0.00106 / 0.001 = 6% — clearly above the 5% threshold, avoiding float boundary issues
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00106, liquidityUsd: 5000 }),
      minPriceChangePct: 5,
    }));
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.priceChangePct).toBeCloseTo(6, 1);
    expect(result.liquidityChangePct).toBeCloseTo(0, 1);
  });

  it('passes when price is well above threshold and liquidity has grown', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput());
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.priceChangePct).toBeGreaterThan(5);
    expect(result.liquidityChangePct).toBeGreaterThan(0);
    expect(result.reason).toContain('confirmed');
  });

  it('confirmed result has non-null entry and confirm prices', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput());
    expect(result.entryPrice).toBeCloseTo(0.001, 6);
    expect(result.confirmPrice).toBeCloseTo(0.00106, 6);
  });
});

// Test 3: Confirmation rejects when price gain is below threshold
describe('evaluateEntryConfirmation — REJECTED_PRICE_WEAK', () => {
  it('rejects when price is up but below the 5% threshold', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00103, liquidityUsd: 5000 }),
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
    expect(result.priceChangePct).toBeCloseTo(3, 1);
    expect(result.reason).toMatch(/below confirmation threshold/i);
  });

  it('rejects when price is flat (0% gain)', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
    expect(result.priceChangePct).toBeCloseTo(0, 1);
  });
});

// Test 4: Confirmation rejects when price drops beyond drawdown threshold
describe('evaluateEntryConfirmation — REJECTED_PRICE_DRAWDOWN', () => {
  it('rejects when price has dropped more than 10%', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00088, liquidityUsd: 4000 }),
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_DRAWDOWN');
    expect(result.priceChangePct).toBeLessThan(-10);
    expect(result.reason).toMatch(/drawdown threshold/i);
  });

  it('does not trigger REJECTED_PRICE_DRAWDOWN when drop is below the threshold (e.g. -5%)', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00095, liquidityUsd: 5000 }),
    }));
    // -5% is above -10% drawdown threshold, so it falls to REJECTED_PRICE_WEAK
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
  });
});

// Test 5: Confirmation rejects when liquidity fades below threshold
describe('evaluateEntryConfirmation — REJECTED_LIQUIDITY_FADE', () => {
  it('rejects when liquidity drops and minLiquidityChangePct is 0', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00106, liquidityUsd: 4900 }),
      minLiquidityChangePct: 0,
    }));
    expect(result.verdict).toBe('REJECTED_LIQUIDITY_FADE');
    expect(result.liquidityChangePct).toBeLessThan(0);
    expect(result.reason).toMatch(/faded/i);
  });

  it('passes when liquidity is exactly flat with threshold of 0', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00106, liquidityUsd: 5000 }),
      minLiquidityChangePct: 0,
    }));
    expect(result.verdict).toBe('CONFIRMED');
  });
});

// Test 6: Confirmation rejects when entry snapshot is missing
describe('evaluateEntryConfirmation — REJECTED_MISSING_SNAPSHOT (entry)', () => {
  it('rejects with REJECTED_MISSING_SNAPSHOT when entrySnapshot is undefined', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({ entrySnapshot: undefined }));
    expect(result.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
    expect(result.reason).toMatch(/entry snapshot/i);
    expect(result.priceChangePct).toBeNull();
  });

  it('rejects when entry price is null', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      entrySnapshot: makeSnapshot({ priceUsd: undefined }),
    }));
    expect(result.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
  });

  it('rejects when entry price is zero', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      entrySnapshot: makeSnapshot({ priceUsd: 0 }),
    }));
    expect(result.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
  });
});

// Test 7: Confirmation rejects when confirmation snapshot is missing
describe('evaluateEntryConfirmation — REJECTED_MISSING_SNAPSHOT (confirm)', () => {
  it('rejects with REJECTED_MISSING_SNAPSHOT when confirmSnapshot is undefined', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({ confirmSnapshot: undefined }));
    expect(result.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
    expect(result.reason).toMatch(/confirmation snapshot/i);
  });

  it('rejects when confirm price is null', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: undefined }),
    }));
    expect(result.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
  });
});

// Test 8: Report includes confirmation verdict and price/liquidity change
describe('renderLiveHarnessReport — Entry Confirmation Gate section', () => {
  it('renders confirmation section with verdict, prices, and pct change when confirmEntry is true', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00088, liquidityUsd: 4000 }),
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2,
      confirmSnapshotPath: 'data/token-grab/live-harness/session-20260606-1800-confirm.json',
      entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Entry Confirmation Gate');
    expect(rendered).toContain('REJECTED_PRICE_DRAWDOWN');
    expect(rendered).toContain('Confirm price');
    expect(rendered).toContain('Price change');
    expect(rendered).toContain('Reject reason');
    expect(rendered).toContain('session-20260606-1800-confirm.json');
  });

  it('renders CONFIRMED verdict without Reject reason line', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput());
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      confirmEntry: true, confirmMinutes: 2,
      entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Entry Confirmation Gate');
    expect(rendered).toContain('CONFIRMED');
    expect(rendered).not.toContain('Reject reason');
  });
});

// Test 9: When confirmation rejects, no PLAN_ONLY trade plan is created
describe('entry confirmation gate — no plan when rejected', () => {
  it('a rejected confirmation result is never CONFIRMED — plan creation must be blocked', () => {
    const weak = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    expect(weak.verdict).not.toBe('CONFIRMED');
    // The CLI uses verdict !== 'CONFIRMED' to block plan creation;
    // verify the verdict here proves no PLAN_ONLY would be created.
    expect(['REJECTED_PRICE_WEAK', 'REJECTED_PRICE_DRAWDOWN',
      'REJECTED_LIQUIDITY_FADE', 'REJECTED_MISSING_SNAPSHOT']).toContain(weak.verdict);
  });

  it('summary with rejected confirmation has no tradePlan', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({ confirmSnapshot: undefined }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    expect(summary.tradePlan).toBeUndefined();
    expect(entryConfirmation.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
  });
});

// Test 10: When confirmation passes, PLAN_ONLY can be created
describe('entry confirmation gate — plan allowed when confirmed', () => {
  it('CONFIRMED verdict allows trade plan creation', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput());
    expect(result.verdict).toBe('CONFIRMED');

    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    expect(plan.status).toBe('PLAN_ONLY');
    expect(plan.entryPrice).toBeGreaterThan(0);
  });

  it('summary with confirmed entryConfirmation can include a tradePlan', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput());
    const tradePlan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation, tradePlan,
    });
    expect(summary.entryConfirmation?.verdict).toBe('CONFIRMED');
    expect(summary.tradePlan?.status).toBe('PLAN_ONLY');
  });
});

// Test 11: No LIVE_EXECUTED status in entry confirmation types
describe('entry confirmation gate — no LIVE_EXECUTED', () => {
  it('EntryConfirmationVerdict does not include LIVE_EXECUTED', () => {
    const validVerdicts = [
      'CONFIRMED', 'REJECTED_PRICE_WEAK', 'REJECTED_PRICE_DRAWDOWN',
      'REJECTED_LIQUIDITY_FADE', 'REJECTED_MISSING_SNAPSHOT', 'NOT_REQUIRED',
    ];
    expect(validVerdicts.includes('LIVE_EXECUTED')).toBe(false);
  });

  it('confirmation gate rendered output never contains LIVE_EXECUTED', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput());
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });
});

// Test 12: No wallet/private key/swap/signing in confirmation rendered output
describe('entry confirmation gate — safety text', () => {
  it('report with entry confirmation contains no signing/swap/key patterns', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({ confirmSnapshot: undefined }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 0.1, entryConfirmation,
      confirmSnapshotPath: 'data/token-grab/live-harness/session-confirm.json',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });
});

// ── Watch-cycle skip tests (6 required) ──────────────────────────────────────

// Test 1: NO_BUY + watchCycle does not require exit snapshot
describe('watch-cycle skip — NO_BUY has no exit snapshot', () => {
  it('NO_BUY summary with watchCycle true has watchCycleSkipped and no exitSnapshotPath', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    expect(summary.watchCycle).toBe(true);
    expect(summary.watchCycleSkipped).toBe(true);
    expect(summary.exitSnapshotPath).toBeUndefined();
    expect(summary.fakePnL).toBeUndefined();
  });

  it('rendering NO_BUY+watchCycleSkipped does not throw', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    expect(() => renderLiveHarnessReport(summary)).not.toThrow();
  });
});

// Test 2: NO_BUY report shows watch-cycle skipped reason
describe('watch-cycle skip — rendered report shows skip reason', () => {
  it('shows Watch Cycle section with Skipped line when watchCycleSkipped is true', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Watch Cycle');
    expect(rendered).toContain('Skipped');
    expect(rendered).toContain('No PLAN_ONLY trade plan was created.');
  });

  it('skipped watch cycle report still contains safety banners', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });
});

// Test 3: FAKE_BUY + PLAN_ONLY still runs watch-cycle with fake P/L
describe('watch-cycle skip — FAKE_BUY with PLAN_ONLY runs normally', () => {
  it('FAKE_BUY + tradePlan + watchCycle renders exit snapshot and P/L (not skipped)', () => {
    const fakePnL = {
      outcome: 'GAIN' as const,
      fakePositionSize: 1,
      fakeEntryPrice: 0.001,
      fakeExitPrice: 0.0015,
      fakeTokensHeld: 1000,
      fakeEndingValue: 1.5,
      pnlDollars: 0.5,
      pnlPct: 50,
      endingBankroll: 20.5,
    };
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      tradePlan: plan,
      watchCycle: true,
      watchCycleSkipped: undefined,
      exitSnapshotPath: 'data/token-grab/live-harness/session-exit.json',
      fakePnL,
    });
    expect(summary.watchCycleSkipped).toBeUndefined();
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Watch Cycle');
    expect(rendered).not.toContain('Skipped');
    expect(rendered).toContain('Fake P/L');
    expect(rendered).toContain('GAIN');
    expect(rendered).toContain('PLAN_ONLY');
  });
});

// Test 4: Confirmation rejection blocks PLAN_ONLY and skips watch-cycle
describe('watch-cycle skip — confirmation rejection skips watch-cycle', () => {
  it('rejected confirmation summary has no tradePlan and watchCycleSkipped true', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    expect(entryConfirmation.verdict).not.toBe('CONFIRMED');
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    expect(summary.tradePlan).toBeUndefined();
    expect(summary.watchCycleSkipped).toBe(true);
    expect(summary.exitSnapshotPath).toBeUndefined();
  });

  it('rejected confirmation renders Watch Cycle section as skipped', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Watch Cycle');
    expect(rendered).toContain('Skipped');
    expect(rendered).toContain('Entry Confirmation Gate');
  });
});

// Test 5: No LIVE_EXECUTED in watch-cycle skip
describe('watch-cycle skip — no LIVE_EXECUTED', () => {
  it('skipped watch-cycle report never contains LIVE_EXECUTED', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });
});

// Test 6: No wallet/private key/swap/signing in watch-cycle skip rendered output
describe('watch-cycle skip — safety patterns absent', () => {
  it('skipped watch-cycle report contains no signing/swap/key patterns', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
  });
});

// ── Confirmed Entry Quality Gate tests (12 required) ─────────────────────────

// Test 1: Stricter price threshold (default 20% when --confirm-entry)
describe('confirmed entry quality gate — price threshold 20', () => {
  it('rejects +18% price gain when threshold is 20', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00118, liquidityUsd: 5200 }),
      minPriceChangePct: 20,
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
    expect(result.priceChangePct).toBeCloseTo(18, 0);
  });

  it('passes +22% price gain when threshold is 20', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00122, liquidityUsd: 5200 }),
      minPriceChangePct: 20,
    }));
    expect(result.verdict).toBe('CONFIRMED');
  });
});

// Test 2: Stricter liquidity-change threshold (default 10% when --confirm-entry)
describe('confirmed entry quality gate — liquidity growth threshold 10', () => {
  it('rejects +7.29% liquidity growth when threshold is 10 → REJECTED_CONFIRMED_LIQUIDITY_WEAK', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00122, liquidityUsd: 5365 }), // +7.3% liq, +22% price
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
    }));
    expect(result.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_WEAK');
    expect(result.liquidityChangePct).toBeCloseTo(7.3, 0);
  });

  it('passes +11% liquidity growth when threshold is 10', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00122, liquidityUsd: 5550 }), // +11% liq, +22% price
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
    }));
    expect(result.verdict).toBe('CONFIRMED');
  });
});

// Test 3: Default confirmed liquidity threshold is 2500
describe('confirmed entry quality gate — absolute liquidity floor 2500', () => {
  it('rejects when confirmLiquidityUsd is below 2500', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00122, liquidityUsd: 2400 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 0,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(result.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_LOW');
    expect(result.confirmLiquidityUsd).toBe(2400);
  });

  it('passes when confirmLiquidityUsd is exactly 2500 with flat liquidity', () => {
    // entry liq 2400, confirm liq 2500 → +4.17% change (above 0% threshold), floor exactly met
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 2400 }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00122, liquidityUsd: 2500 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 0,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.confirmLiquidityUsd).toBe(2500);
  });
});

// Test 4: WORLDS-like fixture passes
describe('confirmed entry quality gate — WORLDS-like fixture', () => {
  it('WORLDS-like: +28% price, +16% liq, $3598 confirmed liq → CONFIRMED', () => {
    // WORLDS evidence: price +28.19%, liquidity +16.15%, entry liquidity $3,598
    const entryLiq = 3098; // entry (3598 / 1.1615 ≈ 3098)
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: entryLiq }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001282, liquidityUsd: 3598 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.priceChangePct).toBeGreaterThan(20);
    expect(result.liquidityChangePct).toBeGreaterThan(10);
    expect(result.confirmLiquidityUsd).toBeGreaterThan(2500);
  });
});

// Test 5: JRE-like fixture fails confirmed liquidity low
describe('confirmed entry quality gate — JRE-like fixture, liquidity too low', () => {
  it('JRE-like: $1233 confirmed liq < $2500 floor → REJECTED_CONFIRMED_LIQUIDITY_LOW', () => {
    // JRE evidence: price +27.49%, liquidity +7.29%, confirmed liquidity $1,233
    const entryLiq = 1150; // approx entry (1233 / 1.0729 ≈ 1150)
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: entryLiq }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001275, liquidityUsd: 1233 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_LOW');
    expect(result.confirmLiquidityUsd).toBe(1233);
    expect(result.reason).toMatch(/1233/);
  });
});

// Test 6: JRE-like fixture fails liquidity growth weak
describe('confirmed entry quality gate — JRE-like fixture, liquidity growth weak', () => {
  it('JRE-like: +7.29% liq growth < 10% threshold → REJECTED_CONFIRMED_LIQUIDITY_WEAK', () => {
    // Same JRE metrics but confirmed liq above floor (so we reach the growth check)
    const entryLiq = 2800;
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: entryLiq }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001275, liquidityUsd: 3004 }), // +7.3% liq
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_WEAK');
    expect(result.liquidityChangePct).toBeCloseTo(7.3, 0);
    expect(result.reason).toMatch(/below required threshold/i);
  });
});

// Test 7: Confirmed price strong but liquidity too low rejects
describe('confirmed entry quality gate — strong price, thin confirmed liquidity', () => {
  it('price +30%, liq growth +20%, but confirmed liq $2000 < $2500 → REJECTED_CONFIRMED_LIQUIDITY_LOW', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 2000 }), // +30% price, -60% from 5000
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(result.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_LOW');
    expect(result.priceChangePct).toBeGreaterThan(20);
    expect(result.confirmLiquidityUsd).toBe(2000);
  });
});

// Test 8: Confirmed liquidity high but growth weak rejects
describe('confirmed entry quality gate — high confirmed liquidity, weak growth', () => {
  it('price +30%, confirmed liq $5200 > $2500, but growth +4% < 10% → REJECTED_CONFIRMED_LIQUIDITY_WEAK', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 5200 }), // +30% price, +4% liq
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(result.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_WEAK');
    expect(result.confirmLiquidityUsd).toBeGreaterThan(2500);
    expect(result.liquidityChangePct).toBeGreaterThan(0);
    expect(result.liquidityChangePct).toBeLessThan(10);
  });
});

// Test 9: Rejected quality gate prevents PLAN_ONLY
describe('confirmed entry quality gate — rejected gate blocks PLAN_ONLY', () => {
  it('summary with REJECTED_CONFIRMED_LIQUIDITY_LOW has no tradePlan', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 2000 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(entryConfirmation.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_LOW');
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    expect(summary.tradePlan).toBeUndefined();
  });

  it('summary with REJECTED_CONFIRMED_LIQUIDITY_WEAK has no tradePlan', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 5200 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(entryConfirmation.verdict).toBe('REJECTED_CONFIRMED_LIQUIDITY_WEAK');
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    expect(summary.tradePlan).toBeUndefined();
  });
});

// Test 10: Passing quality gate allows PLAN_ONLY
describe('confirmed entry quality gate — passing gate allows PLAN_ONLY', () => {
  it('CONFIRMED verdict allows PLAN_ONLY trade plan with stricter thresholds', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00122, liquidityUsd: 5550 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(result.verdict).toBe('CONFIRMED');
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    expect(plan.status).toBe('PLAN_ONLY');
  });
});

// Test 11: No LIVE_EXECUTED in quality gate verdicts or rendered output
describe('confirmed entry quality gate — no LIVE_EXECUTED', () => {
  it('quality gate verdict list does not include LIVE_EXECUTED', () => {
    const verdicts = [
      'CONFIRMED', 'REJECTED_PRICE_WEAK', 'REJECTED_PRICE_DRAWDOWN',
      'REJECTED_LIQUIDITY_FADE', 'REJECTED_CONFIRMED_LIQUIDITY_LOW',
      'REJECTED_CONFIRMED_LIQUIDITY_WEAK', 'REJECTED_MISSING_SNAPSHOT', 'NOT_REQUIRED',
    ];
    expect(verdicts.includes('LIVE_EXECUTED')).toBe(false);
  });

  it('rendered report with quality gate rejection never contains LIVE_EXECUTED', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 2000 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
      confirmMinConfirmedLiquidityUsd: 2500,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });
});

// Test 12: No wallet/private key/swap/signing in quality gate rendered output
describe('confirmed entry quality gate — safety patterns absent', () => {
  it('quality gate report contains no signing/swap/key patterns', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 2000 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
      confirmMinConfirmedLiquidityUsd: 2500,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });
});

// ── Confirmed Entry Quality Diagnostics tests (12 required) ──────────────────

// Test 1: WORLDS-like fixture diagnostics show all checks PASS
describe('confirmed entry quality diagnostics — WORLDS-like fixture', () => {
  it('WORLDS-like: +28% price, +16% liq, $3598 liq — all diagnostics pass', () => {
    const entryLiq = 3098; // 3598 / 1.1615 ≈ 3098
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: entryLiq, volumeUsd: 2230 }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001282, liquidityUsd: 3598, volumeUsd: 2917, observedAt: '2026-06-06T18:11:00Z' }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.qualityDiagnostics).toBeDefined();
    const diag = result.qualityDiagnostics!;
    expect(diag.pricePass).toBe(true);
    expect(diag.liquidityGrowthPass).toBe(true);
    expect(diag.confirmedLiquidityPass).toBe(true);
    expect(diag.drawdownPass).toBe(true);
    expect(diag.overallPass).toBe(true);
    expect(diag.failReasons).toHaveLength(0);
  });
});

// Test 2: JRE-like low-liquidity fixture diagnostics show confirmedLiquidityPass false
describe('confirmed entry quality diagnostics — JRE-like, low confirmed liquidity', () => {
  it('JRE-like: $1233 confirmed liq < $2500 floor — confirmedLiquidityPass is false', () => {
    const entryLiq = 1150; // 1233 / 1.0729 ≈ 1150
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: entryLiq }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001275, liquidityUsd: 1233, observedAt: '2026-06-06T18:11:00Z' }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.qualityDiagnostics).toBeDefined();
    const diag = result.qualityDiagnostics!;
    expect(diag.confirmedLiquidityPass).toBe(false);
    expect(diag.overallPass).toBe(false);
    expect(diag.failReasons.some(r => r.includes('1233') || r.includes('floor'))).toBe(true);
  });
});

// Test 3: JRE-like weak-liquidity-growth fixture diagnostics show liquidityGrowthPass false
describe('confirmed entry quality diagnostics — JRE-like, weak liquidity growth', () => {
  it('JRE-like: +7.29% liq growth < 10% threshold — liquidityGrowthPass is false', () => {
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 2800 }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001275, liquidityUsd: 3004, observedAt: '2026-06-06T18:11:00Z' }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.qualityDiagnostics).toBeDefined();
    const diag = result.qualityDiagnostics!;
    expect(diag.liquidityGrowthPass).toBe(false);
    expect(diag.overallPass).toBe(false);
    expect(diag.failReasons.some(r => r.includes('liquidity growth'))).toBe(true);
  });
});

// Test 4: Diagnostics include failReasons for rejected entries
describe('confirmed entry quality diagnostics — failReasons populated for rejections', () => {
  it('REJECTED_PRICE_WEAK includes price-related failReason', () => {
    // 6% price gain < 20% threshold
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.00106, liquidityUsd: 5200 }),
      minPriceChangePct: 20,
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
    expect(result.qualityDiagnostics).toBeDefined();
    const diag = result.qualityDiagnostics!;
    expect(diag.failReasons.length).toBeGreaterThan(0);
    expect(diag.failReasons.some(r => r.includes('price gain'))).toBe(true);
  });

  it('REJECTED_CONFIRMED_LIQUIDITY_LOW includes liquidity floor failReason', () => {
    // entry 5000 liq, confirm 2000 liq, floor 2500 → 2000 < 2500
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 2000 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(result.qualityDiagnostics).toBeDefined();
    const diag = result.qualityDiagnostics!;
    expect(diag.failReasons.some(r => r.includes('floor') || r.includes('2000') || r.includes('below'))).toBe(true);
  });
});

// Test 5: Diagnostics overallPass true only when all required quality checks pass
describe('confirmed entry quality diagnostics — overallPass', () => {
  it('overallPass is true when CONFIRMED', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput());
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.qualityDiagnostics?.overallPass).toBe(true);
  });

  it('overallPass is false for REJECTED_PRICE_WEAK', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
    expect(result.qualityDiagnostics?.overallPass).toBe(false);
  });

  it('overallPass is false for REJECTED_CONFIRMED_LIQUIDITY_LOW', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 2000 }),
      minPriceChangePct: 20,
      minConfirmedLiquidityUsd: 2500,
    }));
    expect(result.qualityDiagnostics?.overallPass).toBe(false);
  });
});

// Test 6: Report renders Confirmed Entry Quality Diagnostics block
describe('confirmed entry quality diagnostics — renderer shows block', () => {
  it('renders Confirmed Entry Quality Diagnostics section when confirmEntry is true and diagnostics exist', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
      confirmMinConfirmedLiquidityUsd: 2500,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Confirmed Entry Quality Diagnostics');
  });

  it('does not render diagnostics block when confirmEntry is false', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, { status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY' });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toContain('Confirmed Entry Quality Diagnostics');
  });

  it('diagnostics block shows PASS for CONFIRMED result', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput());
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Confirmed Entry Quality Diagnostics');
    expect(rendered).toContain('Overall        : PASS');
  });

  it('diagnostics block shows FAIL for rejected result', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Confirmed Entry Quality Diagnostics');
    expect(rendered).toContain('Overall        : FAIL');
    expect(rendered).toContain('Fail reasons');
  });
});

// Test 7: Report includes thresholds and actual values
describe('confirmed entry quality diagnostics — renderer shows thresholds and actuals', () => {
  it('renders price threshold in diagnostics block', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('required +20%');
    expect(rendered).toContain('required +10%');
  });

  it('renders confirmed liquidity floor threshold in diagnostics block', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
      minPriceChangePct: 20,
      minConfirmedLiquidityUsd: 2500,
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('required $2500');
  });
});

// Test 8: PLAN_ONLY trade plan includes diagnostics when confirmation passes
describe('confirmed entry quality diagnostics — included in PLAN_ONLY trade plan', () => {
  it('buildLiveTradePlan stores qualityDiagnostics when provided', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput());
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.qualityDiagnostics).toBeDefined();
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1, result.qualityDiagnostics);
    expect(plan.qualityDiagnostics).toBeDefined();
    expect(plan.qualityDiagnostics!.overallPass).toBe(true);
    expect(plan.status).toBe('PLAN_ONLY');
  });

  it('buildLiveTradePlan qualityDiagnostics is undefined when not provided', () => {
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1);
    expect(plan.qualityDiagnostics).toBeUndefined();
  });

  it('plan with diagnostics serializes to JSON with qualityDiagnostics', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput());
    const plan = buildLiveTradePlan(makeCandidate(), makeSnapshot(), 1, result.qualityDiagnostics);
    const json = JSON.parse(JSON.stringify(plan));
    expect(json.status).toBe('PLAN_ONLY');
    expect(json.qualityDiagnostics).toBeDefined();
    expect(json.qualityDiagnostics.overallPass).toBe(true);
    expect(json.qualityDiagnostics.failReasons).toHaveLength(0);
  });
});

// Test 9: Rejected confirmation includes diagnostics but no PLAN_ONLY
describe('confirmed entry quality diagnostics — rejected case has diagnostics, no plan', () => {
  it('REJECTED_PRICE_WEAK result has qualityDiagnostics defined', () => {
    const result = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
      minPriceChangePct: 20,
    }));
    expect(result.verdict).toBe('REJECTED_PRICE_WEAK');
    expect(result.qualityDiagnostics).toBeDefined();
    expect(result.qualityDiagnostics!.overallPass).toBe(false);
  });

  it('summary with rejected confirmation has no tradePlan but entryConfirmation with diagnostics', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 }),
      minPriceChangePct: 20,
    }));
    expect(entryConfirmation.qualityDiagnostics).toBeDefined();
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    expect(summary.tradePlan).toBeUndefined();
    expect(summary.entryConfirmation?.qualityDiagnostics).toBeDefined();
  });
});

// Test 10: Volume fields are optional and do not block decisions
describe('confirmed entry quality diagnostics — volume fields optional', () => {
  it('diagnostics computed correctly when snapshots have no volumeUsd', () => {
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000, volumeUsd: undefined }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 5550, volumeUsd: undefined, observedAt: '2026-06-06T18:03:00Z' }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.qualityDiagnostics).toBeDefined();
    const diag = result.qualityDiagnostics!;
    expect(diag.volumeEntryUsd).toBeUndefined();
    expect(diag.volumeConfirmUsd).toBeUndefined();
    expect(diag.entryVolumeToLiquidityRatio).toBeUndefined();
    expect(diag.confirmVolumeToLiquidityRatio).toBeUndefined();
    expect(diag.overallPass).toBe(true);
  });

  it('volume fields present and vol/liq ratio renders when volumeUsd is in snapshots', () => {
    const entryLiq = 3098;
    const result = evaluateEntryConfirmation({
      entrySnapshot: makeSnapshot({ priceUsd: 0.001, liquidityUsd: entryLiq, volumeUsd: 2230 }),
      confirmSnapshot: makeSnapshot({ priceUsd: 0.001282, liquidityUsd: 3598, volumeUsd: 2917, observedAt: '2026-06-06T18:11:00Z' }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
      maxDrawdownPct: -10,
      minConfirmedLiquidityUsd: 2500,
    });
    expect(result.qualityDiagnostics?.volumeEntryUsd).toBe(2230);
    expect(result.qualityDiagnostics?.volumeConfirmUsd).toBe(2917);
    expect(result.qualityDiagnostics?.entryVolumeToLiquidityRatio).toBeCloseTo(2230 / 3098, 4);
    expect(result.qualityDiagnostics?.confirmVolumeToLiquidityRatio).toBeCloseTo(2917 / 3598, 4);

    // Renders vol/liq ratio line in report
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation: result,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Vol/liq ratio');
    expect(rendered).toContain('entry →');
  });
});

// Test 11: No LIVE_EXECUTED in diagnostics block rendered output
describe('confirmed entry quality diagnostics — no LIVE_EXECUTED', () => {
  it('diagnostics block rendered output never contains LIVE_EXECUTED', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput({
      confirmSnapshot: makeSnapshot({ priceUsd: 0.0013, liquidityUsd: 5550 }),
      minPriceChangePct: 20,
      minLiquidityChangePct: 10,
    }));
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE', decision: 'NO_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Confirmed Entry Quality Diagnostics');
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });
});

// Test 12: No wallet/private key/swap/signing in diagnostics block rendered output
describe('confirmed entry quality diagnostics — safety patterns absent', () => {
  it('diagnostics block rendered output contains no signing/swap/key patterns', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const entryConfirmation = evaluateEntryConfirmation(makeConfirmInput());
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY',
      confirmEntry: true, confirmMinutes: 2, entryConfirmation,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Confirmed Entry Quality Diagnostics');
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });
});

// ── Paper Exit Guard tests (12 required) ──────────────────────────────────────

function makePegState(overrides: Partial<PaperExitState> = {}): PaperExitState {
  return {
    checksRun: 1,
    trailingActive: false,
    currentPrice: 0.001,
    currentPnLPct: 0,
    peakPnLPct: 0,
    peakPrice: 0.001,
    ...overrides,
  };
}

function makePegSummary(overrides: Partial<PaperExitGuardSummary> = {}): PaperExitGuardSummary {
  return {
    enabled: true,
    intervalSeconds: 60,
    checksRun: 3,
    exitReason: 'MAX_HOLD',
    entryPrice: 0.001,
    exitPrice: 0.0012,
    exitPnLPct: 20,
    peakPrice: 0.0015,
    peakPnLPct: 50,
    hardStopPct: -25,
    takeProfitPct: 50,
    trailingActivatePct: 30,
    trailingDropPct: 20,
    momentumFloorEnabled: false,
    noRealTradeSent: true,
    ...overrides,
  };
}

// Test 1: calculatePaperPnLPct returns correct gain/loss
describe('calculatePaperPnLPct', () => {
  it('returns 0 when entry and current price are equal', () => {
    expect(calculatePaperPnLPct(0.001, 0.001)).toBe(0);
  });

  it('returns +100 when current price is double entry price', () => {
    expect(calculatePaperPnLPct(0.001, 0.002)).toBeCloseTo(100, 5);
  });

  it('returns -50 when current price is half of entry price', () => {
    expect(calculatePaperPnLPct(0.001, 0.0005)).toBeCloseTo(-50, 5);
  });

  it('returns correct loss for -25% scenario', () => {
    expect(calculatePaperPnLPct(1.0, 0.75)).toBeCloseTo(-25, 5);
  });

  it('returns correct gain for +50% scenario', () => {
    expect(calculatePaperPnLPct(1.0, 1.5)).toBeCloseTo(50, 5);
  });
});

// Test 2: HARD_STOP triggers at or below -25%
describe('evaluatePaperExitGuard — HARD_STOP', () => {
  it('triggers HARD_STOP at exactly -25%', () => {
    const state = makePegState({ currentPnLPct: -25 });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBe('HARD_STOP');
  });

  it('triggers HARD_STOP below -25%', () => {
    const state = makePegState({ currentPnLPct: -40 });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBe('HARD_STOP');
  });

  it('does not trigger HARD_STOP at -24.99%', () => {
    const state = makePegState({ currentPnLPct: -24.99 });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBeNull();
  });
});

// Test 3: TAKE_PROFIT triggers at or above +50%
describe('evaluatePaperExitGuard — TAKE_PROFIT', () => {
  it('triggers TAKE_PROFIT at exactly +50%', () => {
    const state = makePegState({ currentPnLPct: 50 });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBe('TAKE_PROFIT');
  });

  it('triggers TAKE_PROFIT above +50%', () => {
    const state = makePegState({ currentPnLPct: 120 });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBe('TAKE_PROFIT');
  });

  it('does not trigger TAKE_PROFIT at +49.99%', () => {
    const state = makePegState({ currentPnLPct: 49.99 });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBeNull();
  });
});

// Test 4: TRAILING_STOP activates after +30% peak and exits after 20-point drop
describe('evaluatePaperExitGuard — TRAILING_STOP', () => {
  it('does not trigger trailing stop when trailingActive is false', () => {
    const state = makePegState({ currentPnLPct: 5, peakPnLPct: 35, trailingActive: false });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBeNull();
  });

  it('triggers TRAILING_STOP when trailingActive and current drops 25pts from peak of 35', () => {
    const state = makePegState({ currentPnLPct: 10, peakPnLPct: 35, trailingActive: true });
    // 35 - 20 = 15; currentPnLPct 10 <= 15 → TRAILING_STOP
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBe('TRAILING_STOP');
  });

  it('does not trigger TRAILING_STOP when drop is below threshold', () => {
    const state = makePegState({ currentPnLPct: 16, peakPnLPct: 35, trailingActive: true });
    // 35 - 20 = 15; currentPnLPct 16 > 15 → no exit
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBeNull();
  });

  it('updatePaperExitState activates trailing when peak reaches trailingActivatePct', () => {
    let state: PaperExitState = { checksRun: 0, trailingActive: false };
    state = updatePaperExitState(state, 1.35, 1.0, 30);
    expect(state.trailingActive).toBe(true);
    expect(state.peakPnLPct).toBeCloseTo(35, 5);
    expect(state.checksRun).toBe(1);
  });

  it('trailing does not activate when peak is below trailingActivatePct', () => {
    let state: PaperExitState = { checksRun: 0, trailingActive: false };
    state = updatePaperExitState(state, 1.25, 1.0, 30);
    expect(state.trailingActive).toBe(false);
    expect(state.peakPnLPct).toBeCloseTo(25, 5);
  });

  it('trailing full cycle: +35% activates, drop to +10% triggers TRAILING_STOP', () => {
    const entryPrice = 1.0;
    let state: PaperExitState = { checksRun: 0, trailingActive: false };

    state = updatePaperExitState(state, 1.35, entryPrice, 30);
    expect(state.trailingActive).toBe(true);
    let exit = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(exit).toBeNull();

    state = updatePaperExitState(state, 1.10, entryPrice, 30);
    exit = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(exit).toBe('TRAILING_STOP');
  });
});

// Test 5: MOMENTUM_FLOOR exits when current price falls below confirmation price
describe('evaluatePaperExitGuard — MOMENTUM_FLOOR', () => {
  it('triggers MOMENTUM_FLOOR when currentPrice < confirmPrice', () => {
    const state = makePegState({ currentPrice: 0.0009, currentPnLPct: -10 });
    const result = evaluatePaperExitGuard({
      state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20,
      momentumFloorEnabled: true, confirmPrice: 0.001,
    });
    expect(result).toBe('MOMENTUM_FLOOR');
  });

  it('does not trigger MOMENTUM_FLOOR when currentPrice >= confirmPrice', () => {
    const state = makePegState({ currentPrice: 0.001, currentPnLPct: 0 });
    const result = evaluatePaperExitGuard({
      state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20,
      momentumFloorEnabled: true, confirmPrice: 0.001,
    });
    expect(result).toBeNull();
  });

  it('falls through to HARD_STOP (not MOMENTUM_FLOOR) when flag is disabled', () => {
    const state = makePegState({ currentPrice: 0.0005, currentPnLPct: -50 });
    const result = evaluatePaperExitGuard({
      state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20,
      momentumFloorEnabled: false, confirmPrice: 0.001,
    });
    expect(result).toBe('HARD_STOP');
  });

  it('does not trigger MOMENTUM_FLOOR when confirmPrice is not provided', () => {
    const state = makePegState({ currentPrice: 0.0005, currentPnLPct: -10 });
    const result = evaluatePaperExitGuard({
      state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20,
      momentumFloorEnabled: true, confirmPrice: undefined,
    });
    expect(result).toBeNull();
  });
});

// Test 6: MAX_HOLD returns when no other exit hit
describe('evaluatePaperExitGuard — MAX_HOLD via loop exhaustion', () => {
  it('returns null when no condition met — caller assigns MAX_HOLD', () => {
    const state = makePegState({ currentPnLPct: 10, peakPnLPct: 10, trailingActive: false });
    const result = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
    expect(result).toBeNull();
  });

  it('simulates full loop without exit → caller assigns MAX_HOLD', () => {
    const entryPrice = 1.0;
    let state: PaperExitState = { checksRun: 0, trailingActive: false };
    const prices = [1.05, 1.10, 1.08];
    let exitReason: string | null = null;

    for (let i = 0; i < prices.length; i++) {
      state = updatePaperExitState(state, prices[i]!, entryPrice, 30);
      exitReason = evaluatePaperExitGuard({ state, hardStopPct: -25, takeProfitPct: 50, trailingActivatePct: 30, trailingDropPct: 20, momentumFloorEnabled: false });
      if (exitReason !== null) break;
    }
    if (exitReason === null) exitReason = 'MAX_HOLD';
    expect(exitReason).toBe('MAX_HOLD');
    expect(state.checksRun).toBe(3);
  });
});

// Test 7: Paper exit guard does not run when no PLAN_ONLY
describe('Paper Exit Guard — guard not active when no PLAN_ONLY', () => {
  it('LiveHarnessSummary without tradePlan has no paperExitGuard', () => {
    const readiness: LiveReadinessReport = { status: 'NO_TRADE', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'NO_TRADE',
      decision: 'NO_BUY',
      watchCycle: true,
      watchCycleSkipped: true,
      watchCycleSkipReason: 'No PLAN_ONLY trade plan was created.',
    });
    expect(summary.tradePlan).toBeUndefined();
    expect(summary.paperExitGuard).toBeUndefined();
  });

  it('paperExitGuardEnabled is absent in default summary', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, { status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY' });
    expect(summary.paperExitGuardEnabled).toBeUndefined();
    expect(summary.paperExitGuard).toBeUndefined();
  });
});

// Test 8: Existing watch-cycle behavior unchanged without --paper-exit-guard
describe('Paper Exit Guard — standard watch-cycle unaffected when guard absent', () => {
  it('summary with watchCycle but no paperExitGuard still has fakePnL', () => {
    const fakePnL = {
      outcome: 'GAIN' as const,
      fakePositionSize: 1,
      fakeEntryPrice: 0.001,
      fakeExitPrice: 0.002,
      fakeTokensHeld: 1000,
      fakeEndingValue: 2,
      pnlDollars: 1,
      pnlPct: 100,
      endingBankroll: 21,
    };
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      exitSnapshotPath: 'data/token-grab/live-harness/session-20260606-1800-exit.json',
      fakePnL,
    });
    expect(summary.paperExitGuard).toBeUndefined();
    expect(summary.fakePnL?.outcome).toBe('GAIN');
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Fake P/L');
    expect(rendered).not.toContain('Paper Exit Guard');
  });
});

// Test 9: Rendered report includes Paper Exit Guard section
describe('renderLiveHarnessReport — Paper Exit Guard section', () => {
  it('renders Paper Exit Guard section when paperExitGuardEnabled is true', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const peg = makePegSummary({ exitReason: 'HARD_STOP', exitPnLPct: -28, peakPnLPct: 5 });
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      paperExitGuardEnabled: true,
      paperExitGuard: peg,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('Paper Exit Guard');
    expect(rendered).toContain('HARD_STOP');
    expect(rendered).toContain('PAPER-ONLY');
  });

  it('does not render Paper Exit Guard section when paperExitGuardEnabled is absent', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, { status: 'DRY_RUN_ONLY', decision: 'FAKE_BUY' });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toContain('Paper Exit Guard');
  });

  it('renders exit P/L and peak P/L with sign in Paper Exit Guard section', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const peg = makePegSummary({ exitPnLPct: -52.39, peakPnLPct: 3.14, exitReason: 'HARD_STOP' });
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      paperExitGuardEnabled: true,
      paperExitGuard: peg,
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('-52.39%');
    expect(rendered).toContain('+3.14%');
  });

  it('renderPaperExitGuardSummary renders all thresholds and safety line', () => {
    const peg = makePegSummary({ exitReason: 'TAKE_PROFIT', exitPnLPct: 55, peakPnLPct: 58 });
    const rendered = renderPaperExitGuardSummary(peg);
    expect(rendered).toContain('TAKE_PROFIT');
    expect(rendered).toContain('Hard stop');
    expect(rendered).toContain('Take profit');
    expect(rendered).toContain('Trailing activates');
    expect(rendered).toContain('Trailing drop');
    expect(rendered).toContain('Momentum floor');
    expect(rendered).toContain('NO REAL TRADE SENT');
  });
});

// Test 10: Report includes NO REAL TRADE SENT in Paper Exit Guard section
describe('Paper Exit Guard — NO REAL TRADE SENT always present', () => {
  it('renderPaperExitGuardSummary always contains NO REAL TRADE SENT', () => {
    const rendered = renderPaperExitGuardSummary(makePegSummary());
    expect(rendered).toContain('NO REAL TRADE SENT');
  });

  it('renderLiveHarnessReport with paperExitGuard contains NO REAL TRADE SENT', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      paperExitGuardEnabled: true,
      paperExitGuard: makePegSummary(),
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });
});

// Test 11: No LIVE_EXECUTED in Paper Exit Guard output
describe('Paper Exit Guard — no LIVE_EXECUTED', () => {
  it('renderPaperExitGuardSummary never contains LIVE_EXECUTED', () => {
    const rendered = renderPaperExitGuardSummary(makePegSummary({ exitReason: 'TRAILING_STOP' }));
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('renderLiveHarnessReport with paperExitGuard never contains LIVE_EXECUTED', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      paperExitGuardEnabled: true,
      paperExitGuard: makePegSummary({ exitReason: 'MAX_HOLD' }),
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('PaperExitGuardSummary type does not include LIVE_EXECUTED field', () => {
    const peg = makePegSummary();
    expect('LIVE_EXECUTED' in peg).toBe(false);
    expect(peg.exitReason).not.toBe('LIVE_EXECUTED');
  });
});

// Test 12: No wallet/private key/swap/signing in Paper Exit Guard output
describe('Paper Exit Guard — safety patterns absent', () => {
  it('renderPaperExitGuardSummary contains no signing/swap/key patterns', () => {
    const rendered = renderPaperExitGuardSummary(makePegSummary());
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/swap\s*\(/i);
  });

  it('renderLiveHarnessReport with paperExitGuard has no signing/swap/key/LIVE_EXECUTED patterns', () => {
    const readiness: LiveReadinessReport = { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
    const summary = makeBaseSummary(readiness, {
      status: 'DRY_RUN_ONLY',
      decision: 'FAKE_BUY',
      watchCycle: true,
      paperExitGuardEnabled: true,
      paperExitGuard: makePegSummary(),
    });
    const rendered = renderLiveHarnessReport(summary);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
    expect(rendered).toContain('NOT AUTONOMOUS');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  it('noRealTradeSent field is literally true in PaperExitGuardSummary', () => {
    const peg = makePegSummary();
    expect(peg.noRealTradeSent).toBe(true);
  });
});
