import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runLiveShadowCycle,
  loadOrCreateLiveShadowState,
  saveLiveShadowState,
  checkRiskLimits,
  renderLiveShadowCycleSummary,
  BANKROLL_TIERS,
  DEFAULT_RISK_LIMITS,
  DEFAULT_LIVE_SHADOW_FEED_PATH,
  DEFAULT_LIVE_SHADOW_STATE_PATH,
  DEFAULT_LIVE_SHADOW_EVENTS_PATH,
  type LiveShadowEvent,
  type LiveShadowState,
} from '../src/token-grab/liveShadow';

const NOW_MS = new Date('2026-06-10T12:00:00Z').getTime();

// ── Fixture helpers ──────────────────────────────────────────────────────────────────────

interface FixtureCandidate {
  contract: string;
  symbol?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
}

/** Defaults reproduce the "clean prime-window setup" fixture from tokenGrabDexRipperEngine.test.ts,
 *  which is proven to yield BUY_APPROVED_PAPER under DEFAULT_RIPPER_CONFIG. */
function writeFeed(dir: string, candidates: FixtureCandidate[]): string {
  const filePath = path.join(dir, 'feed.json');
  const report = {
    generatedAt: new Date(NOW_MS).toISOString(),
    candidateCount: candidates.length,
    candidates: candidates.map(c => ({
      tier: 'WATCH',
      contract: c.contract,
      symbol: c.symbol ?? 'TEST',
      observedAt: c.observedAt ?? new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      priceChangePct: c.priceChangePct ?? 35,
      liquidityChangePct: c.liquidityChangePct ?? 10,
      volumeLiquidityRatio: c.volumeLiquidityRatio ?? 0.6,
      confidence: 'MEDIUM',
      reasons: [],
      missingSafetySignals: [],
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

function readEvents(eventsPath: string): LiveShadowEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-shadow-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true });
});

// ── Defaults / safety constants ──────────────────────────────────────────────────────────

describe('live-shadow default paths', () => {
  it('default events/state paths live under data/token-grab/live-shadow/', () => {
    expect(DEFAULT_LIVE_SHADOW_EVENTS_PATH).toBe('data/token-grab/live-shadow/live-shadow-events.jsonl');
    expect(DEFAULT_LIVE_SHADOW_STATE_PATH.startsWith('data/token-grab/live-shadow/')).toBe(true);
  });
  it('default feed path points at the live/current candidates feed', () => {
    expect(DEFAULT_LIVE_SHADOW_FEED_PATH).toBe('data/token-grab/legitimacy/dex-winner-candidates-today.json');
  });
});

// ── runLiveShadowCycle ────────────────────────────────────────────────────────────────────

describe('runLiveShadowCycle', () => {
  it('never executes real trades — tradingExecuted=0 and safety flags true/false as specified', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, []);
    const result = runLiveShadowCycle({
      feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.liveShadowOnly).toBe(true);
    expect(result.realTrading).toBe(false);
    expect(result.noWallet).toBe(true);
    expect(result.noSwap).toBe(true);
    expect(result.noSigning).toBe(true);
  });

  it('writes ONLY to the given state and events files — no other files created', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, [{ contract: 'Contract1' }]);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    runLiveShadowCycle({ feedPath, statePath, eventsPath, nowMs: NOW_MS });

    const entries = fs.readdirSync(dir).sort();
    expect(entries).toEqual(['events.jsonl', 'feed.json', 'state.json'].sort());
  });

  it('opens a WOULD_BUY position across all three bankroll tiers for a qualifying candidate', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, [{ contract: 'GoodToken111111111111111111111111111111111' }]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const result = runLiveShadowCycle({
      feedPath, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS,
    });

    expect(result.approvedCount).toBe(1);
    for (const summary of result.bankrollSummaries) {
      expect(summary.wouldBuys).toBe(1);
      expect(summary.openPositions).toBe(1);
    }

    const events = readEvents(eventsPath);
    const buys = events.filter(e => e.type === 'WOULD_BUY');
    expect(buys).toHaveLength(3); // one per bankroll tier
    for (const tier of BANKROLL_TIERS) {
      const ev = buys.find(e => e.bankroll === tier);
      expect(ev).toBeDefined();
      expect(ev!.positionSizeUsd).toBe(DEFAULT_RISK_LIMITS[tier].maxPositionSizeUsd);
      expect(ev!.liveShadowOnly).toBe(true);
      expect(ev!.realTrading).toBe(false);
      expect(ev!.noWallet).toBe(true);
      expect(ev!.noSwap).toBe(true);
      expect(ev!.noSigning).toBe(true);
    }
  });

  it('UNKNOWN risk labels stay UNKNOWN — never upgraded to CLEAN', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, [{ contract: 'CleanUnknownToken111111111111111111111111111' }]);
    const eventsPath = path.join(dir, 'events.jsonl');
    runLiveShadowCycle({ feedPath, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });

    const events = readEvents(eventsPath);
    const buy = events.find(e => e.type === 'WOULD_BUY') as any;
    expect(buy).toBeDefined();
    expect(buy.riskLabels.clusterRisk).toBe('UNKNOWN');
    expect(buy.riskLabels.holderRisk).toBe('UNKNOWN');
    expect(JSON.stringify(buy.riskLabels)).not.toContain('"clusterRisk":"CLEAN"');
  });

  it('does not open a duplicate position for a contract already open on that tier', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, [{ contract: 'DupToken1111111111111111111111111111111111' }]);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');

    runLiveShadowCycle({ feedPath, statePath, eventsPath, nowMs: NOW_MS });
    const result2 = runLiveShadowCycle({ feedPath, statePath, eventsPath, nowMs: NOW_MS + 60_000 });

    for (const summary of result2.bankrollSummaries) {
      expect(summary.wouldBuys).toBe(0);
      expect(summary.openPositions).toBe(1);
    }
  });

  it('closes a position with a WOULD_SELL event when the stop-loss threshold is breached', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    const contract = 'CrashToken111111111111111111111111111111111';

    const feed1 = writeFeed(dir, [{ contract }]);
    runLiveShadowCycle({ feedPath: feed1, statePath, eventsPath, nowMs: NOW_MS });

    // Price crashes hard on the next cycle (still within the prime window).
    const feed2 = writeFeed(dir, [{ contract, priceChangePct: -70 }]);
    const result2 = runLiveShadowCycle({ feedPath: feed2, statePath, eventsPath, nowMs: NOW_MS + 5 * 60_000 });

    for (const summary of result2.bankrollSummaries) {
      expect(summary.wouldSells).toBe(1);
      expect(summary.openPositions).toBe(0);
    }

    const events = readEvents(eventsPath);
    const sells = events.filter(e => e.type === 'WOULD_SELL');
    expect(sells).toHaveLength(3);
    for (const sell of sells as any[]) {
      expect(sell.exitReason).toBe('STOP_LOSS');
      expect(sell.pnlPct).toBeLessThan(0);
      expect(sell.pnlUsd).toBeLessThan(0);
    }
  });

  it('enforces the open-position cap per bankroll tier', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, [
      { contract: 'CapToken1111111111111111111111111111111111' },
      { contract: 'CapToken2222222222222222222222222222222222' },
      { contract: 'CapToken3333333333333333333333333333333333' },
    ]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const result = runLiveShadowCycle({
      feedPath, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS,
    });

    expect(result.approvedCount).toBe(3);

    const s20 = result.bankrollSummaries.find(b => b.bankroll === 20)!;
    expect(DEFAULT_RISK_LIMITS[20].openPositionCap).toBe(2);
    expect(s20.openPositions).toBe(2);
    expect(s20.wouldBuys).toBe(2);
    expect(s20.skippedByRiskLimit).toBe(1);

    const s100 = result.bankrollSummaries.find(b => b.bankroll === 100)!;
    expect(s100.openPositions).toBe(3);
    expect(s100.skippedByRiskLimit).toBe(0);
  });

  it('does not loosen gates — a candidate that fails the standard buy gate is not bought', () => {
    const dir = tmpDir();
    // holderConcentrationStatus not set here, but a risky liquidity pattern (SUSPICIOUS) always blocks.
    const feedPath = writeFeed(dir, [{ contract: 'RiskyToken111111111111111111111111111111111', volumeLiquidityRatio: 7 }]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const result = runLiveShadowCycle({
      feedPath, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS,
    });

    expect(result.approvedCount).toBe(0);
    for (const summary of result.bankrollSummaries) {
      expect(summary.wouldBuys).toBe(0);
    }
    expect(readEvents(eventsPath)).toHaveLength(0);
  });
});

