"""Application configuration loaded from environment variables."""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # Polymarket
    POLYMARKET_API_URL: str = os.getenv("POLYMARKET_API_URL", "https://clob.polymarket.com")
    POLYMARKET_PRIVATE_KEY: str = os.getenv("POLYMARKET_PRIVATE_KEY", "")
    POLYMARKET_FUNDER_ADDRESS: str = os.getenv("POLYMARKET_FUNDER_ADDRESS", "")
    POLYMARKET_SIGNATURE_TYPE: int = int(os.getenv("POLYMARKET_SIGNATURE_TYPE", "0"))

    # Risk Controls
    MAX_POSITION_SIZE_USD: float = float(os.getenv("MAX_POSITION_SIZE_USD", "100"))
    DAILY_LOSS_LIMIT_USD: float = float(os.getenv("DAILY_LOSS_LIMIT_USD", "50"))
    MAX_SINGLE_TRADE_USD: float = float(os.getenv("MAX_SINGLE_TRADE_USD", "20"))
    MIN_ARBITRAGE_SPREAD: float = float(os.getenv("MIN_ARBITRAGE_SPREAD", "0.02"))

    # Server
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8888"))

    # Database
    DB_PATH: str = os.getenv("DB_PATH", "polymarket_bot.db")

    # Polling interval in seconds
    POLL_INTERVAL: int = int(os.getenv("POLL_INTERVAL", "30"))


config = Config()
