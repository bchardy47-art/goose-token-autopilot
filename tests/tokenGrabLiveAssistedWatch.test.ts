import { describe, expect, it } from 'vitest';
import {
  chooseLiveAssistedCandidate,
  isFakeBuyEligible,
  calculateFakePosition,
  calculateFakePnL,
  buildLiveAssistedSummary,
  renderLiveAssistedReport,
} from '../src/token-grab/liveAssistedWatch';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from '../src/token-grab/autopsy';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<TokenGrabAutopsyCandidate> = {}): TokenGrabAutopsyCandidate {
  return {
    id: 'tg-001',
    tokenName: 'TestToken',
    ticker: 'TEST',
    contractAddress: 'TestContractAddress11111111111111111111',
    poolAddress: 'TestPoolAddress111111111111111111111111',
    lane: 'EARLY_VELOCITY_WATCH',
    decision: 'WATCH',
    scoreAtDetection: 0,
    detectedAt: '2026-06-06T14:00:00Z',
    reasons: ['Early volume/liquidity ratio 0.76'],
    redFlags: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<TokenGrabAutopsySnapshot> = {}): TokenGrabAutopsySnapshot {
  return {
    candidateId: 'tg-001',
    observedAt: '2026-06-06T14:01:00Z',
    minutesAfterDetection: 1,
    priceUsd: 0.001,
    liquidityUsd: 5000,
    volumeUsd: 3800,
    source: 'geckoterminal',
    ...overrides,
  };
}

function makeBaseSummaryInput() {
  return {
    ts: '20260606-1400',
    sessionPath: '/data/live-assisted/session-20260606-1400.json',
    entrySnapshotPath: '/data/live-assisted/session-20260606-1400-entry.json',
    exitSnapshotPath: '/data/live-assisted/session-20260606-1400-exit.json',
    fakeBankroll: 20,
    maxFakePosition: 5,
    watchMinutes: 10,
    candidatesDetected: 20,
    laneSummary: { EARLY_VELOCITY_WATCH: 2, NOISE_RUG_LIKELY: 18 },
    watchWorthyCount: 2,
    skipSleepMode: false,
  };
}

// ── Test 1: No watch-worthy candidates → NO_BUY, bankroll unchanged ───────────

describe('chooseLiveAssistedCandidate', () => {
  it('returns undefined when watchCandidates is empty', () => {
    const result = chooseLiveAssistedCandidate([], []);
    expect(result).toBeUndefined();
  });

  it('prefers EARLY_VELOCITY_WATCH over FRESH_LAUNCH_CANDIDATE', () => {
    const evw = makeCandidate({ id: 'tg-001', lane: 'EARLY_VELOCITY_WATCH' });
    const flc = makeCandidate({ id: 'tg-002', lane: 'FRESH_LAUNCH_CANDIDATE', scoreAtDetection: 80 });
    const snapshotEvw = makeSnapshot({ candidateId: 'tg-001' });
    const snapshotFlc = makeSnapshot({ candidateId: 'tg-002' });
    const result = chooseLiveAssistedCandidate([flc, evw], [snapshotEvw, snapshotFlc]);
    expect(result?.candidate.id).toBe('tg-001');
  });

  it('falls back to first sorted candidate when no valid snapshot exists', () => {
    const c = makeCandidate({ id: 'tg-001', lane: 'EARLY_VELOCITY_WATCH' });
    const result = chooseLiveAssistedCandidate([c], []);
    expect(result?.candidate.id).toBe('tg-001');
    expect(result?.snapshot).toBeUndefined();
  });
});

// ── Test 2: EARLY_VELOCITY_WATCH with valid snapshot → FAKE_BUY eligible ─────

describe('isFakeBuyEligible', () => {
  it('returns true for EARLY_VELOCITY_WATCH with valid snapshot', () => {
    const c = makeCandidate({ lane: 'EARLY_VELOCITY_WATCH' });
    const s = makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(true);
  });

  // Test 10: FRESH_LAUNCH_CANDIDATE can be fake-buy eligible
  it('returns true for FRESH_LAUNCH_CANDIDATE with valid snapshot', () => {
    const c = makeCandidate({ lane: 'FRESH_LAUNCH_CANDIDATE', decision: 'ALERT_ONLY' });
    const s = makeSnapshot({ priceUsd: 0.005, liquidityUsd: 10000 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(true);
  });

  // Test 3: Failed/missing entry snapshot → NO_BUY
  it('returns false when snapshot is undefined', () => {
    const c = makeCandidate({ lane: 'EARLY_VELOCITY_WATCH' });
    expect(isFakeBuyEligible(c, undefined, 5, 20)).toBe(false);
  });

  it('returns false when snapshot has no price', () => {
    const c = makeCandidate({ lane: 'EARLY_VELOCITY_WATCH' });
    const s = makeSnapshot({ priceUsd: undefined });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(false);
  });

  it('returns false when snapshot price is zero', () => {
    const c = makeCandidate({ lane: 'EARLY_VELOCITY_WATCH' });
    const s = makeSnapshot({ priceUsd: 0 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(false);
  });

  it('returns false when entry liquidity is below $1000', () => {
    const c = makeCandidate({ lane: 'EARLY_VELOCITY_WATCH' });
    const s = makeSnapshot({ liquidityUsd: 500 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(false);
  });

  // Test 4: Max fake position cannot exceed fake bankroll
  it('returns false when maxPosition exceeds bankroll', () => {
    const c = makeCandidate({ lane: 'EARLY_VELOCITY_WATCH' });
    const s = makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 });
    expect(isFakeBuyEligible(c, s, 25, 20)).toBe(false);
  });

  // Test 11: NOISE_RUG_LIKELY is not fake-buy eligible
  it('returns false for NOISE_RUG_LIKELY', () => {
    const c = makeCandidate({ lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' });
    const s = makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(false);
  });

  it('returns false for PRE_LAUNCH_WATCH', () => {
    const c = makeCandidate({ lane: 'PRE_LAUNCH_WATCH', decision: 'WATCH' });
    const s = makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(false);
  });

  it('returns false for MEME_EVENT_CANDIDATE', () => {
    const c = makeCandidate({ lane: 'MEME_EVENT_CANDIDATE', decision: 'WATCH' });
    const s = makeSnapshot({ priceUsd: 0.001, liquidityUsd: 5000 });
    expect(isFakeBuyEligible(c, s, 5, 20)).toBe(false);
  });
});

// ── Test 4: calculateFakePosition ─────────────────────────────────────────────

describe('calculateFakePosition', () => {
  it('returns maxPosition when it is less than bankroll', () => {
    expect(calculateFakePosition(20, 5)).toBe(5);
  });

  it('caps at bankroll when maxPosition exceeds bankroll', () => {
    expect(calculateFakePosition(20, 25)).toBe(20);
  });

  it('returns bankroll when maxPosition equals bankroll', () => {
    expect(calculateFakePosition(20, 20)).toBe(20);
  });
});

// ── Test 5: Fake P/L — gain ───────────────────────────────────────────────────

describe('calculateFakePnL', () => {
  it('correctly calculates a gain', () => {
    const positionSize = 5;
    const entryPrice = 0.001;
    const fakeTokensHeld = positionSize / entryPrice; // 5000
    const exitPrice = 0.002; // 2× entry
    const result = calculateFakePnL(positionSize, entryPrice, fakeTokensHeld, exitPrice, 20);

    expect(result.outcome).toBe('GAIN');
    expect(result.pnlPct).toBeCloseTo(100, 4);
    expect(result.pnlDollars).toBeCloseTo(5, 4);
    expect(result.fakeEndingValue).toBeCloseTo(10, 4);
    expect(result.endingBankroll).toBeCloseTo(25, 4);
  });

  // Test 6: Fake P/L — loss
  it('correctly calculates a loss', () => {
    const positionSize = 5;
    const entryPrice = 0.001;
    const fakeTokensHeld = positionSize / entryPrice; // 5000
    const exitPrice = 0.0005; // 0.5× entry
    const result = calculateFakePnL(positionSize, entryPrice, fakeTokensHeld, exitPrice, 20);

    expect(result.outcome).toBe('LOSS');
    expect(result.pnlPct).toBeCloseTo(-50, 4);
    expect(result.pnlDollars).toBeCloseTo(-2.5, 4);
    expect(result.fakeEndingValue).toBeCloseTo(2.5, 4);
    expect(result.endingBankroll).toBeCloseTo(17.5, 4);
  });

  it('returns UNKNOWN outcome when exitPrice is undefined', () => {
    const positionSize = 5;
    const entryPrice = 0.001;
    const fakeTokensHeld = 5000;
    const result = calculateFakePnL(positionSize, entryPrice, fakeTokensHeld, undefined, 20);

    expect(result.outcome).toBe('UNKNOWN');
    expect(result.pnlDollars).toBe(0);
    expect(result.pnlPct).toBe(0);
    expect(result.endingBankroll).toBe(20);
  });

  it('returns UNKNOWN when exitPrice is zero', () => {
    const result = calculateFakePnL(5, 0.001, 5000, 0, 20);
    expect(result.outcome).toBe('UNKNOWN');
  });

  it('returns FLAT for small movement', () => {
    const positionSize = 5;
    const entryPrice = 0.001;
    const fakeTokensHeld = 5000;
    const exitPrice = 0.001005; // +0.5%
    const result = calculateFakePnL(positionSize, entryPrice, fakeTokensHeld, exitPrice, 20);
    expect(result.outcome).toBe('FLAT');
  });
});

// ── Test 1 (summary path): NO_BUY, ending bankroll unchanged ─────────────────

describe('buildLiveAssistedSummary', () => {
  it('NO_BUY sets endingBankroll to fakeBankroll and decision to NO_BUY', () => {
    const summary = buildLiveAssistedSummary({
      ...makeBaseSummaryInput(),
      watchWorthyCount: 0,
      decision: 'NO_BUY',
      noBuyReason: 'No watch-worthy candidates found.',
    });

    expect(summary.decision).toBe('NO_BUY');
    expect(summary.endingBankroll).toBe(20);
    expect(summary.fakeBuy).toBeUndefined();
    expect(summary.fakePnL).toBeUndefined();
    expect(summary.noRealTradingExecuted).toBe(true);
    expect(summary.autoPaperNotRun).toBe(true);
    expect(summary.noWalletOrSwapUsed).toBe(true);
  });

  it('FAKE_BUY summary uses fakePnL endingBankroll when pnl is present', () => {
    const fakePnL = {
      outcome: 'GAIN' as const,
      fakePositionSize: 5,
      fakeEntryPrice: 0.001,
      fakeExitPrice: 0.002,
      fakeTokensHeld: 5000,
      fakeEndingValue: 10,
      pnlDollars: 5,
      pnlPct: 100,
      endingBankroll: 25,
    };
    const summary = buildLiveAssistedSummary({
      ...makeBaseSummaryInput(),
      decision: 'FAKE_BUY',
      fakePnL,
    });

    expect(summary.decision).toBe('FAKE_BUY');
    expect(summary.endingBankroll).toBe(25);
    expect(summary.noRealTradingExecuted).toBe(true);
    expect(summary.autoPaperNotRun).toBe(true);
  });

  // Test 12: JSON mode summary has expected shape
  it('summary object serializes to valid JSON with all required fields', () => {
    const summary = buildLiveAssistedSummary({
      ...makeBaseSummaryInput(),
      decision: 'NO_BUY',
      noBuyReason: 'No candidates.',
    });
    const json = JSON.parse(JSON.stringify(summary));

    expect(json.ts).toBe('20260606-1400');
    expect(json.decision).toBe('NO_BUY');
    expect(json.noRealTradingExecuted).toBe(true);
    expect(json.autoPaperNotRun).toBe(true);
    expect(json.noWalletOrSwapUsed).toBe(true);
    expect(typeof json.fakeBankroll).toBe('number');
    expect(typeof json.endingBankroll).toBe('number');
    expect(typeof json.watchWorthyCount).toBe('number');
  });
});

// ── Tests 7, 8, 9: renderLiveAssistedReport safety text ──────────────────────

describe('renderLiveAssistedReport', () => {
  function makeNoBuySummary() {
    return buildLiveAssistedSummary({
      ...makeBaseSummaryInput(),
      decision: 'NO_BUY',
      noBuyReason: 'No watch-worthy candidates.',
    });
  }

  // Test 7: Report includes NO REAL TRADING EXECUTED
  it('contains NO REAL TRADING EXECUTED', () => {
    const rendered = renderLiveAssistedReport(makeNoBuySummary());
    expect(rendered).toContain('NO REAL TRADING EXECUTED');
  });

  // Test 8: Report includes token:auto-paper was NOT run
  it('contains token:auto-paper was NOT run', () => {
    const rendered = renderLiveAssistedReport(makeNoBuySummary());
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  // Test 9: Report does not include real execution instructions
  it('does not contain real execution code patterns', () => {
    const rendered = renderLiveAssistedReport(makeNoBuySummary());
    // Must not contain code-like execution call syntax
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/swapExact\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    // Must not contain directives to actually place a real trade
    expect(rendered).not.toMatch(/EXECUTE\s+(BUY|SELL|SWAP|TRADE)/i);
  });

  it('shows NO_BUY reason in output', () => {
    const rendered = renderLiveAssistedReport(makeNoBuySummary());
    expect(rendered).toContain('NO_BUY');
    expect(rendered).toContain('No watch-worthy candidates.');
  });

  it('shows FAKE_BUY details and P/L in output for a buy scenario', () => {
    const fakeBuy = {
      candidateId: 'tg-001',
      tokenName: 'MANLET',
      ticker: 'MANLET',
      lane: 'EARLY_VELOCITY_WATCH' as const,
      fakePositionSize: 5,
      fakeEntryPrice: 0.0001,
      fakeLiquidityAtEntry: 5000,
      fakeTokensHeld: 50000,
      paperStopNote: 'Paper stop only; no real order placed',
      fakeExitRule: 'Exit at 10-minute snapshot',
    };
    const fakePnL = {
      outcome: 'GAIN' as const,
      fakePositionSize: 5,
      fakeEntryPrice: 0.0001,
      fakeExitPrice: 0.0002,
      fakeTokensHeld: 50000,
      fakeEndingValue: 10,
      pnlDollars: 5,
      pnlPct: 100,
      endingBankroll: 25,
    };
    const summary = buildLiveAssistedSummary({
      ...makeBaseSummaryInput(),
      decision: 'FAKE_BUY',
      fakeBuy,
      fakePnL,
    });
    const rendered = renderLiveAssistedReport(summary);
    expect(rendered).toContain('MANLET');
    expect(rendered).toContain('FAKE_BUY');
    expect(rendered).toContain('GAIN');
    expect(rendered).toContain('NO REAL TRADING EXECUTED');
    expect(rendered).toContain('token:auto-paper was NOT run');
    expect(rendered).toContain('Paper stop only; no real order placed');
    expect(rendered).not.toContain('signTransaction');
    expect(rendered).not.toContain('sendTransaction');
  });
});