// ── checkRiskLimits ───────────────────────────────────────────────────────────────────────

describe('checkRiskLimits', () => {
  const cfg = DEFAULT_RISK_LIMITS[20];

  it('blocks when kill-switch is active', () => {
    const bs = { killSwitchActive: true, killSwitchReason: 'daily loss cap hit', openPositions: [], dailyBuyCount: 0 } as any;
    const r = checkRiskLimits(bs, cfg);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('daily loss cap hit');
  });

  it('blocks when open position cap reached', () => {
    const bs = { killSwitchActive: false, openPositions: new Array(cfg.openPositionCap).fill({}), dailyBuyCount: 0 } as any;
    expect(checkRiskLimits(bs, cfg).allowed).toBe(false);
  });

  it('blocks when max daily buys reached', () => {
    const bs = { killSwitchActive: false, openPositions: [], dailyBuyCount: cfg.maxDailyBuys } as any;
    expect(checkRiskLimits(bs, cfg).allowed).toBe(false);
  });

  it('allows when under all limits', () => {
    const bs = { killSwitchActive: false, openPositions: [], dailyBuyCount: 0 } as any;
    expect(checkRiskLimits(bs, cfg).allowed).toBe(true);
  });
});

// ── Kill switch trips on cumulative daily loss ──────────────────────────────────────────

