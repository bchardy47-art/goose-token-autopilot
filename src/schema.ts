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
`;
