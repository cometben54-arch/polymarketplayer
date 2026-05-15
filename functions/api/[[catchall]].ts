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

// Sleep helper - used to pace API requests
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// --- Account / Position helpers ---
// Query USDC balance directly from Polygon RPC (most reliable)
async function getAccountBalance(env: Env): Promise<number> {
  const addr = env.POLYMARKET_FUNDER_ADDRESS;
  if (!addr) return 0;

  // USDC.e contract on Polygon (used by Polymarket)
  const USDC_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  // ERC20 balanceOf(address) function selector + padded address
  const data = '0x70a08231' + addr.replace('0x', '').toLowerCase().padStart(64, '0');

  // Try multiple public Polygon RPCs for reliability
  const rpcs = [
    'https://polygon-rpc.com',
    'https://rpc-mainnet.matic.network',
    'https://polygon-bor-rpc.publicnode.com',
  ];

  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: USDC_ADDR, data }, 'latest'],
        }),
      });
      if (!res.ok) continue;
      const json: any = await res.json();
      if (json.result) {
        // USDC has 6 decimals
        const bigInt = BigInt(json.result);
        return Number(bigInt) / 1e6;
      }
    } catch {}
  }

  // Fallback: try Polymarket Data API
  try {
    const dataUrl = (env.DATA_API_URL || 'https://data-api.polymarket.com').replace(/\/$/, '');
    const res = await fetch(`${dataUrl}/value?user=${addr}`);
    if (res.ok) { const d: any = await res.json(); return parseFloat(d.value || '0'); }
  } catch {}

  return 0;
}

async function getTokenPosition(env: Env, tokenId: string): Promise<number> {
  // Fetch user's holdings of a specific token via Data API
  const addr = env.POLYMARKET_FUNDER_ADDRESS;
  if (!addr || !tokenId) return 0;
  try {
    const dataUrl = (env.DATA_API_URL || 'https://data-api.polymarket.com').replace(/\/$/, '');
    const res = await fetch(`${dataUrl}/positions?user=${addr}`);
    if (res.ok) {
      const positions: any[] = await res.json();
      const p = positions.find((x: any) => x.asset === tokenId || x.tokenId === tokenId);
      return p ? parseFloat(p.size || '0') : 0;
    }
  } catch {}
  return 0;
}

// In paper mode, calculate simulated balance/positions from DB
async function getPaperBalance(db: D1Database, startingCash = 100): Promise<number> {
  const res = await db.prepare("SELECT COALESCE(SUM(CASE WHEN side='BUY' THEN -amount_usd ELSE amount_usd END), 0) as net FROM trades WHERE mode='paper' AND status='filled'").first<{net:number}>();
  return startingCash + (res?.net || 0);
}

async function getPaperPosition(db: D1Database, tokenId: string): Promise<number> {
  if (!tokenId) return 0;
  const res = await db.prepare("SELECT COALESCE(SUM(CASE WHEN side='BUY' THEN size ELSE -size END), 0) as total FROM trades WHERE mode='paper' AND status='filled' AND token_id=?").bind(tokenId).first<{total:number}>();
  return res?.total || 0;
}

// --- DB helpers ---
async function getState(db: D1Database, k: string): Promise<string> { const r = await db.prepare('SELECT value FROM bot_state WHERE key=?').bind(k).first<{value:string}>(); return r?.value || ''; }
async function setState(db: D1Database, k: string, v: string) { await db.prepare('INSERT OR REPLACE INTO bot_state(key,value,updated_at) VALUES(?,?,datetime("now"))').bind(k, v).run(); }
async function getSetting(db: D1Database, k: string, fb = ''): Promise<string> { const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first<{value:string}>(); return r?.value || fb; }
async function addAlert(db: D1Database, level: string, msg: string) { await db.prepare('INSERT INTO alerts(level,message) VALUES(?,?)').bind(level, msg).run(); }

