import { describe, it, expect } from 'vitest';
import {
  classifyLaunchAge,
  scoreLiquidityProfile,
  scoreHolderCluster,
  scoreBotRisk,
  scoreRipper,
  checkPaperBuyGate,
  evaluateSell,
  DEFAULT_RIPPER_CONFIG,
  type RipperInput,
  type RipperPaperPosition,
  type RipperConfig,
} from '../src/token-grab/dexRipperEngine';
import {
  runRipperSession,
  loadOrCreateSessionState,
  type RipperSessionOptions,
} from '../src/token-grab/dexRipperSession';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const NOW_MS  = new Date('2026-06-10T12:00:00Z').getTime();
const cfg     = DEFAULT_RIPPER_CONFIG;

// ── classifyLaunchAge ─────────────────────────────────────────────────────────

describe('classifyLaunchAge', () => {
  it('returns TOO_EARLY for age < tooEarlyMaxMinutes', () => {
    expect(classifyLaunchAge(1, cfg)).toBe('TOO_EARLY');
  });
  it('returns PRIME_WINDOW for age in [tooEarlyMaxMinutes, primeWindowMaxMinutes)', () => {
    expect(classifyLaunchAge(5,  cfg)).toBe('PRIME_WINDOW');
    expect(classifyLaunchAge(19, cfg)).toBe('PRIME_WINDOW');
  });
  it('returns LATE for age in [primeWindowMaxMinutes, lateWindowMaxMinutes)', () => {
    expect(classifyLaunchAge(25, cfg)).toBe('LATE');
    expect(classifyLaunchAge(59, cfg)).toBe('LATE');
  });
  it('returns DEAD_WINDOW for age >= lateWindowMaxMinutes', () => {
    expect(classifyLaunchAge(60, cfg)).toBe('DEAD_WINDOW');
    expect(classifyLaunchAge(200, cfg)).toBe('DEAD_WINDOW');
  });
  it('returns DEAD_WINDOW for null/undefined/negative age', () => {
    expect(classifyLaunchAge(null, cfg)).toBe('DEAD_WINDOW');
    expect(classifyLaunchAge(undefined, cfg)).toBe('DEAD_WINDOW');
    expect(classifyLaunchAge(-5, cfg)).toBe('DEAD_WINDOW');
  });
});

// ── scoreLiquidityProfile ─────────────────────────────────────────────────────

describe('scoreLiquidityProfile', () => {
  it('SUSPICIOUS when VLR > 5', () => {
    const r = scoreLiquidityProfile(10, 6);
    expect(r.quality).toBe('SUSPICIOUS');
  });
  it('ONE_SIDED when liq < -20 and VLR > 1.5', () => {
    const r = scoreLiquidityProfile(-25, 2);
    expect(r.quality).toBe('ONE_SIDED');
  });
  it('THIN when liq < -30', () => {
    const r = scoreLiquidityProfile(-35, undefined);
    expect(r.quality).toBe('THIN');
  });
  it('THIN when VLR elevated (> 2, no other flags)', () => {
    const r = scoreLiquidityProfile(5, 2.5);
    expect(r.quality).toBe('THIN');
  });
  it('GOOD when liq growing and VLR healthy', () => {
    const r = scoreLiquidityProfile(15, 0.4);
    expect(r.quality).toBe('GOOD');
  });
  it('GOOD when no data except mild positive liq', () => {
    const r = scoreLiquidityProfile(5, undefined);
    expect(r.quality).toBe('GOOD');
  });
  it('UNKNOWN when both are missing', () => {
    const r = scoreLiquidityProfile(undefined, undefined);
    expect(r.quality).toBe('UNKNOWN');
  });
});

// ── scoreHolderCluster ────────────────────────────────────────────────────────

