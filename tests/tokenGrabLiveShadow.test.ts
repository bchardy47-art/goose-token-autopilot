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
  DEFAULT_LIVE_SHADOW_CYCLES_DIR,
  DEFAULT_LIVE_SHADOW_FEED_PATH,
  DEFAULT_LIVE_SHADOW_STATE_PATH,
  DEFAULT_LIVE_SHADOW_EVENTS_PATH,
  DEFAULT_MAX_SOURCE_AGE_MINUTES,
  type LiveShadowEvent,
  type LiveShadowWouldBuyEvent,
  type LiveShadowState,
} from '../src/token-grab/liveShadow';

const NOW_MS = new Date('2026-07-01T12:00:00Z').getTime();
const nowIso = new Date(NOW_MS).toISOString();

// ── Cycle fixture helpers (fresh ripper cycle jsonl rows) ───────────────────────────────────

interface RowOpts {
  symbol?: string;
  capturedAt?: string;
  ripperScore?: number;
  launchAgeBucket?: string;
  buyGateDecision?: string;
  entryDecision?: string;
  entryMomentumPct?: number;   // m5 momentum → drives m5Band
  liquidityUsd?: number;       // → liquidity bucket
  volumeLiquidityRatio?: number; // → vlr bucket
  priceChangePct?: number;
  liquidityChangePct?: number;
  clusterRisk?: string;
  topReasons?: string[];
}

/** A pre-scored ripper cycle row that (with defaults) matches NO_BM_INTERNAL_BROAD + best-VLR. */
function cycleRow(contract: string, o: RowOpts = {}): Record<string, unknown> {
  const m5 = o.entryMomentumPct ?? -10;         // '-20 to -5' band
  const captured = o.capturedAt ?? nowIso;
  return {
    capturedAt: captured,
    ripperScore: o.ripperScore ?? 70,           // >= NO_BM_RESEARCH_MIN_SCORE (60)
    launchAgeBucket: o.launchAgeBucket ?? 'PRIME_WINDOW',
    buyGateDecision: o.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision: o.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    entryMomentumPct: m5,
    topReasons: o.topReasons ?? [`momentum ${m5}%`],
    ripperInput: { contract, clusterRisk: o.clusterRisk ?? 'UNKNOWN' },
    normalizedSignal: {
      contract,
      symbol: o.symbol ?? contract.slice(0, 4),
      liquidityUsd: o.liquidityUsd ?? 20_000,   // LIQ_10K_30K (near)
      volumeLiquidityRatio: o.volumeLiquidityRatio ?? 0.6,  // VLR_0_5_TO_2
      priceChangePct: o.priceChangePct ?? 35,
      liquidityChangePct: o.liquidityChangePct ?? 10,
      entryPriceChangeM5: m5,
      observedAt: captured,
    },
  };
}

