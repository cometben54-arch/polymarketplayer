/**
 * Polymarket Arbitrage Bot v2.3 - Cloudflare Pages Functions API
 * Features: 4 strategies, paper/real mode, AI review, REAL trading via clob-client
 */
import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { cors } from 'hono/cors';
import { privateKeyToAddress } from 'viem/accounts';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

interface Env {
  DB: D1Database;
  POLYMARKET_API_URL?: string; GAMMA_API_URL?: string; DATA_API_URL?: string;
  POLYMARKET_API_KEY?: string; POLYMARKET_API_SECRET?: string; POLYMARKET_API_PASSPHRASE?: string;
  POLYMARKET_PRIVATE_KEY?: string; POLYMARKET_FUNDER_ADDRESS?: string; ADMIN_PASSWORD?: string;
}

const CLOB = (e: Env) => (e.POLYMARKET_API_URL || 'https://clob.polymarket.com').replace(/\/$/, '');
const GAMMA = (e: Env) => (e.GAMMA_API_URL || 'https://gamma-api.polymarket.com').replace(/\/$/, '');

// --- Crypto helpers ---
async function hmacSign(secret: string, msg: string): Promise<string> {
  const std = secret.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - std.length % 4) % 4);
  const kd = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', kd, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_');
}
function getSignerAddress(env: Env): string {
  if (!env.POLYMARKET_PRIVATE_KEY) return env.POLYMARKET_FUNDER_ADDRESS || '';
  try { return privateKeyToAddress(env.POLYMARKET_PRIVATE_KEY as `0x${string}`); } catch { return env.POLYMARKET_FUNDER_ADDRESS || ''; }
}
async function authHeaders(env: Env, method: string, path: string, body = ''): Promise<Record<string, string>> {
  if (!env.POLYMARKET_API_KEY || !env.POLYMARKET_API_SECRET) return {};
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacSign(env.POLYMARKET_API_SECRET, ts + method.toUpperCase() + path + body);
  return { 'POLY_ADDRESS': getSignerAddress(env), 'POLY_API_KEY': env.POLYMARKET_API_KEY, 'POLY_SIGNATURE': sig, 'POLY_TIMESTAMP': ts, 'POLY_PASSPHRASE': env.POLYMARKET_API_PASSPHRASE || '' };
}

