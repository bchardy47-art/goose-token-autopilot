// TOKEN GRAB — FAILURE AUTOPSY / EXACT POCKET COLLAPSE REPORT (read-only)
//
// REPORT_ONLY  NO_TRADES  DO_NOT_ENABLE_REAL_TRADING  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
//
// The Prime Candidate Report found an earlier-promising lane — gate=true + NO_BM_INTERNAL_BROAD, and
// its exact 7-key sub-pocket — that decayed from WATCH/PROMISING to WEAK as more valued samples
// arrived. This report performs the AUTOPSY: it replays the SAME pocket over growing time/sample
// windows (first 25 / 50 / 75 / all valued, plus per-day) and explains WHAT changed and WHY the
// edge washed out. It is strictly READ-ONLY: it opens no positions, runs no paper/auto-paper/paper-buy
// command, changes no gates, no brain policy, no live-shadow behaviour, touches no wallet/signer/swap.
//
// P/L is measured ONLY over valued closed trades (valuationUsable && pnlPct != null). Trades whose
// valuation is unavailable are EXCLUDED from every statistic and are NEVER counted as flat. Sells are
// joined to their opening buy (contract|lane|sourceCycle) to recover the full 7-key profile.

import * as fs from 'fs';
import {
  readEvents,
  computeCohort,
  HAIRCUT_2_PCT,
  HAIRCUT_5_PCT,
  type CohortStats,
  type ProfileLike,
  type TradeRec,
} from './primeCandidateReport';
import { DEFAULT_RESEARCH_SHADOW_EVENTS_PATH } from './researchShadow';
import { DEFAULT_BRAIN_POLICY_MEMORY_PATH, policyProfileKey } from './brainPolicy';

export type { ProfileLike, TradeRec } from './primeCandidateReport';

// ── Pocket definitions (exactly as specified) ──────────────────────────────────────────────────

/** The main collapsed broad lane: gate=true + NO_BM_INTERNAL_BROAD. */
export const BROAD_POCKET_LANE = 'NO_BM_INTERNAL_BROAD';
export function isBroadPocket(p: ProfileLike): boolean {
  return p.productionGateApproved === true && p.lane === BROAD_POCKET_LANE;
}

/** The exact 7-key sub-pocket that also weakened. */
export const EXACT_POCKET_KEY =
  'NO_BM_INTERNAL_BROAD|gate=true|age=PRIME_WINDOW|m5=-5 to +5|liq=LIQ_10K_30K|vlr=VLR_LT_0_5|score=SCORE_100';
export function isExactPocket(p: ProfileLike): boolean {
  return policyProfileKey({
    lane: p.lane,
    productionGateApproved: p.productionGateApproved,
    launchAgeBucket: p.launchAgeBucket,
    m5Band: p.m5Band,
    liquidityBucket: p.liquidityBucket,
    vlrBucket: p.vlrBucket,
    ripperScoreBand: p.ripperScoreBand,
  }) === EXACT_POCKET_KEY;
}

/** Sample-count windows to replay each pocket over. `null` = "all valued so far". */
export const WINDOW_SIZES: Array<{ label: string; size: number | null }> = [
  { label: 'first 25 valued', size: 25 },
  { label: 'first 50 valued', size: 50 },
  { label: 'first 75 valued', size: 75 },
  { label: 'all valued', size: null },
];

/** Red-loss rate above this is outside the "safe" range for a would-be tradable pocket. */
export const SAFE_RED_LOSS_RATE = 0.50;

export type Trend = 'BASELINE' | 'IMPROVED' | 'HELD' | 'COLLAPSED';

// ── Trade view (extends the prime-report TradeRec with a timestamp for ordering) ────────────────

export interface AutopsyTrade extends TradeRec {
  ts: string;   // sell timestamp (ISO) — used to order windows chronologically
}