function writeCycle(cyclesDir: string, slug: string, rows: Record<string, unknown>[]): string {
  fs.mkdirSync(cyclesDir, { recursive: true });
  const file = path.join(cyclesDir, `cycle-${slug}.jsonl`);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
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
function cyclesDirIn(base: string): string {
  const d = path.join(base, 'cycles');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ── Defaults / safety constants ──────────────────────────────────────────────────────────

describe('live-shadow default source', () => {
  it('default source is the FRESH ripper cycles dir, NOT the legacy winner-candidates file', () => {
    expect(DEFAULT_LIVE_SHADOW_CYCLES_DIR).toBe('data/token-grab/ripper/cycles');
    // The legacy constant still exists (explicit legacy/debug option only) but is not the default.
    expect(DEFAULT_LIVE_SHADOW_FEED_PATH).toBe('data/token-grab/legitimacy/dex-winner-candidates-today.json');
    expect(DEFAULT_LIVE_SHADOW_CYCLES_DIR).not.toBe(DEFAULT_LIVE_SHADOW_FEED_PATH);
  });
  it('default events/state paths live under data/token-grab/live-shadow/', () => {
    expect(DEFAULT_LIVE_SHADOW_EVENTS_PATH).toBe('data/token-grab/live-shadow/live-shadow-events.jsonl');
    expect(DEFAULT_LIVE_SHADOW_STATE_PATH.startsWith('data/token-grab/live-shadow/')).toBe(true);
  });
  it('has a sane default freshness window', () => {
    expect(DEFAULT_MAX_SOURCE_AGE_MINUTES).toBeGreaterThan(0);
  });
});

// ── Source selection ────────────────────────────────────────────────────────────────────────

describe('runLiveShadowCycle source selection', () => {
  it('reads the LATEST fresh ripper cycle by default (not an older cycle, not the legacy file)', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-110000', [cycleRow('OldToken11111111111111111111111111111111111')]);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('NewToken22222222222222222222222222222222222')]);

    const r = runLiveShadowCycle({
      cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS,
    });

    expect(r.source.sourceMode).toBe('FRESH_CYCLE');
    expect(r.sourceCycle).toBe('cycle-2026-07-01-115500');
    expect(r.source.sourceFile?.endsWith('cycle-2026-07-01-115500.jsonl')).toBe(true);
    expect(r.diagnostics.map(d => d.contract)).toEqual(['NewToken22222222222222222222222222222222222']);
    expect(r.source.staleSource).toBe(false);
  });

  it('does not use the legacy winner-candidates file unless --legacy-feed is passed explicitly', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('FreshToken1111111111111111111111111111111')]);
    const r = runLiveShadowCycle({
      cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS,
    });
    expect(r.source.sourceMode).toBe('FRESH_CYCLE');
    expect(r.source.sourceFile).not.toContain('dex-winner-candidates-today');
  });

  it('reports source freshness fields (file, timestamp, age, count, staleSource)', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('AToken111111111111111111111111111111111111A'),
      cycleRow('BToken222222222222222222222222222222222222B'),
    ]);
    const r = runLiveShadowCycle({
      cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS,
    });
    expect(r.source.sourceFile).toBeTruthy();
    expect(r.source.sourceTimestamp).toBe(nowIso);
    expect(r.source.sourceAgeMinutes).toBeCloseTo(0, 1);
    expect(r.source.candidateCount).toBe(2);
    expect(r.source.staleSource).toBe(false);
  });
});

// ── Freshness gate ──────────────────────────────────────────────────────────────────────────

describe('stale source handling', () => {
  it('skips with STALE_SOURCE and creates NO would-buy events when the newest cycle is too old', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const oldIso = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // 60 min old > 15 min window
    writeCycle(cyclesDir, '2026-07-01-110000', [cycleRow('StaleToken1111111111111111111111111111111', { capturedAt: oldIso })]);

    const eventsPath = path.join(dir, 'events.jsonl');
    const r = runLiveShadowCycle({
      cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath,
      diagnosticsPath: path.join(dir, 'diag.jsonl'), nowMs: NOW_MS,
    });

    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('STALE_SOURCE');
    expect(r.source.staleSource).toBe(true);
    expect(r.wouldBuyCount).toBe(0);
    expect(readEvents(eventsPath).filter(e => e.type === 'WOULD_BUY')).toHaveLength(0);
    for (const b of r.bankrollSummaries) expect(b.wouldBuys).toBe(0);

    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'diag.jsonl'), 'utf-8').trim());
    expect(rec.staleSource).toBe(true);
    expect(rec.ignoredByReason.STALE_SOURCE).toBe(1);
  });

  it('an empty cycles dir is treated as stale (no source) and produces no would-buy events', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const eventsPath = path.join(dir, 'events.jsonl');
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });
    expect(r.skipped).toBe(true);
    expect(r.wouldBuyCount).toBe(0);
    expect(readEvents(eventsPath)).toHaveLength(0);
  });
});

// ── Lane-based WOULD_BUY ──────────────────────────────────────────────────────────────────────

