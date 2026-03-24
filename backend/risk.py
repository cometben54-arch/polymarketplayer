"""Risk management and trade execution."""

import logging
from datetime import date
from backend.config import config
from backend.database import get_bot_state, set_bot_state, add_alert, get_db
from backend.polymarket_client import polymarket
from backend.arbitrage import ArbitrageOpportunity

logger = logging.getLogger(__name__)


class RiskManager:
    """Enforces risk limits before allowing trades."""

    def __init__(self):
        self.max_position_usd = config.MAX_POSITION_SIZE_USD
        self.daily_loss_limit = config.DAILY_LOSS_LIMIT_USD
        self.max_single_trade = config.MAX_SINGLE_TRADE_USD
        self.min_spread = config.MIN_ARBITRAGE_SPREAD

    async def update_settings(self, **kwargs):
        """Update risk parameters at runtime."""
        if "max_position_size_usd" in kwargs and kwargs["max_position_size_usd"] is not None:
            self.max_position_usd = kwargs["max_position_size_usd"]
        if "daily_loss_limit_usd" in kwargs and kwargs["daily_loss_limit_usd"] is not None:
            self.daily_loss_limit = kwargs["daily_loss_limit_usd"]
        if "max_single_trade_usd" in kwargs and kwargs["max_single_trade_usd"] is not None:
            self.max_single_trade = kwargs["max_single_trade_usd"]
        if "min_arbitrage_spread" in kwargs and kwargs["min_arbitrage_spread"] is not None:
            self.min_spread = kwargs["min_arbitrage_spread"]

    async def check_daily_reset(self):
        """Reset daily P&L if new day."""
        last_reset = await get_bot_state("last_reset_date")
        today = date.today().isoformat()
        if last_reset != today:
            await set_bot_state("daily_pnl", "0")
            await set_bot_state("last_reset_date", today)

    async def can_trade(self, opportunity: ArbitrageOpportunity) -> tuple[bool, str]:
        """Check if a trade passes all risk checks."""
        await self.check_daily_reset()

        # Check bot state
        paused = await get_bot_state("paused")
        if paused == "true":
            return False, "Bot is paused"

        running = await get_bot_state("running")
        if running != "true":
            return False, "Bot is not running"

        # Check minimum spread
        if opportunity.spread < self.min_spread:
            return False, f"Spread {opportunity.spread:.4f} below minimum {self.min_spread:.4f}"

        # Check single trade size
        total_trade_usd = sum(leg["price"] * leg["size"] for leg in opportunity.legs)
        if total_trade_usd > self.max_single_trade * len(opportunity.legs):
            return False, f"Trade size ${total_trade_usd:.2f} exceeds max ${self.max_single_trade * len(opportunity.legs):.2f}"

        # Check daily loss limit
        daily_pnl = float(await get_bot_state("daily_pnl") or "0")
        if daily_pnl <= -self.daily_loss_limit:
            await add_alert("critical", f"Daily loss limit reached: ${daily_pnl:.2f}")
            await set_bot_state("paused", "true")
            return False, f"Daily loss limit reached: ${daily_pnl:.2f}"

        # Check total position size
        async with await get_db() as db:
            cursor = await db.execute(
                "SELECT COALESCE(SUM(amount_usd), 0) FROM trades WHERE status = 'filled'"
            )
            row = await cursor.fetchone()
            total_position = row[0] if row else 0

        if total_position + total_trade_usd > self.max_position_usd:
            return False, f"Position size would exceed max ${self.max_position_usd:.2f}"

        return True, "OK"

    async def record_trade(self, group_id: int, leg: dict, order_result: dict, status: str = "filled"):
        """Record a trade in the database."""
        async with await get_db() as db:
            await db.execute(
                """INSERT INTO trades (group_id, condition_id, side, token_id, price, size, amount_usd, order_id, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    group_id,
                    leg["condition_id"],
                    leg["side"],
                    leg["token_id"],
                    leg["price"],
                    leg["size"],
                    leg["price"] * leg["size"],
                    order_result.get("orderID", "") if order_result else "",
                    status,
                ),
            )
            await db.commit()


class TradeExecutor:
    """Executes arbitrage opportunities after risk checks."""

    def __init__(self):
        self.risk = RiskManager()

    async def execute(self, opportunity: ArbitrageOpportunity) -> dict:
        """Execute an arbitrage opportunity if it passes risk checks."""
        can_trade, reason = await self.risk.can_trade(opportunity)
        if not can_trade:
            logger.info(f"Trade blocked: {reason}")
            return {"success": False, "reason": reason}

        if not polymarket.is_trading_ready():
            return {"success": False, "reason": "Trading credentials not configured"}

        results = []
        all_success = True

        for leg in opportunity.legs:
            result = polymarket.place_limit_order(
                token_id=leg["token_id"],
                price=leg["price"],
                size=leg["size"],
                side=leg["side"],
            )

            if result:
                await self.risk.record_trade(0, leg, result, "filled")
                results.append({"leg": leg, "result": result, "success": True})
            else:
                all_success = False
                await self.risk.record_trade(0, leg, {}, "failed")
                results.append({"leg": leg, "result": None, "success": False})
                await add_alert(
                    "warning",
                    f"Leg failed: {leg['side']} {leg['token_id'][:8]}... @ {leg['price']}"
                )

        if not all_success:
            await add_alert(
                "critical",
                f"Partial fill on {opportunity.group_name} - manual review needed"
            )
            await set_bot_state("paused", "true")

        # Update daily P&L tracking
        if all_success:
            daily_pnl = float(await get_bot_state("daily_pnl") or "0")
            # For now, count expected profit; actual P&L realized on settlement
            await set_bot_state("daily_pnl", str(daily_pnl + opportunity.expected_profit_usd))
            total_pnl = float(await get_bot_state("total_pnl") or "0")
            await set_bot_state("total_pnl", str(total_pnl + opportunity.expected_profit_usd))

        return {
            "success": all_success,
            "opportunity": {
                "group": opportunity.group_name,
                "spread": opportunity.spread,
                "expected_profit": opportunity.expected_profit_usd,
            },
            "results": [
                {"side": r["leg"]["side"], "price": r["leg"]["price"], "success": r["success"]}
                for r in results
            ],
        }


# Singletons
risk_manager = RiskManager()
trade_executor = TradeExecutor()