interface BuyEvent {
  type: 'RESEARCH_WOULD_BUY';
  contract: string; symbol?: string; lane: string; sourceCycle: string;
  productionGateApproved: boolean; launchAgeBucket: string;
  m5Band: string; liquidityBucket: string; vlrBucket: string; ripperScoreBand: string; ripperScore: number;
  brainAction?: string;
}
interface SellEvent {
  type: 'RESEARCH_WOULD_SELL';
  contract: string; symbol?: string; lane: string; sourceCycle: string; ts?: string;
  productionGateApproved: boolean; launchAgeBucket: string;
  m5Band?: string; liquidityBucket?: string; vlrBucket?: string; ripperScoreBand?: string;
  valuationUsable: boolean; pnlPct: number | null; pnlUsd: number | null;
}
/** Tolerant event union (same shape the prime report reads): known events plus anything else. */
export type RawEvent = BuyEvent | SellEvent | { type: string; [k: string]: unknown };

/** Join sells to their opening buys to recover the 7-key profile; keep the sell timestamp. */
export function buildAutopsyTrades(events: RawEvent[]): AutopsyTrade[] {
  const buys = events.filter((e): e is BuyEvent => e.type === 'RESEARCH_WOULD_BUY');
  const sells = events.filter((e): e is SellEvent => e.type === 'RESEARCH_WOULD_SELL');
  const buyByKey = new Map<string, BuyEvent>();
  for (const b of buys) buyByKey.set(`${b.contract}|${b.lane}|${b.sourceCycle}`, b);

  const trades: AutopsyTrade[] = sells.map((s, i) => {
    const b = buyByKey.get(`${s.contract}|${s.lane}|${s.sourceCycle}`);
    return {
      contract: s.contract, symbol: s.symbol,
      lane: s.lane,
      productionGateApproved: s.productionGateApproved,
      launchAgeBucket: s.launchAgeBucket,
      m5Band: b?.m5Band ?? s.m5Band ?? 'UNAVAILABLE',
      liquidityBucket: b?.liquidityBucket ?? s.liquidityBucket ?? 'UNAVAILABLE',
      vlrBucket: b?.vlrBucket ?? s.vlrBucket ?? 'UNAVAILABLE',
      ripperScoreBand: b?.ripperScoreBand ?? s.ripperScoreBand ?? 'UNAVAILABLE',
      ripperScore: b?.ripperScore ?? null,
      brainAction: b?.brainAction ?? null,
      valued: s.valuationUsable === true && s.pnlPct != null,
      pnlPct: s.pnlPct, pnlUsd: s.pnlUsd,
      ts: s.ts ?? `~${String(i).padStart(9, '0')}`,   // stable fallback preserves file order
    };
  });
  return trades;
}

/** Valued trades matching a pocket predicate, ordered chronologically (stable on ties). */
export function orderedValuedPocket(trades: AutopsyTrade[], pred: (p: ProfileLike) => boolean): AutopsyTrade[] {
  return trades
    .map((t, i) => ({ t, i }))
    .filter(x => x.t.valued && pred(x.t))
    .sort((a, b) => (a.t.ts < b.t.ts ? -1 : a.t.ts > b.t.ts ? 1 : a.i - b.i))
    .map(x => x.t);
}

// ── Window statistics ──────────────────────────────────────────────────────────────────────────

export interface WindowStat extends CohortStats {
  label: string;
  requested: number | null;   // requested window size (null = all)
  trend: Trend;               // vs the previous (smaller) window
}

const MATCH_ALL = (_p: ProfileLike): boolean => true;

/**
 * Compute the stats for a window = the first `size` valued pocket trades (all if size == null).
 * Reuses the prime-report cohort maths so metrics stay identical to the source report.
 */
export function windowStat(orderedValued: AutopsyTrade[], label: string, size: number | null): WindowStat {
  const slice = size == null ? orderedValued : orderedValued.slice(0, size);
  // `slice` is already valued-only and pocket-only, so MATCH_ALL over it reproduces the cohort maths.
  const c = computeCohort(label, 'window', [], slice, MATCH_ALL);
  return { ...c, label, requested: size, trend: 'BASELINE' };
}

/**
 * Classify how a window moved vs the previous (smaller) one. A pocket "collapsed" when the typical
 * trade got worse: median dropped, net-after-2% dropped, or red-loss climbed. "Improved" needs the
 * median AND net to rise with red-loss not worsening. Otherwise it "held".
 */