// Polymarket taker fees by category
// LAST VERIFIED: 2026-04-13 from help.polymarket.com/articles/13364478
// TODO: Re-verify weekly - fees can change. Sources:
//   - https://help.polymarket.com/en/articles/13364478-trading-fees
//   - https://docs.polymarket.com/trading/fees
// Makers pay 0%, takers pay by category. Geopolitics is fee-free.
const CATEGORY_FEES: Record<string, number> = {
  geopolitics: 0.0000,  // 0.00% - fee-free!
  sports: 0.0075,       // 0.75%
  politics: 0.0100,     // 1.00%
  finance: 0.0100,      // 1.00%
  tech: 0.0100,         // 1.00%
  culture: 0.0125,      // 1.25%
  weather: 0.0125,      // 1.25%
  economics: 0.0150,    // 1.50%
  mentions: 0.0156,     // 1.56%
  crypto: 0.0180,       // 1.80%
  other: 0.0125,        // default 1.25%
};
const FEES_LAST_VERIFIED = '2026-04-13';
const DEFAULT_FEE = 0.0125;

function getFeeForCategory(topic: string | undefined): number {
  if (!topic) return DEFAULT_FEE;
  const t = topic.toLowerCase().trim();
  // Aliases
  if (t.includes('geopolit') || t === 'world' || t === 'world-events') return 0;
  if (t.includes('sport')) return CATEGORY_FEES.sports;
  if (t.includes('politic')) return CATEGORY_FEES.politics;
  if (t.includes('financ') || t.includes('stock')) return CATEGORY_FEES.finance;
  if (t.includes('tech') || t.includes('ai')) return CATEGORY_FEES.tech;
  if (t.includes('cultur') || t.includes('entertain')) return CATEGORY_FEES.culture;
  if (t.includes('weather') || t.includes('climate')) return CATEGORY_FEES.weather;
  if (t.includes('econom')) return CATEGORY_FEES.economics;
  if (t.includes('crypto') || t.includes('bitcoin') || t.includes('ethereum')) return CATEGORY_FEES.crypto;
  return CATEGORY_FEES[t] ?? DEFAULT_FEE;
}