describe('internal shadow lanes drive WOULD_BUY', () => {
  it('a NO_BM_INTERNAL_BROAD match produces WOULD_BUY shadow events across all three tiers', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    // score 90, m5 0 (band -5 to +5 → not pullback), near liquidity, vlr 3 (VLR_GTE_2 → not best-vlr)
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('BroadToken1111111111111111111111111111111', { ripperScore: 90, entryMomentumPct: 0, volumeLiquidityRatio: 3 }),
    ]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });

    expect(r.laneMatchCounts.NO_BM_INTERNAL_BROAD).toBe(1);
    expect(r.laneMatchCounts.NO_BM_BEST_VLR).toBe(0);
    expect(r.readyCount).toBe(1);
    for (const b of r.bankrollSummaries) expect(b.wouldBuys).toBe(1);

    const buys = readEvents(eventsPath).filter(e => e.type === 'WOULD_BUY') as LiveShadowWouldBuyEvent[];
    expect(buys).toHaveLength(3);
    for (const ev of buys) {
      expect(ev.lane).toBe('NO_BM_INTERNAL_BROAD');
      expect(ev.paperOnly).toBe(true);
      expect(ev.liveShadowOnly).toBe(true);
      expect(ev.realTrading).toBe(false);
      expect(ev.notBuySignal).toBe(true);
      expect(ev.sourceCycle).toBe('cycle-2026-07-01-115500');
      for (const k of ['m5Band', 'liquidityBucket', 'vlrBucket', 'ripperScoreBand', 'clusterRisk'] as const) {
        expect(ev).toHaveProperty(k);
      }
    }
  });

  it('the VLR_0_5_TO_2 subgroup yields lane=NO_BM_BEST_VLR would-buy events', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('BestVlrToken11111111111111111111111111111', { volumeLiquidityRatio: 1.2 }), // 0.5<=vlr<2
    ]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });

    expect(r.laneMatchCounts.NO_BM_BEST_VLR).toBe(1);
    const buy = readEvents(eventsPath).find(e => e.type === 'WOULD_BUY') as LiveShadowWouldBuyEvent;
    expect(buy.lane).toBe('NO_BM_BEST_VLR');
    expect(buy.vlrBucket).toBe('VLR_0_5_TO_2');
  });

  it('a NO_BM_PULLBACK candidate (m5 -20..-5, liquidity near) is a lane match', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('PullbackToken1111111111111111111111111111', { entryMomentumPct: -12, volumeLiquidityRatio: 3 }),
    ]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(r.laneMatchCounts.NO_BM_PULLBACK).toBe(1);
    expect(r.diagnostics[0]!.matchesPullback).toBe(true);
  });

  it('production buy gate REJECTION does not block a shadow WOULD_BUY when a lane matches', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('RejectedGateToken1111111111111111111111111', { buyGateDecision: 'BUY_REJECTED', entryDecision: 'PAPER_BUY_BLOCKED' }),
    ]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });

    expect(r.productionGateApprovedCount).toBe(0);
    expect(r.readyCount).toBe(1);
    const buy = readEvents(eventsPath).find(e => e.type === 'WOULD_BUY') as LiveShadowWouldBuyEvent;
    expect(buy).toBeDefined();
    expect(buy.productionGateApproved).toBe(false);
    expect(buy.lane).toBe('NO_BM_BEST_VLR'); // default row is best-vlr
  });

  it('a candidate that matches NO lane is not bought (score below floor)', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('LowScoreToken1111111111111111111111111111', { ripperScore: 40 }),
    ]);
    const eventsPath = path.join(dir, 'events.jsonl');
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });
    expect(r.readyCount).toBe(0);
    for (const b of r.bankrollSummaries) expect(b.wouldBuys).toBe(0);
    expect(readEvents(eventsPath)).toHaveLength(0);
    expect(r.diagnostics[0]!.rejectReasons).toContain('SCORE_BELOW_FLOOR');
  });
});

// ── Safety / UNKNOWN handling ─────────────────────────────────────────────────────────────────