export function classifyTrend(prev: WindowStat | null, cur: WindowStat): Trend {
  if (!prev) return 'BASELINE';
  const dMedian = (cur.medianPnlPct ?? 0) - (prev.medianPnlPct ?? 0);
  const dNet2 = (cur.netCappedAvgAfter2 ?? 0) - (prev.netCappedAvgAfter2 ?? 0);
  const dRedLoss = cur.redLossRate - prev.redLossRate;   // rising = worse

  const worse = dMedian < -0.5 || dNet2 < -1 || dRedLoss > 0.05;
  const better = dMedian > 0.5 && dNet2 > 1 && dRedLoss <= 0;

  if (better) return 'IMPROVED';
  if (worse) return 'COLLAPSED';
  return 'HELD';
}

// ── Pocket autopsy (windows chained with trend detection) ────────────────────────────────────────

export interface DayStat extends CohortStats { day: string; }

export interface PocketAutopsy {
  name: string;
  predicateDesc: string;
  totalValued: number;
  windows: WindowStat[];
  dayWindows: DayStat[];
}

function dayOf(ts: string): string {
  // ISO timestamps sort/slice cleanly; fallback markers (`~…`) group under "unknown".
  return /^\d{4}-\d{2}-\d{2}T/.test(ts) ? ts.slice(0, 10) : 'unknown-date';
}

export function buildPocketAutopsy(
  name: string, predicateDesc: string, trades: AutopsyTrade[], pred: (p: ProfileLike) => boolean,
): PocketAutopsy {
  const ordered = orderedValuedPocket(trades, pred);

  const windows: WindowStat[] = [];
  let prev: WindowStat | null = null;
  for (const w of WINDOW_SIZES) {
    const s = windowStat(ordered, w.label, w.size);
    s.trend = classifyTrend(prev, s);
    windows.push(s);
    prev = s;
  }

  // Optional: by generated day (chronological). Read-only convenience view.
  const byDay = new Map<string, AutopsyTrade[]>();
  for (const t of ordered) {
    const d = dayOf(t.ts);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t);
  }
  const dayWindows: DayStat[] = [...byDay.keys()].sort().map(day => ({
    ...computeCohort(day, 'day', [], byDay.get(day)!, MATCH_ALL), day,
  }));

  return { name, predicateDesc, totalValued: ordered.length, windows, dayWindows };
}

// ── Collapse reasons ─────────────────────────────────────────────────────────────────────────────

export type CollapseReasonCode =
  | 'SAMPLE_SIZE_ILLUSION'
  | 'MEDIAN_WENT_NEGATIVE'
  | 'RED_LOSS_ROSE_ABOVE_SAFE_RANGE'
  | 'BROAD_LANE_WASHED_OUT'
  | 'EXACT_POCKET_FAILED_TO_HOLD'
  | 'WINNERS_LIFTING_CAPPEDAVG_WHILE_TYPICAL_WEAK';

export interface CollapseReason {
  code: CollapseReasonCode;
  active: boolean;
  detail: string;
}

function windowByLabel(p: PocketAutopsy, label: string): WindowStat | undefined {
  return p.windows.find(w => w.label === label);
}

/** A window looked "promising" early — non-negative typical trade with a positive net edge. */
function lookedPromising(w: WindowStat | undefined): boolean {
  return !!w && w.valuedClosed >= 20 && (w.medianPnlPct ?? -1) >= 0 && (w.netCappedAvgAfter2 ?? -1) > 0;
}