// --- API helpers ---
async function clobGet(env: Env, path: string): Promise<any> { const r = await fetch(`${CLOB(env)}${path}`); return r.ok ? r.json() : null; }
async function clobAuthGet(env: Env, path: string): Promise<any> { const h = await authHeaders(env, 'GET', path); const r = await fetch(`${CLOB(env)}${path}`, { headers: h }); return r.ok ? r.json() : null; }
async function clobAuthPost(env: Env, path: string, body: any): Promise<any> {
  const b = JSON.stringify(body); const h = await authHeaders(env, 'POST', path, b);
  const r = await fetch(`${CLOB(env)}${path}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: b });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}
async function getPrice(env: Env, tid: string, side = 'BUY'): Promise<number | null> { const d: any = await clobGet(env, `/price?token_id=${tid}&side=${side}`); return d?.price ? parseFloat(d.price) : null; }
async function getMidpoint(env: Env, tid: string): Promise<number | null> { const d: any = await clobGet(env, `/midpoint?token_id=${tid}`); return d?.mid ? parseFloat(d.mid) : null; }
async function getOrderbook(env: Env, tid: string): Promise<any> { return clobGet(env, `/book?token_id=${tid}`); }

// --- DB helpers ---
async function getState(db: D1Database, k: string): Promise<string> { const r = await db.prepare('SELECT value FROM bot_state WHERE key=?').bind(k).first<{value:string}>(); return r?.value || ''; }
async function setState(db: D1Database, k: string, v: string) { await db.prepare('INSERT OR REPLACE INTO bot_state(key,value,updated_at) VALUES(?,?,datetime("now"))').bind(k, v).run(); }
async function getSetting(db: D1Database, k: string, fb = ''): Promise<string> { const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first<{value:string}>(); return r?.value || fb; }
async function addAlert(db: D1Database, level: string, msg: string) { await db.prepare('INSERT INTO alerts(level,message) VALUES(?,?)').bind(level, msg).run(); }

// Polymarket taker fee: 2% (0.02) per side
const TAKER_FEE = 0.02;

// =============================================
// STRATEGY 1: Complement Arbitrage (Dutch Book)
// YES + NO should = $1. If not, guaranteed profit after fees.
// =============================================
async function strategyComplement(env: Env, m: any, minSpread: number, tradeSize: number): Promise<any|null> {
  if (!m.token_yes || !m.token_no) return null;
  const [pY, pN] = await Promise.all([getPrice(env, m.token_yes, 'BUY'), getPrice(env, m.token_no, 'BUY')]);
  if (pY === null || pN === null) return null;
  if (pY < 0.03 || pN < 0.03) return null; // Skip extreme prices
  const totalCost = pY + pN;
  const fees = totalCost * TAKER_FEE * 2;
  const netProfit = 1 - totalCost - fees;
  if (netProfit > minSpread) {
    const sh = Math.min(tradeSize / totalCost, 100); // Cap 100 shares
    const profit = sh * netProfit;
    if (profit > tradeSize) return null; // Sanity: profit can't exceed trade size
    return { strategy: 'complement', action: 'BUY_BOTH', spread: netProfit, profit, confidence: Math.min(netProfit / 0.05, 1),
      legs: [{ token: m.token_yes, side: 'BUY', price: pY, size: sh }, { token: m.token_no, side: 'BUY', price: pN, size: sh }] };
  }
  const [bY, bN] = await Promise.all([getPrice(env, m.token_yes, 'SELL'), getPrice(env, m.token_no, 'SELL')]);
  if (bY !== null && bN !== null) {
    if (bY < 0.03 || bN < 0.03) return null;
    const totalBid = bY + bN;
    const feesS = totalBid * TAKER_FEE * 2;
    const netProfitS = totalBid - 1 - feesS;
    if (netProfitS > minSpread) {
      const sh = Math.min(tradeSize / totalBid, 100);
      const profitS = sh * netProfitS;
      if (profitS > tradeSize) return null;
      return { strategy: 'complement', action: 'SELL_BOTH', spread: netProfitS, profit: profitS, confidence: Math.min(netProfitS / 0.05, 1),
        legs: [{ token: m.token_yes, side: 'SELL', price: bY, size: sh }, { token: m.token_no, side: 'SELL', price: bN, size: sh }] };
    }
  }
  return null;
}

// =============================================
// STRATEGY 2: Probability Deviation (advisory only, NOT auto-trade)
// User conviction is a personal bias indicator, not a trading signal.
// This strategy only REPORTS the deviation for the AI advisory.
// It does NOT generate auto-trade opportunities.
// =============================================
async function strategyProbability(env: Env, m: any, tradeSize: number): Promise<any|null> {
  if (!m.token_yes || m.user_conviction === 0.5) return null;
  const marketPrice = await getMidpoint(env, m.token_yes);
  if (marketPrice === null) return null;
  const deviation = m.user_conviction - marketPrice;
  if (Math.abs(deviation) < 0.15) return null;

  // Report only - no auto-trade legs. This info feeds into AI advisory.
  return { strategy: 'probability', action: 'ADVISORY_ONLY',
    spread: Math.abs(deviation), profit: 0, confidence: Math.min(Math.abs(deviation) / 0.2, 1),
    userConviction: m.user_conviction, marketPrice, deviation,
    advisory: `用户判断${(m.user_conviction*100).toFixed(0)}% vs 市场${(marketPrice*100).toFixed(0)}%, 偏差${(Math.abs(deviation)*100).toFixed(0)}%`,
    legs: [] }; // Empty legs = won't auto-trade
}
    legs: [{ token, side, price, size }] };
}

// =============================================
// STRATEGY 3: Market Making (bid-ask spread)
// Place limit orders on both sides to capture spread.
// =============================================
async function strategyMarketMaking(env: Env, m: any, tradeSize: number): Promise<any|null> {
  if (!m.token_yes) return null;
  const book = await getOrderbook(env, m.token_yes);
  if (!book || !book.bids?.length || !book.asks?.length) return null;
  const bestBid = parseFloat(book.bids[0].price);
  const bestAsk = parseFloat(book.asks[0].price);
  const spread = bestAsk - bestBid;
  if (spread < 0.05) return null;
  // Skip extreme prices where size calculation blows up
  if (bestBid < 0.05 || bestAsk > 0.95) return null;

  const buyPrice = Math.round((bestBid + 0.01) * 100) / 100;
  const sellPrice = Math.round((bestAsk - 0.01) * 100) / 100;
  const netSpread = sellPrice - buyPrice;
  if (netSpread <= 0.02) return null;

  // Size: cap so neither leg exceeds tradeSize
  const maxSize = Math.min(tradeSize / buyPrice, tradeSize / sellPrice);
  const size = Math.min(maxSize, 200); // Hard cap 200 shares
  const revenue = size * sellPrice;
  const cost = size * buyPrice;
  // Both legs must be within tradeSize
  if (cost > tradeSize * 1.1 || revenue > tradeSize * 3) return null;
  const feeBuy = cost * TAKER_FEE;
  const feeSell = revenue * TAKER_FEE;
  const profit = revenue - cost - feeBuy - feeSell;

  if (profit < 0.10) return null;

  return { strategy: 'market_making', action: 'MAKE_MARKET', spread: netSpread, profit,
    confidence: Math.min(netSpread / 0.06, 1), midPrice: (bestBid + bestAsk) / 2,
    legs: [{ token: m.token_yes, side: 'BUY', price: buyPrice, size }, { token: m.token_yes, side: 'SELL', price: sellPrice, size }] };
}

// =============================================
// STRATEGY 4: Momentum (ADVISORY ONLY)
// Detects rapid price changes. Reports for AI analysis,
// does NOT auto-trade (single-leg speculation, not arbitrage).
// =============================================
async function strategyMomentum(env: Env, m: any, db: D1Database, tradeSize: number): Promise<any|null> {
  if (!m.token_yes) return null;
  const snaps = (await db.prepare('SELECT price_yes,recorded_at FROM price_snapshots WHERE condition_id=? ORDER BY recorded_at DESC LIMIT 10').bind(m.condition_id).all()).results as any[];
  if (snaps.length < 3) return null;
  const current = snaps[0]?.price_yes;
  const prev5 = snaps[Math.min(4, snaps.length - 1)]?.price_yes;
  if (!current || !prev5) return null;

  const change = current - prev5;
  const pctChange = Math.abs(change) / prev5;
  if (pctChange < 0.05) return null;

  return { strategy: 'momentum', action: 'ADVISORY_ONLY',
    spread: pctChange, profit: 0, confidence: Math.min(pctChange / 0.1, 1),
    priceChange: change, pctChange,
    advisory: `价格${change > 0 ? '上涨' : '下跌'}${(pctChange*100).toFixed(1)}% (${prev5.toFixed(3)}→${current.toFixed(3)})`,
    legs: [] };
}

// =============================================
// STRATEGY 5: Logical / Dutch Book Arbitrage
// Detect pricing contradictions between related markets.
// E.g. "Team A wins conference" at 24% but "Team A wins championship" at 28%
// is a contradiction since winning championship implies winning conference.
// Uses AI to find logical relationships, then checks price consistency.
// =============================================
async function strategyLogical(env: Env, allMarkets: any[], db: D1Database, tradeSize: number): Promise<any[]> {
  if (allMarkets.length < 2) return [];

  // Step 1: Get current prices for all markets
  const priced: any[] = [];
  for (const m of allMarkets) {
    if (!m.token_yes) continue;
    const p = await getMidpoint(env, m.token_yes);
    if (p !== null) priced.push({ ...m, price_yes: p, price_no: 1 - p });
  }
  if (priced.length < 2) return [];

  // Step 2: Check all pairs for logical contradictions
  const opps: any[] = [];

  for (let i = 0; i < priced.length; i++) {
    for (let j = i + 1; j < priced.length; j++) {
      const a = priced[i], b = priced[j];

      // Check "subset" pattern: if A implies B, then P(A) ≤ P(B)
      // Example: "X wins final" implies "X wins semifinal"
      // If P(final) > P(semifinal), contradiction → buy semifinal, sell final

      // Check if questions are related (simple keyword overlap)
      const wordsA = a.question.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3);
      const wordsB = b.question.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3);
      const overlap = wordsA.filter((w: string) => wordsB.includes(w));
      if (overlap.length < 2) continue; // Not enough keyword overlap to be related

      // Check for temporal/scope contradiction
      // If market A is a subset of B (e.g. "by June" vs "by December"), P(A) ≤ P(B)
      const diff = Math.abs(a.price_yes - b.price_yes);
      if (diff < 0.05) continue; // Prices too similar, no contradiction

      // Determine which should be higher based on question scope
      // The more specific/restrictive event should have lower probability
      const aHasNarrower = /by (jan|feb|mar|apr|may|jun)/i.test(a.question) && /by (jul|aug|sep|oct|nov|dec)/i.test(b.question);
      const bHasNarrower = /by (jan|feb|mar|apr|may|jun)/i.test(b.question) && /by (jul|aug|sep|oct|nov|dec)/i.test(a.question);

      let contradiction = false;
      let buyMarket: any = null, sellMarket: any = null;

      if (aHasNarrower && a.price_yes > b.price_yes + 0.03) {
        // A is narrower but priced higher → buy B (broader), it's underpriced
        contradiction = true; buyMarket = b; sellMarket = a;
      } else if (bHasNarrower && b.price_yes > a.price_yes + 0.03) {
        contradiction = true; buyMarket = a; sellMarket = b;
      }

      // General check: if same topic but one is much cheaper and logically should be similar
      if (!contradiction && overlap.length >= 3 && diff > 0.10) {
        // Markets with strong keyword overlap but >10% price difference
        const cheaper = a.price_yes < b.price_yes ? a : b;
        const pricier = a.price_yes < b.price_yes ? b : a;
        buyMarket = cheaper; sellMarket = pricier;
        contradiction = true;
      }

      if (contradiction && buyMarket && sellMarket) {
        const spread = Math.abs(buyMarket.price_yes - sellMarket.price_yes);
        const fee = tradeSize * TAKER_FEE * 2;
        const size = (tradeSize * 0.3) / buyMarket.price_yes; // Conservative 30% sizing
        const netProfit = size * spread - fee;
        if (netProfit < 0.10) continue;

        opps.push({
          strategy: 'logical', action: 'ADVISORY_ONLY',
          spread, profit: 0,
          confidence: Math.min(spread / 0.15, 1),
          market: buyMarket.question.slice(0, 40) + ' vs ' + sellMarket.question.slice(0, 40),
          condition_id: buyMarket.condition_id,
          advisory: `逻辑矛盾: "${buyMarket.question.slice(0, 25)}" @${(buyMarket.price_yes*100).toFixed(0)}% vs "${sellMarket.question.slice(0, 25)}" @${(sellMarket.price_yes*100).toFixed(0)}%`,
          legs: [],
        });
      }
    }
  }

  return opps;
}

// AI-enhanced logical arbitrage: uses AI to find deeper logical relationships
async function strategyLogicalAI(env: Env, allMarkets: any[], db: D1Database, tradeSize: number): Promise<any[]> {
  // Only run AI check once per hour (expensive)
  const lastAILogical = await getState(db, 'last_ai_logical');
  const now = Math.floor(Date.now() / 1000);
  if (lastAILogical && now - parseInt(lastAILogical) < 3600) return [];

  const aiKey = await getSetting(db, 'AI_API_KEY');
  if (!aiKey) return [];

  const priced: any[] = [];
  for (const m of allMarkets) {
    if (!m.token_yes) continue;
    const p = await getMidpoint(env, m.token_yes);
    if (p !== null) priced.push({ question: m.question, price: p, condition_id: m.condition_id, token_yes: m.token_yes });
  }
  if (priced.length < 2) return [];

  const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
  const aiModel = await getSetting(db, 'AI_MODEL', 'gpt-4o');
  const aiBaseUrl = await getSetting(db, 'AI_BASE_URL', 'https://api.openai.com/v1');

  const prompt = `你是预测市场套利分析师。分析以下市场是否存在逻辑定价矛盾。

市场列表:
${priced.map((m, i) => `${i + 1}. "${m.question}" → YES价格: ${(m.price * 100).toFixed(1)}%`).join('\n')}

规则:
- 如果事件A逻辑上蕴含事件B (A发生则B必发生)，那么 P(A) ≤ P(B)
- 如果事件互斥且穷尽，概率之和应为100%
- 如果事件有时间范围包含关系（如"6月前" vs "12月前"），较短期限的概率应≤较长期限

请仅回复JSON数组,格式: [{"buy_idx":0,"sell_idx":1,"reason":"简短理由","confidence":0.8}]
如果没有矛盾,回复空数组 []
只标记你有高置信度(>0.7)的矛盾。`;

  try {
    let content = '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (aiProvider === 'anthropic') {
      headers['x-api-key'] = aiKey; headers['anthropic-version'] = '2023-06-01';
      const res = await fetch((aiBaseUrl || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: aiModel, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }) });
      const data: any = await res.json(); content = data.content?.[0]?.text || '';
    } else {
      headers['Authorization'] = `Bearer ${aiKey}`;
      const res = await fetch(aiBaseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: aiModel, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }) });
      const data: any = await res.json(); content = data.choices?.[0]?.message?.content || '';
    }

    await setState(db, 'last_ai_logical', now.toString());

    // Parse AI response
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const pairs: any[] = JSON.parse(match[0]);
    const opps: any[] = [];

    for (const pair of pairs) {
      if (!pair.buy_idx && pair.buy_idx !== 0) continue;
      const buy = priced[pair.buy_idx];
      const sell = priced[pair.sell_idx];
      if (!buy || !sell) continue;

      const spread = Math.abs(buy.price - sell.price);
      const size = (tradeSize * 0.3) / buy.price;
      const fee = size * buy.price * TAKER_FEE;
      const netProfit = size * spread - fee;
      if (netProfit < 0.10) continue;

      opps.push({
        strategy: 'logical', action: 'ADVISORY_ONLY', spread, profit: 0,
        confidence: pair.confidence || 0.8,
        market: buy.question.slice(0, 30) + ' vs ' + sell.question.slice(0, 30),
        condition_id: buy.condition_id,
        advisory: `AI发现矛盾: ${pair.reason} | "${buy.question.slice(0,20)}" @${(buy.price*100).toFixed(0)}% vs "${sell.question.slice(0,20)}" @${(sell.price*100).toFixed(0)}%`,
        legs: [],
      });

      await addAlert(db, 'info', `[逻辑套利] AI发现矛盾: "${buy.question.slice(0, 25)}" vs "${sell.question.slice(0, 25)}" | ${pair.reason}`);
    }
    return opps;
  } catch { return []; }
}

// =============================================
// SCAN ENGINE: Run all enabled strategies
// =============================================
async function runScan(env: Env) {
  const db = env.DB;
  if ((await getState(db, 'running')) !== 'true' || (await getState(db, 'paused')) === 'true') return { skipped: true };
  const mkts = (await db.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  if (!mkts.length) return { skipped: true, reason: 'no markets' };

  const minSpread = parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02'));
  const tradeSize = parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20'));
  const enabledStr = await getSetting(db, 'ENABLED_STRATEGIES', 'complement,probability,market_making,momentum,logical');
  const enabled = enabledStr.split(',').map(s => s.trim());
  const mode = await getSetting(db, 'TRADING_MODE', 'paper');
  const cooldown = parseInt(await getSetting(db, 'TRADE_COOLDOWN_SEC', '60'));

  // Price snapshots
  for (const m of mkts) {
    try {
      const [pY, pN] = await Promise.all([m.token_yes ? getMidpoint(env, m.token_yes) : null, m.token_no ? getMidpoint(env, m.token_no) : null]);
      const sp = pY != null && pN != null ? Math.abs(1 - pY - pN) : null;
      await db.prepare('INSERT INTO price_snapshots(condition_id,price_yes,price_no,spread) VALUES(?,?,?,?)').bind(m.condition_id, pY, pN, sp).run();
    } catch {}
  }

  // Run strategies
  const opps: any[] = [];
  for (const m of mkts) {
    try {
      if (enabled.includes('complement')) { const o = await strategyComplement(env, m, minSpread, tradeSize); if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id }); }
      if (enabled.includes('probability')) { const o = await strategyProbability(env, m, tradeSize); if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id }); }
      if (enabled.includes('market_making')) { const o = await strategyMarketMaking(env, m, tradeSize); if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id }); }
      if (enabled.includes('momentum')) { const o = await strategyMomentum(env, m, db, tradeSize); if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id }); }
    } catch {}
  }

  // Logical arbitrage runs across ALL markets (not per-market)
  if (enabled.includes('logical')) {
    try {
      const logicalOpps = await strategyLogical(env, mkts, db, tradeSize);
      opps.push(...logicalOpps);
      // Also try AI-enhanced logical (once per hour)
      const aiLogicalOpps = await strategyLogicalAI(env, mkts, db, tradeSize);
      opps.push(...aiLogicalOpps);
    } catch {}
  }

  // Risk controls
  const maxPosition = parseFloat(await getSetting(db, 'MAX_POSITION_SIZE_USD', '50'));
  const dailyLossLimit = parseFloat(await getSetting(db, 'DAILY_LOSS_LIMIT_USD', '20'));
  const dailyPnl = parseFloat(await getState(db, 'daily_pnl') || '0');

  // Calculate current open position (total paper/real trades not yet settled)
  const openPositionRes = await db.prepare("SELECT COALESCE(SUM(amount_usd),0) as total FROM trades WHERE side='BUY' AND status IN ('filled','submitted')").first<{total:number}>();
  const currentPosition = openPositionRes?.total || 0;

  // Filter: only real arbitrage (has legs with both buy+sell, or single leg within budget)
  const tradableOpps = opps.filter(o => {
    if (!o.legs || o.legs.length === 0) return false; // Advisory-only (probability)
    if (o.profit < 0.10 || o.profit > tradeSize * 2) return false;
    const totalLegCost = o.legs.reduce((s: number, l: any) => s + l.price * l.size, 0);
    if (totalLegCost > tradeSize * 2) return false;
    if (currentPosition + totalLegCost > maxPosition) return false; // Would exceed max position
    return true;
  });

  // Auto-trade best opportunity (rate limited + risk checks)
  let traded = null;
  if (tradableOpps.length > 0) {
    if (dailyPnl <= -dailyLossLimit) {
      await addAlert(db, 'critical', `日亏损已达限额 $${dailyLossLimit}，自动暂停交易`);
      await setState(db, 'paused', 'true');
    } else {
      const lastTrade = parseInt(await getState(db, 'last_trade_time') || '0');
      const now = Math.floor(Date.now() / 1000);
      if (now - lastTrade >= cooldown) {
        const best = tradableOpps.sort((a, b) => b.profit - a.profit)[0];
        traded = await executeTrade(env, db, best, mode);
      }
    }
  }

  // Log summary (include advisory-only opps for info)
  const stratNames: Record<string,string> = { complement: '互补套利', probability: '概率偏差', market_making: '做市', momentum: '动量', logical: '逻辑套利' };
  if (tradableOpps.length > 0 || opps.length > 0) {
    const tradeableSummary = tradableOpps.map(o => `[${stratNames[o.strategy] || o.strategy}] ${o.market?.slice(0,20)} $${o.profit.toFixed(2)}`).join('; ');
    const advisorySummary = opps.filter(o => !o.legs?.length).map(o => `[${stratNames[o.strategy] || o.strategy}] ${o.market?.slice(0,20)} ${o.advisory || ''}`).join('; ');
    await addAlert(db, 'info',
      `扫描${mkts.length}市场 | 持仓$${currentPosition.toFixed(0)}/$${maxPosition}`
      + (tradableOpps.length ? ` | 可交易${tradableOpps.length}个: ${tradeableSummary}` : ' | 无可交易机会')
      + (traded ? ` | 已${mode === 'paper' ? '模拟' : '真实'}交易[${stratNames[traded.strategy] || traded.strategy}]` : '')
      + (advisorySummary ? ` | 参考: ${advisorySummary}` : ''));
  }

  return { scanned: mkts.length, mode, strategies: enabled, opportunities: opps.map(o => ({ strategy: o.strategy, market: o.market, action: o.action, spread: Math.round(o.spread * 10000) / 10000, profit: Math.round(o.profit * 100) / 100, confidence: Math.round(o.confidence * 100) / 100, legs: o.legs?.length || 0 })), traded };
}

// =============================================
// TRADE EXECUTION (paper or real)
// =============================================
// --- ClobClient factory for real trading ---
function createClobClient(env: Env, creds: { key: string; secret: string; passphrase: string }): ClobClient {
  const signer = new Wallet(env.POLYMARKET_PRIVATE_KEY!);
  return new ClobClient(
    (env.POLYMARKET_API_URL || 'https://clob.polymarket.com').replace(/\/$/, ''),
    137, // Polygon chain ID
    signer,
    creds,
    env.POLYMARKET_FUNDER_ADDRESS ? 1 : 0, // signatureType: 1 if funder differs from signer
    env.POLYMARKET_FUNDER_ADDRESS || undefined,
  );
}

async function executeTrade(env: Env, db: D1Database, opp: any, mode: string) {
  await setState(db, 'last_trade_time', Math.floor(Date.now() / 1000).toString());
  const results: any[] = [];

  for (const leg of opp.legs || []) {
    let orderId = 'paper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let status = 'filled';

    if (mode === 'real') {
      // --- REAL TRADE via @polymarket/clob-client ---
      try {
        if (!env.POLYMARKET_PRIVATE_KEY || !env.POLYMARKET_API_KEY || !env.POLYMARKET_API_SECRET) {
          status = 'error_no_creds';
          orderId = 'err_' + Date.now();
        } else {
          const client = createClobClient(env, {
            key: env.POLYMARKET_API_KEY,
            secret: env.POLYMARKET_API_SECRET,
            passphrase: env.POLYMARKET_API_PASSPHRASE || '',
          });

          const side = leg.side === 'BUY' ? Side.BUY : Side.SELL;

          // Get tick size for this token
          let tickSize = '0.01';
          try {
            const ts = await client.getTickSize(leg.token);
            if (ts) tickSize = ts;
          } catch {}

          // Get neg risk
          let negRisk = false;
          try {
            negRisk = await client.getNegRisk(leg.token);
          } catch {}

          // Place limit order (GTC = Good Till Cancelled)
          const result = await client.createAndPostOrder(
            {
              tokenID: leg.token,
              price: leg.price,
              side: side,
              size: leg.size,
            },
            { tickSize, negRisk },
            OrderType.GTC,
          );

          if (result && (result.orderID || result.success !== false)) {
            orderId = result.orderID || result.id || ('real_' + Date.now());
            status = 'submitted';
            await db.prepare("INSERT INTO alerts(level,message) VALUES('info',?)").bind(
              `真实订单已提交: ${leg.side} ${leg.size.toFixed(2)} @ $${leg.price.toFixed(3)} (${opp.strategy})`
            ).run();
          } else {
            status = 'rejected';
            orderId = 'rej_' + Date.now();
            const errMsg = JSON.stringify(result).slice(0, 200);
            await db.prepare("INSERT INTO alerts(level,message) VALUES('warning',?)").bind('订单被拒绝: ' + errMsg).run();
          }
        }
      } catch (e: any) {
        status = 'error';
        orderId = 'err_' + Date.now();
        await db.prepare("INSERT INTO alerts(level,message) VALUES('critical',?)").bind('下单失败: ' + e.message.slice(0, 200)).run();
      }
    }

    await db.prepare('INSERT INTO trades(condition_id,side,token_id,price,size,amount_usd,order_id,status,strategy,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(
      opp.condition_id, leg.side, leg.token, leg.price, leg.size, leg.price * leg.size, orderId, status, opp.strategy, mode
    ).run();

    results.push({ side: leg.side, price: leg.price, status, orderId });
  }

  // Update P&L
  const pnlDelta = mode === 'paper' ? opp.profit : 0;
  const dailyPnl = parseFloat(await getState(db, 'daily_pnl') || '0') + pnlDelta;
  const totalPnl = parseFloat(await getState(db, 'total_pnl') || '0') + pnlDelta;
  await setState(db, 'daily_pnl', dailyPnl.toString());
  await setState(db, 'total_pnl', totalPnl.toString());

  return { strategy: opp.strategy, market: opp.market, mode, profit: opp.profit, orders: results };
}

// =============================================
// AI REVIEW: Call AI API for analysis
// =============================================
async function aiReview(env: Env, db: D1Database, reviewType: string): Promise<string> {
  const aiKey = await getSetting(db, 'AI_API_KEY');
  const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
  const aiModel = await getSetting(db, 'AI_MODEL', 'gpt-4o');
  const aiBaseUrl = await getSetting(db, 'AI_BASE_URL', 'https://api.openai.com/v1');
  if (!aiKey) return 'AI API Key 未配置';

  // Gather data
  const trades = (await db.prepare("SELECT * FROM trades WHERE created_at > datetime('now','-1 day') ORDER BY created_at DESC LIMIT 50").all()).results;
  const alerts = (await db.prepare("SELECT * FROM alerts WHERE created_at > datetime('now','-1 day') ORDER BY created_at DESC LIMIT 20").all()).results;
  const pnl = { daily: await getState(db, 'daily_pnl'), total: await getState(db, 'total_pnl') };

  const prompt = reviewType === 'daily'
    ? `你是一个预测市场套利交易分析师。请分析过去24小时的交易表现并给出简报。\n\n交易记录:\n${JSON.stringify(trades, null, 2)}\n\n警报:\n${JSON.stringify(alerts, null, 2)}\n\n盈亏: 日=${pnl.daily}, 总=${pnl.total}\n\n请用中文给出：1)整体表现评价 2)盈亏分析 3)策略效果对比 4)风险提示 5)明日建议。简洁明了。`
    : `你是预测市场套利分析师。分析过去1小时的操作是否合理。\n\n最近交易:\n${JSON.stringify(trades.slice(0, 10), null, 2)}\n\n盈亏: ${pnl.daily}\n\n简要评价操作合理性，有无异常，50字内。`;

  try {
    let apiUrl = aiBaseUrl + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (aiProvider === 'anthropic') {
      apiUrl = (aiBaseUrl || 'https://api.anthropic.com') + '/v1/messages';
      headers['x-api-key'] = aiKey;
      headers['anthropic-version'] = '2023-06-01';
      const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ model: aiModel, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }) });
      const data: any = await res.json();
      const content = data.content?.[0]?.text || JSON.stringify(data);
      await db.prepare('INSERT INTO ai_reviews(review_type,content) VALUES(?,?)').bind(reviewType, content).run();
      return content;
    }

    // OpenAI compatible
    headers['Authorization'] = `Bearer ${aiKey}`;
    const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ model: aiModel, messages: [{ role: 'user', content: prompt }], max_tokens: 1000 }) });
    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content || JSON.stringify(data);
    await db.prepare('INSERT INTO ai_reviews(review_type,content) VALUES(?,?)').bind(reviewType, content).run();
    return content;
  } catch (e: any) {
    return 'AI 调用失败: ' + e.message;
  }
}

// --- AI Advisory: deep analysis with market data + context ---
async function generateAdvisory(env: Env, db: D1Database): Promise<string> {
  const aiKey = await getSetting(db, 'AI_API_KEY');
  const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
  const aiModel = await getSetting(db, 'AI_MODEL', 'gpt-4o');
  const aiBaseUrl = await getSetting(db, 'AI_BASE_URL', 'https://api.openai.com/v1');
  if (!aiKey) return 'AI API Key 未配置，请在齿轮设置中填入。';

  // 1. Gather all watched markets
  const markets = (await db.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  if (!markets.length) return '暂无监控市场，请先添加市场。';

  // 2. Get 24h price snapshots for each market
  const marketData: any[] = [];
  for (const m of markets) {
    const snapshots = (await db.prepare("SELECT * FROM price_snapshots WHERE condition_id=? AND recorded_at > datetime('now','-1 day') ORDER BY recorded_at ASC").bind(m.condition_id).all()).results;
    // Current price
    let currentYes = null, currentNo = null;
    if (m.token_yes) currentYes = await getMidpoint(env, m.token_yes);
    if (m.token_no) currentNo = await getMidpoint(env, m.token_no);
    marketData.push({
      question: m.question, topic: m.topic || 'other', condition_id: m.condition_id,
      user_conviction: m.user_conviction || 0.5,
      current_yes: currentYes, current_no: currentNo,
      snapshots_count: snapshots.length,
      price_24h_ago: snapshots.length > 0 ? { yes: (snapshots[0] as any).price_yes, no: (snapshots[0] as any).price_no } : null,
      price_latest: snapshots.length > 0 ? { yes: (snapshots[snapshots.length - 1] as any).price_yes, no: (snapshots[snapshots.length - 1] as any).price_no } : null,
      price_change_yes: snapshots.length > 1 ? ((snapshots[snapshots.length - 1] as any).price_yes - (snapshots[0] as any).price_yes) : null,
    });
  }

  // 3. Get recent trades
  const trades = (await db.prepare("SELECT * FROM trades WHERE created_at > datetime('now','-1 day') ORDER BY created_at DESC LIMIT 30").all()).results;

  // 4. Get P&L
  const pnl = { daily: await getState(db, 'daily_pnl'), total: await getState(db, 'total_pnl') };

  // 5. Build prompt
  const prompt = `你是一位专业的预测市场投资顾问，精通 Polymarket 套利策略。请基于以下数据，为用户提供明天的手动投资建议。