describe('runLiveShadowCycle safety', () => {
  it('never executes real trades — tradingExecuted=0, READY_FOR_REAL_TRADING=false, flags correct', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('SafeToken11111111111111111111111111111111A')]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(r.tradingExecuted).toBe(0);
    expect(r.readyForRealTrading).toBe(false);
    expect(r.liveShadowOnly).toBe(true);
    expect(r.realTrading).toBe(false);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
  });

  it('writes ONLY to the given state and events files (plus the cycles dir input)', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('WriteToken1111111111111111111111111111111')]);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS });
    const entries = fs.readdirSync(dir).sort();
    expect(entries).toEqual(['cycles', 'events.jsonl', 'state.json'].sort());
  });

  it('UNKNOWN risk labels stay UNKNOWN — never upgraded to CLEAN', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('UnknownToken11111111111111111111111111111', { clusterRisk: 'UNKNOWN' })]);
    const eventsPath = path.join(dir, 'events.jsonl');
    runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath, nowMs: NOW_MS });

    const buy = readEvents(eventsPath).find(e => e.type === 'WOULD_BUY') as any;
    expect(buy).toBeDefined();
    expect(buy.clusterRisk).toBe('UNKNOWN');
    expect(buy.riskLabels.clusterRisk).toBe('UNKNOWN');
    expect(buy.riskLabels.holderRisk).toBe('UNKNOWN');
    expect(JSON.stringify(buy)).not.toContain('"clusterRisk":"CLEAN"');
  });

  it('does not open a duplicate position for a contract already open on that tier', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const contract = 'DupToken1111111111111111111111111111111111';
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow(contract)]);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');

    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS });
    // Second cycle: newer file, same contract still present + fresh.
    writeCycle(cyclesDir, '2026-07-01-115600', [cycleRow(contract, { capturedAt: new Date(NOW_MS + 60_000).toISOString() })]);
    const r2 = runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS + 60_000 });

    for (const b of r2.bankrollSummaries) {
      expect(b.wouldBuys).toBe(0);
      expect(b.openPositions).toBe(1);
    }
    expect(r2.diagnostics[0]!.decision).toBe('BLOCKED');
    expect(r2.diagnostics[0]!.rejectReasons).toContain('DUPLICATE_OPEN_SHADOW_POSITION');
  });

  it('enforces the open-position cap per bankroll tier', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('CapToken1111111111111111111111111111111111'),
      cycleRow('CapToken2222222222222222222222222222222222'),
      cycleRow('CapToken3333333333333333333333333333333333'),
    ]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });

    expect(r.laneMatchCounts.NO_BM_BEST_VLR).toBe(3);
    const s20 = r.bankrollSummaries.find(b => b.bankroll === 20)!;
    expect(DEFAULT_RISK_LIMITS[20].openPositionCap).toBe(2);
    expect(s20.openPositions).toBe(2);
    expect(s20.wouldBuys).toBe(2);
    expect(s20.skippedByRiskLimit).toBe(1);

    const s100 = r.bankrollSummaries.find(b => b.bankroll === 100)!;
    expect(s100.openPositions).toBe(3);
    expect(s100.skippedByRiskLimit).toBe(0);
  });
});

// ── Exits ──────────────────────────────────────────────────────────────────────────────────