export function detectCollapseReasons(broad: PocketAutopsy, exact: PocketAutopsy): CollapseReason[] {
  const bAll = windowByLabel(broad, 'all valued');
  const bFirst = windowByLabel(broad, 'first 25 valued');
  const eAll = windowByLabel(exact, 'all valued');

  const reasons: CollapseReason[] = [];

  // 1 — sample-size illusion: an early window looked promising but the full sample does not.
  const earlyPromising = lookedPromising(bFirst) || lookedPromising(windowByLabel(exact, 'first 25 valued'));
  const fullWeak = !!bAll && ((bAll.netCappedAvgAfter2 ?? -1) <= 0 || bAll.readiness === 'WEAK' || (bAll.medianPnlPct ?? 0) < 0);
  reasons.push({
    code: 'SAMPLE_SIZE_ILLUSION', active: earlyPromising && fullWeak,
    detail: earlyPromising && fullWeak
      ? 'Early windows read positive; the edge disappeared once the sample grew — small-sample noise, not a real edge.'
      : 'No early-window mirage vs full-sample gap detected.',
  });

  // 2 — median went negative on the full sample.
  const medNeg = !!bAll && (bAll.medianPnlPct ?? 0) < 0;
  reasons.push({
    code: 'MEDIAN_WENT_NEGATIVE', active: medNeg,
    detail: medNeg
      ? `Full-sample median P/L is ${fmtPnl(bAll!.medianPnlPct)} — the typical trade now loses money.`
      : 'Full-sample median is not negative.',
  });

  // 3 — red-loss rate rose above the safe range.
  const redHigh = !!bAll && bAll.redLossRate > SAFE_RED_LOSS_RATE;
  reasons.push({
    code: 'RED_LOSS_ROSE_ABOVE_SAFE_RANGE', active: redHigh,
    detail: redHigh
      ? `Red-loss rate is ${fmtPct(bAll!.redLossRate)} (> ${fmtPct(SAFE_RED_LOSS_RATE)} safe cap) — more than half of trades close red.`
      : `Red-loss rate is within the ${fmtPct(SAFE_RED_LOSS_RATE)} safe range.`,
  });

  // 4 — broad lane washed out.
  const broadWashed = !!bAll && ((bAll.netCappedAvgAfter2 ?? -1) <= 0 || bAll.readiness === 'WEAK');
  reasons.push({
    code: 'BROAD_LANE_WASHED_OUT', active: broadWashed,
    detail: broadWashed
      ? `gate=true + ${BROAD_POCKET_LANE} is ${bAll!.readiness} at ${bAll!.valuedClosed} valued (net-2% ${fmtPts(bAll!.netCappedAvgAfter2)}) — the broad lane no longer carries an edge.`
      : 'Broad lane still shows a net edge.',
  });

  // 5 — exact pocket failed to hold.
  const exactFailed = !!eAll && ((eAll.netCappedAvgAfter2 ?? -1) <= 0 || eAll.readiness === 'WEAK' || (eAll.medianPnlPct ?? 0) < 0);
  reasons.push({
    code: 'EXACT_POCKET_FAILED_TO_HOLD', active: exactFailed,
    detail: exactFailed
      ? `The exact 7-key sub-pocket is ${eAll!.readiness} at ${eAll!.valuedClosed} valued (median ${fmtPnl(eAll!.medianPnlPct)}, net-2% ${fmtPts(eAll!.netCappedAvgAfter2)}) — tightening to the exact profile did not rescue the edge.`
      : 'Exact sub-pocket still holds a net edge.',
  });

  // 6 — winners lifting cappedAvg while the typical trade is weak.
  const winnersLift = !!bAll && (bAll.cappedAveragePnlPct ?? -1) > 0 && (bAll.medianPnlPct ?? 0) <= 0;
  reasons.push({
    code: 'WINNERS_LIFTING_CAPPEDAVG_WHILE_TYPICAL_WEAK', active: winnersLift,
    detail: winnersLift
      ? `cappedAvg is ${fmtPnl(bAll!.cappedAveragePnlPct)} but median is ${fmtPnl(bAll!.medianPnlPct)} — a few winners (top-1 dep ${fmtPts(bAll!.topTradeDependencyPts)}pts, top-3 ${fmtPts(bAll!.top3TradeDependencyPts)}pts) prop up the average while the typical trade is flat-to-red.`
      : 'The average is not being propped up by a few winners over a weak median.',
  });

  return reasons;
}

// ── Result ─────────────────────────────────────────────────────────────────────────────────────

export interface FailureAutopsyReportResult {
  generatedAt: string;
  eventsPath: string;
  memoryPath: string;
  totalValuedClosed: number;
  totalUnvaluedExcluded: number;
  broadPocket: PocketAutopsy;
  exactPocket: PocketAutopsy;
  collapseReasons: CollapseReason[];
  primeCandidateFound: false;
  conclusion: string;
  recommendation: string;
  // Safety.
  reportOnly: true;
  noTrades: true;
  readyForRealTrading: false;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
}

export interface FailureAutopsyReportOptions {
  eventsPath?: string;
  memoryPath?: string;
  generatedAt: string;
}