## 监控中的市场及24小时数据变化
${marketData.map((m, i) => `
### ${i + 1}. ${m.question}
- 话题: ${m.topic}
- 用户判断 YES 概率: ${Math.round(m.user_conviction * 100)}%
- 当前价格: YES=${m.current_yes ?? '无'}, NO=${m.current_no ?? '无'}
- 24h前价格: YES=${m.price_24h_ago?.yes ?? '无'}, NO=${m.price_24h_ago?.no ?? '无'}
- 24h变化: YES ${m.price_change_yes !== null ? (m.price_change_yes > 0 ? '+' : '') + (m.price_change_yes * 100).toFixed(1) + '%' : '无数据'}
- 数据点数: ${m.snapshots_count}
`).join('')}

## 今日交易记录
${trades.length > 0 ? trades.map((t: any) => `- ${t.side} ${t.strategy || ''} $${t.amount_usd} (${t.mode}) ${t.status}`).join('\n') : '今日暂无交易'}

## 盈亏
- 日盈亏: $${pnl.daily}
- 总盈亏: $${pnl.total}

## 请分析并给出建议

请用中文回答，格式如下：

### 📊 市场概况
（简要总结当前各市场态势和24h变化趋势）

### 🔥 重点关注
（哪些市场出现了显著价格波动或异常）

