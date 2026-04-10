/**
 * Arbitrage detection engine.
 */

import { PolymarketClient } from './polymarket';

export interface ArbOpportunity {
  groupName: string;
  strategy: string;
  spread: number;
  expectedProfit: number;
  confidence: number;
  legs: ArbLeg[];
}

interface ArbLeg {
  conditionId: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
}

export async function detectComplementArb(
  client: PolymarketClient,
  conditionId: string,
  tokenYes: string,
  tokenNo: string,
  minSpread: number,
  tradeSize: number,
): Promise<ArbOpportunity | null> {
  if (!tokenYes || !tokenNo) return null;

  const [priceYes, priceNo] = await Promise.all([
    client.getPrice(tokenYes, 'BUY'),
    client.getPrice(tokenNo, 'BUY'),
  ]);

  if (priceYes === null || priceNo === null) return null;

  const totalAsk = priceYes + priceNo;

  // Buy both sides: cost < $1, guaranteed $1 payout
  if (totalAsk < 1.0 - minSpread) {
    const spread = 1.0 - totalAsk;
    const shares = tradeSize / totalAsk;
    return {
      groupName: `complement_${conditionId.slice(0, 8)}`,
      strategy: 'complement',
      spread,
      expectedProfit: shares * spread,
      confidence: Math.min(spread / 0.05, 1.0),
      legs: [
        { conditionId, tokenId: tokenYes, side: 'BUY', price: priceYes, size: shares },
        { conditionId, tokenId: tokenNo, side: 'BUY', price: priceNo, size: shares },
      ],
    };
  }

  // Sell both sides: bids > $1
  const [bidYes, bidNo] = await Promise.all([
    client.getPrice(tokenYes, 'SELL'),
    client.getPrice(tokenNo, 'SELL'),
  ]);

  if (bidYes === null || bidNo === null) return null;
  const totalBid = bidYes + bidNo;

  if (totalBid > 1.0 + minSpread) {
    const spread = totalBid - 1.0;
    const shares = tradeSize / totalBid;
    return {
      groupName: `complement_${conditionId.slice(0, 8)}`,
      strategy: 'complement',
      spread,
      expectedProfit: shares * spread,
      confidence: Math.min(spread / 0.05, 1.0),
      legs: [
        { conditionId, tokenId: tokenYes, side: 'SELL', price: bidYes, size: shares },
        { conditionId, tokenId: tokenNo, side: 'SELL', price: bidNo, size: shares },
      ],
    };
  }

  return null;
}

export async function scanAllOpportunities(
  client: PolymarketClient,
  markets: any[],
  groups: any[],
  minSpread: number,
  tradeSize: number,
): Promise<ArbOpportunity[]> {
  const opportunities: ArbOpportunity[] = [];

  // Check complement arbitrage on each market
  for (const m of markets) {
    try {
      const opp = await detectComplementArb(client, m.condition_id, m.token_yes || '', m.token_no || '', minSpread, tradeSize);
      if (opp) opportunities.push(opp);
    } catch { /* skip failed markets */ }
  }

  // Multi-outcome arbitrage across groups
  for (const group of groups) {
    if (group.strategy !== 'multi_outcome') continue;
    const marketIds: string[] = typeof group.market_ids === 'string' ? JSON.parse(group.market_ids) : group.market_ids;
    const groupMarkets = markets.filter(m => marketIds.includes(m.condition_id));
    if (groupMarkets.length < 2) continue;

    try {
      const prices = await Promise.all(groupMarkets.map(m => m.token_yes ? client.getPrice(m.token_yes, 'BUY') : null));
      const valid = prices.filter((p): p is number => p !== null);
      if (valid.length !== groupMarkets.length) continue;

      const total = valid.reduce((s, p) => s + p, 0);
      if (total < 1.0 - minSpread) {
        const spread = 1.0 - total;
        const perMarket = tradeSize / groupMarkets.length;
        opportunities.push({
          groupName: group.name,
          strategy: 'multi_outcome',
          spread,
          expectedProfit: (tradeSize / total) * spread,
          confidence: Math.min(spread / 0.05, 1.0),
          legs: groupMarkets.map((m, i) => ({
            conditionId: m.condition_id,
            tokenId: m.token_yes,
            side: 'BUY',
            price: valid[i],
            size: perMarket / valid[i],
          })),
        });
      }
    } catch { /* skip */ }
  }

  return opportunities;
}
