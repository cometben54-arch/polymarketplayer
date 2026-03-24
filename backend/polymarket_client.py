"""Wrapper around Polymarket CLOB API using httpx with HMAC authentication."""

import base64
import hashlib
import hmac
import logging
import time
from typing import Optional
import httpx
from backend.config import config

logger = logging.getLogger(__name__)

CLOB_URL = config.POLYMARKET_API_URL.rstrip("/")
GAMMA_URL = config.GAMMA_API_URL.rstrip("/")
DATA_URL = config.DATA_API_URL.rstrip("/")


def _build_hmac_signature(secret: str, timestamp: str, method: str, path: str, body: str = "") -> str:
    """Build HMAC-SHA256 signature for CLOB API authentication."""
    message = timestamp + method.upper() + path + body
    key = base64.urlsafe_b64decode(secret)
    sig = hmac.new(key, message.encode("utf-8"), hashlib.sha256)
    return base64.urlsafe_b64encode(sig.digest()).decode("utf-8")


def _auth_headers(method: str, path: str, body: str = "") -> dict:
    """Generate authentication headers for CLOB API requests."""
    if not config.POLYMARKET_API_KEY:
        return {}
    timestamp = str(int(time.time()))
    sig = _build_hmac_signature(config.POLYMARKET_API_SECRET, timestamp, method, path, body)
    return {
        "POLY_HMAC_KEY": config.POLYMARKET_API_KEY,
        "POLY_HMAC_SIGNATURE": sig,
        "POLY_HMAC_TIMESTAMP": timestamp,
        "POLY_HMAC_PASSPHRASE": config.POLYMARKET_API_PASSPHRASE,
    }


class PolymarketClient:
    """Interface to Polymarket CLOB, Gamma, and Data APIs."""

    def __init__(self):
        self._clob = httpx.Client(base_url=CLOB_URL, timeout=15)
        self._gamma = httpx.Client(base_url=GAMMA_URL, timeout=15)
        self._data = httpx.Client(base_url=DATA_URL, timeout=15)

    # ---- CLOB API: Read-only endpoints ----

    def get_markets(self, next_cursor: str = "") -> dict:
        """Get list of available markets from CLOB."""
        try:
            params = {}
            if next_cursor:
                params["next_cursor"] = next_cursor
            resp = self._clob.get("/markets", params=params)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get markets: {e}")
            return {"data": [], "next_cursor": ""}

    def get_market(self, condition_id: str) -> Optional[dict]:
        """Get a single market by condition ID."""
        try:
            resp = self._clob.get(f"/markets/{condition_id}")
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get market {condition_id}: {e}")
            return None

    def get_orderbook(self, token_id: str) -> Optional[dict]:
        """Get order book for a token."""
        try:
            resp = self._clob.get("/book", params={"token_id": token_id})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get orderbook for {token_id}: {e}")
            return None

    def get_midpoint(self, token_id: str) -> Optional[float]:
        """Get midpoint price for a token."""
        try:
            resp = self._clob.get("/midpoint", params={"token_id": token_id})
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
            resp = self._clob.get("/price", params={"token_id": token_id, "side": side})
            resp.raise_for_status()
            data = resp.json()
            price = data.get("price")
            return float(price) if price else None
        except Exception as e:
            logger.error(f"Failed to get price for {token_id}: {e}")
            return None

    # ---- CLOB API: Authenticated endpoints ----

    def get_api_keys(self) -> list:
        """List API keys for the authenticated user."""
        path = "/auth/api-keys"
        headers = _auth_headers("GET", path)
        try:
            resp = self._clob.get(path, headers=headers)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get API keys: {e}")
            return []

    def get_open_orders(self) -> list:
        """Get all open orders for the authenticated user."""
        path = "/data/orders"
        headers = _auth_headers("GET", path)
        try:
            resp = self._clob.get(path, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else data.get("data", [])
        except Exception as e:
            logger.error(f"Failed to get open orders: {e}")
            return []

    def get_trades(self) -> list:
        """Get trade history for the authenticated user."""
        path = "/data/trades"
        headers = _auth_headers("GET", path)
        try:
            resp = self._clob.get(path, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else data.get("data", [])
        except Exception as e:
            logger.error(f"Failed to get trades: {e}")
            return []

    # ---- Gamma API: Market discovery ----

    def search_markets(self, query: str, limit: int = 10) -> list:
        """Search markets by keyword via Gamma API."""
        try:
            resp = self._gamma.get("/markets", params={"slug": query, "limit": limit, "active": True})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to search markets: {e}")
            return []

    def get_events(self, limit: int = 10) -> list:
        """Get recent events via Gamma API."""
        try:
            resp = self._gamma.get("/events", params={"limit": limit, "active": True})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get events: {e}")
            return []

    # ---- Data API: Positions & activity ----

    def get_positions(self, address: str = "") -> list:
        """Get positions for a wallet address via Data API."""
        addr = address or config.POLYMARKET_FUNDER_ADDRESS
        if not addr:
            logger.warning("No wallet address configured for position query")
            return []
        try:
            resp = self._data.get(f"/positions", params={"user": addr})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get positions: {e}")
            return []

    def get_balance(self) -> Optional[dict]:
        """Get balance info via Data API."""
        addr = config.POLYMARKET_FUNDER_ADDRESS
        if not addr:
            logger.warning("No wallet address configured for balance query")
            return None
        try:
            resp = self._data.get(f"/activity", params={"user": addr, "limit": 1})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get balance: {e}")
            return None

    # ---- Trading endpoints (require private key signing) ----

    def place_limit_order(self, token_id: str, price: float, size: float, side: str) -> Optional[dict]:
        """Place a limit order. Requires POLYMARKET_PRIVATE_KEY + API credentials."""
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

    def is_trading_ready(self) -> bool:
        """Check if all trading credentials are configured."""
        return bool(
            config.POLYMARKET_PRIVATE_KEY
            and config.POLYMARKET_API_KEY
            and config.POLYMARKET_API_SECRET
            and config.POLYMARKET_API_PASSPHRASE
        )


# Singleton
polymarket = PolymarketClient()