### 💡 投资建议
对每个市场给出具体建议：
- 建议操作（买YES/买NO/持有观望/卖出）
- 建议仓位比例
- 理由

### ⚠️ 风险提示
（主要风险因素）

### 📈 策略建议
（综合策略建议，考虑用户的判断倾向和市场数据的偏差）

请务必结合用户的判断概率和市场实际价格的偏差来给出建议。当用户判断与市场价格偏差超过15%时，重点提示。`;

  try {
    let apiUrl = aiBaseUrl + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (aiProvider === 'anthropic') {
      apiUrl = (aiBaseUrl || 'https://api.anthropic.com') + '/v1/messages';
      headers['x-api-key'] = aiKey;
      headers['anthropic-version'] = '2023-06-01';
      const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ model: aiModel, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }) });
      const data: any = await res.json();
      const content = data.content?.[0]?.text || JSON.stringify(data);
      await db.prepare('INSERT INTO ai_reviews(review_type,content) VALUES(?,?)').bind('advisory', content).run();
      return content;
    }

    // OpenAI compatible
    headers['Authorization'] = `Bearer ${aiKey}`;
    const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ model: aiModel, messages: [{ role: 'system', content: '你是一位专业的 Polymarket 预测市场投资顾问。' }, { role: 'user', content: prompt }], max_tokens: 2000 }) });
    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content || JSON.stringify(data);
    await db.prepare('INSERT INTO ai_reviews(review_type,content) VALUES(?,?)').bind('advisory', content).run();
    return content;
  } catch (e: any) {
    return 'AI 分析失败: ' + e.message;
  }
}

// =============================================
// HONO APP + ROUTES
// =============================================
const app = new Hono<{ Bindings: Env }>().basePath('/api');
app.use('*', cors());

// Bot status & control
app.get('/bot/status', async c => {
  const db = c.env.DB;
  return c.json({ running: (await getState(db, 'running')) === 'true', paused: (await getState(db, 'paused')) === 'true',
    daily_pnl: parseFloat(await getState(db, 'daily_pnl') || '0'), total_pnl: parseFloat(await getState(db, 'total_pnl') || '0'),
    trading_ready: !!(c.env.POLYMARKET_API_KEY && c.env.POLYMARKET_PRIVATE_KEY),
    mode: await getSetting(db, 'TRADING_MODE', 'paper'), strategies: (await getSetting(db, 'ENABLED_STRATEGIES', 'complement,probability,market_making,momentum,logical')).split(',') });
});
app.post('/bot/control', async c => {
  const { action } = await c.req.json<{ action: string }>(); const db = c.env.DB;
  if (action === 'start') { await setState(db, 'running', 'true'); await setState(db, 'paused', 'false'); }
  else if (action === 'stop') await setState(db, 'running', 'false');
  else if (action === 'pause') { await setState(db, 'paused', 'true'); await addAlert(db, 'info', 'Bot paused'); }
  else if (action === 'resume') await setState(db, 'paused', 'false');
  return c.json({ status: action });
});

// Markets CRUD
app.get('/markets', async c => c.json((await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active=1 ORDER BY added_at DESC').all()).results));
app.get('/markets/prices', async c => {
  const mkts = (await c.env.DB.prepare('SELECT condition_id,token_yes,token_no FROM watched_markets WHERE active=1').all()).results as any[];
  const results = [];
  for (const m of mkts) {
    let priceYes = null, priceNo = null;
    try { if (m.token_yes && m.token_yes.length > 5) priceYes = await getMidpoint(c.env, m.token_yes); } catch {}
    try { if (m.token_no && m.token_no.length > 5) priceNo = await getMidpoint(c.env, m.token_no); } catch {}
    results.push({ condition_id: m.condition_id, price_yes: priceYes, price_no: priceNo });
  }
  return c.json(results);
});
app.post('/markets', async c => {
  const b = await c.req.json();
  await c.env.DB.prepare('INSERT OR REPLACE INTO watched_markets(condition_id,question,token_yes,token_no,user_conviction,topic) VALUES(?,?,?,?,?,?)').bind(b.condition_id, b.question, b.token_yes || null, b.token_no || null, b.user_conviction || 0.5, b.topic || 'other').run();
  return c.json({ status: 'added' });
});
app.put('/markets/:id/conviction', async c => {
  const { conviction } = await c.req.json<{ conviction: number }>();
  await c.env.DB.prepare('UPDATE watched_markets SET user_conviction=? WHERE condition_id=?').bind(conviction, c.req.param('id')).run();
  return c.json({ status: 'updated' });
});
app.delete('/markets/:id', async c => { await c.env.DB.prepare('UPDATE watched_markets SET active=0 WHERE condition_id=?').bind(c.req.param('id')).run(); return c.json({ status: 'removed' }); });
app.get('/markets/search', async c => {
  const q = (c.req.query('q') || '').toLowerCase();
  try { const res = await fetch(`${GAMMA(c.env)}/markets?limit=20&active=true`); let data: any[] = res.ok ? await res.json() : [];
    if (q) data = data.filter((m: any) => ((m.question || '') + (m.slug || '')).toLowerCase().includes(q)); return c.json(data.slice(0, 20));
  } catch { return c.json([]); }
});
// Helper: parse clobTokenIds which can be a JSON string or array
function parseClobTokens(raw: any): [string, string] {
  if (!raw) return ['', ''];
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return ['', '']; } }
  if (Array.isArray(arr)) return [arr[0] || '', arr[1] || ''];
  return ['', ''];
}

app.post('/markets/resolve-url', async c => {
  const { url } = await c.req.json<{ url: string }>(); if (!url) return c.json({ error: 'URL required' }, 400);
  const match = url.match(/polymarket\.com\/event\/([a-z0-9-]+)/i); if (!match) return c.json({ error: 'Invalid URL' }, 400);
  const slug = match[1];
  try {
    const evtRes = await fetch(`${GAMMA(c.env)}/events?slug=${slug}`);
    if (evtRes.ok) { const events: any[] = await evtRes.json();
      if (events.length > 0 && events[0].markets) {
        return c.json({ event: events[0].title, slug, markets: events[0].markets.map((m: any) => {
          const [tY, tN] = parseClobTokens(m.clobTokenIds);
          return { condition_id: m.conditionId || m.condition_id || '', question: m.question || m.groupItemTitle || events[0].title || '',
            token_yes: tY, token_no: tN, slug: m.slug || slug };
        }) });
      }
    }
    const mktRes = await fetch(`${GAMMA(c.env)}/markets?slug=${slug}&limit=10`);
    if (mktRes.ok) { const mkts: any[] = await mktRes.json();
      if (mkts.length) return c.json({ event: mkts[0].question, slug, markets: mkts.map((m: any) => {
        const [tY, tN] = parseClobTokens(m.clobTokenIds);
        return { condition_id: m.conditionId || m.condition_id || '', question: m.question || '', token_yes: tY, token_no: tN };
      }) });
    }
    return c.json({ error: 'Not found: ' + slug });
  } catch (e: any) { return c.json({ error: e.message }); }
});

// Groups
app.get('/groups', async c => c.json((await c.env.DB.prepare('SELECT * FROM arbitrage_groups WHERE active=1').all()).results.map((x: any) => ({ ...x, market_ids: JSON.parse(x.market_ids || '[]') }))));
app.post('/groups', async c => { const b = await c.req.json(); await c.env.DB.prepare('INSERT INTO arbitrage_groups(name,description,market_ids,strategy) VALUES(?,?,?,?)').bind(b.name, b.description || '', JSON.stringify(b.market_ids), b.strategy || 'complement').run(); return c.json({ status: 'created' }); });
app.delete('/groups/:id', async c => { await c.env.DB.prepare('UPDATE arbitrage_groups SET active=0 WHERE id=?').bind(+c.req.param('id')).run(); return c.json({ status: 'removed' }); });

// Risk
app.get('/risk', async c => { const db = c.env.DB; return c.json({ max_position_size_usd: parseFloat(await getSetting(db, 'MAX_POSITION_SIZE_USD', '100')), daily_loss_limit_usd: parseFloat(await getSetting(db, 'DAILY_LOSS_LIMIT_USD', '50')), max_single_trade_usd: parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20')), min_arbitrage_spread: parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02')) }); });
app.put('/risk', async c => { const b = await c.req.json(); const db = c.env.DB;
  for (const [k, v] of Object.entries(b)) { if (v != null) await db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(k.toUpperCase().replace(/([a-z])([A-Z])/g, '$1_$2'), String(v)).run(); }
  return c.json({ status: 'updated' }); });

// Trades & Alerts
app.get('/trades', async c => c.json((await c.env.DB.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').bind(+(c.req.query('limit') || '50')).all()).results));
app.post('/trades/reset-paper', async c => {
  await c.env.DB.prepare("DELETE FROM trades WHERE mode='paper'").run();
  await setState(c.env.DB, 'daily_pnl', '0');
  await setState(c.env.DB, 'total_pnl', '0');
  return c.json({ status: 'reset' });
});
app.get('/trades/pnl-by-strategy', async c => {
  const rows = (await c.env.DB.prepare("SELECT strategy, mode, COUNT(*) as count, SUM(amount_usd) as total_amount FROM trades GROUP BY strategy, mode").all()).results as any[];
  const result: Record<string, { count: number; amount: number; mode: string }> = {};
  for (const r of rows) {
    const key = (r.strategy || 'unknown') + '_' + (r.mode || 'paper');
    result[key] = { count: r.count, amount: r.total_amount || 0, mode: r.mode || 'paper' };
  }
  // Also compute simulated P&L per strategy from trade pairs
  const allTrades = (await c.env.DB.prepare("SELECT strategy, side, price, size, amount_usd, mode FROM trades WHERE mode='paper'").all()).results as any[];
  const stratPnl: Record<string, number> = {};
  for (const t of allTrades) {
    const s = t.strategy || 'unknown';
    if (!stratPnl[s]) stratPnl[s] = 0;
    // BUY = cost (negative), SELL = income (positive) for market_making
    // For complement: both BUY, profit comes from payout - cost
    if (t.side === 'SELL') stratPnl[s] += t.amount_usd;
    else stratPnl[s] -= t.amount_usd;
  }
  return c.json({ by_strategy: result, pnl: stratPnl, total_pnl: Object.values(stratPnl).reduce((a: number, b: number) => a + b, 0) });
});
app.get('/alerts', async c => c.json((await c.env.DB.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').bind(+(c.req.query('limit') || '50')).all()).results));
app.post('/alerts/:id/resolve', async c => { await c.env.DB.prepare('UPDATE alerts SET resolved=1 WHERE id=?').bind(+c.req.param('id')).run(); return c.json({ status: 'resolved' }); });

// Prices
app.get('/prices/:cid', async c => c.json((await c.env.DB.prepare('SELECT * FROM price_snapshots WHERE condition_id=? ORDER BY recorded_at DESC LIMIT ?').bind(c.req.param('cid'), +(c.req.query('limit') || '100')).all()).results));

// Settings
app.get('/settings', async c => {
  const db = c.env.DB; const rows = await db.prepare('SELECT key,value FROM settings').all(); const s: Record<string, any> = {};
  for (const r of rows.results as any[]) s[r.key] = { value: r.value, is_set: !!r.value };
  for (const k of ['POLYMARKET_API_KEY','POLYMARKET_API_SECRET','POLYMARKET_API_PASSPHRASE','POLYMARKET_PRIVATE_KEY','POLYMARKET_FUNDER_ADDRESS']) { const v = (c.env as any)[k] || ''; s[k] = { value: v ? v.slice(0, 4) + '****' + v.slice(-4) : '', is_set: !!v }; }
  s['POLYMARKET_API_URL'] = { value: c.env.POLYMARKET_API_URL || 'https://clob.polymarket.com', is_set: true };
  s['GAMMA_API_URL'] = { value: c.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com', is_set: true };
  s['DATA_API_URL'] = { value: c.env.DATA_API_URL || 'https://data-api.polymarket.com', is_set: true };
  return c.json(s);
});
app.put('/settings', async c => {
  const { settings } = await c.req.json<{ settings: Record<string, string> }>(); const db = c.env.DB;
  const dbKeys = ['MAX_POSITION_SIZE_USD','DAILY_LOSS_LIMIT_USD','MAX_SINGLE_TRADE_USD','MIN_ARBITRAGE_SPREAD','POLL_INTERVAL','AI_PROVIDER','AI_API_KEY','AI_MODEL','AI_BASE_URL','TRADING_MODE','ENABLED_STRATEGIES','TRADE_COOLDOWN_SEC','AI_PROVIDERS_JSON','AI_ACTIVE_PROVIDER'];
  for (const [k, v] of Object.entries(settings)) { if (dbKeys.includes(k) && v && !v.includes('****')) await db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(k, v).run(); }
  return c.json({ status: 'saved' }); });

// Fix broken market tokens by re-fetching from Gamma API
app.post('/markets/fix-tokens', async c => {
  const mkts = (await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  const fixed: string[] = [];
  for (const m of mkts) {
    if (m.token_yes && m.token_yes.length > 10 && m.token_no && m.token_no.length > 10) continue; // already valid
    try {
      // Try CLOB API first
      const clob: any = await clobGet(c.env, `/markets/${m.condition_id}`);
      if (clob && clob.tokens) {
        const tokens = clob.tokens;
        const yes = tokens.find((t: any) => t.outcome === 'Yes')?.token_id || tokens[0]?.token_id || '';
        const no = tokens.find((t: any) => t.outcome === 'No')?.token_id || tokens[1]?.token_id || '';
        if (yes && no) {
          await c.env.DB.prepare('UPDATE watched_markets SET token_yes=?, token_no=? WHERE condition_id=?').bind(yes, no, m.condition_id).run();
          fixed.push(m.question + ': OK');
          continue;
        }
      }
      // Fallback: Gamma API
      const gamma = await fetch(`${GAMMA(c.env)}/markets?condition_id=${m.condition_id}`);
      if (gamma.ok) {
        const gm: any[] = await gamma.json();
        if (gm.length > 0) {
          const [tY, tN] = parseClobTokens(gm[0].clobTokenIds);
          if (tY && tN) {
            await c.env.DB.prepare('UPDATE watched_markets SET token_yes=?, token_no=? WHERE condition_id=?').bind(tY, tN, m.condition_id).run();
            fixed.push(m.question + ': OK (gamma)');
            continue;
          }
        }
      }
      fixed.push(m.question + ': FAILED - no tokens found');
    } catch (e: any) { fixed.push(m.question + ': ERROR - ' + e.message); }
  }
  return c.json({ fixed });
});

// Debug: check market data and token prices
app.get('/debug/markets', async c => {
  const mkts = (await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  const results = [];
  for (const m of mkts) {
    const info: any = { question: m.question, condition_id: m.condition_id, token_yes: m.token_yes || 'EMPTY', token_no: m.token_no || 'EMPTY' };
    if (m.token_yes) {
      try { info.price_yes = await getMidpoint(c.env, m.token_yes); } catch (e: any) { info.price_yes_error = e.message; }
    }
    if (m.token_no) {
      try { info.price_no = await getMidpoint(c.env, m.token_no); } catch (e: any) { info.price_no_error = e.message; }
    }
    // Try to fetch tokens from CLOB if missing
    if (!m.token_yes || !m.token_no) {
      try {
        const mkt: any = await clobGet(c.env, `/markets/${m.condition_id}`);
        info.clob_market = mkt ? { tokens: mkt.tokens, clobTokenIds: mkt.clobTokenIds } : 'not found';
      } catch (e: any) { info.clob_error = e.message; }
    }
    results.push(info);
  }
  return c.json(results);
});

// Scan & AI
app.post('/scan', async c => c.json(await runScan(c.env)));

// Manual trade: place a single order (for testing)
app.post('/trade', async c => {
  const { token_id, price, size, side } = await c.req.json<{ token_id: string; price: number; size: number; side: string }>();
  if (!token_id || !price || !size || !side) return c.json({ error: 'Missing fields: token_id, price, size, side' }, 400);
  if (!c.env.POLYMARKET_PRIVATE_KEY || !c.env.POLYMARKET_API_KEY) return c.json({ error: 'Trading credentials not configured' }, 400);

  try {
    const client = createClobClient(c.env, {
      key: c.env.POLYMARKET_API_KEY!,
      secret: c.env.POLYMARKET_API_SECRET!,
      passphrase: c.env.POLYMARKET_API_PASSPHRASE || '',
    });

    const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;
    let tickSize = '0.01';
    try { const ts = await client.getTickSize(token_id); if (ts) tickSize = ts; } catch {}
    let negRisk = false;
    try { negRisk = await client.getNegRisk(token_id); } catch {}

    const result = await client.createAndPostOrder(
      { tokenID: token_id, price, side: orderSide, size },
      { tickSize, negRisk },
      OrderType.GTC,
    );

    await c.env.DB.prepare('INSERT INTO trades(condition_id,side,token_id,price,size,amount_usd,order_id,status,strategy,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(
      '', side, token_id, price, size, price * size, result?.orderID || 'manual', 'submitted', 'manual', 'real'
    ).run();

    return c.json({ success: true, result });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/ai-review', async c => { const { type } = await c.req.json<{ type: string }>(); return c.json({ review: await aiReview(c.env, c.env.DB, type || 'hourly') }); });
app.get('/ai-reviews', async c => c.json((await c.env.DB.prepare('SELECT * FROM ai_reviews ORDER BY created_at DESC LIMIT 10').all()).results));

// AI Advisory: daily investment advice based on 24h data + market context
app.post('/ai-advisory', async c => {
  const result = await generateAdvisory(c.env, c.env.DB);
  return c.json({ advisory: result });
});
app.get('/ai-advisory/latest', async c => {
  const r = await c.env.DB.prepare("SELECT * FROM ai_reviews WHERE review_type='advisory' ORDER BY created_at DESC LIMIT 1").first();
  return c.json(r || { content: '暂无投资建议。系统将在每天凌晨2点自动生成。', created_at: '' });
});

// AI Chat: follow-up conversation based on advisory
app.post('/ai-chat', async c => {
  const { message, context, history } = await c.req.json<{ message: string; context: string; history: any[] }>();
  const db = c.env.DB;
  const aiKey = await getSetting(db, 'AI_API_KEY');
  const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
  const aiModel = await getSetting(db, 'AI_MODEL', 'gpt-4o');
  const aiBaseUrl = await getSetting(db, 'AI_BASE_URL', 'https://api.openai.com/v1');
  if (!aiKey) return c.json({ reply: 'AI API Key 未配置，请在齿轮设置中添加。' });

  // Build messages with context
  const systemMsg = `你是 Polymarket 预测市场投资顾问。用户正在查看以下 AI 分析报告，并基于此追问。请用中文回答，简洁实用。

