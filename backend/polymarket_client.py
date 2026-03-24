"""Wrapper around Polymarket CLOB API using httpx (no py-clob-client dependency)."""

import logging
from typing import Optional
import httpx
from backend.config import config

logger = logging.getLogger(__name__)

# Polymarket CLOB REST endpoints
BASE_URL = config.POLYMARKET_API_URL.rstrip("/")


class PolymarketClient:
    """Simplified interface to Polymarket CLOB API via direct HTTP calls."""

    def __init__(self):
        self._http = httpx.Client(base_url=BASE_URL, timeout=15, trust_env=False)

    # ---- Read-only endpoints ----

    def get_markets(self, next_cursor: str = "") -> dict:
        """Get list of available markets."""
        try:
            params = {}
            if next_cursor:
                params["next_cursor"] = next_cursor
            resp = self._http.get("/markets", params=params)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get markets: {e}")
            return {"data": [], "next_cursor": ""}

    def get_market(self, condition_id: str) -> Optional[dict]:
        """Get a single market by condition ID."""
        try:
            resp = self._http.get(f"/markets/{condition_id}")
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get market {condition_id}: {e}")
            return None

    def get_orderbook(self, token_id: str) -> Optional[dict]:
        """Get order book for a token."""
        try:
            resp = self._http.get("/book", params={"token_id": token_id})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get orderbook for {token_id}: {e}")
            return None

    def get_midpoint(self, token_id: str) -> Optional[float]:
        """Get midpoint price for a token."""
        try:
            resp = self._http.get("/midpoint", params={"token_id": token_id})
            resp.raise_for_status()
            data = resp.json()
            mid = data.get("mid")
            return float(mid) if mid else None
        except Exception as e:
            logger.error(f"Failed to get midpoint for {token_id}: {e}")
            return None

    def get_price(self, token_id: str, side: str = "BUY") -> Optional[float]:
        """Get best price for a token on a given side."""
        try:
            resp = self._http.get("/price", params={"token_id": token_id, "side": side})
            resp.raise_for_status()
            data = resp.json()
            price = data.get("price")
            return float(price) if price else None
        except Exception as e:
            logger.error(f"Failed to get price for {token_id}: {e}")
            return None

    # ---- Trading endpoints (stubs – require signing logic) ----

    def place_limit_order(self, token_id: str, price: float, size: float, side: str) -> Optional[dict]:
        """Place a limit order. Requires POLYMARKET_PRIVATE_KEY."""
        logger.warning("Trading via direct HTTP not yet implemented – need on-chain signing")
        return None

    def place_market_order(self, token_id: str, amount_usd: float, side: str) -> Optional[dict]:
        """Place a market order by dollar amount."""
        logger.warning("Trading via direct HTTP not yet implemented – need on-chain signing")
        return None

    def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order."""
        logger.warning("Trading via direct HTTP not yet implemented – need on-chain signing")
        return False

    def get_open_orders(self) -> list:
        """Get all open orders."""
        try:
            if not config.POLYMARKET_PRIVATE_KEY:
                return []
            # This endpoint requires auth headers in production
            return []
        except Exception as e:
            logger.error(f"Failed to get open orders: {e}")
            return []

    def is_trading_ready(self) -> bool:
        """Check if trading credentials are configured."""
        return bool(config.POLYMARKET_PRIVATE_KEY)


# Singleton
polymarket = PolymarketClient()