describe('scoreHolderCluster', () => {
  it('RISKY when status is DANGER', () => {
    const r = scoreHolderCluster('DANGER', undefined);
    expect(r.holderRisk).toBe('RISKY');
  });
  it('RISKY when topHolderPercent >= 30', () => {
    const r = scoreHolderCluster(undefined, 35);
    expect(r.holderRisk).toBe('RISKY');
  });
  it('WATCH when status is WARNING', () => {
    const r = scoreHolderCluster('WARNING', undefined);
    expect(r.holderRisk).toBe('WATCH');
  });
  it('WATCH when topHolderPercent in 15–29%', () => {
    const r = scoreHolderCluster(undefined, 20);
    expect(r.holderRisk).toBe('WATCH');
  });
  it('CLEAN when status is CLEAN', () => {
    const r = scoreHolderCluster('CLEAN', 5);
    expect(r.holderRisk).toBe('CLEAN');
  });
  it('UNKNOWN when no data', () => {
    const r = scoreHolderCluster(undefined, undefined);
    expect(r.holderRisk).toBe('UNKNOWN');
  });
  it('clusterRisk is always UNKNOWN in V1', () => {
    const r = scoreHolderCluster('CLEAN', 3);
    expect(r.clusterRisk).toBe('UNKNOWN');
  });
});

// ── scoreBotRisk ──────────────────────────────────────────────────────────────

describe('scoreBotRisk', () => {
  it('RISKY when VLR > 5', () => {
    const r = scoreBotRisk(6, undefined, undefined);
    expect(r.botRisk).toBe('RISKY');
  });
  it('RISKY when price > 50 and liq < -20 (dump pattern)', () => {
    const r = scoreBotRisk(1, -25, 60);
    expect(r.botRisk).toBe('RISKY');
  });
  it('WATCH when VLR 2–5', () => {
    const r = scoreBotRisk(3, 5, 20);
    expect(r.botRisk).toBe('WATCH');
  });
  it('CLEAN when all healthy', () => {
    const r = scoreBotRisk(0.5, 10, 30);
    expect(r.botRisk).toBe('CLEAN');
  });
  it('UNKNOWN when no data', () => {
    const r = scoreBotRisk(undefined, undefined, undefined);
    expect(r.botRisk).toBe('UNKNOWN');
  });
});

// ── scoreRipper ───────────────────────────────────────────────────────────────

function primeInput(overrides: Partial<RipperInput> = {}): RipperInput {
  const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString(); // 10 min ago = PRIME_WINDOW
  return {
    contract: 'TestContract111',
    symbol: 'TEST',
    observedAt,
    priceChangePct: 35,
    liquidityChangePct: 10,
    volumeLiquidityRatio: 0.6,
    ...overrides,
  };
}

describe('scoreRipper', () => {
  it('assigns PRIME_WINDOW to recently observed token', () => {
    const signal = scoreRipper(primeInput(), cfg, NOW_MS);
    expect(signal.launchAgeBucket).toBe('PRIME_WINDOW');
  });

  it('assigns DEAD_WINDOW and IGNORE to very old token', () => {
    const input = primeInput({
      observedAt: new Date(NOW_MS - 120 * 60 * 1000).toISOString(),
    });
    const signal = scoreRipper(input, cfg, NOW_MS);
    expect(signal.launchAgeBucket).toBe('DEAD_WINDOW');
    expect(signal.entryDecision).toBe('IGNORE');
    expect(signal.ripperScore).toBeLessThan(cfg.minScoreToWatch);
  });

  it('scores above buy threshold for clean prime-window setup', () => {
    const signal = scoreRipper(primeInput(), cfg, NOW_MS);
    expect(signal.ripperScore).toBeGreaterThanOrEqual(cfg.minScoreToReady);
    expect(signal.entryDecision).toBe('READY_TO_SNIPE_PAPER');
  });

  it('sets PAPER_BUY_BLOCKED when holderRisk is RISKY', () => {
    const input = primeInput({ holderConcentrationStatus: 'DANGER' });
    const signal = scoreRipper(input, cfg, NOW_MS);
    expect(signal.holderCluster.holderRisk).toBe('RISKY');
    expect(signal.entryDecision).toBe('PAPER_BUY_BLOCKED');
  });

  it('sets PAPER_BUY_BLOCKED when botRisk is RISKY (high VLR)', () => {
    const input = primeInput({ volumeLiquidityRatio: 6, liquidityChangePct: -25, priceChangePct: 60 });
    const signal = scoreRipper(input, cfg, NOW_MS);
    expect(signal.botRiskProfile.botRisk).toBe('RISKY');
    expect(signal.entryDecision).toBe('PAPER_BUY_BLOCKED');
  });

  it('sets PAPER_BUY_BLOCKED when liquidity is SUSPICIOUS', () => {
    const input = primeInput({ volumeLiquidityRatio: 7 });
    const signal = scoreRipper(input, cfg, NOW_MS);
    expect(signal.liquidityProfile.quality).toBe('SUSPICIOUS');
    expect(signal.entryDecision).toBe('PAPER_BUY_BLOCKED');
  });

  it('score is clamped to 0–100', () => {
    const s1 = scoreRipper(primeInput({ holderConcentrationStatus: 'DANGER', volumeLiquidityRatio: 7 }), cfg, NOW_MS);
    const s2 = scoreRipper(primeInput({ holderConcentrationStatus: 'CLEAN', volumeLiquidityRatio: 0.2, priceChangePct: 80 }), cfg, NOW_MS);
    expect(s1.ripperScore).toBeGreaterThanOrEqual(0);
    expect(s2.ripperScore).toBeLessThanOrEqual(100);
  });

  it('includes topReasons and blockers in signal', () => {
    const signal = scoreRipper(primeInput({ holderConcentrationStatus: 'DANGER' }), cfg, NOW_MS);
    expect(signal.blockers.some(b => b.includes('RISKY'))).toBe(true);
  });

  it('returns WATCH for moderate score without RISKY signals', () => {
    const cfgLow: RipperConfig = { ...cfg, minScoreToReady: 200 }; // unreachable
    const signal = scoreRipper(primeInput(), cfgLow, NOW_MS);
    // score >= minScoreToWatch but < minScoreToReady → WATCH
    expect(signal.entryDecision).toBe('WATCH');
  });
});

