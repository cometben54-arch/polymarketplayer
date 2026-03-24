"""Wrapper around Polymarket CLOB API client."""

import logging
from typing import Optional
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from backend.config import config

logger = logging.getLogger(__name__)


class PolymarketClient:
    """Simplified interface to Polymarket CLOB API."""

    def __init__(self):
        self._read_client = None
        self._trade_client = None

    def _get_read_client(self) -> ClobClient:
        """Client for read-only operations (no auth needed)."""
        if self._read_client is None:
            self._read_client = ClobClient(config.POLYMARKET_API_URL)
        return self._read_client

    def _get_trade_client(self) -> ClobClient:
        """Client for trading operations (requires private key)."""
        if self._trade_client is None:
            if not config.POLYMARKET_PRIVATE_KEY:
                raise ValueError("POLYMARKET_PRIVATE_KEY is required for trading")
            self._trade_client = ClobClient(
                config.POLYMARKET_API_URL,
                key=config.POLYMARKET_PRIVATE_KEY,
                chain_id=137,  # Polygon
                funder=config.POLYMARKET_FUNDER_ADDRESS or None,
                signature_type=config.POLYMARKET_SIGNATURE_TYPE,
            )
        return self._trade_client

    def get_markets(self, next_cursor: str = "") -> dict:
        """Get list of available markets."""
        try:
            client = self._get_read_client()
            return client.get_simplified_markets(next_cursor=next_cursor)
        except Exception as e:
            logger.error(f"Failed to get markets: {e}")
            return {"data": [], "next_cursor": ""}

    def get_market(self, condition_id: str) -> Optional[dict]:
        """Get a single market by condition ID."""
        try:
            client = self._get_read_client()
            return client.get_market(condition_id)
        except Exception as e:
            logger.error(f"Failed to get market {condition_id}: {e}")
            return None

    def get_orderbook(self, token_id: str) -> Optional[dict]:
        """Get order book for a token."""
        try:
            client = self._get_read_client()
            return client.get_order_book(token_id)
        except Exception as e:
            logger.error(f"Failed to get orderbook for {token_id}: {e}")
            return None

    def get_midpoint(self, token_id: str) -> Optional[float]:
        """Get midpoint price for a token."""
        try:
            client = self._get_read_client()
            mid = client.get_midpoint(token_id)
            return float(mid) if mid else None
        except Exception as e:
            logger.error(f"Failed to get midpoint for {token_id}: {e}")
            return None

    def get_price(self, token_id: str, side: str = "BUY") -> Optional[float]:
        """Get best price for a token on a given side."""
        try:
            client = self._get_read_client()
            price = client.get_price(token_id, side)
            return float(price) if price else None
        except Exception as e:
            logger.error(f"Failed to get price for {token_id}: {e}")
            return None

    def place_limit_order(self, token_id: str, price: float, size: float, side: str) -> Optional[dict]:
        """Place a limit order."""
        try:
            client = self._get_trade_client()
            order_args = OrderArgs(
                token_id=token_id,
                price=price,
                size=size,
                side=side,
            )
            signed_order = client.create_order(order_args)
            result = client.post_order(signed_order, OrderType.GTC)
            logger.info(f"Order placed: {side} {size} @ {price} for {token_id}")
            return result
        except Exception as e:
            logger.error(f"Failed to place order: {e}")
            return None

    def place_market_order(self, token_id: str, amount_usd: float, side: str) -> Optional[dict]:
        """Place a market order by dollar amount."""
        try:
            client = self._get_trade_client()
            result = client.create_market_order(
                OrderArgs(token_id=token_id, price=0, size=0, side=side),
                amount_usd,
            )
            logger.info(f"Market order placed: {side} ${amount_usd} for {token_id}")
            return result
        except Exception as e:
            logger.error(f"Failed to place market order: {e}")
            return None

    def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order."""
        try:
            client = self._get_trade_client()
            client.cancel(order_id)
            logger.info(f"Order cancelled: {order_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to cancel order {order_id}: {e}")
            return False

    def get_open_orders(self) -> list:
        """Get all open orders."""
        try:
            client = self._get_trade_client()
            return client.get_orders() or []
        except Exception as e:
            logger.error(f"Failed to get open orders: {e}")
            return []

    def is_trading_ready(self) -> bool:
        """Check if trading credentials are configured."""
        return bool(config.POLYMARKET_PRIVATE_KEY)


# Singleton
polymarket = PolymarketClient()
