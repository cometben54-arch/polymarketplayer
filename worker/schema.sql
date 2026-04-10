-- Polymarket Bot D1 Schema

CREATE TABLE IF NOT EXISTS watched_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT UNIQUE NOT NULL,
    question TEXT NOT NULL,
    token_yes TEXT,
    token_no TEXT,
    active INTEGER DEFAULT 1,
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
    recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default bot state
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('running', 'false');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('paused', 'false');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('daily_pnl', '0');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('total_pnl', '0');
INSERT OR IGNORE INTO bot_state (key, value) VALUES ('last_reset_date', '');

-- Default risk settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('MAX_POSITION_SIZE_USD', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('DAILY_LOSS_LIMIT_USD', '50');
INSERT OR IGNORE INTO settings (key, value) VALUES ('MAX_SINGLE_TRADE_USD', '20');
INSERT OR IGNORE INTO settings (key, value) VALUES ('MIN_ARBITRAGE_SPREAD', '0.02');
INSERT OR IGNORE INTO settings (key, value) VALUES ('POLL_INTERVAL', '120');