export function buildFailureAutopsyReport(
  events: RawEvent[], opts: FailureAutopsyReportOptions,
): FailureAutopsyReportResult {
  const trades = buildAutopsyTrades(events);
  const broadPocket = buildPocketAutopsy(
    'gate=true + NO_BM_INTERNAL_BROAD (broad lane)', 'productionGateApproved==true AND lane==NO_BM_INTERNAL_BROAD',
    trades, isBroadPocket);
  const exactPocket = buildPocketAutopsy(
    'exact 7-key sub-pocket', EXACT_POCKET_KEY, trades, isExactPocket);
  const collapseReasons = detectCollapseReasons(broadPocket, exactPocket);

  return {
    generatedAt: opts.generatedAt,
    eventsPath: opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH,
    memoryPath: opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH,
    totalValuedClosed: trades.filter(t => t.valued).length,
    totalUnvaluedExcluded: trades.filter(t => !t.valued).length,
    broadPocket, exactPocket, collapseReasons,
    primeCandidateFound: false,
    conclusion: 'NO PRIME CANDIDATE FOUND',
    recommendation:
      'Keep collecting research/paper evidence or tighten the exact criteria further, but make NO live or paper-buy changes. DO NOT ENABLE REAL TRADING.',
    reportOnly: true, noTrades: true, readyForRealTrading: false, realTrading: false,
    noWallet: true, noSwap: true, noSigning: true,
  };
}

export function runFailureAutopsyReport(opts: Partial<FailureAutopsyReportOptions> = {}): FailureAutopsyReportResult {
  const eventsPath = opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH;
  const memoryPath = opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const events = readEvents(eventsPath) as RawEvent[];
  return buildFailureAutopsyReport(events, { eventsPath, memoryPath, generatedAt });
}

// ── Renderer ─────────────────────────────────────────────────────────────────────────────────

function fmtPnl(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function fmtPts(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1); }
function fmtPct(v: number): string { return (v * 100).toFixed(0) + '%'; }
function fmtTrade(t: { symbol?: string; contract: string; pnlUsd: number; pnlPct: number } | null): string {
  if (!t) return '(none)';
  const sym = t.symbol ? `$${t.symbol}` : t.contract.slice(0, 8) + '…';
  return `${sym} ${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)} (${fmtPnl(t.pnlPct)})`;
}

const TREND_MARK: Record<Trend, string> = {
  BASELINE: 'BASELINE ', IMPROVED: 'IMPROVED↑', HELD: 'HELD    ', COLLAPSED: 'COLLAPSED↓',
};

function windowBlock(w: WindowStat): string[] {
  return [
    `  [${TREND_MARK[w.trend]}] ${w.label}  (readiness ${w.readiness})`,
    `      valued ${w.valuedClosed}  W/L/F ${w.wins}/${w.losses}/${w.flats}  ` +
      `win ${fmtPct(w.winRate)}  redLoss ${fmtPct(w.redLossRate)}`,
    `      median ${fmtPnl(w.medianPnlPct)}  cappedAvg ${fmtPnl(w.cappedAveragePnlPct)}  ` +
      `net-2% ${fmtPts(w.netCappedAvgAfter2)}  net-5% ${fmtPts(w.netCappedAvgAfter5)}`,
    `      top1-dep ${fmtPts(w.topTradeDependencyPts)}pts  top3-dep ${fmtPts(w.top3TradeDependencyPts)}pts  ` +
      `worst ${fmtTrade(w.worstTrade)}  best ${fmtTrade(w.bestTrade)}`,
  ];
}

function pocketSection(p: PocketAutopsy, thin: string): string[] {
  const L: string[] = [];
  L.push(thin);
  L.push(`  POCKET: ${p.name}`);
  L.push(`  match : ${p.predicateDesc}`);
  L.push(`  total valued: ${p.totalValued}`);
  L.push(thin);
  for (const w of p.windows) L.push(...windowBlock(w));
  if (p.dayWindows.length > 1) {
    L.push('      — by generated day —');
    for (const d of p.dayWindows) {
      L.push(`        ${d.day}  valued ${String(d.valuedClosed).padStart(3)}  ` +
        `win ${fmtPct(d.winRate)}  redLoss ${fmtPct(d.redLossRate)}  ` +
        `median ${fmtPnl(d.medianPnlPct).padStart(7)}  net-2% ${fmtPts(d.netCappedAvgAfter2).padStart(6)}`);
    }
  }
  L.push('');
  return L;
}