// Smart classifier: detect category from market question text
// Polymarket sometimes mislabels markets in Gamma API. We override based on keywords.
function classifyByKeywords(question: string, currentTopic: string = ''): string {
  if (!question) return currentTopic || 'other';
  const q = question.toLowerCase();

  // GEOPOLITICS: international relations, conflicts, diplomacy, world events
  const geoKeywords = [
    'us-iran', 'us iran', 'iran-us', 'iran us', 'iran nuclear', 'iran deal',
    'israel', 'palestine', 'gaza', 'hamas', 'hezbollah', 'lebanon',
    'russia', 'ukraine', 'putin', 'zelensky', 'crimea',
    'china taiwan', 'taiwan strait', 'xi jinping', 'taiwan war',
    'north korea', 'kim jong un', 'south korea',
    'nato', 'g7', 'g20', 'un security', 'united nations',
    'syria', 'yemen', 'houthi', 'red sea',
    'venezuela', 'maduro', 'cuba',
    'sanctions on', 'embargo', 'ceasefire', 'peace deal', 'diplomatic',
    'hormuz', 'strait of', 'persian gulf',
    'wto', 'tariff war', 'trade war',
    'wagner', 'mercenar',
    'invasion', 'invade', 'annex', 'sovereign',
    'nuclear test', 'nuclear weapon', 'icbm', 'missile test',
    'embassy', 'ambassador', 'summit',
    'border crossing', 'refugee crisis',
  ];
  for (const kw of geoKeywords) if (q.includes(kw)) return 'geopolitics';

  // CRYPTO
  const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth ', 'eth?', 'solana', 'sol ', 'doge', 'crypto', 'altcoin', 'defi', 'nft', 'stablecoin', 'binance', 'coinbase', 'sec ruling', 'satoshi'];
  for (const kw of cryptoKeywords) if (q.includes(kw)) return 'crypto';

  // SPORTS
  const sportsKeywords = ['nba', 'nfl', 'mlb', 'nhl', 'fifa', 'world cup', 'olympics', 'championship', 'super bowl', 'finals', 'playoff', 'lakers', 'warriors', 'liverpool', 'real madrid', 'champions league', 'tennis', 'golf', 'f1 grand prix', 'formula 1', 'ufc'];
  for (const kw of sportsKeywords) if (q.includes(kw)) return 'sports';

  // WEATHER / CLIMATE
  const weatherKeywords = ['hurricane', 'tornado', 'typhoon', 'earthquake', 'tsunami', 'wildfire', 'flood', 'drought', 'climate', 'global warming', 'temperature record'];
  for (const kw of weatherKeywords) if (q.includes(kw)) return 'weather';

  // ECONOMICS / FED
  const econKeywords = ['fed rate', 'fomc', 'cpi ', 'inflation', 'recession', 'gdp', 'unemployment rate', 'jobs report', 'fed cut', 'fed hike', 'interest rate', 'jerome powell'];
  for (const kw of econKeywords) if (q.includes(kw)) return 'economics';

  // FINANCE / STOCKS
  const finKeywords = ['s&p 500', 'nasdaq', 'dow jones', 'stock', 'tesla', 'apple', 'nvidia', 'microsoft', 'amazon', 'ipo', 'dividend', 'earnings'];
  for (const kw of finKeywords) if (q.includes(kw)) return 'finance';

  // TECH
  const techKeywords = ['openai', 'chatgpt', 'gpt-', 'claude', 'anthropic', 'gemini', 'google ai', 'meta ai', 'agi ', 'artificial general', 'self-driving', 'robotaxi', 'spacex launch', 'nasa launch'];
  for (const kw of techKeywords) if (q.includes(kw)) return 'tech';

  // POLITICS (US domestic, elections, etc.)
  const politicsKeywords = ['election', 'president 2028', 'primary', 'democrat', 'republican', 'congress', 'senate', 'house bill', 'supreme court', 'scotus', 'governor', 'mayor', 'biden', 'trump approval', 'kamala'];
  for (const kw of politicsKeywords) if (q.includes(kw)) return 'politics';

  return currentTopic || 'other';
}

// =============================================
// STRATEGY 1: Complement Arbitrage (Dutch Book)
// YES + NO should = $1. If not, guaranteed profit after fees.
// =============================================
async function strategyComplement(env: Env, m: any, minSpread: number, tradeSize: number, cache?: any): Promise<any|null> {
  if (!m.token_yes || !m.token_no) return null;
  const pY = cache?.askY ?? await getPrice(env, m.token_yes, 'BUY');
  const pN = cache?.askN ?? await getPrice(env, m.token_no, 'BUY');
  if (pY === null || pN === null) return null;
  if (pY < 0.02 || pN < 0.02) return null; // Skip very extreme prices
  const fee = getFeeForCategory(m.topic);
  const totalCost = pY + pN;
  const fees = totalCost * fee * 2; // fees on both legs
  const netProfit = 1 - totalCost - fees;
  // ANY positive net profit > 0.001 (0.1¢) is captured
  if (netProfit > 0.001) {
    const sh = Math.min(tradeSize / totalCost, 100);
    const profit = sh * netProfit;
    if (profit > tradeSize) return null;
    return { strategy: 'complement', action: 'BUY_BOTH', spread: netProfit, profit, confidence: Math.min(netProfit / 0.05, 1),
      fee_rate: fee, gap: 1 - totalCost,
      legs: [{ token: m.token_yes, side: 'BUY', price: pY, size: sh }, { token: m.token_no, side: 'BUY', price: pN, size: sh }] };
  }
  const bY = cache?.bidY ?? await getPrice(env, m.token_yes, 'SELL');
  const bN = cache?.bidN ?? await getPrice(env, m.token_no, 'SELL');
  if (bY !== null && bN !== null) {
    if (bY < 0.02 || bN < 0.02) return null;
    const totalBid = bY + bN;
    const feesS = totalBid * fee * 2;
    const netProfitS = totalBid - 1 - feesS;
    if (netProfitS > 0.001) {
      const sh = Math.min(tradeSize / totalBid, 100);
      const profitS = sh * netProfitS;
      if (profitS > tradeSize) return null;
      return { strategy: 'complement', action: 'SELL_BOTH', spread: netProfitS, profit: profitS, confidence: Math.min(netProfitS / 0.05, 1),
        fee_rate: fee, gap: totalBid - 1,
        legs: [{ token: m.token_yes, side: 'SELL', price: bY, size: sh }, { token: m.token_no, side: 'SELL', price: bN, size: sh }] };
    }
  }
  return null;
}