当前分析报告摘要:
${(context || '无').slice(0, 2000)}`;

  const messages: any[] = [{ role: 'system', content: systemMsg }];
  // Add chat history
  for (const h of (history || []).slice(-8)) {
    if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content });
  }
  // Add current message
  messages.push({ role: 'user', content: message });

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let reply = '';
    if (aiProvider === 'anthropic') {
      headers['x-api-key'] = aiKey; headers['anthropic-version'] = '2023-06-01';
      const msgs = messages.filter((m: any) => m.role !== 'system');
      const res = await fetch((aiBaseUrl || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: aiModel, max_tokens: 1500, system: systemMsg, messages: msgs }) });
      const data: any = await res.json();
      reply = data.content?.[0]?.text || JSON.stringify(data);
    } else {
      headers['Authorization'] = `Bearer ${aiKey}`;
      const res = await fetch(aiBaseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: aiModel, messages, max_tokens: 1500 }) });
      const data: any = await res.json();
      reply = data.choices?.[0]?.message?.content || JSON.stringify(data);
    }
    return c.json({ reply });
  } catch (e: any) { return c.json({ reply: 'AI 请求失败: ' + e.message }); }
});

// Debug
app.get('/debug/env', async c => {
  const keys = ['POLYMARKET_API_KEY','POLYMARKET_API_SECRET','POLYMARKET_API_PASSPHRASE','POLYMARKET_PRIVATE_KEY','POLYMARKET_FUNDER_ADDRESS','POLYMARKET_API_URL','GAMMA_API_URL','DATA_API_URL'];
  const s: Record<string, any> = {}; for (const k of keys) { const v = (c.env as any)[k]; s[k] = { exists: !!v, length: v ? String(v).length : 0 }; }
  s['DB_BOUND'] = { exists: !!c.env.DB }; try { s['SIGNER'] = getSignerAddress(c.env); } catch {} return c.json(s);
});
app.get('/connection/test', async c => {
  const result: any = { api_configured: false, clob_reachable: false, auth_ok: false, message: '' };
  if (!c.env.POLYMARKET_API_KEY) { result.message = 'API Key 未配置'; return c.json(result); }
  if (!c.env.POLYMARKET_API_SECRET) { result.message = 'API Secret 未配置'; return c.json(result); }
  result.api_configured = true;
  try { const r = await fetch(`${CLOB(c.env)}/markets`); if (r.ok) result.clob_reachable = true; else { result.message = 'CLOB HTTP ' + r.status; return c.json(result); } } catch (e: any) { result.message = e.message; return c.json(result); }
  try { const h = await authHeaders(c.env, 'GET', '/auth/api-keys'); const r = await fetch(`${CLOB(c.env)}/auth/api-keys`, { headers: h }); if (r.ok) { result.auth_ok = true; result.message = '连接成功！API 认证通过'; } else { result.message = 'HTTP ' + r.status + ': ' + (await r.text()).slice(0, 100); } } catch (e: any) { result.message = e.message; }
  return c.json(result);
});

export const onRequest = handle(app);