describe('kill-switch', () => {
  it('trips once a tier accumulates losses at or beyond its max daily loss, then blocks new buys on that tier', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    const nowIso = new Date(NOW_MS).toISOString();

    // Seed state: $20 tier already carries $3.90 of realized daily loss and one open position.
    const state = loadOrCreateLiveShadowState(statePath, nowIso) as LiveShadowState;
    state.bankrolls[20].dailyLossUsd = 3.9;
    state.bankrolls[20].dailyResetDate = nowIso.slice(0, 10);
    state.bankrolls[20].openPositions = [{
      contract: 'SeededToken11111111111111111111111111111111',
      symbol: 'SEED',
      bankroll: 20,
      openedAt: nowIso,
      entryPriceChangePct: 35,
      entryLiquidityChangePct: 10,
      entryVlr: 0.6,
      entryRipperScore: 80,
      positionSizeUsd: 2,
      peakPriceChangePct: 35,
      riskLabels: {
        ripperScore: 80, launchAgeBucket: 'PRIME_WINDOW', liquidityQuality: 'GOOD',
        holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN', botRisk: 'CLEAN',
      },
      status: 'OPEN',
    }];
    saveLiveShadowState(state, statePath);

    // Cycle 1: seeded position crashes hard → stop-loss realizes a loss that pushes past $4.
    const feed1 = writeFeed(dir, [{ contract: 'SeededToken11111111111111111111111111111111', priceChangePct: -50 }]);
    const r1 = runLiveShadowCycle({ feedPath: feed1, statePath, eventsPath, nowMs: NOW_MS + 60_000 });
    const s20After = r1.bankrollSummaries.find(b => b.bankroll === 20)!;
    expect(s20After.killSwitchActive).toBe(true);

    // Cycle 2: a fresh, otherwise-qualifying candidate must be skipped on the $20 tier.
    const feed2 = writeFeed(dir, [{ contract: 'FreshToken11111111111111111111111111111111' }]);
    const r2 = runLiveShadowCycle({ feedPath: feed2, statePath, eventsPath, nowMs: NOW_MS + 2 * 60_000 });
    const s20Cycle2 = r2.bankrollSummaries.find(b => b.bankroll === 20)!;
    expect(s20Cycle2.wouldBuys).toBe(0);
    expect(s20Cycle2.skippedByRiskLimit).toBeGreaterThan(0);
    expect(s20Cycle2.killSwitchActive).toBe(true);

    // Other tiers are unaffected — their own limits/kill-switches are independent.
    const s50Cycle2 = r2.bankrollSummaries.find(b => b.bankroll === 50)!;
    expect(s50Cycle2.killSwitchActive).toBe(false);
    expect(s50Cycle2.wouldBuys).toBe(1);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────────────────

describe('renderLiveShadowCycleSummary', () => {
  it('always prints the required safety lines', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, []);
    const result = runLiveShadowCycle({
      feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS,
    });
    const text = renderLiveShadowCycleSummary(result);
    expect(text).toContain('LIVE_SHADOW_ONLY=true');
    expect(text).toContain('REAL_TRADING=false');
    expect(text).toContain('NO_WALLET=true');
    expect(text).toContain('NO_SWAP=true');
    expect(text).toContain('NO_SIGNING=true');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('token:auto-paper NOT run');
    expect(text).toContain('token:paper-buy NOT run');
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────────

describe('liveShadow module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/liveShadow.ts'), 'utf-8');
  it('never invokes token:auto-paper or token:paper-buy (no shelling out to other CLI commands)', () => {
    expect(src).not.toMatch(/execSync|spawn|child_process|require\(['"]\.\/cli/);
  });
  it('no --live flag is parsed anywhere', () => {
    expect(src).not.toMatch(/'--live'|"--live"|process\.argv[\s\S]{0,20}--live/);
  });
  it('no wallet signing / swap / private key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|swapExecute|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
  });
});

describe('CLI wiring for token:live-shadow introduces no unsafe behavior', () => {
  const cliSrc = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf-8');
  function extractCase(caseName: string): string {
    const re = new RegExp(`case '${caseName}':([\\s\\S]*?)\\n      case '`, 'm');
    const match = cliSrc.match(re);
    expect(match, `expected to find case '${caseName}' in cli.ts`).toBeTruthy();
    return match![1];
  }

  it('token:live-shadow case has no --live flag, no auto-paper, no paper-buy', () => {
    const block = extractCase('token:live-shadow');
    expect(block).not.toContain('--live');
    expect(block).not.toContain('token:auto-paper');
    expect(block).not.toContain('token:paper-buy');
  });

  it('token:live-shadow-report case has no --live flag, no auto-paper, no paper-buy', () => {
    const block = extractCase('token:live-shadow-report');
    expect(block).not.toContain('--live');
    expect(block).not.toContain('token:auto-paper');
    expect(block).not.toContain('token:paper-buy');
  });
});
