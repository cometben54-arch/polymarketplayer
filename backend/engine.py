"""Main bot engine - orchestrates scanning and trading on a schedule."""

import asyncio
import json
import logging
from datetime import datetime
from backend.config import config
from backend.database import init_db, get_db, get_bot_state, set_bot_state, add_alert
from backend.arbitrage import scan_all_opportunities
from backend.risk import trade_executor, risk_manager
from backend.polymarket_client import polymarket

logger = logging.getLogger(__name__)

# WebSocket broadcast callback (set by server.py)
_ws_broadcast = None


def set_ws_broadcast(fn):
    global _ws_broadcast
    _ws_broadcast = fn


async def broadcast(event: str, data: dict):
    """Broadcast event to connected WebSocket clients."""
    if _ws_broadcast:
        await _ws_broadcast(json.dumps({"event": event, "data": data, "ts": datetime.utcnow().isoformat()}))


async def get_watched_markets() -> list[dict]:
    """Get all active watched markets from DB."""
    async with await get_db() as db:
        cursor = await db.execute("SELECT * FROM watched_markets WHERE active = 1")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_arb_groups() -> list[dict]:
    """Get all active arbitrage groups from DB."""
    async with await get_db() as db:
        cursor = await db.execute("SELECT * FROM arbitrage_groups WHERE active = 1")
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["market_ids"] = json.loads(d["market_ids"]) if isinstance(d["market_ids"], str) else d["market_ids"]
            result.append(d)
        return result


async def record_prices(markets: list[dict]):
    """Snapshot current prices for tracking."""
    async with await get_db() as db:
        for m in markets:
            price_yes = None
            price_no = None
            if m.get("token_yes"):
                price_yes = polymarket.get_midpoint(m["token_yes"])
            if m.get("token_no"):
                price_no = polymarket.get_midpoint(m["token_no"])

            spread = None
            if price_yes is not None and price_no is not None:
                spread = abs(1.0 - price_yes - price_no)

            await db.execute(
                "INSERT INTO price_snapshots (condition_id, price_yes, price_no, spread) VALUES (?, ?, ?, ?)",
                (m["condition_id"], price_yes, price_no, spread),
            )
        await db.commit()


async def run_scan_cycle():
    """One cycle of scanning and trading."""
    try:
        running = await get_bot_state("running")
        paused = await get_bot_state("paused")
        if running != "true" or paused == "true":
            return

        markets = await get_watched_markets()
        groups = await get_arb_groups()

        if not markets:
            return

        # Record prices
        await record_prices(markets)

        # Scan for opportunities
        opportunities = scan_all_opportunities(
            watched_markets=markets,
            arb_groups=groups,
            min_spread=risk_manager.min_spread,
            trade_size=risk_manager.max_single_trade,
        )

        # Broadcast scan results
        await broadcast("scan_complete", {
            "markets_scanned": len(markets),
            "opportunities_found": len(opportunities),
            "opportunities": [
                {
                    "group": opp.group_name,
                    "strategy": opp.strategy,
                    "spread": round(opp.spread, 4),
                    "expected_profit": round(opp.expected_profit_usd, 2),
                    "confidence": round(opp.confidence, 2),
                    "legs": len(opp.legs),
                }
                for opp in opportunities
            ],
        })

        # Execute trades for each opportunity
        for opp in opportunities:
            result = await trade_executor.execute(opp)
            await broadcast("trade_executed", result)

            if not result["success"]:
                logger.warning(f"Trade not executed: {result.get('reason', 'unknown')}")

    except Exception as e:
        logger.error(f"Scan cycle error: {e}", exc_info=True)
        await add_alert("error", f"Scan cycle error: {str(e)}")
        await broadcast("error", {"message": str(e)})


async def bot_loop():
    """Main bot loop running on interval."""
    await init_db()
    logger.info("Bot engine initialized")

    while True:
        await run_scan_cycle()
        await asyncio.sleep(config.POLL_INTERVAL)