export function renderFailureAutopsyReport(r: FailureAutopsyReportResult): string {
  const WIDE = '═'.repeat(78);
  const THIN = '─'.repeat(78);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — FAILURE AUTOPSY / EXACT POCKET COLLAPSE REPORT');
  L.push('  REPORT_ONLY  NO_TRADES  SIMULATED — NOT A BUY SIGNAL');
  L.push('  [READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at         : ${r.generatedAt}`);
  L.push(`  Events file          : ${r.eventsPath}`);
  L.push(`  Memory file          : ${r.memoryPath}`);
  L.push(`  Total valued closed  : ${r.totalValuedClosed}   (unvalued excluded: ${r.totalUnvaluedExcluded} — never counted as flat)`);
  L.push(`  Windows              : first 25 / 50 / 75 / all valued (chronological), plus by-day`);
  L.push(`  Haircuts             : 2% and 5% (percentage-point round-trip fee/slippage)`);
  L.push('');
  L.push('  WHAT THIS SHOWS: the earlier-promising lane replayed as the sample grew. Watch median,');
  L.push('  red-loss and net-2% move window-to-window — an edge that only existed in the first few');
  L.push('  dozen trades is small-sample noise, not a tradable pocket.');
  L.push('');

  L.push(...pocketSection(r.broadPocket, THIN));
  L.push(...pocketSection(r.exactPocket, THIN));

  L.push(THIN);
  L.push('  WHY IT COLLAPSED (active reasons flagged ✓)');
  L.push(THIN);
  for (const reason of r.collapseReasons) {
    L.push(`  [${reason.active ? '✓' : ' '}] ${reason.code}`);
    L.push(`      ${reason.detail}`);
  }
  L.push('');

  L.push(THIN);
  L.push('  CONCLUSION');
  L.push(THIN);
  L.push(`  >>> ${r.conclusion} <<<`);
  L.push('  DO NOT ENABLE REAL TRADING.');
  L.push(`  Recommendation: ${r.recommendation}`);
  L.push('');

  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  REPORT_ONLY');
  L.push('  NO_TRADES');
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  REAL_TRADING=false');
  L.push('  NO_WALLET=true');
  L.push('  NO_SWAP=true');
  L.push('  NO_SIGNING=true');
  L.push('  Report only — no trades, no paper/auto-paper/paper-buy, no gates changed, no brain memory');
  L.push('  writes, no live-shadow changes, no wallet/signing/swap. UNKNOWN stays UNKNOWN — never CLEAN.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderFailureAutopsyReportUsage(): string {
  return `
token:failure-autopsy-report — read-only autopsy of the collapsed prime-candidate lane. Replays the
gate=true + NO_BM_INTERNAL_BROAD broad pocket and its exact 7-key sub-pocket over growing sample
windows (first 25 / 50 / 75 / all valued, plus by-day) and explains WHAT changed and WHY the edge
washed out (sample-size illusion, median gone negative, red-loss above the safe range, broad lane
washed out, exact pocket failed to hold, winners lifting cappedAvg over a weak median).

Usage:
  npm run token:failure-autopsy-report [options]

Options:
  --events <path>   research-shadow events jsonl (default: ${DEFAULT_RESEARCH_SHADOW_EVENTS_PATH})
  --memory <path>   brain policy memory json     (default: ${DEFAULT_BRAIN_POLICY_MEMORY_PATH})
  --json             emit machine-readable JSON instead of the text report
  --help              show this message

Safety:
  REPORT_ONLY  NO_TRADES  READY_FOR_REAL_TRADING=false. Excludes VALUATION_UNAVAILABLE from P/L
  (never counted as flat). Changes no gates, no brain policy, no live-shadow behaviour, and does not
  run the auto-paper or paper-buy commands. DO_NOT_ENABLE_REAL_TRADING.
`.trim();
}

// Referenced to keep haircut constants in the module's public surface (mirrors the source report).
export const HAIRCUTS = { two: HAIRCUT_2_PCT, five: HAIRCUT_5_PCT };