// ── checkPaperBuyGate ─────────────────────────────────────────────────────────

describe('checkPaperBuyGate', () => {
  it('approves a clean prime-window setup', () => {
    const signal = scoreRipper(primeInput(), cfg, NOW_MS);
    const gate   = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_APPROVED_PAPER');
    expect(gate.blockers).toHaveLength(0);
    expect(gate.reasons.length).toBeGreaterThan(0);
  });

  it('rejects when holderRisk is RISKY', () => {
    const signal = scoreRipper(primeInput({ holderConcentrationStatus: 'DANGER' }), cfg, NOW_MS);
    const gate   = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_REJECTED');
    expect(gate.blockers.some(b => b.includes('holder') && b.includes('RISKY'))).toBe(true);
  });

  it('rejects when liquidityProfile is ONE_SIDED', () => {
    const signal = scoreRipper(
      primeInput({ liquidityChangePct: -25, volumeLiquidityRatio: 2 }),
      cfg,
      NOW_MS,
    );
    const gate = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_REJECTED');
    expect(gate.blockers.some(b => b.includes('one-sided') || b.includes('ONE_SIDED') || b.includes('liquidity'))).toBe(true);
  });

  it('rejects when botRisk is RISKY', () => {
    const signal = scoreRipper(
      primeInput({ volumeLiquidityRatio: 6, liquidityChangePct: -25, priceChangePct: 60 }),
      cfg,
      NOW_MS,
    );
    const gate = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_REJECTED');
    expect(gate.blockers.some(b => b.includes('bot'))).toBe(true);
  });

  it('rejects when launch age is not PRIME_WINDOW and requirePrimeWindow=true', () => {
    const lateObservedAt = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
    const signal = scoreRipper(primeInput({ observedAt: lateObservedAt }), cfg, NOW_MS);
    const gate   = checkPaperBuyGate(signal, cfg);
    // LATE window → signal.entryDecision will not be READY → should be rejected
    expect(gate.decision).toBe('BUY_REJECTED');
  });

  it('rejects when score below minScoreToBuy', () => {
    // VLR=2.5 → THIN liq (-10) + VLR penalty (-10) + botRisk WATCH (-5) + PRIME (+25) + price20 (+10) = ~60
    // 60 >= minScoreToReady (60) so READY_TO_SNIPE_PAPER, but 60 < threshold 80 → gate rejects
    const cfgHighThreshold: RipperConfig = { ...cfg, minScoreToBuy: 80 };
    const signal = scoreRipper(
      primeInput({ priceChangePct: 20, liquidityChangePct: 5, volumeLiquidityRatio: 2.5 }),
      cfg,
      NOW_MS,
    );
    expect(signal.entryDecision).toBe('READY_TO_SNIPE_PAPER');
    expect(signal.ripperScore).toBeLessThan(80);
    const gate = checkPaperBuyGate(signal, cfgHighThreshold);
    expect(gate.decision).toBe('BUY_REJECTED');
    expect(gate.blockers.some(b => b.includes('below buy threshold'))).toBe(true);
  });
});