// =============================================
// STRATEGY 2: AI-Powered Probability Analysis
// Uses AI to analyze:
// 1. Price history (24-48h trend from snapshots)
// 2. Market context (question, end date, topic)
// 3. Bayesian reasoning (prior base rate + evidence)
// 4. Latest relevant information (if AI supports web search)
// Returns AI-estimated "true" probability, trades on deviation from market.
// User conviction is used as WEAK prior, not main signal.
// =============================================
async function strategyProbability(env: Env, m: any, db: D1Database, tradeSize: number, balance: number, mode: string, cache?: any): Promise<any|null> {
  if (!m.token_yes) return null;
  const marketPrice = cache?.mid ?? await getMidpoint(env, m.token_yes);
  if (marketPrice === null || marketPrice < 0.05 || marketPrice > 0.95) return null;

  // Rate limit AI calls: only run per market every 30 minutes
  const cacheKey = 'ai_prob_' + m.condition_id.slice(0, 16);
  const cached = await getState(db, cacheKey);
  const now = Math.floor(Date.now() / 1000);
  let aiProb: number | null = null;
  let aiReasoning = '';

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (now - parsed.ts < 1800) { // 30 min cache
        aiProb = parsed.prob;
        aiReasoning = parsed.reasoning;
      }
    } catch {}
  }

  if (aiProb === null) {
    // Fetch AI probability analysis
    const aiKey = await getSetting(db, 'AI_API_KEY');
    if (!aiKey) return null;
    const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
    const aiModel = await getSetting(db, 'AI_MODEL', 'gpt-4o');
    const aiBaseUrl = await getSetting(db, 'AI_BASE_URL', 'https://api.openai.com/v1');

    // Gather price history (last 48 hours)
    const snaps = (await db.prepare("SELECT price_yes,recorded_at FROM price_snapshots WHERE condition_id=? AND recorded_at > datetime('now','-2 days') ORDER BY recorded_at ASC LIMIT 100").bind(m.condition_id).all()).results as any[];
    const priceTrend = snaps.length ? snaps.map(s => (s.price_yes * 100).toFixed(0) + '%').join('→') : '无历史数据';

    const prompt = `你是一位专业的预测市场量化分析师。基于以下信息，给出这个市场 YES 结果的“真实概率”估计。

市场问题: "${m.question}"
当前市场价格: YES = ${(marketPrice * 100).toFixed(1)}%
48小时价格走势: ${priceTrend}
用户主观判断 (弱先验): ${(m.user_conviction * 100).toFixed(0)}%

请运用以下分析方法:
1. 基于事件性质的贝叶斯先验（历史基率）
2. 价格走势分析（是否有确认信号或反向信号）
3. 结合你所了解的最新相关信息（政治、经济、社会等背景）
4. 数学物理原理（如均值回归、动量效应、羊群效应、消息扩散）
5. 对于地缘政治/加密货币/经济类事件，考虑宏观因素
6. 谨慎对待黑天鹅事件

请严格按以下 JSON 格式回复，不要任何其他内容:
{"prob": 0.XX, "confidence": 0.X, "reasoning": "简短理由(30字内)"}

prob: 你估计的真实概率 (0-1)
confidence: 你对这个估计的信心 (0-1, 只在>0.7时才会被采用)
reasoning: 核心理由`;

    try {
      let content = '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (aiProvider === 'anthropic') {
        headers['x-api-key'] = aiKey;
        headers['anthropic-version'] = '2023-06-01';
        const res = await fetch((aiBaseUrl || 'https://api.anthropic.com') + '/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({ model: aiModel, max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
        });
        const data: any = await res.json();
        content = data.content?.[0]?.text || '';
      } else {
        headers['Authorization'] = `Bearer ${aiKey}`;
        const res = await fetch(aiBaseUrl + '/chat/completions', {
          method: 'POST', headers,
          body: JSON.stringify({ model: aiModel, max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
        });
        const data: any = await res.json();
        content = data.choices?.[0]?.message?.content || '';
      }

      const match = content.match(/\{[\s\S]*?\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.prob !== 'number' || parsed.prob < 0 || parsed.prob > 1) return null;
      if (typeof parsed.confidence !== 'number' || parsed.confidence < 0.7) return null; // Need high confidence

      aiProb = parsed.prob;
      aiReasoning = parsed.reasoning || '';
      await setState(db, cacheKey, JSON.stringify({ prob: aiProb, reasoning: aiReasoning, ts: now }));
    } catch { return null; }
  }

  if (aiProb === null) return null;
  const deviation = aiProb - marketPrice;
  if (Math.abs(deviation) < 0.10) return null; // Need ≥10% deviation

  // Kelly fraction (half-Kelly for safety)
  const kelly = Math.min(Math.abs(deviation) / 2, 0.15);
  const dollarBet = Math.min(tradeSize * kelly * 4, balance * 0.08);
  if (dollarBet < 0.50) return null;

  const feeRate = getFeeForCategory(m.topic);
  if (deviation > 0) {
    const price = cache?.askY ?? await getPrice(env, m.token_yes, 'BUY');
    if (price === null || price < 0.05 || price > 0.95) return null;
    if (balance < dollarBet) return null;
    const size = Math.min(dollarBet / price, 100);
    const fee = size * price * feeRate;
    const expectedProfit = size * Math.abs(deviation) - fee;
    if (expectedProfit < 0.01) return null;
    return { strategy: 'probability', action: 'BUY_YES_AI', spread: Math.abs(deviation), profit: expectedProfit,
      confidence: Math.min(Math.abs(deviation) / 0.2, 1), fee_rate: feeRate,
      advisory: `AI估计${(aiProb*100).toFixed(0)}% > 市场${(marketPrice*100).toFixed(0)}% | ${aiReasoning}`,
      legs: [{ token: m.token_yes, side: 'BUY', price, size }] };
  } else {
    const position = mode === 'paper' ? await getPaperPosition(db, m.token_yes) : await getTokenPosition(env, m.token_yes);
    if (position < 1) return null;
    const price = cache?.bidY ?? await getPrice(env, m.token_yes, 'SELL');
    if (price === null || price < 0.05) return null;
    const size = Math.min(position, 100, dollarBet / price);
    if (size < 1) return null;
    const fee = size * price * feeRate;
    const expectedProfit = size * Math.abs(deviation) - fee;
    if (expectedProfit < 0.01) return null;
    return { strategy: 'probability', action: 'SELL_YES_AI', spread: Math.abs(deviation), profit: expectedProfit,
      confidence: Math.min(Math.abs(deviation) / 0.2, 1), fee_rate: feeRate,
      advisory: `AI估计${(aiProb*100).toFixed(0)}% < 市场${(marketPrice*100).toFixed(0)}% | ${aiReasoning}`,
      legs: [{ token: m.token_yes, side: 'SELL', price, size }] };
  }
}

