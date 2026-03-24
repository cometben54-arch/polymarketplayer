"""Arbitrage detection engine.

Supported strategies:
1. complement  - Two outcomes (YES/NO) in same market: if YES_price + NO_price < 1, buy both.
2. multi_outcome - Multiple related markets whose probabilities should sum to 1.
3. correlation - Cross-market arbitrage based on logical relationships.
"""

import logging
from dataclasses import dataclass
from typing import Optional
from backend.polymarket_client import polymarket

logger = logging.getLogger(__name__)


@dataclass
class ArbitrageOpportunity:
    """Represents a detected arbitrage opportunity."""
    group_name: str
    strategy: str
    spread: float           # expected profit margin (e.g. 0.03 = 3%)
    legs: list[dict]        # each leg: {condition_id, token_id, side, price, size}
    expected_profit_usd: float
    confidence: float       # 0-1, how confident we are


def detect_complement_arb(
    condition_id: str,
    token_yes: str,
    token_no: str,
    min_spread: float = 0.02,
    trade_size: float = 10.0,
) -> Optional[ArbitrageOpportunity]:
    """Detect arbitrage in a single binary market.

    In a binary market, YES + NO should = $1.00.
    If YES_ask + NO_ask < 1.00, we can buy both and lock in profit.
    If YES_bid + NO_bid > 1.00, we can sell both and lock in profit.
    """
    if not token_yes or not token_no:
        return None

    price_yes_ask = polymarket.get_price(token_yes, "BUY")
    price_no_ask = polymarket.get_price(token_no, "BUY")

    if price_yes_ask is None or price_no_ask is None:
        return None

    total_ask = price_yes_ask + price_no_ask

    # Buy both sides: cost < $1, guaranteed $1 payout
    if total_ask < (1.0 - min_spread):
        spread = 1.0 - total_ask
        shares = trade_size / total_ask  # number of share pairs
        expected_profit = shares * spread

        return ArbitrageOpportunity(
            group_name=f"complement_{condition_id[:8]}",
            strategy="complement",
            spread=spread,
            legs=[
                {
                    "condition_id": condition_id,
                    "token_id": token_yes,
                    "side": "BUY",
                    "price": price_yes_ask,
                    "size": shares,
                },
                {
                    "condition_id": condition_id,
                    "token_id": token_no,
                    "side": "BUY",
                    "price": price_no_ask,
                    "size": shares,
                },
            ],
            expected_profit_usd=expected_profit,
            confidence=min(spread / 0.05, 1.0),
        )

    # Check sell side: if bids sum > $1
    price_yes_bid = polymarket.get_price(token_yes, "SELL")
    price_no_bid = polymarket.get_price(token_no, "SELL")

    if price_yes_bid is None or price_no_bid is None:
        return None

    total_bid = price_yes_bid + price_no_bid
    if total_bid > (1.0 + min_spread):
        spread = total_bid - 1.0
        shares = trade_size / total_bid
        expected_profit = shares * spread

        return ArbitrageOpportunity(
            group_name=f"complement_{condition_id[:8]}",
            strategy="complement",
            spread=spread,
            legs=[
                {
                    "condition_id": condition_id,
                    "token_id": token_yes,
                    "side": "SELL",
                    "price": price_yes_bid,
                    "size": shares,
                },
                {
                    "condition_id": condition_id,
                    "token_id": token_no,
                    "side": "SELL",
                    "price": price_no_bid,
                    "size": shares,
                },
            ],
            expected_profit_usd=expected_profit,
            confidence=min(spread / 0.05, 1.0),
        )

    return None


def detect_multi_outcome_arb(
    markets: list[dict],
    min_spread: float = 0.02,
    trade_size: float = 10.0,
) -> Optional[ArbitrageOpportunity]:
    """Detect arbitrage across multiple related markets.

    For mutually exclusive outcomes that must sum to 1:
    - If sum of all YES prices < 1: buy all YES outcomes
    - If sum of all YES prices > 1: sell all YES outcomes
    """
    if len(markets) < 2:
        return None

    prices = []
    for m in markets:
        token_yes = m.get("token_yes")
        if not token_yes:
            return None
        price = polymarket.get_price(token_yes, "BUY")
        if price is None:
            return None
        prices.append({"market": m, "price": price})

    total = sum(p["price"] for p in prices)

    # All YES asks sum < 1: buy all, guaranteed one pays $1
    if total < (1.0 - min_spread):
        spread = 1.0 - total
        per_market = trade_size / len(markets)
        expected_profit = (trade_size / total) * spread

        legs = []
        for p in prices:
            legs.append({
                "condition_id": p["market"]["condition_id"],
                "token_id": p["market"]["token_yes"],
                "side": "BUY",
                "price": p["price"],
                "size": per_market / p["price"],
            })

        return ArbitrageOpportunity(
            group_name="multi_outcome",
            strategy="multi_outcome",
            spread=spread,
            legs=legs,
            expected_profit_usd=expected_profit,
            confidence=min(spread / 0.05, 1.0),
        )

    return None


def scan_all_opportunities(
    watched_markets: list[dict],
    arb_groups: list[dict],
    min_spread: float = 0.02,
    trade_size: float = 10.0,
) -> list[ArbitrageOpportunity]:
    """Scan all watched markets and arbitrage groups for opportunities."""
    opportunities = []

    # 1. Check complement arbitrage on each individual market
    for market in watched_markets:
        opp = detect_complement_arb(
            condition_id=market["condition_id"],
            token_yes=market.get("token_yes", ""),
            token_no=market.get("token_no", ""),
            min_spread=min_spread,
            trade_size=trade_size,
        )
        if opp:
            logger.info(f"Complement arb found: {opp.spread:.4f} spread on {market['question']}")
            opportunities.append(opp)

    # 2. Check multi-outcome arbitrage in groups
    for group in arb_groups:
        if group.get("strategy") == "multi_outcome":
            group_markets = [m for m in watched_markets if m["condition_id"] in group.get("market_ids", [])]
            opp = detect_multi_outcome_arb(
                markets=group_markets,
                min_spread=min_spread,
                trade_size=trade_size,
            )
            if opp:
                opp.group_name = group.get("name", "multi")
                logger.info(f"Multi-outcome arb found: {opp.spread:.4f} spread in {group['name']}")
                opportunities.append(opp)

    return opportunities
