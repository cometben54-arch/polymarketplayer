"""FastAPI server with REST API and WebSocket support."""

import asyncio
import json
import logging
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.config import config
from backend.database import init_db, get_db, get_bot_state, set_bot_state, add_alert
from backend.models import MarketAdd, ArbitrageGroupCreate, RiskSettings, BotCommand
from backend.engine import bot_loop, set_ws_broadcast, broadcast
from backend.risk import risk_manager
from backend.polymarket_client import polymarket

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Polymarket Arbitrage Bot", version="1.0.0")

# WebSocket connections
ws_clients: set[WebSocket] = set()


async def ws_broadcast(message: str):
    """Send a message to all connected WebSocket clients."""
    disconnected = set()
    for ws in ws_clients:
        try:
            await ws.send_text(message)
        except Exception:
            disconnected.add(ws)
    ws_clients -= disconnected


set_ws_broadcast(ws_broadcast)


@app.on_event("startup")
async def startup():
    await init_db()
    asyncio.create_task(bot_loop())
    logger.info(f"Server started on {config.HOST}:{config.PORT}")


# --- Static files ---
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("frontend/index.html")


# --- WebSocket ---
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        # Send initial state
        state = {
            "running": await get_bot_state("running") == "true",
            "paused": await get_bot_state("paused") == "true",
            "daily_pnl": float(await get_bot_state("daily_pnl") or "0"),
            "total_pnl": float(await get_bot_state("total_pnl") or "0"),
        }
        await ws.send_text(json.dumps({"event": "state", "data": state}))
        while True:
            await ws.receive_text()  # keep alive
    except WebSocketDisconnect:
        ws_clients.discard(ws)


# --- Bot Control ---
@app.post("/api/bot/control")
async def bot_control(cmd: BotCommand):
    if cmd.action == "start":
        await set_bot_state("running", "true")
        await set_bot_state("paused", "false")
        await broadcast("state", {"running": True, "paused": False})
        return {"status": "started"}
    elif cmd.action == "stop":
        await set_bot_state("running", "false")
        await broadcast("state", {"running": False, "paused": False})
        return {"status": "stopped"}
    elif cmd.action == "pause":
        await set_bot_state("paused", "true")
        await broadcast("state", {"paused": True})
        await add_alert("info", "Bot paused by user")
        return {"status": "paused"}
    elif cmd.action == "resume":
        await set_bot_state("paused", "false")
        await broadcast("state", {"paused": False})
        return {"status": "resumed"}
    return {"status": "unknown action"}


@app.get("/api/bot/status")
async def bot_status():
    return {
        "running": await get_bot_state("running") == "true",
        "paused": await get_bot_state("paused") == "true",
        "daily_pnl": float(await get_bot_state("daily_pnl") or "0"),
        "total_pnl": float(await get_bot_state("total_pnl") or "0"),
        "trading_ready": polymarket.is_trading_ready(),
    }


# --- Markets ---
@app.get("/api/markets")
async def list_markets():
    async with await get_db() as db:
        cursor = await db.execute("SELECT * FROM watched_markets WHERE active = 1 ORDER BY added_at DESC")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


@app.post("/api/markets")
async def add_market(market: MarketAdd):
    async with await get_db() as db:
        await db.execute(
            "INSERT OR REPLACE INTO watched_markets (condition_id, question, token_yes, token_no) VALUES (?, ?, ?, ?)",
            (market.condition_id, market.question, market.token_yes, market.token_no),
        )
        await db.commit()
    return {"status": "added", "condition_id": market.condition_id}


@app.delete("/api/markets/{condition_id}")
async def remove_market(condition_id: str):
    async with await get_db() as db:
        await db.execute("UPDATE watched_markets SET active = 0 WHERE condition_id = ?", (condition_id,))
        await db.commit()
    return {"status": "removed"}


@app.get("/api/markets/search")
async def search_markets(q: str = ""):
    """Search Polymarket for markets (proxied to API)."""
    try:
        result = polymarket.get_markets()
        markets = result.get("data", []) if isinstance(result, dict) else []
        if q:
            q_lower = q.lower()
            markets = [m for m in markets if q_lower in str(m.get("question", "")).lower()]
        return markets[:20]
    except Exception as e:
        return {"error": str(e)}


# --- Arbitrage Groups ---
@app.get("/api/groups")
async def list_groups():
    async with await get_db() as db:
        cursor = await db.execute("SELECT * FROM arbitrage_groups WHERE active = 1")
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["market_ids"] = json.loads(d["market_ids"]) if isinstance(d["market_ids"], str) else d["market_ids"]
            result.append(d)
        return result


@app.post("/api/groups")
async def create_group(group: ArbitrageGroupCreate):
    async with await get_db() as db:
        await db.execute(
            "INSERT INTO arbitrage_groups (name, description, market_ids, strategy) VALUES (?, ?, ?, ?)",
            (group.name, group.description, json.dumps(group.market_ids), group.strategy),
        )
        await db.commit()
    return {"status": "created"}


@app.delete("/api/groups/{group_id}")
async def delete_group(group_id: int):
    async with await get_db() as db:
        await db.execute("UPDATE arbitrage_groups SET active = 0 WHERE id = ?", (group_id,))
        await db.commit()
    return {"status": "removed"}


# --- Risk Settings ---
@app.get("/api/risk")
async def get_risk_settings():
    return {
        "max_position_size_usd": risk_manager.max_position_usd,
        "daily_loss_limit_usd": risk_manager.daily_loss_limit,
        "max_single_trade_usd": risk_manager.max_single_trade,
        "min_arbitrage_spread": risk_manager.min_spread,
    }


@app.put("/api/risk")
async def update_risk(settings: RiskSettings):
    await risk_manager.update_settings(**settings.model_dump())
    return {"status": "updated"}


# --- Trades & History ---
@app.get("/api/trades")
async def list_trades(limit: int = 50):
    async with await get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM trades ORDER BY created_at DESC LIMIT ?", (limit,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


# --- Alerts ---
@app.get("/api/alerts")
async def list_alerts(limit: int = 50):
    async with await get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?", (limit,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


@app.post("/api/alerts/{alert_id}/resolve")
async def resolve_alert(alert_id: int):
    async with await get_db() as db:
        await db.execute("UPDATE alerts SET resolved = 1 WHERE id = ?", (alert_id,))
        await db.commit()
    return {"status": "resolved"}


# --- Price History ---
@app.get("/api/prices/{condition_id}")
async def price_history(condition_id: str, limit: int = 100):
    async with await get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM price_snapshots WHERE condition_id = ? ORDER BY recorded_at DESC LIMIT ?",
            (condition_id, limit),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