// LEGACY: kept the logic inline but not reachable
async function _strategyProbabilityLegacy(env: Env, m: any, db: D1Database, tradeSize: number, balance: number, mode: string): Promise<any|null> {
  if (!m.token_yes || m.user_conviction === 0.5) return null;
  const marketPrice = await getMidpoint(env, m.token_yes);
  if (marketPrice === null) return null;
  const deviation = m.user_conviction - marketPrice;
  if (Math.abs(deviation) < 0.15) return null;
  const kelly = Math.min(Math.abs(deviation) / 2, 0.25);
  const dollarBet = Math.min(tradeSize * kelly, balance * 0.1);
  if (dollarBet < 0.50) return null;
  if (deviation > 0) {
    const price = await getPrice(env, m.token_yes, 'BUY');
    if (price === null || price < 0.03 || price > 0.97) return null;
    if (balance < dollarBet) return null;
    const size = Math.min(dollarBet / price, 100);
    const fee = size * price * getFeeForCategory(m.topic);
    const expectedProfit = size * Math.abs(deviation) - fee;
    if (expectedProfit < 0.01) return null;
    return { strategy: 'probability', action: 'BUY_YES', spread: Math.abs(deviation), profit: expectedProfit,
      confidence: Math.min(Math.abs(deviation) / 0.2, 1),
      advisory: `用户${(m.user_conviction*100).toFixed(0)}% > 市场${(marketPrice*100).toFixed(0)}%`,
      legs: [{ token: m.token_yes, side: 'BUY', price, size }] };
  } else {
    const position = mode === 'paper' ? await getPaperPosition(db, m.token_yes) : await getTokenPosition(env, m.token_yes);
    if (position < 1) return null;
    const price = await getPrice(env, m.token_yes, 'SELL');
    if (price === null || price < 0.03) return null;
    const size = Math.min(position, 100, dollarBet / price);
    if (size < 1) return null;
    const fee = size * price * getFeeForCategory(m.topic);
    const expectedProfit = size * Math.abs(deviation) - fee;
    if (expectedProfit < 0.01) return null;
    return { strategy: 'probability', action: 'SELL_YES', spread: Math.abs(deviation), profit: expectedProfit,
      confidence: Math.min(Math.abs(deviation) / 0.2, 1),
      advisory: `用户${(m.user_conviction*100).toFixed(0)}% < 市场${(marketPrice*100).toFixed(0)}%, 卖YES (持仓${position.toFixed(0)})`,
      legs: [{ token: m.token_yes, side: 'SELL', price, size }] };
  }
}

