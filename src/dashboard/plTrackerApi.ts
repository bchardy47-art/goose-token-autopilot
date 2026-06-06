/**
 * Token Grab — P/L Tracker read-only API model builders.
 *
 * SAFETY:
 *  - This module is strictly READ-ONLY. It performs no DB writes, no network
 *    calls, and never touches trade execution logic.
 *  - It introduces no buy/sell path. Live trading remains locked by the
 *    existing config/verifySafety gates; this module only reports their state.
 *  - All numbers are derived from already-persisted paper/simulated state.
 */
import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import type { PaperPositionView } from '../types';
import { verifySafety } from '../verifySafety';
import { buildTokenGrabDashboardModel } from './tokenGrabDashboard';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface TrackerStatusBar {
  app: 'TOKEN GRAB';
  mode: string; // e.g. "Paper / Dry Run"
  liveTradingLocked: boolean;
  liveTradingLabel: 'LOCKED' | 'UNLOCKED';
  source: string;
  generatedAt: string;
  readOnly: true;
  tradingExecuted: 0;
}

export interface TrackerSummaryCards {
  todayPlUsd: number;
  todayRealizedUsd: number;
  openPlUsd: number;
  closedPlUsd: number;
  winRatePct: number | null;
  openPositions: number;
  closedTrades: number;
}

export interface TrackerMeta {
  tokenSource: string;
  positionsSource: 'live DB' | 'none';
  radarSource: 'live' | 'fixture';
  watchlistSource: 'live' | 'fixture';
  radarCount: number;
  watchlistCount: number;
  fixtureFallbackActive: boolean;
  refreshIntervalSeconds: number;
  liveTradingLocked: boolean;
  readOnly: true;
}

export interface TrackerEvent {
  at: string;
  token: string;
  text: string;
  plUsd: number | null;
}

export interface TrackerDashboard {
  statusBar: TrackerStatusBar;
  summary: TrackerSummaryCards;
  meta: TrackerMeta;
  recentEvents: TrackerEvent[];
}

export interface PositionRow {
  id: number;
  token: string;
  mint: string;
  entryPriceUsd: number;
  currentPriceUsd: number | null;
  positionSizeUsd: number;
  quantity: number;
  plUsd: number | null;
  plPct: number | null;
  ageMinutes: number | null;
  ageLabel: string;
  exitStatus: string;
  status: PaperPositionView['status'];
  mode: string;
}

export interface PositionDetail extends PositionRow {
  source: string;
  openedAt: string;
  entryReason: string | null;
  exitGuidance: string;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  eventLog: Array<{
    observedAt: string;
    priceUsd: number | null;
    unrealizedPnlUsd: number | null;
    unrealizedPnlPct: number | null;
  }>;
}

