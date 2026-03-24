"""Entry point to start the Polymarket Arbitrage Bot."""

import uvicorn
from backend.config import config

if __name__ == "__main__":
    uvicorn.run(
        "backend.server:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