// =============================================
// STRATEGY 3: Market Making (bid-ask spread)
// Place limit orders on both sides to capture spread.
// =============================================
async function strategyMarketMaking(env: Env, m: any, tradeSize: number, cache?: any): Promise<any|null> {
  if (!m.token_yes) return null;
  const book = cache?.bookY ?? await getOrderbook(env, m.token_yes);
  if (!book || !book.bids?.length || !book.asks?.length) return null;
  const bestBid = parseFloat(book.bids[0].price);
  const bestAsk = parseFloat(book.asks[0].price);
  const spread = bestAsk - bestBid;
  // Lower threshold: 2¢ raw spread (was 5¢)
  if (spread < 0.02) return null;
  if (bestBid < 0.03 || bestAsk > 0.97) return null;

  // Improve quotes by 1¢ on each side (or use minimum tick)
  const tickSize = 0.01;
  const buyPrice = Math.round((bestBid + tickSize) * 100) / 100;
  const sellPrice = Math.round((bestAsk - tickSize) * 100) / 100;
  const netSpread = sellPrice - buyPrice;
  if (netSpread <= 0) return null; // No profit possible after improvements

  const maxSize = Math.min(tradeSize / buyPrice, tradeSize / sellPrice);
  const size = Math.min(maxSize, 200);
  const revenue = size * sellPrice;
  const cost = size * buyPrice;
  if (cost > tradeSize * 1.1 || revenue > tradeSize * 3) return null;
  const feeRate = getFeeForCategory(m.topic);
  const feeBuy = cost * feeRate;
  const feeSell = revenue * feeRate;
  const profit = revenue - cost - feeBuy - feeSell;

  // ANY positive profit > 0.5¢ qualifies (global filter applies later)
  if (profit < 0.005) return null;

  return { strategy: 'market_making', action: 'MAKE_MARKET', spread: netSpread, profit, fee_rate: feeRate,
    confidence: Math.min(netSpread / 0.06, 1), midPrice: (bestBid + bestAsk) / 2,
    legs: [{ token: m.token_yes, side: 'BUY', price: buyPrice, size }, { token: m.token_yes, side: 'SELL', price: sellPrice, size }] };
}