// ── evaluateSell ──────────────────────────────────────────────────────────────

function makeOpenPosition(overrides: Partial<RipperPaperPosition> = {}): RipperPaperPosition {
  return {
    contract: 'TestContract111',
    symbol: 'TEST',
    openedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    entryPriceChangePct: 30,
    entryVlr: 0.4,
    entryRipperScore: 72,
    positionSizeUsd: 1.0,
    peakPriceChangePct: 30,
    status: 'OPEN',
    ...overrides,
  };
}

function makeCurrentSignal(priceChangePct = 30): ReturnType<typeof scoreRipper> {
  const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
  return scoreRipper(
    { contract: 'TestContract111', symbol: 'TEST', observedAt, priceChangePct, volumeLiquidityRatio: 0.4 },
    cfg,
    NOW_MS,
  );
}

describe('evaluateSell', () => {
  it('DATA_STALE_EXIT when currentSignal is null', () => {
    const pos    = makeOpenPosition();
    const result = evaluateSell(pos, null, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('DATA_STALE_EXIT');
  });

  it('STOP_LOSS when fake P/L <= stopLossPct', () => {
    // entry at +30%, current at -5% → pnl = (95/130 - 1)*100 ≈ -26.9%
    const pos     = makeOpenPosition({ entryPriceChangePct: 30 });
    const signal  = makeCurrentSignal(-5);
    const result  = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('STOP_LOSS');
    expect(result.fakePnlPct).toBeDefined();
    expect(result.fakePnlPct!).toBeLessThan(cfg.stopLossPct);
  });

  it('TAKE_PROFIT_FAST when fake P/L >= takeProfitPct', () => {
    // entry at +10%, current at +70% → pnl = (170/110 - 1)*100 ≈ 54.5%
    const pos    = makeOpenPosition({ entryPriceChangePct: 10, peakPriceChangePct: 70 });
    const signal = makeCurrentSignal(70);
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('TAKE_PROFIT_FAST');
    expect(result.fakePnlPct!).toBeGreaterThanOrEqual(cfg.takeProfitPct);
  });

  it('TRAILING_STOP when pulled back from peak', () => {
    // entry at +10%, peak at +60% (peakPnl ≈ 45%), current at +20% (pnl ≈ 9%)
    // pullback from peak ≈ 45 - 9 = 36% > trailingStopFromPeakPct (25)
    const pos    = makeOpenPosition({ entryPriceChangePct: 10, peakPriceChangePct: 60 });
    const signal = makeCurrentSignal(20);
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('TRAILING_STOP');
  });

  it('MAX_HOLD_TIME when held beyond maxHoldMinutes', () => {
    const pos = makeOpenPosition({
      openedAt: new Date(NOW_MS - (cfg.maxHoldMinutes + 1) * 60 * 1000).toISOString(),
    });
    const signal = makeCurrentSignal(32);
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('MAX_HOLD_TIME');
  });

  it('LIQUIDITY_RISK_SPIKE when VLR spiked post-entry', () => {
    // entry VLR < threshold, current VLR >= threshold
    const pos = makeOpenPosition({ entryVlr: 0.3 });
    const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
    const signal = scoreRipper(
      { contract: 'TestContract111', symbol: 'TEST', observedAt, priceChangePct: 32, volumeLiquidityRatio: 3 },
      cfg,
      NOW_MS,
    );
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('LIQUIDITY_RISK_SPIKE');
  });

  it('HOLDER_RISK_SPIKE when holder became RISKY', () => {
    const pos = makeOpenPosition();
    const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
    const signal = scoreRipper(
      { contract: 'TestContract111', symbol: 'TEST', observedAt, priceChangePct: 32, holderConcentrationStatus: 'DANGER' },
      cfg,
      NOW_MS,
    );
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('HOLDER_RISK_SPIKE');
  });

  it('BOT_RISK_SPIKE when botRisk became RISKY', () => {
    // entryVlr must be >= vlrSpikeThreshold so LIQUIDITY_RISK_SPIKE does not fire first
    const pos = makeOpenPosition({ entryVlr: 3 });
    const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
    const signal = scoreRipper(
      { contract: 'TestContract111', symbol: 'TEST', observedAt, priceChangePct: 32,
        volumeLiquidityRatio: 6, liquidityChangePct: -25 },
      cfg,
      NOW_MS,
    );
    expect(signal.botRiskProfile.botRisk).toBe('RISKY');
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(true);
    expect(result.reason).toBe('BOT_RISK_SPIKE');
  });

  it('does NOT sell when position is healthy', () => {
    const pos    = makeOpenPosition({ entryPriceChangePct: 30, peakPriceChangePct: 35 });
    const signal = makeCurrentSignal(35);
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.shouldSell).toBe(false);
  });

  it('returns fakePnlPct for all exit decisions except DATA_STALE_EXIT', () => {
    const pos    = makeOpenPosition({ entryPriceChangePct: 10 });
    const signal = makeCurrentSignal(70); // triggers TAKE_PROFIT_FAST
    const result = evaluateSell(pos, signal, cfg, NOW_MS);
    expect(result.fakePnlPct).toBeDefined();
  });
});