describe('WOULD_SELL exits', () => {
  it('closes a position with STOP_LOSS when the price crashes on the next cycle', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    const contract = 'CrashToken111111111111111111111111111111111';

    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow(contract, { priceChangePct: 35 })]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS });

    // Same contract crashes. Score below floor so it is NOT re-bought after the stop-loss exit
    // closes it — the exit reads the price snapshot, entries read the shadow lanes.
    const t2 = NOW_MS + 5 * 60_000;
    writeCycle(cyclesDir, '2026-07-01-116000', [cycleRow(contract, { priceChangePct: -70, ripperScore: 40, capturedAt: new Date(t2).toISOString() })]);
    const r2 = runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: t2 });

    for (const b of r2.bankrollSummaries) {
      expect(b.wouldSells).toBe(1);
      expect(b.openPositions).toBe(0);
    }
    const sells = readEvents(eventsPath).filter(e => e.type === 'WOULD_SELL');
    expect(sells).toHaveLength(3);
    for (const sell of sells as any[]) {
      expect(sell.exitReason).toBe('STOP_LOSS');
      expect(sell.pnlUsd).toBeLessThan(0);
      expect(sell.paperOnly).toBe(true);
    }
  });

  it('closes with DATA_STALE_EXIT when the token drops out of the newest cycle', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');

    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('GoneToken1111111111111111111111111111111')]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS });

    const t2 = NOW_MS + 60_000;
    writeCycle(cyclesDir, '2026-07-01-115600', [cycleRow('OtherToken222222222222222222222222222222', { capturedAt: new Date(t2).toISOString() })]);
    const r2 = runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: t2 });

    const sells = readEvents(eventsPath).filter(e => e.type === 'WOULD_SELL') as any[];
    expect(sells.length).toBeGreaterThan(0);
    expect(sells.every(s => s.exitReason === 'DATA_STALE_EXIT')).toBe(true);
    for (const b of r2.bankrollSummaries) expect(b.wouldSells).toBe(1);
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
  it('trips once a tier reaches its max daily loss, then blocks new buys on that tier only', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');

    // Seed: $20 tier already carries $3.90 realized daily loss and one open position.
    const state = loadOrCreateLiveShadowState(statePath, nowIso) as LiveShadowState;
    state.bankrolls[20].dailyLossUsd = 3.9;
    state.bankrolls[20].dailyResetDate = nowIso.slice(0, 10);
    state.bankrolls[20].openPositions = [{
      contract: 'SeededToken11111111111111111111111111111111', symbol: 'SEED', bankroll: 20,
      openedAt: nowIso, lane: 'NO_BM_BEST_VLR', sourceCycle: 'seed',
      entryPriceChangePct: 35, entryLiquidityChangePct: 10, entryVlr: 0.6, entryRipperScore: 80,
      positionSizeUsd: 2, peakPriceChangePct: 35,
      riskLabels: { ripperScore: 80, launchAgeBucket: 'PRIME_WINDOW', liquidityQuality: 'GOOD', holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN', botRisk: 'CLEAN' },
      status: 'OPEN',
    }];
    saveLiveShadowState(state, statePath);

    // Cycle 1: seeded position crashes → stop-loss pushes realized loss past $4.
    const t1 = NOW_MS + 60_000;
    writeCycle(cyclesDir, '2026-07-01-115600', [cycleRow('SeededToken11111111111111111111111111111111', { priceChangePct: -50, capturedAt: new Date(t1).toISOString() })]);
    const r1 = runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: t1 });
    expect(r1.bankrollSummaries.find(b => b.bankroll === 20)!.killSwitchActive).toBe(true);

    // Cycle 2: a fresh, otherwise-qualifying candidate must be skipped on $20 but bought on $50.
    const t2 = NOW_MS + 2 * 60_000;
    writeCycle(cyclesDir, '2026-07-01-115700', [cycleRow('FreshToken11111111111111111111111111111111', { capturedAt: new Date(t2).toISOString() })]);
    const r2 = runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: t2 });
    const s20 = r2.bankrollSummaries.find(b => b.bankroll === 20)!;
    expect(s20.wouldBuys).toBe(0);
    expect(s20.skippedByRiskLimit).toBeGreaterThan(0);
    expect(s20.killSwitchActive).toBe(true);

    const s50 = r2.bankrollSummaries.find(b => b.bankroll === 50)!;
    expect(s50.killSwitchActive).toBe(false);
    expect(s50.wouldBuys).toBe(1);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────────────────

describe('renderLiveShadowCycleSummary', () => {
  it('prints the required safety lines and source freshness', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('RenderToken1111111111111111111111111111111')]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    const text = renderLiveShadowCycleSummary(r);
    expect(text).toContain('LIVE_SHADOW_ONLY=true');
    expect(text).toContain('REAL_TRADING=false');
    expect(text).toContain('READY_FOR_REAL_TRADING=false');
    expect(text).toContain('NO_WALLET=true');
    expect(text).toContain('NO_SWAP=true');
    expect(text).toContain('NO_SIGNING=true');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('token:auto-paper NOT run');
    expect(text).toContain('token:paper-buy NOT run');
    expect(text).toContain('SOURCE FRESHNESS');
    expect(text).toContain('staleSource');
  });

  it('shows the STALE_SOURCE skip banner when the source is stale', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const oldIso = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    writeCycle(cyclesDir, '2026-07-01-110000', [cycleRow('StaleRender111111111111111111111111111111', { capturedAt: oldIso })]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(renderLiveShadowCycleSummary(r)).toContain('CYCLE SKIPPED — STALE_SOURCE');
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────────

describe('liveShadow module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/liveShadow.ts'), 'utf-8');
  it('never invokes token:auto-paper or token:paper-buy (no shelling out to other CLI commands)', () => {
    // The module only *mentions* these commands in negated documentation; it must never CALL them.
    expect(src).not.toMatch(/execSync|spawn|child_process|require\(['"]\.\/cli/);
  });
  it('no --live flag is parsed anywhere', () => {
    expect(src).not.toMatch(/'--live'|"--live"|process\.argv[\s\S]{0,20}--live/);
  });
  it('no wallet signing / swap / private key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|swapExecute|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
  });
  it('no code path relabels UNKNOWN to CLEAN', () => {
    expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
  });
  it('READY_FOR_REAL_TRADING stays false', () => {
    expect(src).toMatch(/READY_FOR_REAL_TRADING\s*=\s*false/);
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
