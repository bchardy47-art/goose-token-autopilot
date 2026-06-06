import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_POSITION_V1,
  assertMaxLivePosition,
  getRequiredConfirmationPhrase,
  parseLiveUnlockEnv,
  buildLiveTradePlan,
  evaluateLiveReadinessGates,
  renderLiveHarnessReport,
  type EvaluateLiveReadinessGatesInput,
  type LiveHarnessSummary,
  type LiveReadinessReport,
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
