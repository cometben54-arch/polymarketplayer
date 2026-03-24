"""Pydantic models for API request/response."""

from pydantic import BaseModel
from typing import Optional


class MarketAdd(BaseModel):
    condition_id: str
    question: str
    token_yes: Optional[str] = None
    token_no: Optional[str] = None


class ArbitrageGroupCreate(BaseModel):
    name: str
    description: Optional[str] = None
    market_ids: list[str]  # list of condition_ids
    strategy: str = "complement"  # complement, correlation, multi_outcome


class RiskSettings(BaseModel):
    max_position_size_usd: Optional[float] = None
    daily_loss_limit_usd: Optional[float] = None
    max_single_trade_usd: Optional[float] = None
    min_arbitrage_spread: Optional[float] = None


class TradeRequest(BaseModel):
    condition_id: str
    side: str  # BUY or SELL
    token_id: str
    price: float
    size: float


class BotCommand(BaseModel):
    action: str  # start, stop, pause, resume