// =============================================
// STRATEGY 4: Momentum (with balance/position checks)
// Buys on upward momentum if cash available; sells on downward momentum only if holding.
// =============================================
async function strategyMomentum(env: Env, m: any, db: D1Database, tradeSize: number, balance: number, mode: string, cache?: any): Promise<any|null> {
  if (!m.token_yes) return null;
  if (!m.token_yes) return null;
  const snaps = (await db.prepare('SELECT price_yes,recorded_at FROM price_snapshots WHERE condition_id=? ORDER BY recorded_at DESC LIMIT 10').bind(m.condition_id).all()).results as any[];
  if (snaps.length < 3) return null;
  const current = snaps[0]?.price_yes;
  const prev5 = snaps[Math.min(4, snaps.length - 1)]?.price_yes;
  if (!current || !prev5) return null;

  const change = current - prev5;
  const pctChange = Math.abs(change) / prev5;
  if (pctChange < 0.05) return null;

  const dollarBet = Math.min(tradeSize * 0.3, balance * 0.05); // Max 5% of balance for momentum
  if (dollarBet < 0.50) return null;

  if (change > 0) {
    // Upward momentum → BUY YES (needs cash)
    const price = cache?.askY ?? await getPrice(env, m.token_yes, 'BUY');
    if (price === null || price < 0.03 || price > 0.97) return null;
    if (balance < dollarBet) return null;
    const size = Math.min(dollarBet / price, 100);
    const feeRate = getFeeForCategory(m.topic);
    const fee = size * price * feeRate;
    const expectedProfit = size * pctChange * price - fee;
    if (expectedProfit < 0.01) return null;
    return { strategy: 'momentum', action: 'BUY_MOMENTUM', spread: pctChange, profit: expectedProfit,
      confidence: Math.min(pctChange / 0.1, 1), fee_rate: feeRate,
      advisory: `上涨${(pctChange*100).toFixed(1)}% (${prev5.toFixed(3)}→${current.toFixed(3)})`,
      legs: [{ token: m.token_yes, side: 'BUY', price, size }] };
  } else {
    // Downward momentum → SELL YES only if we hold it
    const position = mode === 'paper' ? await getPaperPosition(db, m.token_yes) : await getTokenPosition(env, m.token_yes);
    if (position < 1) return null;
    const price = cache?.bidY ?? await getPrice(env, m.token_yes, 'SELL');
    if (price === null || price < 0.03) return null;
    const size = Math.min(position, 100, dollarBet / price);
    if (size < 1) return null;
    const feeRate = getFeeForCategory(m.topic);
    const fee = size * price * feeRate;
    const expectedProfit = size * pctChange * price - fee;
    if (expectedProfit < 0.01) return null;
    return { strategy: 'momentum', action: 'SELL_MOMENTUM', spread: pctChange, profit: expectedProfit,
      confidence: Math.min(pctChange / 0.1, 1), fee_rate: feeRate,
      advisory: `下跌${(pctChange*100).toFixed(1)}%, 卖YES (持仓${position.toFixed(0)})`,
      legs: [{ token: m.token_yes, side: 'SELL', price, size }] };
  }
}