export interface ClosedTradeRow {
  id: number;
  token: string;
  mint: string;
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  plUsd: number | null;
  plPct: number | null;
  holdMinutes: number | null;
  holdLabel: string;
  entryReason: string | null;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface ClosedTradesModel {
  stats: {
    totalClosed: number;
    winRatePct: number | null;
    averageWinUsd: number | null;
    averageLossUsd: number | null;
    bestTradeUsd: number | null;
    worstTradeUsd: number | null;
    netPlUsd: number;
  };
  trades: ClosedTradeRow[];
}

export interface RadarRow {
  id: string;
  token: string;
  mint: string | null;
  ageLabel: string;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  priceMovePct: number | null;
  verdict: string;
  blockers: string[];
  source: 'live' | 'fixture';
}

export interface WatchlistRow {
  id: string;
  token: string;
  mint: string | null;
  watchedAt: string | null;
  reason: string | null;
  currentMovePct: number | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  blockers: string[];
  wouldHavePlPct: number | null;
  source: 'live' | 'fixture';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function round(value: number, dp = 4): number {
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

function minutesBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 60_000);
}

function ageLabel(minutes: number | null): string {
  if (minutes === null) return 'N/A';
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function todayStr(generatedAt: string): string {
  return generatedAt.slice(0, 10);
}

function deriveMode(config: AppConfig): string {
  const parts: string[] = ['Paper'];
  if (config.tokenRadarDryRun) parts.push('Dry Run');
  return parts.join(' / ');
}

/**
 * Exit guidance is purely descriptive. It reflects the configured paper exit
 * thresholds and the position's current unrealized P/L — it never triggers an
 * action and never changes trading logic.
 */
function deriveExitGuidance(position: PaperPositionView, config: AppConfig): string {
  if (position.status === 'CLOSED') return 'Closed';
  const pct = position.unrealizedPnlPct;
  if (pct === null) return 'Monitoring (no live price)';

  const trailingOn = config.paperTrailingStopEnabled === true;
  const activation = Number(config.paperTrailingActivationPct);
  const stop = Number(config.paperTrailingStopPct);

  if (trailingOn && Number.isFinite(activation) && (position.bestGainPct ?? 0) >= activation) {
    return `Trailing stop armed (gain peaked ${round(position.bestGainPct ?? 0, 1)}%)`;
  }
  if (trailingOn && Number.isFinite(stop) && pct <= -Math.abs(stop)) {
    return `At/under trailing stop band (${round(pct, 1)}%)`;
  }
  if (pct >= 0) return `In profit (${round(pct, 1)}%) — hold/monitor`;
  return `In drawdown (${round(pct, 1)}%) — watch exit`;
}

function buildTokenIndex(db: AppDb): Map<number, { symbol: string; mint: string }> {
  const map = new Map<number, { symbol: string; mint: string }>();
  for (const id of db.getAllTokenIds()) {
    const rec = db.getTokenRecord(id);
    if (rec) map.set(id, { symbol: rec.symbol, mint: rec.mint });
  }
  return map;
}

// ── Builders ────────────────────────────────────────────────────────────────

export function buildTrackerStatusBar(db: AppDb, config: AppConfig, generatedAt: string): TrackerStatusBar {
  const safety = verifySafety(config) as Record<string, unknown>;
  // Live trading is "locked" whenever any of the real-trading gates is closed.
  const locked = Boolean(safety.realTradingLockedByDefault);
  return {
    app: 'TOKEN GRAB',
    mode: deriveMode(config),
    liveTradingLocked: locked,
    liveTradingLabel: locked ? 'LOCKED' : 'UNLOCKED',
    source: String(config.tokenSource ?? 'unknown'),
    generatedAt,
    readOnly: true,
    tradingExecuted: 0,
  };
}

export function buildTrackerSummary(db: AppDb, config: AppConfig, generatedAt: string): TrackerSummaryCards {
  const positions = db.listPositions('PAPER');
  const open = positions.filter((p) => p.status === 'OPEN');
  const closed = positions.filter((p) => p.status === 'CLOSED');
  const today = todayStr(generatedAt);

  const openPlUsd = open.reduce((sum, p) => sum + (p.unrealizedPnlUsd ?? 0), 0);
  const closedPlUsd = db.getClosedPaperPnl();
  const todayRealizedUsd = closed
    .filter((p) => p.closedAt?.startsWith(today))
    .reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0);

  const winners = closed.filter((p) => (p.realizedPnlUsd ?? 0) > 0).length;
  const winRatePct = closed.length > 0 ? round((winners / closed.length) * 100, 1) : null;

  return {
    todayPlUsd: round(todayRealizedUsd + openPlUsd, 4),
    todayRealizedUsd: round(todayRealizedUsd, 4),
    openPlUsd: round(openPlUsd, 4),
    closedPlUsd: round(closedPlUsd, 4),
    winRatePct,
    openPositions: open.length,
    closedTrades: closed.length,
  };
}

const REFRESH_INTERVAL_SECONDS = 4;

function buildRecentEvents(db: AppDb, generatedAt: string): TrackerEvent[] {
  const positions = db.listPositions('PAPER');
  const events: TrackerEvent[] = [];

  // Latest tracked price observation per open position.
  for (const p of positions.filter((x) => x.status === 'OPEN')) {
    const snaps = db.getPerformanceSnapshots(p.id);
    const last = snaps[snaps.length - 1];
    if (last) {
      events.push({
        at: last.observedAt,
        token: p.symbol,
        text: `tracked @ ${last.priceUsd ?? 'n/a'} (${last.unrealizedPnlPct === null ? 'n/a' : round(last.unrealizedPnlPct, 1) + '%'})`,
        plUsd: last.unrealizedPnlUsd,
      });
    } else {
      events.push({ at: p.openedAt, token: p.symbol, text: `paper position opened — ${p.notes ?? 'entry'}`, plUsd: null });
    }
  }

  // Closed-trade exits.
  for (const p of positions.filter((x) => x.status === 'CLOSED')) {
    events.push({
      at: p.closedAt ?? p.openedAt,
      token: p.symbol,
      text: `closed — ${p.notes ?? 'exit'}`,
      plUsd: p.realizedPnlUsd,
    });
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 6);
}

export function buildTrackerDashboard(db: AppDb, config: AppConfig): TrackerDashboard {
  const generatedAt = new Date().toISOString();
  const statusBar = buildTrackerStatusBar(db, config, generatedAt);
  const summary = buildTrackerSummary(db, config, generatedAt);

  const radar = buildRadarModel(db, config);
  const watchlist = buildWatchlistModel(db, config);
  const positionsCount = db.listPositions('PAPER').length;
  const fixtureFallbackActive = radar.source === 'fixture' || watchlist.source === 'fixture';

  const meta: TrackerMeta = {
    tokenSource: String(config.tokenSource ?? 'unknown'),
    positionsSource: positionsCount > 0 ? 'live DB' : 'none',
    radarSource: radar.source,
    watchlistSource: watchlist.source,
    radarCount: radar.candidates.length,
    watchlistCount: watchlist.entries.length,
    fixtureFallbackActive,
    refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
    liveTradingLocked: statusBar.liveTradingLocked,
    readOnly: true,
  };

  return {
    statusBar,
    summary,
    meta,
    recentEvents: buildRecentEvents(db, generatedAt),
  };
}

function toPositionRow(p: PaperPositionView, config: AppConfig, now: string): PositionRow {
  const age = p.status === 'OPEN'
    ? minutesBetween(p.openedAt, now)
    : minutesBetween(p.openedAt, p.closedAt ?? now);
  return {
    id: p.id,
    token: p.symbol,
    mint: p.mint,
    entryPriceUsd: p.entryPriceUsd,
    currentPriceUsd: p.latestPriceUsd,
    positionSizeUsd: p.amountUsd,
    quantity: p.quantity,
    plUsd: p.unrealizedPnlUsd,
    plPct: p.unrealizedPnlPct,
    ageMinutes: age,
    ageLabel: ageLabel(age),
    exitStatus: deriveExitGuidance(p, config),
    status: p.status,
    mode: p.mode,
  };
}

export function buildPositionsModel(db: AppDb, config: AppConfig): { generatedAt: string; positions: PositionRow[] } {
  const now = new Date().toISOString();
  const open = db.listPositions('PAPER').filter((p) => p.status === 'OPEN');
  return {
    generatedAt: now,
    positions: open.map((p) => toPositionRow(p, config, now)),
  };
}

export function buildPositionDetail(db: AppDb, config: AppConfig, positionId: number): PositionDetail | null {
  const now = new Date().toISOString();
  const position = db.listPositions('PAPER').find((p) => p.id === positionId);
  if (!position) return null;
  const base = toPositionRow(position, config, now);
  const snapshot = db.getLatestSnapshot(position.tokenId);
  const snaps = db.getPerformanceSnapshots(positionId);
  return {
    ...base,
    source: snapshot?.source ?? config.tokenSource ?? 'unknown',
    openedAt: position.openedAt,
    entryReason: position.notes,
    exitGuidance: deriveExitGuidance(position, config),
    bestGainPct: position.bestGainPct,
    worstDrawdownPct: position.worstDrawdownPct,
    eventLog: snaps.map((s) => ({
      observedAt: s.observedAt,
      priceUsd: s.priceUsd,
      unrealizedPnlUsd: s.unrealizedPnlUsd,
      unrealizedPnlPct: s.unrealizedPnlPct,
    })),
  };
}

export function buildTradesModel(db: AppDb, _config: AppConfig): { generatedAt: string } & ClosedTradesModel {
  const generatedAt = new Date().toISOString();
  const closed = db.listPositions('PAPER').filter((p) => p.status === 'CLOSED');

  const trades: ClosedTradeRow[] = closed.map((p) => {
    const hold = minutesBetween(p.openedAt, p.closedAt ?? generatedAt);
    return {
      id: p.id,
      token: p.symbol,
      mint: p.mint,
      entryPriceUsd: p.entryPriceUsd,
      exitPriceUsd: p.exitPriceUsd,
      plUsd: p.realizedPnlUsd,
      plPct: p.realizedPnlPct,
      holdMinutes: hold,
      holdLabel: ageLabel(hold),
      entryReason: p.notes,
      exitReason: p.notes, // notes carry exit context; entry/exit reasons share the column source
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    };
  });

  const realized = closed.map((p) => p.realizedPnlUsd).filter((v): v is number => v !== null);
  const wins = realized.filter((v) => v > 0);
  const losses = realized.filter((v) => v < 0);
  const netPlUsd = round(realized.reduce((s, v) => s + v, 0), 4);

  return {
    generatedAt,
    stats: {
      totalClosed: closed.length,
      winRatePct: closed.length > 0 ? round((wins.length / closed.length) * 100, 1) : null,
      averageWinUsd: wins.length > 0 ? round(wins.reduce((s, v) => s + v, 0) / wins.length, 4) : null,
      averageLossUsd: losses.length > 0 ? round(losses.reduce((s, v) => s + v, 0) / losses.length, 4) : null,
      bestTradeUsd: realized.length > 0 ? round(Math.max(...realized), 4) : null,
      worstTradeUsd: realized.length > 0 ? round(Math.min(...realized), 4) : null,
      netPlUsd,
    },
    trades,
  };
}

export function buildRadarModel(db: AppDb, config: AppConfig): { generatedAt: string; source: 'live' | 'fixture'; candidates: RadarRow[] } {
  const generatedAt = new Date().toISOString();
  const openTokenIds = new Set(
    db.listPositions('PAPER').filter((p) => p.status === 'OPEN').map((p) => p.tokenId)
  );

  const liveStates = db.listLatestTokenStates(100).filter((s) => s.score !== null && !openTokenIds.has(s.tokenId));

  if (liveStates.length > 0) {
    const candidates: RadarRow[] = liveStates.map((s) => {
      const snap = s.snapshot;
      const age = snap?.tokenCreatedAt ? minutesBetween(snap.tokenCreatedAt, generatedAt) : null;
      return {
        id: `live-${s.tokenId}`,
        token: s.symbol,
        mint: s.mint,
        ageLabel: ageLabel(age),
        liquidityUsd: snap?.liquidityUsd ?? null,
        volumeUsd: snap?.volume5mUsd ?? snap?.volume1hUsd ?? null,
        priceMovePct: snap?.priceChange5mPct ?? snap?.priceChange1hPct ?? null,
        verdict: s.score?.verdict ?? 'N/A',
        blockers: s.score?.redFlags ?? [],
        source: 'live',
      };
    });
    return { generatedAt, source: 'live', candidates };
  }

  // Fixture fallback — existing, deterministic, no network.
  const model = buildTokenGrabDashboardModel();
  const candidates: RadarRow[] = model.earsReport.candidates.map((c) => ({
    id: `fixture-${c.id}`,
    token: c.ticker ?? c.tokenName ?? c.id,
    mint: c.contractAddress ?? null,
    ageLabel: ageLabel(c.poolAgeMinutes ?? null),
    liquidityUsd: null,
    volumeUsd: null,
    priceMovePct: null,
    verdict: c.decision,
    blockers: c.redFlags,
    source: 'fixture',
  }));
  return { generatedAt, source: 'fixture', candidates };
}

export function buildWatchlistModel(db: AppDb, _config: AppConfig): { generatedAt: string; source: 'live' | 'fixture'; entries: WatchlistRow[] } {
  const generatedAt = new Date().toISOString();
  const tokenIndex = buildTokenIndex(db);
  const live = db.listWatchOnlyCandidates();

  if (live.length > 0) {
    const entries: WatchlistRow[] = live.map((c) => {
      const tok = tokenIndex.get(c.tokenId);
      const currentMove = c.entryPriceUsd && c.latestPriceUsd && c.entryPriceUsd > 0
        ? round(((c.latestPriceUsd - c.entryPriceUsd) / c.entryPriceUsd) * 100, 2)
        : null;
      return {
        id: `live-${c.id}`,
        token: tok?.symbol ?? `token ${c.tokenId}`,
        mint: tok?.mint ?? null,
        watchedAt: c.createdAt,
        reason: c.reason,
        currentMovePct: currentMove,
        bestGainPct: c.bestGainPct,
        worstDrawdownPct: c.worstDrawdownPct,
        blockers: [],
        wouldHavePlPct: c.bestGainPct,
        source: 'live',
      };
    });
    return { generatedAt, source: 'live', entries };
  }

  // Fixture fallback — token-grab candidates flagged WATCH.
  const model = buildTokenGrabDashboardModel();
  const entries: WatchlistRow[] = model.earsReport.candidates
    .filter((c) => c.decision === 'WATCH')
    .map((c) => ({
      id: `fixture-${c.id}`,
      token: c.ticker ?? c.tokenName ?? c.id,
      mint: c.contractAddress ?? null,
      watchedAt: c.firstSeenAt,
      reason: c.reasons[0] ?? null,
      currentMovePct: null,
      bestGainPct: null,
      worstDrawdownPct: null,
      blockers: c.redFlags,
      wouldHavePlPct: null,
      source: 'fixture',
    }));
  return { generatedAt, source: 'fixture', entries };
}
