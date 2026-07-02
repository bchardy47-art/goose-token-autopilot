import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordResearchShadow,
  loadOrCreateResearchShadowState,
  RESEARCH_NOTIONAL_USD,
  BANKROLL_CAP_REACHED,
  DEFAULT_RESEARCH_SHADOW_EVENTS_PATH,
  DEFAULT_RESEARCH_SHADOW_STATE_PATH,
  type ResearchWouldBuyEvent,
  type ResearchWouldSellEvent,
} from '../src/token-grab/researchShadow';
import { resolveLiveShadowSource, type ShadowCandidate } from '../src/token-grab/liveShadow';

const NOW_MS = new Date('2026-07-01T12:00:00Z').getTime();

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

interface RowOpts { priceUsd?: number | null; symbol?: string; buyGateDecision?: string; launchAgeBucket?: string; }

/** A pre-scored ripper cycle row that (with defaults) matches NO_BM_BEST_VLR (⊂ NO_BM_INTERNAL_BROAD). */
function cycleRow(contract: string, o: RowOpts = {}): Record<string, unknown> {
  const m5 = -10;                                   // '-20 to -5' band
  const capturedIso = new Date(NOW_MS).toISOString();
  const priceUsd = o.priceUsd === undefined ? 0.001 : o.priceUsd;
  const raw = priceUsd == null
    ? { contract }
    : { contract, entry: { contract, priceUsd }, final: { contract, priceUsd } };
  return {
    capturedAt: capturedIso,
    ripperScore: 70,
    launchAgeBucket: o.launchAgeBucket ?? 'PRIME_WINDOW',
    buyGateDecision: o.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision: 'READY_TO_SNIPE_PAPER',
    entryMomentumPct: m5,
    topReasons: [`momentum ${m5}%`],
    ripperInput: { contract, clusterRisk: 'UNKNOWN' },
    raw,
    normalizedSignal: {
      contract,
      symbol: o.symbol ?? contract.slice(0, 4),
      liquidityUsd: 20_000,
      volumeLiquidityRatio: 0.6,
      priceChangePct: 35,
      liquidityChangePct: 10,
      entryPriceChangeM5: m5,
      observedAt: capturedIso,
    },
  };
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-shadow-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Write one cycle file and resolve it into ShadowCandidates (+ its sourceCycle slug). */
function resolveCycle(rows: Record<string, unknown>[], slug: string, nowMs: number): { candidates: ShadowCandidate[]; sourceCycle: string } {
  const dir = tmpDir();
  const cyclesDir = path.join(dir, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.writeFileSync(path.join(cyclesDir, `cycle-${slug}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  const resolved = resolveLiveShadowSource(
    { cyclesDir, statePath: path.join(dir, 's.json'), eventsPath: path.join(dir, 'e.jsonl') },
    nowMs,
  );
  return { candidates: resolved.candidates, sourceCycle: resolved.sourceCycle };
}

function readEvents(eventsPath: string): (ResearchWouldBuyEvent | ResearchWouldSellEvent)[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const C1 = 'ResearchAAAA1111111111111111111111111111111';
const C2 = 'ResearchBBBB2222222222222222222222222222222';
const C3 = 'ResearchCCCC3333333333333333333333333333333';

// ── Recording lane matches independent of bankroll ──────────────────────────────────────────

describe('recordResearchShadow — bankroll independence', () => {
  it('records a RESEARCH_WOULD_BUY for every lane match, annotating bankroll-capped contracts', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const statePath  = path.join(dir, 'state.json');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(C1), cycleRow(C2), cycleRow(C3)], '2026-07-01-115500', NOW_MS);

    // Pretend the bankroll tier could only open C1; C2 + C3 were blocked by risk caps.
    const res = recordResearchShadow({
      candidates, sourceCycle, nowMs: NOW_MS, statePath, eventsPath,
      bankrollBlockedContracts: new Set([C2, C3]),
    });

    expect(res.researchBuys).toBe(3);
    const buys = readEvents(eventsPath).filter((e): e is ResearchWouldBuyEvent => e.type === 'RESEARCH_WOULD_BUY');
    expect(buys).toHaveLength(3);
    const blocked = buys.filter(b => b.bankrollBlockedReason === BANKROLL_CAP_REACHED).map(b => b.contract).sort();
    expect(blocked).toEqual([C2, C3].sort());
    // The one the bankroll could open carries no blocked reason.
    expect(buys.find(b => b.contract === C1)!.bankrollBlockedReason).toBeUndefined();
  });

  it('records the required event fields including valuation and lane descriptors', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(C1)], '2026-07-01-115500', NOW_MS);
    recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(dir, 'st.json'), eventsPath });

    const buy = readEvents(eventsPath).find((e): e is ResearchWouldBuyEvent => e.type === 'RESEARCH_WOULD_BUY')!;
    expect(buy.contract).toBe(C1);
    expect(buy.lane).toBeTruthy();
    expect(buy.m5Band).toBeTruthy();
    expect(buy.liquidityBucket).toBeTruthy();
    expect(buy.vlrBucket).toBeTruthy();
    expect(buy.ripperScoreBand).toBeTruthy();
    expect(buy.ripperScore).toBe(70);
    expect(buy.entryValuation).toBe(0.001);
    expect(buy.valuationField).toBe('priceUsd');
    expect(buy.clusterRisk).toBe('UNKNOWN');       // UNKNOWN stays UNKNOWN
    expect(buy.launchAgeBucket).toBe('PRIME_WINDOW');
    expect(buy.paperOnly).toBe(true);
    expect(buy.researchOnly).toBe(true);
    expect(buy.realTrading).toBe(false);
    expect(buy.noWallet).toBe(true);
    expect(buy.noSwap).toBe(true);
    expect(buy.noSigning).toBe(true);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────────────────

describe('recordResearchShadow — dedup by contract+lane+sourceCycle', () => {
  it('does not re-record the same contract+lane+sourceCycle on repeated cron runs', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const statePath  = path.join(dir, 'state.json');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(C1), cycleRow(C2)], '2026-07-01-115500', NOW_MS);

    const first  = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath, eventsPath });
    const second = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS + 1000, statePath, eventsPath });

    expect(first.researchBuys).toBe(2);
    expect(second.researchBuys).toBe(0);   // deduped — no duplicate spam
    expect(readEvents(eventsPath).filter(e => e.type === 'RESEARCH_WOULD_BUY')).toHaveLength(2);
  });
});

// ── Exits: valuation-based P/L ──────────────────────────────────────────────────────────────

describe('recordResearchShadow — exits compute real valuation P/L', () => {
  it('computes POSITIVE pnl when the exit valuation is higher (MAX_HOLD after 30m)', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const statePath  = path.join(dir, 'state.json');

    // Entry cycle: valued at 0.001.
    const c1 = resolveCycle([cycleRow(C1, { priceUsd: 0.001 })], '2026-07-01-115500', NOW_MS);
    recordResearchShadow({ candidates: c1.candidates, sourceCycle: c1.sourceCycle, nowMs: NOW_MS, statePath, eventsPath });

    // Exit cycle 31 minutes later, same contract present but valued at 0.002 → MAX_HOLD, +100%.
    const laterMs = NOW_MS + 31 * 60 * 1000;
    const c2 = resolveCycle([cycleRow(C1, { priceUsd: 0.002 })], '2026-07-01-120100', laterMs);
    const res = recordResearchShadow({ candidates: c2.candidates, sourceCycle: c2.sourceCycle, nowMs: laterMs, statePath, eventsPath });

    expect(res.researchSells).toBe(1);
    const sell = readEvents(eventsPath).find((e): e is ResearchWouldSellEvent => e.type === 'RESEARCH_WOULD_SELL')!;
    expect(sell.exitReason).toBe('MAX_HOLD_TIME');
    expect(sell.valuationUsable).toBe(true);
    expect(sell.valuationStatus).toBe('OK');
    expect(sell.pnlPct).toBeCloseTo(100, 1);
    expect(sell.pnlUsd).toBeCloseTo(RESEARCH_NOTIONAL_USD * 1.0, 3);
  });

  it('computes NEGATIVE pnl when the exit valuation is lower', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const statePath  = path.join(dir, 'state.json');

    const c1 = resolveCycle([cycleRow(C1, { priceUsd: 0.001 })], '2026-07-01-115500', NOW_MS);
    recordResearchShadow({ candidates: c1.candidates, sourceCycle: c1.sourceCycle, nowMs: NOW_MS, statePath, eventsPath });

    const laterMs = NOW_MS + 31 * 60 * 1000;
    const c2 = resolveCycle([cycleRow(C1, { priceUsd: 0.0005 })], '2026-07-01-120100', laterMs);
    recordResearchShadow({ candidates: c2.candidates, sourceCycle: c2.sourceCycle, nowMs: laterMs, statePath, eventsPath });

    const sell = readEvents(eventsPath).find((e): e is ResearchWouldSellEvent => e.type === 'RESEARCH_WOULD_SELL')!;
    expect(sell.valuationUsable).toBe(true);
    expect(sell.pnlPct).toBeCloseTo(-50, 1);
    expect(sell.pnlUsd!).toBeLessThan(0);
  });

  it('marks VALUATION_UNAVAILABLE (never a fake flat 0) when the price cannot be valued', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const statePath  = path.join(dir, 'state.json');

    // Entry has a real valuation…
    const c1 = resolveCycle([cycleRow(C1, { priceUsd: 0.001 })], '2026-07-01-115500', NOW_MS);
    recordResearchShadow({ candidates: c1.candidates, sourceCycle: c1.sourceCycle, nowMs: NOW_MS, statePath, eventsPath });

    // …but the contract falls off the next cycle entirely → DATA_STALE_EXIT, no exit valuation.
    const laterMs = NOW_MS + 5 * 60 * 1000;
    const c2 = resolveCycle([cycleRow(C2, { priceUsd: 0.003 })], '2026-07-01-120100', laterMs);
    recordResearchShadow({ candidates: c2.candidates, sourceCycle: c2.sourceCycle, nowMs: laterMs, statePath, eventsPath });

    const sell = readEvents(eventsPath).find((e): e is ResearchWouldSellEvent => e.type === 'RESEARCH_WOULD_SELL')!;
    expect(sell.exitReason).toBe('DATA_STALE_EXIT');
    expect(sell.valuationUsable).toBe(false);
    expect(sell.valuationStatus).toBe('VALUATION_UNAVAILABLE');
    expect(sell.pnlPct).toBeNull();      // NOT a fabricated 0
    expect(sell.pnlUsd).toBeNull();
    expect(sell.valuationMissing.length).toBeGreaterThan(0);
  });
});

// ── State + safety ──────────────────────────────────────────────────────────────────────────

describe('recordResearchShadow — state + safety', () => {
  it('persists research-only safety flags into state', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(C1)], '2026-07-01-115500', NOW_MS);
    recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath, eventsPath: path.join(dir, 'e.jsonl') });

    const state = loadOrCreateResearchShadowState(statePath, new Date(NOW_MS).toISOString());
    expect(state.researchOnly).toBe(true);
    expect(state.realTrading).toBe(false);
    expect(state.noWallet).toBe(true);
    expect(state.noSwap).toBe(true);
    expect(state.noSigning).toBe(true);
    expect(state.tradingExecuted).toBe(0);
  });

  it('default paths live under data/token-grab/live-shadow/', () => {
    expect(DEFAULT_RESEARCH_SHADOW_EVENTS_PATH).toBe('data/token-grab/live-shadow/research-shadow-events.jsonl');
    expect(DEFAULT_RESEARCH_SHADOW_STATE_PATH.startsWith('data/token-grab/live-shadow/')).toBe(true);
  });
});

// ── Static safety guard ─────────────────────────────────────────────────────────────────────

describe('researchShadow module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/researchShadow.ts'), 'utf-8');
  it('no wallet / signing / swap / private key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
  });
  it('never shells out to token:auto-paper or token:paper-buy', () => {
    expect(src).not.toMatch(/execSync|spawn|child_process|token:auto-paper|token:paper-buy/);
  });
  it('never relabels UNKNOWN to CLEAN', () => {
    expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
  });
});
