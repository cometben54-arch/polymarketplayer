-- Polymarket Bot D1 Schema v2.0

-- Watched markets with user conviction and topic tags
CREATE TABLE IF NOT EXISTS watched_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT UNIQUE NOT NULL,
    question TEXT NOT NULL,
    token_yes TEXT,
    token_no TEXT,
    active INTEGER DEFAULT 1,
    user_conviction REAL DEFAULT 0.5,
    topic TEXT DEFAULT 'other',
    added_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS arbitrage_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    market_ids TEXT NOT NULL,
    strategy TEXT DEFAULT 'complement',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Trades with strategy info and paper/real mode
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    condition_id TEXT,
    side TEXT NOT NULL,
    token_id TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    amount_usd REAL NOT NULL,
    order_id TEXT,
    status TEXT DEFAULT 'pending',
    strategy TEXT DEFAULT '',
    mode TEXT DEFAULT 'paper',
    pnl REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT NOT NULL,
    price_yes REAL,
    price_no REAL,
    spread REAL,
    volume_yes REAL DEFAULT 0,
    volume_no REAL DEFAULT 0,
    recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- AI analysis logs
CREATE TABLE IF NOT EXISTS ai_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Default bot state
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('running', 'false');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('paused', 'false');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('daily_pnl', '0');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('total_pnl', '0');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('last_reset_date', '');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('last_trade_time', '0');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('last_ai_review', '');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('last_ai_logical', '0');

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('MAX_POSITION_SIZE_USD', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('DAILY_LOSS_LIMIT_USD', '50');
INSERT OR IGNORE INTO settings (key, value) VALUES ('MAX_SINGLE_TRADE_USD', '20');
INSERT OR IGNORE INTO settings (key, value) VALUES ('MIN_ARBITRAGE_SPREAD', '0.02');
INSERT OR IGNORE INTO settings (key, value) VALUES ('POLL_INTERVAL', '120');
INSERT OR IGNORE INTO settings (key, value) VALUES ('TRADING_MODE', 'paper');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ENABLED_STRATEGIES', 'complement,probability,market_making,momentum');
INSERT OR IGNORE INTO settings (key, value) VALUES ('TRADE_COOLDOWN_SEC', '60');
INSERT OR IGNORE INTO settings (key, value) VALUES ('STARTING_CASH', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('AI_MODEL_FAST', 'gpt-4o-mini');
