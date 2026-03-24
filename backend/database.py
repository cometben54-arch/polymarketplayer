"""SQLite database setup and access."""

import aiosqlite
import json
from datetime import datetime
from backend.config import config

DB_PATH = config.DB_PATH


async def init_db():
    """Create tables if they don't exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
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
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (group_id) REFERENCES arbitrage_groups(id)
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

            INSERT OR IGNORE INTO bot_state (key, value) VALUES ('running', 'false');
            INSERT OR IGNORE INTO bot_state (key, value) VALUES ('paused', 'false');
            INSERT OR IGNORE INTO bot_state (key, value) VALUES ('daily_pnl', '0');
            INSERT OR IGNORE INTO bot_state (key, value) VALUES ('total_pnl', '0');
            INSERT OR IGNORE INTO bot_state (key, value) VALUES ('last_reset_date', '');
        """)
        await db.commit()


async def get_db():
    """Get a database connection."""
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def get_bot_state(key: str) -> str:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT value FROM bot_state WHERE key = ?", (key,))
        row = await cursor.fetchone()
        return row["value"] if row else ""


async def set_bot_state(key: str, value: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)",
            (key, value, datetime.utcnow().isoformat())
        )
        await db.commit()


async def add_alert(level: str, message: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO alerts (level, message) VALUES (?, ?)",
            (level, message)
        )
        await db.commit()
