import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schemaSql } from './schema';
import type {
  AppConfig,
  PaperPerformanceSnapshot,
  PaperPositionView,
  PositionMode,
  PositionStatus,
  ProposalStatus,
  ResearchStatus,
  SafetySeverity,
  TokenCandidate,
  TokenScoreResult,
  TradeSide,
  Verdict,
  WatchOnlyCandidate,
  WatchOnlyOutcome
} from './types';

function toToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class AppDb {
  public readonly sqlite: Database.Database;

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
    this.sqlite = new Database(config.databaseFile);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.exec(schemaSql);
  }

  close(): void {
    this.sqlite.close();
  }

  createRunLog(runType: string): number {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare('INSERT INTO run_logs (run_type, started_at, finished_at, status, summary_json) VALUES (?, ?, NULL, ?, ?)')
      .run(runType, now, 'RUNNING', JSON.stringify({}));
    return Number(result.lastInsertRowid);
  }

  finishRunLog(id: number, status: string, summary: Record<string, unknown>): void {
    this.sqlite
      .prepare('UPDATE run_logs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?')
      .run(new Date().toISOString(), status, JSON.stringify(summary), id);
  }

  logSafetyEvent(tokenId: number | null, severity: SafetySeverity, eventType: string, message: string, raw: Record<string, unknown> = {}): number {
    const result = this.sqlite
      .prepare('INSERT INTO safety_events (token_id, created_at, severity, event_type, message, raw_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenId, new Date().toISOString(), severity, eventType, message, JSON.stringify(raw));
    return Number(result.lastInsertRowid);
  }

  upsertToken(candidate: TokenCandidate): number {
    const existing = this.sqlite
      .prepare('SELECT id FROM tokens WHERE chain = ? AND mint = ?')
      .get(candidate.chain, candidate.mint) as { id: number } | undefined;

    if (existing) {
      this.sqlite
        .prepare('UPDATE tokens SET symbol = ?, name = ?, source = ?, source_url = ?, last_seen_at = ? WHERE id = ?')
        .run(candidate.symbol, candidate.name, candidate.source, candidate.sourceUrl ?? null, candidate.discoveredAt, existing.id);
      return existing.id;
    }

    const result = this.sqlite
      .prepare(
        'INSERT INTO tokens (chain, mint, symbol, name, source, source_url, first_seen_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        candidate.chain,
        candidate.mint,
        candidate.symbol,
        candidate.name,
        candidate.source,
        candidate.sourceUrl ?? null,
        candidate.discoveredAt,
        candidate.discoveredAt,
        candidate.tokenCreatedAt
      );

    return Number(result.lastInsertRowid);
  }

  insertSnapshot(tokenId: number, candidate: TokenCandidate): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO token_snapshots (
          token_id, observed_at, price_usd, liquidity_usd, market_cap_usd,
          volume_5m_usd, volume_1h_usd, volume_24h_usd,
          price_change_5m_pct, price_change_1h_pct, buys_5m, sells_5m, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tokenId,
        candidate.dataUpdatedAt,
        candidate.priceUsd,
        candidate.liquidityUsd,
        candidate.marketCapUsd,
        candidate.volume5mUsd,
        candidate.volume1hUsd,
        candidate.volume24hUsd,
        candidate.priceChange5mPct,
        candidate.priceChange1hPct,
        candidate.buys5m,
        candidate.sells5m,
        JSON.stringify(candidate)
      );
    return Number(result.lastInsertRowid);
  }

  saveScore(score: TokenScoreResult): number {
    const result = this.sqlite
      .prepare(
        'INSERT INTO token_scores (token_id, scored_at, momentum_score, safety_score, social_score, total_score, verdict, reasons_json, red_flags_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        score.tokenId,
        score.scoredAt,
        score.momentumScore,
        score.safetyScore,
        score.socialScore,
        score.totalScore,
        score.verdict,
        JSON.stringify(score.reasons),
        JSON.stringify(score.redFlags)
      );
    return Number(result.lastInsertRowid);
  }

  createProposal(tokenId: number, side: TradeSide, amountUsd: number, verdict: Verdict, reason: string, status: ProposalStatus, safetySnapshot: Record<string, unknown>): number {
    const result = this.sqlite
      .prepare(
        'INSERT INTO trade_proposals (token_id, created_at, side, amount_usd, verdict, reason, status, safety_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(tokenId, new Date().toISOString(), side, amountUsd, verdict, reason, status, JSON.stringify(safetySnapshot));
    return Number(result.lastInsertRowid);
  }

  updateProposalStatus(id: number, status: ProposalStatus): void {
    this.sqlite.prepare('UPDATE trade_proposals SET status = ? WHERE id = ?').run(status, id);
  }

  createPaperTrade(tokenId: number, proposalId: number | null, side: TradeSide, amountUsd: number, priceUsd: number, quantity: number, reason: string): number {
    const result = this.sqlite
      .prepare(
        'INSERT INTO paper_trades (token_id, proposal_id, side, amount_usd, price_usd, quantity, created_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(tokenId, proposalId, side, amountUsd, priceUsd, quantity, new Date().toISOString(), reason);
    return Number(result.lastInsertRowid);
  }

  createPosition(tokenId: number, mode: PositionMode, status: PositionStatus, entryPriceUsd: number, quantity: number, amountUsd: number, notes: string | null): number {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        'INSERT INTO positions (token_id, mode, status, opened_at, closed_at, entry_price_usd, exit_price_usd, quantity, amount_usd, realized_pnl_usd, notes) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?)'
      )
      .run(tokenId, mode, status, now, entryPriceUsd, quantity, amountUsd, notes);
    return Number(result.lastInsertRowid);
  }

  closePosition(positionId: number, exitPriceUsd: number, realizedPnlUsd: number, notes: string | null): void {
    this.sqlite
      .prepare('UPDATE positions SET status = ?, closed_at = ?, exit_price_usd = ?, realized_pnl_usd = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run('CLOSED', new Date().toISOString(), exitPriceUsd, realizedPnlUsd, notes, positionId);
  }

  createPaperPerformanceSnapshot(
    positionId: number,
    tokenId: number,
    observedAt: string,
    priceUsd: number | null,
    unrealizedPnlUsd: number | null,
    unrealizedPnlPct: number | null,
    liquidityUsd: number | null,
    marketCapUsd: number | null,
    volume5mUsd: number | null,
    volume1hUsd: number | null,
    raw: Record<string, unknown>
  ): number {
    const result = this.sqlite
      .prepare(
        'INSERT INTO paper_performance_snapshots (position_id, token_id, observed_at, price_usd, unrealized_pnl_usd, unrealized_pnl_pct, liquidity_usd, market_cap_usd, volume_5m_usd, volume_1h_usd, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(positionId, tokenId, observedAt, priceUsd, unrealizedPnlUsd, unrealizedPnlPct, liquidityUsd, marketCapUsd, volume5mUsd, volume1hUsd, JSON.stringify(raw));
    return Number(result.lastInsertRowid);
  }

  recordRealTradeAttempt(tokenId: number, proposalId: number | null, side: TradeSide, amountUsd: number, blocked: boolean, blockReason: string, raw: Record<string, unknown>, txSignature: string | null = null): number {
    const result = this.sqlite
      .prepare(
        'INSERT INTO real_trade_attempts (token_id, proposal_id, side, amount_usd, attempted_at, blocked, block_reason, tx_signature, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(tokenId, proposalId, side, amountUsd, new Date().toISOString(), blocked ? 1 : 0, blockReason, txSignature, JSON.stringify(raw));
    return Number(result.lastInsertRowid);
  }

  upsertWatchOnlyCandidate(
    tokenId: number,
    status: ResearchStatus,
    reason: string,
    entryPriceUsd: number | null,
    latestPriceUsd: number | null,
    liquidityUsd: number | null,
    volume5mUsd: number | null,
    volume1hUsd: number | null,
    raw: Record<string, unknown>
  ): number {
    const existing = this.sqlite.prepare('SELECT * FROM watch_only_candidates WHERE token_id = ?').get(tokenId) as any;
    const bestPriceUsd = existing ? Math.max(existing.best_price_usd ?? entryPriceUsd ?? 0, latestPriceUsd ?? 0) : latestPriceUsd;
    const worstPriceUsd = existing ? Math.min(existing.worst_price_usd ?? entryPriceUsd ?? latestPriceUsd ?? 0, latestPriceUsd ?? existing.worst_price_usd ?? 0) : latestPriceUsd;
    const baseEntry = existing?.entry_price_usd ?? entryPriceUsd;
    const bestGainPct = baseEntry && bestPriceUsd !== null ? ((bestPriceUsd - baseEntry) / baseEntry) * 100 : null;
    const worstDrawdownPct = baseEntry && worstPriceUsd !== null ? ((worstPriceUsd - baseEntry) / baseEntry) * 100 : null;

    if (existing) {
      this.sqlite.prepare(
        'UPDATE watch_only_candidates SET status = ?, reason = ?, latest_price_usd = ?, best_price_usd = ?, worst_price_usd = ?, best_gain_pct = ?, worst_drawdown_pct = ?, liquidity_usd = ?, volume_5m_usd = ?, volume_1h_usd = ?, raw_json = ? WHERE token_id = ?'
      ).run(
        status,
        reason,
        latestPriceUsd,
        bestPriceUsd,
        worstPriceUsd,
        bestGainPct,
        worstDrawdownPct,
        liquidityUsd,
        volume5mUsd,
        volume1hUsd,
        JSON.stringify(raw),
        tokenId
      );
      return existing.id;
    }

    const result = this.sqlite.prepare(
      'INSERT INTO watch_only_candidates (token_id, created_at, status, reason, entry_price_usd, latest_price_usd, best_price_usd, worst_price_usd, best_gain_pct, worst_drawdown_pct, liquidity_usd, volume_5m_usd, volume_1h_usd, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      tokenId,
      new Date().toISOString(),
      status,
      reason,
      entryPriceUsd,
      latestPriceUsd,
      bestPriceUsd,
      worstPriceUsd,
      bestGainPct,
      worstDrawdownPct,
      liquidityUsd,
      volume5mUsd,
      volume1hUsd,
      JSON.stringify(raw)
    );
    return Number(result.lastInsertRowid);
  }

  listWatchOnlyCandidates(): WatchOnlyCandidate[] {
    return this.sqlite.prepare('SELECT * FROM watch_only_candidates ORDER BY created_at DESC, id DESC').all().map((row: any) => ({
      id: row.id,
      tokenId: row.token_id,
      createdAt: row.created_at,
      status: row.status,
      reason: row.reason,
      entryPriceUsd: row.entry_price_usd,
      latestPriceUsd: row.latest_price_usd,
      bestPriceUsd: row.best_price_usd,
      worstPriceUsd: row.worst_price_usd,
      bestGainPct: row.best_gain_pct,
      worstDrawdownPct: row.worst_drawdown_pct,
      liquidityUsd: row.liquidity_usd,
      volume5mUsd: row.volume_5m_usd,
      volume1hUsd: row.volume_1h_usd,
      rawJson: row.raw_json
    }));
  }

  getWatchOnlyCount(date = toToday()): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) as count FROM watch_only_candidates WHERE substr(created_at, 1, 10) = ?').get(date) as { count: number };
    return row.count;
  }

  createWatchOnlyOutcome(
    watchCandidateId: number,
    tokenId: number,
    windowLabel: string,
    targetMinutes: number,
    observedAt: string,
    entryPriceUsd: number | null,
    observedPriceUsd: number | null,
    returnPct: number | null,
    bestGainPct: number | null,
    worstDrawdownPct: number | null,
    wouldHitTakeProfit: boolean,
    wouldHitStopLoss: boolean,
    liquidityUsd: number | null,
    volume5mUsd: number | null,
    volume1hUsd: number | null,
    notes: string | null,
    raw: Record<string, unknown>
  ): number {
    const result = this.sqlite.prepare(
      'INSERT INTO watch_only_outcomes (watch_candidate_id, token_id, window_label, target_minutes, observed_at, entry_price_usd, observed_price_usd, return_pct, best_gain_pct, worst_drawdown_pct, would_hit_take_profit, would_hit_stop_loss, liquidity_usd, volume_5m_usd, volume_1h_usd, notes, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      watchCandidateId,
      tokenId,
      windowLabel,
      targetMinutes,
      observedAt,
      entryPriceUsd,
      observedPriceUsd,
      returnPct,
      bestGainPct,
      worstDrawdownPct,
      wouldHitTakeProfit ? 1 : 0,
      wouldHitStopLoss ? 1 : 0,
      liquidityUsd,
      volume5mUsd,
      volume1hUsd,
      notes,
      JSON.stringify(raw)
    );
    return Number(result.lastInsertRowid);
  }

  getWatchOnlyOutcome(watchCandidateId: number, windowLabel: string): WatchOnlyOutcome | null {
    const row = this.sqlite.prepare('SELECT * FROM watch_only_outcomes WHERE watch_candidate_id = ? AND window_label = ?').get(watchCandidateId, windowLabel) as any;
    if (!row) return null;
    return {
      id: row.id,
      watchCandidateId: row.watch_candidate_id,
      tokenId: row.token_id,
      windowLabel: row.window_label,
      targetMinutes: row.target_minutes,
      observedAt: row.observed_at,
      entryPriceUsd: row.entry_price_usd,
      observedPriceUsd: row.observed_price_usd,
      returnPct: row.return_pct,
      bestGainPct: row.best_gain_pct,
      worstDrawdownPct: row.worst_drawdown_pct,
      wouldHitTakeProfit: Boolean(row.would_hit_take_profit),
      wouldHitStopLoss: Boolean(row.would_hit_stop_loss),
      liquidityUsd: row.liquidity_usd,
      volume5mUsd: row.volume_5m_usd,
      volume1hUsd: row.volume_1h_usd,
      notes: row.notes,
      rawJson: row.raw_json
    };
  }

  listWatchOnlyOutcomes(): WatchOnlyOutcome[] {
    return this.sqlite.prepare('SELECT * FROM watch_only_outcomes ORDER BY observed_at DESC, id DESC').all().map((row: any) => ({
      id: row.id,
      watchCandidateId: row.watch_candidate_id,
      tokenId: row.token_id,
      windowLabel: row.window_label,
      targetMinutes: row.target_minutes,
      observedAt: row.observed_at,
      entryPriceUsd: row.entry_price_usd,
      observedPriceUsd: row.observed_price_usd,
      returnPct: row.return_pct,
      bestGainPct: row.best_gain_pct,
      worstDrawdownPct: row.worst_drawdown_pct,
      wouldHitTakeProfit: Boolean(row.would_hit_take_profit),
      wouldHitStopLoss: Boolean(row.would_hit_stop_loss),
      liquidityUsd: row.liquidity_usd,
      volume5mUsd: row.volume_5m_usd,
      volume1hUsd: row.volume_1h_usd,
      notes: row.notes,
      rawJson: row.raw_json
    }));
  }

  getLatestSnapshot(tokenId: number): TokenCandidate | null {
    const row = this.sqlite
      .prepare('SELECT raw_json FROM token_snapshots WHERE token_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1')
      .get(tokenId) as { raw_json: string } | undefined;
    return row ? (JSON.parse(row.raw_json) as TokenCandidate) : null;
  }

  getLatestScore(tokenId: number): TokenScoreResult | null {
    const row = this.sqlite
      .prepare('SELECT * FROM token_scores WHERE token_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1')
      .get(tokenId) as any;
    if (!row) return null;
    return {
      tokenId: row.token_id,
      scoredAt: row.scored_at,
      momentumScore: row.momentum_score,
      safetyScore: row.safety_score,
      socialScore: row.social_score,
      totalScore: row.total_score,
      verdict: row.verdict,
      reasons: parseJsonArray(row.reasons_json),
      redFlags: parseJsonArray(row.red_flags_json),
      autopilotBlocked: row.verdict !== 'AUTOPILOT_ELIGIBLE',
      autopilotBlockers: []
    };
  }

  getAllTokenIds(): number[] {
    return (this.sqlite.prepare('SELECT id FROM tokens ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id);
  }

  getTokenRecord(tokenId: number): any | null {
    return (this.sqlite.prepare('SELECT * FROM tokens WHERE id = ?').get(tokenId) as any) ?? null;
  }

  findTokenByMint(mint: string): { id: number; symbol: string; mint: string } | null {
    return (this.sqlite.prepare('SELECT id, symbol, mint FROM tokens WHERE mint = ?').get(mint) as any) ?? null;
  }

  getRankedTokens(limit = 10): Array<any> {
    return this.sqlite
      .prepare(
        `SELECT t.id, t.symbol, t.mint, s.total_score, s.verdict, snap.price_usd, snap.liquidity_usd
         FROM tokens t
         JOIN token_scores s ON s.id = (
           SELECT id FROM token_scores WHERE token_id = t.id ORDER BY scored_at DESC, id DESC LIMIT 1
         )
         LEFT JOIN token_snapshots snap ON snap.id = (
           SELECT id FROM token_snapshots WHERE token_id = t.id ORDER BY observed_at DESC, id DESC LIMIT 1
         )
         ORDER BY s.total_score DESC, t.last_seen_at DESC
         LIMIT ?`
      )
      .all(limit);
  }

  listLatestTokenStates(limit = 100): Array<{
    tokenId: number;
    symbol: string;
    mint: string;
    score: TokenScoreResult | null;
    snapshot: TokenCandidate | null;
  }> {
    const rows = this.sqlite
      .prepare(
        `SELECT t.id as token_id, t.symbol, t.mint,
                s.id as score_id, s.scored_at, s.momentum_score, s.safety_score, s.social_score, s.total_score, s.verdict, s.reasons_json, s.red_flags_json,
                snap.raw_json as snapshot_raw
         FROM tokens t
         LEFT JOIN token_scores s ON s.id = (
           SELECT id FROM token_scores WHERE token_id = t.id ORDER BY scored_at DESC, id DESC LIMIT 1
         )
         LEFT JOIN token_snapshots snap ON snap.id = (
           SELECT id FROM token_snapshots WHERE token_id = t.id ORDER BY observed_at DESC, id DESC LIMIT 1
         )
         ORDER BY COALESCE(s.total_score, 0) DESC, t.last_seen_at DESC
         LIMIT ?`
      )
      .all(limit) as any[];

    return rows.map((row) => ({
      tokenId: row.token_id,
      symbol: row.symbol,
      mint: row.mint,
      score: row.score_id ? {
        tokenId: row.token_id,
        scoredAt: row.scored_at,
        momentumScore: row.momentum_score,
        safetyScore: row.safety_score,
        socialScore: row.social_score,
        totalScore: row.total_score,
        verdict: row.verdict,
        reasons: parseJsonArray(row.reasons_json),
        redFlags: parseJsonArray(row.red_flags_json),
        autopilotBlocked: row.verdict !== 'AUTOPILOT_ELIGIBLE',
        autopilotBlockers: []
      } : null,
      snapshot: row.snapshot_raw ? JSON.parse(row.snapshot_raw) as TokenCandidate : null
    }));
  }

  getProposal(id: number): any | null {
    return (this.sqlite.prepare('SELECT * FROM trade_proposals WHERE id = ?').get(id) as any) ?? null;
  }

  getPosition(positionId: number): any | null {
    return (this.sqlite.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any) ?? null;
  }

  getLatestOpenPositionByToken(tokenId: number, mode: PositionMode = 'PAPER'): any | null {
    return (
      this.sqlite
        .prepare('SELECT * FROM positions WHERE token_id = ? AND mode = ? AND status = ? ORDER BY opened_at DESC, id DESC LIMIT 1')
        .get(tokenId, mode, 'OPEN') as any
    ) ?? null;
  }

  getOpenPositionCount(mode: PositionMode = 'PAPER'): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) as count FROM positions WHERE mode = ? AND status = ?').get(mode, 'OPEN') as { count: number };
    return row.count;
  }

  getDailyPaperBuyCount(date = toToday()): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) as count FROM paper_trades WHERE side = 'BUY' AND substr(created_at, 1, 10) = ?")
      .get(date) as { count: number };
    return row.count;
  }

  getDailyPaperSellCount(date = toToday()): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) as count FROM paper_trades WHERE side = 'SELL' AND substr(created_at, 1, 10) = ?")
      .get(date) as { count: number };
    return row.count;
  }

  getDailyRealBuyCount(date = toToday()): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) as count FROM real_trade_attempts WHERE side = 'BUY' AND blocked = 0 AND substr(attempted_at, 1, 10) = ?")
      .get(date) as { count: number };
    return row.count;
  }

  getOpenExposureUsd(mode: PositionMode = 'PAPER'): number {
    const row = this.sqlite
      .prepare('SELECT COALESCE(SUM(amount_usd), 0) as total FROM positions WHERE mode = ? AND status = ?')
      .get(mode, 'OPEN') as { total: number };
    return row.total;
  }

  getClosedRealizedLossToday(mode: PositionMode = 'PAPER', date = toToday()): number {
    const row = this.sqlite
      .prepare('SELECT COALESCE(SUM(CASE WHEN realized_pnl_usd < 0 THEN ABS(realized_pnl_usd) ELSE 0 END), 0) as total FROM positions WHERE mode = ? AND status = ? AND substr(closed_at, 1, 10) = ?')
      .get(mode, 'CLOSED', date) as { total: number };
    return row.total;
  }

  getPerformanceSnapshots(positionId: number): PaperPerformanceSnapshot[] {
    return this.sqlite
      .prepare('SELECT * FROM paper_performance_snapshots WHERE position_id = ? ORDER BY observed_at ASC, id ASC')
      .all(positionId)
      .map((row: any) => ({
        id: row.id,
        positionId: row.position_id,
        tokenId: row.token_id,
        observedAt: row.observed_at,
        priceUsd: row.price_usd,
        unrealizedPnlUsd: row.unrealized_pnl_usd,
        unrealizedPnlPct: row.unrealized_pnl_pct,
        liquidityUsd: row.liquidity_usd,
        marketCapUsd: row.market_cap_usd,
        volume5mUsd: row.volume_5m_usd,
        volume1hUsd: row.volume_1h_usd,
        rawJson: row.raw_json
      }));
  }

  listPositions(mode: PositionMode = 'PAPER'): PaperPositionView[] {
    const rows = this.sqlite
      .prepare(
        `SELECT p.*, t.symbol, t.mint, snap.price_usd as latest_price_usd
         FROM positions p
         JOIN tokens t ON t.id = p.token_id
         LEFT JOIN token_snapshots snap ON snap.id = (
           SELECT id FROM token_snapshots WHERE token_id = p.token_id ORDER BY observed_at DESC, id DESC LIMIT 1
         )
         WHERE p.mode = ?
         ORDER BY p.status ASC, p.opened_at DESC`
      )
      .all(mode) as any[];

    return rows.map((row) => {
      const latestPriceUsd = row.latest_price_usd as number | null;
      const unrealizedPnlUsd = row.status === 'OPEN' && latestPriceUsd !== null
        ? row.quantity * (latestPriceUsd - row.entry_price_usd)
        : null;
      const unrealizedPnlPct = unrealizedPnlUsd !== null && row.amount_usd > 0
        ? (unrealizedPnlUsd / row.amount_usd) * 100
        : null;
      const realizedPnlPct = row.realized_pnl_usd !== null && row.amount_usd > 0
        ? (row.realized_pnl_usd / row.amount_usd) * 100
        : null;
      const snapshots = this.getPerformanceSnapshots(row.id);
      const pctSeries = snapshots
        .map((snapshot) => snapshot.unrealizedPnlPct)
        .filter((value): value is number => value !== null);
      if (unrealizedPnlPct !== null) pctSeries.push(unrealizedPnlPct);
      if (realizedPnlPct !== null) pctSeries.push(realizedPnlPct);

      return {
        id: row.id,
        tokenId: row.token_id,
        symbol: row.symbol,
        mint: row.mint,
        mode: row.mode,
        status: row.status,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        entryPriceUsd: row.entry_price_usd,
        exitPriceUsd: row.exit_price_usd,
        quantity: row.quantity,
        amountUsd: row.amount_usd,
        realizedPnlUsd: row.realized_pnl_usd,
        realizedPnlPct: realizedPnlPct !== null ? Number(realizedPnlPct.toFixed(4)) : null,
        latestPriceUsd,
        unrealizedPnlUsd: unrealizedPnlUsd !== null ? Number(unrealizedPnlUsd.toFixed(6)) : null,
        unrealizedPnlPct: unrealizedPnlPct !== null ? Number(unrealizedPnlPct.toFixed(4)) : null,
        bestGainPct: pctSeries.length > 0 ? Number(Math.max(...pctSeries).toFixed(4)) : null,
        worstDrawdownPct: pctSeries.length > 0 ? Number(Math.min(...pctSeries).toFixed(4)) : null,
        notes: row.notes
      } satisfies PaperPositionView;
    });
  }

  getLatestScanTime(): string | null {
    const row = this.sqlite
      .prepare("SELECT finished_at FROM run_logs WHERE run_type = 'token:scan' AND status = 'SUCCESS' ORDER BY id DESC LIMIT 1")
      .get() as { finished_at: string | null } | undefined;
    return row?.finished_at ?? null;
  }

  getTokenCount(): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) as count FROM tokens').get() as { count: number };
    return row.count;
  }

  getVerdictCounts(): Record<Verdict, number> {
    const rows = this.sqlite
      .prepare(
        `SELECT verdict, COUNT(*) as count
         FROM token_scores
         WHERE id IN (SELECT MAX(id) FROM token_scores GROUP BY token_id)
         GROUP BY verdict`
      )
      .all() as Array<{ verdict: Verdict; count: number }>;
    return {
      AVOID: rows.find((row) => row.verdict === 'AVOID')?.count ?? 0,
      WATCH: rows.find((row) => row.verdict === 'WATCH')?.count ?? 0,
      PAPER_BUY: rows.find((row) => row.verdict === 'PAPER_BUY')?.count ?? 0,
      AUTOPILOT_ELIGIBLE: rows.find((row) => row.verdict === 'AUTOPILOT_ELIGIBLE')?.count ?? 0
    };
  }

  getVerdictCountsForDate(date = toToday()): Record<Verdict, number> {
    const rows = this.sqlite
      .prepare('SELECT verdict, COUNT(*) as count FROM token_scores WHERE substr(scored_at, 1, 10) = ? GROUP BY verdict')
      .all(date) as Array<{ verdict: Verdict; count: number }>;
    return {
      AVOID: rows.find((row) => row.verdict === 'AVOID')?.count ?? 0,
      WATCH: rows.find((row) => row.verdict === 'WATCH')?.count ?? 0,
      PAPER_BUY: rows.find((row) => row.verdict === 'PAPER_BUY')?.count ?? 0,
      AUTOPILOT_ELIGIBLE: rows.find((row) => row.verdict === 'AUTOPILOT_ELIGIBLE')?.count ?? 0
    };
  }

  getClosedPaperPnl(): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(SUM(realized_pnl_usd), 0) as total FROM positions WHERE mode = 'PAPER' AND status = 'CLOSED'")
      .get() as { total: number };
    return row.total;
  }

  getBlockedRealTradeAttempts(): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) as count FROM real_trade_attempts WHERE blocked = 1').get() as { count: number };
    return row.count;
  }

  getSafetyEventSummary(): Record<string, number> {
    const rows = this.sqlite.prepare('SELECT event_type, COUNT(*) as count FROM safety_events GROUP BY event_type').all() as Array<{ event_type: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.event_type, row.count]));
  }

  listSafetyEvents(date = toToday()): Array<{ eventType: string; message: string; rawJson: string; createdAt: string }> {
    return this.sqlite
      .prepare('SELECT event_type, message, raw_json, created_at FROM safety_events WHERE substr(created_at, 1, 10) = ? ORDER BY id DESC')
      .all(date)
      .map((row: any) => ({ eventType: row.event_type, message: row.message, rawJson: row.raw_json, createdAt: row.created_at }));
  }

  listRunLogs(runType?: string, date = toToday()): Array<{ runType: string; summary: Record<string, unknown> }> {
    const query = runType
      ? "SELECT run_type, summary_json FROM run_logs WHERE run_type = ? AND substr(started_at, 1, 10) = ? AND status = 'SUCCESS' ORDER BY id DESC"
      : "SELECT run_type, summary_json FROM run_logs WHERE substr(started_at, 1, 10) = ? AND status = 'SUCCESS' ORDER BY id DESC";
    const rows = (runType ? this.sqlite.prepare(query).all(runType, date) : this.sqlite.prepare(query).all(date)) as any[];
    return rows.map((row) => ({ runType: row.run_type, summary: JSON.parse(row.summary_json) }));
  }

  listClosedPositionsToday(mode: PositionMode = 'PAPER', date = toToday()): PaperPositionView[] {
    return this.listPositions(mode).filter((position) => position.status === 'CLOSED' && position.closedAt?.startsWith(date));
  }

  getCandidateByMint(mint: string): { tokenId: number; snapshot: TokenCandidate | null; score: TokenScoreResult | null } | null {
    const token = this.findTokenByMint(mint);
    if (!token) return null;
    return {
      tokenId: token.id,
      snapshot: this.getLatestSnapshot(token.id),
      score: this.getLatestScore(token.id)
    };
  }
}

export function createDb(config: AppConfig): AppDb {
  return new AppDb(config);
}