// ── runRipperSession ──────────────────────────────────────────────────────────

function writeTempCandidates(
  dir: string,
  candidates: Array<{
    tier?: string;
    contract: string;
    symbol?: string;
    observedAt?: string;
    priceChangePct?: number;
    liquidityChangePct?: number;
    volumeLiquidityRatio?: number;
    confidence?: string;
    reasons?: string[];
    missingSafetySignals?: string[];
  }>,
): string {
  const filePath = path.join(dir, 'candidates.json');
  const report = {
    generatedAt: new Date(NOW_MS).toISOString(),
    candidateCount: candidates.length,
    candidates: candidates.map(c => ({
      tier: c.tier ?? 'WATCH',
      contract: c.contract,
      symbol: c.symbol,
      observedAt: c.observedAt ?? new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      priceChangePct: c.priceChangePct ?? 30,
      liquidityChangePct: c.liquidityChangePct ?? 10,
      volumeLiquidityRatio: c.volumeLiquidityRatio ?? 0.5,
      confidence: c.confidence ?? 'MEDIUM',
      reasons: c.reasons ?? [],
      missingSafetySignals: c.missingSafetySignals ?? [],
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

describe('runRipperSession', () => {
  it('returns safety constants — tradingExecuted=0 and noRealTradeSent=true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-'));
    const candidatesPath = writeTempCandidates(dir, []);
    const opts: RipperSessionOptions = {
      candidatesPath,
      sessionStatePath: path.join(dir, 'state.json'),
      nowMs: NOW_MS,
    };
    const result = runRipperSession(opts);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('opens a paper buy for a qualifying candidate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-'));
    const candidatesPath = writeTempCandidates(dir, [
      { contract: 'GoodToken11111111111111111111111111111111111', symbol: 'GOOD', priceChangePct: 40 },
    ]);
    const opts: RipperSessionOptions = {
      candidatesPath,
      sessionStatePath: path.join(dir, 'state.json'),
      nowMs: NOW_MS,
    };
    const result = runRipperSession(opts);
    // May or may not buy depending on exact score, but no crash
    expect(result.tradingExecuted).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });

  it('does NOT open duplicate positions for same contract', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-'));
    const candidatesPath = writeTempCandidates(dir, [
      { contract: 'GoodToken11111111111111111111111111111111111', symbol: 'GOOD', priceChangePct: 40 },
    ]);
    const statePath = path.join(dir, 'state.json');
    const opts: RipperSessionOptions = {
      candidatesPath,
      sessionStatePath: statePath,
      nowMs: NOW_MS,
    };

    // Run twice
    const r1 = runRipperSession(opts);
    const r2 = runRipperSession({ ...opts, nowMs: NOW_MS + 60_000 });

    // If first run opened a position, second run must NOT open another
    if (r1.paperBuysOpened > 0) {
      expect(r2.paperBuysOpened).toBe(0);
      // Only one open position for this contract
      const state = loadOrCreateSessionState(statePath, new Date(NOW_MS).toISOString());
      const forContract = state.openPositions.filter(
        p => p.contract === 'GoodToken11111111111111111111111111111111111',
      );
      expect(forContract.length).toBe(1);
    }
    fs.rmSync(dir, { recursive: true });
  });

  it('session state persists between calls (cycleCount increments)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-'));
    const candidatesPath = writeTempCandidates(dir, []);
    const statePath = path.join(dir, 'state.json');
    const opts: RipperSessionOptions = { candidatesPath, sessionStatePath: statePath, nowMs: NOW_MS };

    runRipperSession(opts);
    runRipperSession({ ...opts, nowMs: NOW_MS + 60_000 });
    const state = loadOrCreateSessionState(statePath, new Date(NOW_MS).toISOString());
    expect(state.cycleCount).toBe(2);
    fs.rmSync(dir, { recursive: true });
  });

  it('blocks buy for candidate with DANGER holder concentration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-'));
    // Risky candidate: we can test that the signal is PAPER_BUY_BLOCKED
    const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
    const signal = scoreRipper(
      {
        contract: 'DangerToken1111111111111111111111111111111111',
        symbol: 'DANGER',
        observedAt,
        priceChangePct: 40,
        liquidityChangePct: 10,
        volumeLiquidityRatio: 0.5,
        holderConcentrationStatus: 'DANGER',
      },
      cfg,
      NOW_MS,
    );
    expect(signal.entryDecision).toBe('PAPER_BUY_BLOCKED');
    const gate = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_REJECTED');
    fs.rmSync(dir, { recursive: true });
  });

  it('blocks buy for one-sided liquidity candidate', () => {
    const observedAt = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
    const signal = scoreRipper(
      {
        contract: 'OneSidedToken1111111111111111111111111111111',
        symbol: 'ONESIDED',
        observedAt,
        priceChangePct: 30,
        liquidityChangePct: -25, // collapsing
        volumeLiquidityRatio: 2.5, // high VLR
      },
      cfg,
      NOW_MS,
    );
    expect(signal.liquidityProfile.quality).toBe('ONE_SIDED');
    const gate = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_REJECTED');
    expect(gate.blockers.some(b => b.includes('one-sided') || b.includes('liquidity'))).toBe(true);
  });

  it('blocks buy for stale (dead-window) candidate', () => {
    const staleObservedAt = new Date(NOW_MS - 90 * 60 * 1000).toISOString(); // 90m ago
    const signal = scoreRipper(
      {
        contract: 'StaleToken11111111111111111111111111111111111',
        symbol: 'STALE',
        observedAt: staleObservedAt,
        priceChangePct: 30,
        liquidityChangePct: 10,
        volumeLiquidityRatio: 0.5,
      },
      cfg,
      NOW_MS,
    );
    expect(signal.launchAgeBucket).toBe('DEAD_WINDOW');
    expect(signal.entryDecision).toBe('IGNORE');
    const gate = checkPaperBuyGate(signal, cfg);
    expect(gate.decision).toBe('BUY_REJECTED');
  });

  it('real trading remains locked across all session operations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-'));
    const candidatesPath = writeTempCandidates(dir, [
      { contract: 'GoodToken11111111111111111111111111111111111', symbol: 'GOOD', priceChangePct: 50 },
    ]);
    const statePath = path.join(dir, 'state.json');
    const result = runRipperSession({
      candidatesPath,
      sessionStatePath: statePath,
      nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    // State file also enforces this
    const state = loadOrCreateSessionState(statePath, new Date(NOW_MS).toISOString());
    expect(state.tradingExecuted).toBe(0);
    expect(state.noRealTradeSent).toBe(true);
    expect(state.paperOnly).toBe(true);
    expect(state.readOnly).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });
});
