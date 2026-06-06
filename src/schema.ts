export const schemaSql = `
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(chain, mint)
);

CREATE TABLE IF NOT EXISTS token_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  price_usd REAL,
  liquidity_usd REAL,
  market_cap_usd REAL,
  volume_5m_usd REAL,
  volume_1h_usd REAL,
  volume_24h_usd REAL,
  price_change_5m_pct REAL,
  price_change_1h_pct REAL,
  buys_5m INTEGER,
  sells_5m INTEGER,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS token_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  scored_at TEXT NOT NULL,
  momentum_score REAL NOT NULL,
  safety_score REAL NOT NULL,
  social_score REAL NOT NULL,
  total_score REAL NOT NULL,
  verdict TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  red_flags_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS trade_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  side TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  safety_snapshot_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  proposal_id INTEGER,
  side TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  price_usd REAL NOT NULL,
  quantity REAL NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id),
  FOREIGN KEY(proposal_id) REFERENCES trade_proposals(id)
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  entry_price_usd REAL NOT NULL,
  exit_price_usd REAL,
  quantity REAL NOT NULL,
  amount_usd REAL NOT NULL,
  realized_pnl_usd REAL,
  notes TEXT,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS paper_performance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  price_usd REAL,
  unrealized_pnl_usd REAL,
  unrealized_pnl_pct REAL,
  liquidity_usd REAL,
  market_cap_usd REAL,
  volume_5m_usd REAL,
  volume_1h_usd REAL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(position_id) REFERENCES positions(id),
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS paper_entry_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  profile TEXT,
  priority TEXT,
  score_total REAL,
  score_safety REAL,
  score_momentum REAL,
  verdict TEXT,
  data_age_minutes REAL,
  token_age_minutes REAL,
  moved_before_discovery_pct REAL,
  raw_json TEXT NOT NULL,
  UNIQUE(position_id),
  FOREIGN KEY(position_id) REFERENCES positions(id),
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS watch_only_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  entry_price_usd REAL,
  latest_price_usd REAL,
  best_price_usd REAL,
  worst_price_usd REAL,
  best_gain_pct REAL,
  worst_drawdown_pct REAL,
  liquidity_usd REAL,
  volume_5m_usd REAL,
  volume_1h_usd REAL,
  raw_json TEXT NOT NULL,
  UNIQUE(token_id),
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS watch_only_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_candidate_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  window_label TEXT NOT NULL,
  target_minutes INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  entry_price_usd REAL,
  observed_price_usd REAL,
  return_pct REAL,
  best_gain_pct REAL,
  worst_drawdown_pct REAL,
  would_hit_take_profit INTEGER NOT NULL,
  would_hit_stop_loss INTEGER NOT NULL,
  liquidity_usd REAL,
  volume_5m_usd REAL,
  volume_1h_usd REAL,
  notes TEXT,
  raw_json TEXT NOT NULL,
  UNIQUE(watch_candidate_id, window_label),
  FOREIGN KEY(watch_candidate_id) REFERENCES watch_only_candidates(id),
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS watch_only_signal_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_candidate_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  signal_class TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  best_gain_pct REAL,
  worst_drawdown_pct REAL,
  moved_before_discovery_pct REAL,
  liquidity_usd REAL,
  sell_quote_available TEXT,
  mint_authority TEXT,
  freeze_authority TEXT,
  reason TEXT NOT NULL,
  notes TEXT,
  raw_json TEXT NOT NULL,
  UNIQUE(watch_candidate_id),
  FOREIGN KEY(watch_candidate_id) REFERENCES watch_only_candidates(id),
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS solana_safety_enrichments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  freeze_authority TEXT,
  mint_authority TEXT,
  mint_authority_renounced INTEGER,
  freeze_authority_renounced INTEGER,
  token_program TEXT,
  supply TEXT,
  decimals INTEGER,
  holder_count INTEGER,
  top_holder_pct REAL,
  top_10_holder_pct REAL,
  holder_concentration_level TEXT NOT NULL,
  holder_concentration_status TEXT,
  creator_address TEXT,
  creator_status TEXT,
  lp_or_pool_address TEXT,
  pool_age_minutes REAL,
  safety_status TEXT,
  red_flags_json TEXT NOT NULL,
  notes TEXT,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS quote_sellability_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  quote_provider TEXT NOT NULL,
  input_mint TEXT,
  output_mint TEXT,
  sell_amount_usd REAL NOT NULL,
  sell_amount_raw TEXT,
  route_available INTEGER,
  expected_output_amount TEXT,
  estimated_slippage_bps REAL,
  price_impact_pct REAL,
  sell_quote_status TEXT,
  safety_status TEXT,
  error_summary TEXT,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS real_trade_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL,
  proposal_id INTEGER,
  side TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  attempted_at TEXT NOT NULL,
  blocked INTEGER NOT NULL,
  block_reason TEXT NOT NULL,
  tx_signature TEXT,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id),
  FOREIGN KEY(proposal_id) REFERENCES trade_proposals(id)
);

CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER,
  created_at TEXT NOT NULL,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_refresh_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  watch_candidate_id INTEGER,
  symbol TEXT,
  source TEXT,
  pool_address TEXT,
  window_hours REAL,
  outcome TEXT NOT NULL,
  reason TEXT,
  snapshots_inserted INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tokens(id),
  FOREIGN KEY(watch_candidate_id) REFERENCES watch_only_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_tokens_last_seen_at ON tokens(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_snapshots_token_id_id ON token_snapshots(token_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_token_snapshots_token_id_observed_at ON token_snapshots(token_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_scores_token_id_scored_at_id ON token_scores(token_id, scored_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_positions_mode_status_opened_at ON positions(mode, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_mode_closed_at ON positions(mode, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_created_at ON paper_trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_only_candidates_created_at ON watch_only_candidates(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_watch_only_outcomes_observed_at ON watch_only_outcomes(observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_watch_only_signal_analysis_analyzed_at ON watch_only_signal_analysis(analyzed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_solana_safety_enrichments_token_id_checked_at ON solana_safety_enrichments(token_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_sellability_checks_token_id_checked_at ON quote_sellability_checks(token_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_events_created_at_event_type ON safety_events(created_at DESC, event_type);
CREATE INDEX IF NOT EXISTS idx_run_logs_run_type_started_at ON run_logs(run_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_refresh_attempts_attempted_at ON watch_refresh_attempts(attempted_at DESC);
`;
