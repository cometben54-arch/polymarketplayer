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
  CRON_SECRET?: string;
}

// Verify the X-Cron-Secret header on trigger endpoints.
// Backward compatible: if CRON_SECRET is not configured, allow (current behavior).
// If configured, callers (CF cron worker / local bridge / external cron) must send it.
function cronAuthorized(c: any): boolean {
  const secret = c.env.CRON_SECRET;
  if (!secret) return true; // not configured → open (unchanged)
  return c.req.header('X-Cron-Secret') === secret;
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
// Query balance via multiple methods
async function getAccountBalance(env: Env): Promise<number> {
  const addr = env.POLYMARKET_FUNDER_ADDRESS;
  const signerAddr = env.POLYMARKET_PRIVATE_KEY ? getSignerAddress(env) : '';

  // Method 1: Try Polymarket Data API for portfolio value
  if (addr) {
    try {
      const dataUrl = (env.DATA_API_URL || 'https://data-api.polymarket.com').replace(/\/$/, '');
      const res = await fetch(`${dataUrl}/value?user=${addr}`);
      if (res.ok) {
        const d: any = await res.json();
        const val = parseFloat(d.value || d.portfolio_value || '0');
        if (val > 0) return val;
      }
    } catch {}
  }

  // Method 2: Query USDC.e on both funder and signer addresses
  const USDC_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const addresses = [addr, signerAddr].filter(a => a);
  const rpcs = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://1rpc.io/matic'];

  let totalBalance = 0;
  for (const checkAddr of addresses) {
    if (!checkAddr) continue;
    const data = '0x70a08231' + checkAddr.replace('0x', '').toLowerCase().padStart(64, '0');
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_ADDR, data }, 'latest'] }),
        });
        if (!res.ok) continue;
        const json: any = await res.json();
        if (json.result && json.result !== '0x') {
          const bal = Number(BigInt(json.result)) / 1e6;
          if (bal > 0) { totalBalance += bal; break; }
        }
      } catch {}
    }
  }

  // Method 3: Also check USDC (native, not bridged) contract
  if (totalBalance === 0) {
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    for (const checkAddr of addresses) {
      if (!checkAddr) continue;
      const data = '0x70a08231' + checkAddr.replace('0x', '').toLowerCase().padStart(64, '0');
      for (const rpc of rpcs) {
        try {
          const res = await fetch(rpc, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_NATIVE, data }, 'latest'] }),
          });
          if (!res.ok) continue;
          const json: any = await res.json();
          if (json.result && json.result !== '0x') {
            const bal = Number(BigInt(json.result)) / 1e6;
            if (bal > 0) { totalBalance += bal; break; }
          }
        } catch {}
      }
    }
  }

  return totalBalance;
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
// MARKET RISK RATING SYSTEM
// 🟢 SAFE: High confidence, data-driven, suitable for auto-trading
// 🟡 CAUTION: Moderate risk, reduced position sizing
// 🔴 DANGER: Do not auto-trade (blacklisted)
// =============================================
type RiskLevel = 'safe' | 'caution' | 'danger';

function rateMarketRisk(question: string, topic: string = ''): { level: RiskLevel; reason: string } {
  const q = (question || '').toLowerCase();
  const t = (topic || '').toLowerCase();

  // ========== 🔴 DANGER: Never auto-trade ==========

  // Political high-risk: elections, impeachment, regime change
  const dangerPolitical = ['election result', 'who will win', 'presidential winner', 'impeach', 'removed from office',
    'coup', 'regime change', 'overthrow', 'assassination', 'civil war'];
  for (const kw of dangerPolitical) if (q.includes(kw)) return { level: 'danger', reason: '政治高危' };

  // Geopolitical conflict: war, invasion, military action
  const dangerGeo = ['war break', 'invade', 'invasion of', 'military strike', 'nuclear launch', 'declare war',
    'armed conflict', 'border clash', 'diplomatic crisis'];
  for (const kw of dangerGeo) if (q.includes(kw)) return { level: 'danger', reason: '地缘冲突' };

  // Disaster: earthquake, tsunami, pandemic
  const dangerDisaster = ['earthquake above', 'tsunami', 'pandemic', 'outbreak', 'category 5', 'volcanic eruption',
    'plane crash', 'mass casualty'];
  for (const kw of dangerDisaster) if (q.includes(kw)) return { level: 'danger', reason: '灾难预测' };

  // Insider/emotion: crypto collapse, scandal, celebrity
  const dangerInsider = ['rug pull', 'ponzi', 'hack ', 'exploit ', 'scandal', 'arrest',
    'jail', 'prison', 'indicted', 'convicted', 'collapse of'];
  for (const kw of dangerInsider) if (q.includes(kw)) return { level: 'danger', reason: '内幕/情绪盘' };

  // Mystical/unpredictable: prophecy, aliens, far future
  const dangerMystic = ['jesus', 'alien', 'ufo', 'prophecy', 'end of the world', 'rapture',
    'before 2030', 'before 2035', 'in our lifetime'];
  for (const kw of dangerMystic) if (q.includes(kw)) return { level: 'danger', reason: '玄学/远期' };

  // ========== 🟡 CAUTION: Reduced sizing ==========

  // Political but not high-risk (nomination, approval rating)
  const cautionPolitical = ['nomination', 'approval rating', 'resign', 'step down', 'party leader',
    'primary win', 'debate winner'];
  for (const kw of cautionPolitical) if (q.includes(kw)) return { level: 'caution', reason: '政治相关' };

  // Sanctions, trade disputes
  const cautionGeo = ['sanction', 'tariff', 'trade deal', 'peace deal', 'ceasefire', 'treaty',
    'nuclear deal', 'diplomatic meeting'];
  for (const kw of cautionGeo) if (q.includes(kw)) return { level: 'caution', reason: '地缘外交' };

  // Crypto price (volatile)
  const cautionCrypto = ['bitcoin', 'btc', 'ethereum', 'eth ', 'solana', 'crypto price',
    'dip to', 'hit $', 'above $', 'below $'];
  for (const kw of cautionCrypto) if (q.includes(kw)) return { level: 'caution', reason: '加密货币' };

  // GTA VI / entertainment speculation
  if (q.includes('gta vi') || q.includes('gta 6')) return { level: 'caution', reason: '娱乐猜测' };

  // ========== 🟢 SAFE: Best for auto-trading ==========

  // Macro economics: CPI, jobs, GDP, interest rate
  const safeEcon = ['cpi ', 'inflation rate', 'nonfarm', 'non-farm', 'unemployment rate', 'gdp ',
    'interest rate', 'fed rate', 'fomc', 'jobs report', 'pce '];
  for (const kw of safeEcon) if (q.includes(kw)) return { level: 'safe', reason: '宏观经济数据' };

  // Corporate earnings
  const safeEarnings = ['earnings', 'revenue', 'quarterly report', 'net income', 'profit margin',
    'eps ', 'beat expectations', 'miss expectations', 'guidance'];
  for (const kw of safeEarnings) if (q.includes(kw)) return { level: 'safe', reason: '企业财报' };

  // Weather (data-driven)
  const safeWeather = ['temperature', 'high of', 'low of', 'rain', 'snow', 'inches of',
    'precipitation', 'forecast', '°f', '°c', 'weather'];
  for (const kw of safeWeather) if (q.includes(kw)) return { level: 'safe', reason: '天气预报' };

  // Tech product release
  const safeTech = ['release date', 'launch date', 'version ', 'update ', 'ios ',
    'android ', 'announced', 'product launch'];
  for (const kw of safeTech) if (q.includes(kw)) return { level: 'safe', reason: '科技产品' };

  // Entertainment fixed events
  const safeEntertain = ['box office', 'opening weekend', 'premiere date', 'album release',
    'concert', 'award winner', 'grammy', 'oscar', 'emmy', 'nominated'];
  for (const kw of safeEntertain) if (q.includes(kw)) return { level: 'safe', reason: '影视文娱' };

  // Sports (predictable categories)
  if (t.includes('sport') || q.includes('stanley cup') || q.includes('nba finals') ||
      q.includes('world series') || q.includes('super bowl'))
    return { level: 'safe', reason: '体育赛事' };

  // Default: caution for unknown
  return { level: 'caution', reason: '未分类' };
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

  // Pre-filter: skip danger-rated markets (they'll be filtered out in risk check anyway)
  const risk = rateMarketRisk(m.question || '', m.topic || '');
  if (risk.level === 'danger') return null;

  // Adaptive AI cache: extend TTL when price is stable or last AI signal was weak
  const cacheKey = 'ai_prob_' + m.condition_id.slice(0, 16);
  const cached = await getState(db, cacheKey);
  const now = Math.floor(Date.now() / 1000);
  let aiProb: number | null = null;
  let aiReasoning = '';

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // Adaptive TTL based on price stability and signal strength
      const lastDeviation = parsed.prob !== undefined ? Math.abs(parsed.prob - marketPrice) : 1;
      const priceMoved = parsed.lastMarketPrice !== undefined ? Math.abs(marketPrice - parsed.lastMarketPrice) : 1;
      let cacheTTL: number;
      if (priceMoved < 0.03 && lastDeviation < 0.10) {
        cacheTTL = 21600; // 6 hours - no signal, price stable
      } else if (priceMoved < 0.05) {
        cacheTTL = 14400; // 4 hours - price relatively stable
      } else {
        cacheTTL = 3600;  // 1 hour - notable movement, check sooner
      }
      if (now - parsed.ts < cacheTTL) {
        aiProb = parsed.prob;
        aiReasoning = parsed.reasoning;
      }
    } catch {}
  }

  if (aiProb === null) {
    // Fetch AI probability analysis (use fast/cheap model to reduce cost)
    const aiKey = await getSetting(db, 'AI_API_KEY');
    if (!aiKey) return null;
    const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
    const aiModel = await getSetting(db, 'AI_MODEL_FAST', '') || await getSetting(db, 'AI_MODEL', 'gpt-4o-mini');
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
      await setState(db, cacheKey, JSON.stringify({ prob: aiProb, reasoning: aiReasoning, ts: now, lastMarketPrice: marketPrice }));
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

// =============================================
// STRATEGY 5: Logical / Dutch Book Arbitrage
// Detect pricing contradictions between related markets.
// E.g. "Team A wins conference" at 24% but "Team A wins championship" at 28%
// is a contradiction since winning championship implies winning conference.
// Uses AI to find logical relationships, then checks price consistency.
// =============================================
async function strategyLogical(env: Env, allMarkets: any[], db: D1Database, tradeSize: number, balance: number, mode: string): Promise<any[]> {
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
        // Only trade if we have enough cash to buy the underpriced side
        const dollarBet = Math.min(tradeSize * 0.3, balance * 0.05);
        if (dollarBet < 0.50) continue;
        if (balance < dollarBet) continue;
        if (buyMarket.price_yes < 0.03 || buyMarket.price_yes > 0.97) continue;
        const size = Math.min(dollarBet / buyMarket.price_yes, 100);
        const feeRate = getFeeForCategory(buyMarket.topic);
        const fee = size * buyMarket.price_yes * feeRate;
        const netProfit = size * spread - fee;
        if (netProfit < 0.01) continue;

        opps.push({
          strategy: 'logical', action: 'BUY_UNDERPRICED',
          spread, profit: netProfit,
          confidence: Math.min(spread / 0.15, 1),
          market: buyMarket.question.slice(0, 40) + ' vs ' + sellMarket.question.slice(0, 40),
          condition_id: buyMarket.condition_id,
          advisory: `买低估: "${buyMarket.question.slice(0, 25)}" @${(buyMarket.price_yes*100).toFixed(0)}% (对比 "${sellMarket.question.slice(0, 20)}" @${(sellMarket.price_yes*100).toFixed(0)}%)`,
          legs: [{ token: buyMarket.token_yes, side: 'BUY', price: buyMarket.price_yes, size }],
        });
      }
    }
  }

  return opps;
}

// AI-enhanced logical arbitrage: uses AI to find deeper logical relationships
async function strategyLogicalAI(env: Env, allMarkets: any[], db: D1Database, tradeSize: number, balance: number, mode: string): Promise<any[]> {
  // Only run AI check once per 4 hours (expensive, relationships change slowly)
  const lastAILogical = await getState(db, 'last_ai_logical');
  const now = Math.floor(Date.now() / 1000);
  if (lastAILogical && now - parseInt(lastAILogical) < 14400) return [];

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
- 如果事件有时间范围包含关系（如“6月前” vs “12月前”），较短期限的概率应≤较长期限

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
      // Check balance before trading
      const dollarBet = Math.min(tradeSize * 0.3, balance * 0.05);
      if (dollarBet < 0.50 || balance < dollarBet) continue;
      if (buy.price < 0.03 || buy.price > 0.97) continue;
      const size = Math.min(dollarBet / buy.price, 100);
      const feeRate = getFeeForCategory(buy.topic);
      const fee = size * buy.price * feeRate;
      const netProfit = size * spread - fee;
      if (netProfit < 0.01) continue;

      opps.push({
        strategy: 'logical', action: 'AI_BUY_UNDERPRICED', spread, profit: netProfit,
        confidence: pair.confidence || 0.8,
        market: buy.question.slice(0, 30) + ' vs ' + sell.question.slice(0, 30),
        condition_id: buy.condition_id,
        advisory: `AI发现矛盾(${pair.reason}): 买 "${buy.question.slice(0,20)}" @${(buy.price*100).toFixed(0)}%`,
        legs: [{ token: buy.token_yes, side: 'BUY', price: buy.price, size }],
      });

      await addAlert(db, 'info', `[逻辑套利] AI发现矛盾: "${buy.question.slice(0, 25)}" vs "${sell.question.slice(0, 25)}" | ${pair.reason}`);
    }
    return opps;
  } catch { return []; }
}

// =============================================
// STRATEGY 6: Weather Forecast Arbitrage
// Compare Open-Meteo weather forecasts with Polymarket weather market prices.
// When forecast disagrees with market by >5%, bet on the forecast.
// Weather forecasts 1-2 days out are ~90% accurate.
// =============================================

// Location coordinates for weather markets
const WEATHER_LOCATIONS: Record<string, { lat: number; lon: number }> = {
  'new york': { lat: 40.71, lon: -74.01 }, 'nyc': { lat: 40.71, lon: -74.01 },
  'london': { lat: 51.51, lon: -0.13 }, 'los angeles': { lat: 34.05, lon: -118.24 },
  'chicago': { lat: 41.88, lon: -87.63 }, 'miami': { lat: 25.76, lon: -80.19 },
  'tokyo': { lat: 35.68, lon: 139.69 }, 'seoul': { lat: 37.57, lon: 126.98 },
  'paris': { lat: 48.86, lon: 2.35 }, 'berlin': { lat: 52.52, lon: 13.41 },
  'sydney': { lat: -33.87, lon: 151.21 }, 'dubai': { lat: 25.20, lon: 55.27 },
  'singapore': { lat: 1.35, lon: 103.82 }, 'mumbai': { lat: 19.08, lon: 72.88 },
  'toronto': { lat: 43.65, lon: -79.38 }, 'dallas': { lat: 32.78, lon: -96.80 },
  'houston': { lat: 29.76, lon: -95.37 }, 'phoenix': { lat: 33.45, lon: -112.07 },
  'denver': { lat: 39.74, lon: -104.99 }, 'atlanta': { lat: 33.75, lon: -84.39 },
  'san francisco': { lat: 37.77, lon: -122.42 }, 'seattle': { lat: 47.61, lon: -122.33 },
  'boston': { lat: 42.36, lon: -71.06 }, 'washington': { lat: 38.91, lon: -77.04 },
  'dc': { lat: 38.91, lon: -77.04 },
};

function extractWeatherInfo(question: string): { location: string; type: 'temp_high' | 'temp_low' | 'rain' | 'snow' | null; threshold: number | null; date: string | null; coords: { lat: number; lon: number } | null } {
  const q = question.toLowerCase();
  let location = '', coords = null;
  for (const [name, c] of Object.entries(WEATHER_LOCATIONS)) {
    if (q.includes(name)) { location = name; coords = c; break; }
  }
  if (!coords) return { location: '', type: null, threshold: null, date: null, coords: null };

  let type: 'temp_high' | 'temp_low' | 'rain' | 'snow' | null = null;
  if (q.includes('high') || q.includes('above') || q.includes('over') || q.includes('reach')) type = 'temp_high';
  else if (q.includes('low') || q.includes('below') || q.includes('under') || q.includes('drop')) type = 'temp_low';
  else if (q.includes('rain') || q.includes('precipitation') || q.includes('inch')) type = 'rain';
  else if (q.includes('snow')) type = 'snow';

  // Extract temperature threshold (e.g. "above 80°F", "reach 90")
  const tempMatch = q.match(/(\d+)\s*°?\s*f/i) || q.match(/(above|over|reach|exceed|below|under|drop)\s+(\d+)/i);
  const threshold = tempMatch ? parseInt(tempMatch[2] || tempMatch[1]) : null;

  // Extract date
  const dateMatch = q.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})/i);
  const date = dateMatch ? dateMatch[0] : null;

  return { location, type, threshold, date, coords };
}

async function strategyWeather(env: Env, m: any, db: D1Database, tradeSize: number, balance: number, mode: string, cache?: any): Promise<any|null> {
  // Only applies to weather-related markets
  const q = (m.question || '').toLowerCase();
  if (!q.includes('temperature') && !q.includes('weather') && !q.includes('rain') && !q.includes('snow') && !q.includes('°f') && !q.includes('high') && !q.includes('forecast')) return null;

  const info = extractWeatherInfo(m.question);
  if (!info.coords || !info.type || info.threshold === null) return null;
  if (!m.token_yes) return null;

  const marketPrice = cache?.mid ?? await getMidpoint(env, m.token_yes);
  if (marketPrice === null || marketPrice < 0.03 || marketPrice > 0.97) return null;

  // Rate limit weather API: once per market per hour
  const cacheKey = 'weather_' + m.condition_id.slice(0, 16);
  const cached_wx = await getState(db, cacheKey);
  const now = Math.floor(Date.now() / 1000);
  let forecastProb: number | null = null;

  if (cached_wx) {
    try { const p = JSON.parse(cached_wx); if (now - p.ts < 3600) forecastProb = p.prob; } catch {}
  }

  if (forecastProb === null) {
    try {
      // Fetch 7-day forecast from Open-Meteo (free, no API key needed)
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${info.coords.lat}&longitude=${info.coords.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum&temperature_unit=fahrenheit&forecast_days=7&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const wx: any = await res.json();

      if (wx.daily) {
        // Calculate probability based on forecast
        if (info.type === 'temp_high' && info.threshold && wx.daily.temperature_2m_max) {
          const maxTemps: number[] = wx.daily.temperature_2m_max;
          const daysAbove = maxTemps.filter(t => t >= info.threshold!).length;
          forecastProb = daysAbove / maxTemps.length;
        } else if (info.type === 'temp_low' && info.threshold && wx.daily.temperature_2m_min) {
          const minTemps: number[] = wx.daily.temperature_2m_min;
          const daysBelow = minTemps.filter(t => t <= info.threshold!).length;
          forecastProb = daysBelow / minTemps.length;
        } else if (info.type === 'rain' && wx.daily.precipitation_sum) {
          const rainDays = wx.daily.precipitation_sum.filter((p: number) => p > 0.5).length;
          forecastProb = rainDays / wx.daily.precipitation_sum.length;
        } else if (info.type === 'snow' && wx.daily.snowfall_sum) {
          const snowDays = wx.daily.snowfall_sum.filter((s: number) => s > 0.1).length;
          forecastProb = snowDays / wx.daily.snowfall_sum.length;
        }
      }

      if (forecastProb !== null) {
        await setState(db, cacheKey, JSON.stringify({ prob: forecastProb, ts: now }));
      }
    } catch { return null; }
  }

  if (forecastProb === null) return null;

  // Need >5% deviation between forecast and market to trade
  const deviation = forecastProb - marketPrice;
  if (Math.abs(deviation) < 0.05) return null;

  const feeRate = getFeeForCategory(m.topic);
  const dollarBet = Math.min(tradeSize, balance * 0.08);
  if (dollarBet < 0.50) return null;

  if (deviation > 0) {
    // Forecast says more likely than market → BUY YES
    const price = cache?.askY ?? await getPrice(env, m.token_yes, 'BUY');
    if (price === null || price < 0.03 || price > 0.97) return null;
    if (balance < dollarBet) return null;
    const size = Math.min(dollarBet / price, 100);
    const fee = size * price * feeRate;
    const expectedProfit = size * Math.abs(deviation) - fee;
    if (expectedProfit < 0.005) return null;
    return { strategy: 'weather', action: 'BUY_YES_WEATHER', spread: Math.abs(deviation), profit: expectedProfit,
      confidence: Math.min(Math.abs(deviation) / 0.1, 1), fee_rate: feeRate,
      advisory: `天气预报${(forecastProb*100).toFixed(0)}% > 市场${(marketPrice*100).toFixed(0)}% | ${info.location} ${info.type}>${info.threshold}`,
      legs: [{ token: m.token_yes, side: 'BUY', price, size }] };
  } else {
    // Forecast says less likely → BUY NO
    if (!m.token_no) return null;
    const price = cache?.askN ?? await getPrice(env, m.token_no, 'BUY');
    if (price === null || price < 0.03 || price > 0.97) return null;
    if (balance < dollarBet) return null;
    const size = Math.min(dollarBet / price, 100);
    const fee = size * price * feeRate;
    const expectedProfit = size * Math.abs(deviation) - fee;
    if (expectedProfit < 0.005) return null;
    return { strategy: 'weather', action: 'BUY_NO_WEATHER', spread: Math.abs(deviation), profit: expectedProfit,
      confidence: Math.min(Math.abs(deviation) / 0.1, 1), fee_rate: feeRate,
      advisory: `天气预报${(forecastProb*100).toFixed(0)}% < 市场${(marketPrice*100).toFixed(0)}% | ${info.location} ${info.type}<${info.threshold}`,
      legs: [{ token: m.token_no, side: 'BUY', price, size }] };
  }
}

// =============================================
// STRATEGY 7: Nothing-Ever-Happens No-Bot
// Auto-buy NO on non-sports markets where NO price ≤ $0.65.
// Based on the statistical bias that people overestimate dramatic outcomes.
// Win rate ~73%, annual return 16-33%.
// =============================================
async function strategyNoBot(env: Env, m: any, tradeSize: number, balance: number, cache?: any): Promise<any|null> {
  if (!m.token_no) return null;

  // Skip sports markets only (no-bot doesn't work on sports outcomes)
  const topic = (m.topic || '').toLowerCase();
  if (topic.includes('sport') || topic.includes('nba') || topic.includes('nfl') || topic.includes('mlb') || topic.includes('nhl')) return null;

  // Skip crypto short-term markets (too volatile)
  const q = (m.question || '').toLowerCase();
  if (q.includes('5-min') || q.includes('15-min') || q.includes('minute')) return null;

  // Skip danger-rated markets
  const risk = rateMarketRisk(m.question || '', m.topic || '');
  if (risk.level === 'danger') return null;

  // Get NO price
  const priceNo = cache?.askN ?? await getPrice(env, m.token_no, 'BUY');
  if (priceNo === null) return null;

  // EXPANDED range: buy NO when price is 5¢ to 80¢ (was 5¢-65¢)
  // 80¢ NO = 20¢ YES = market thinks 20% chance event happens
  // "Nothing happens" wins 73% of the time for non-sports
  if (priceNo > 0.80) return null;
  if (priceNo < 0.05) return null;

  const feeRate = getFeeForCategory(m.topic);
  // Position sizing: 2-4% of balance, scaled by confidence
  const betPct = priceNo < 0.50 ? 0.04 : 0.02; // Cheaper NO = more confident = bigger bet
  const dollarBet = Math.min(tradeSize, balance * betPct);
  if (dollarBet < 0.20) return null;

  const size = Math.min(dollarBet / priceNo, 100);
  const fee = size * priceNo * feeRate;
  const estimatedWinRate = priceNo < 0.50 ? 0.78 : 0.68; // Cheaper NO = higher win rate
  const expectedProfit = size * ((1 - priceNo) * estimatedWinRate - priceNo * (1 - estimatedWinRate)) - fee;
  if (expectedProfit < 0.001) return null; // Any positive EV is good

  return { strategy: 'nobot', action: 'BUY_NO', spread: 1 - priceNo, profit: expectedProfit,
    confidence: Math.min((0.80 - priceNo) / 0.4, 1), fee_rate: feeRate,
    advisory: `No-Bot: NO@${(priceNo*100).toFixed(1)}¢ EV$${expectedProfit.toFixed(3)} | ${risk.reason} | ${(estimatedWinRate*100).toFixed(0)}%胜`,
    legs: [{ token: m.token_no, side: 'BUY', price: priceNo, size }] };
}

// =============================================
// STRATEGY 8: 4-Hour Pre-Settlement Positive EV
// Buy YES when price is 0.55-0.85 within 4 hours of settlement.
// At this point, the market has strong signal but hasn't fully priced in.
// Expected win rate ~65-80%, positive expected value.
// Hold to settlement (no early exit).
// =============================================
async function strategyPreSettlement(env: Env, m: any, db: D1Database, tradeSize: number, balance: number, cache?: any): Promise<any|null> {
  if (!m.token_yes) return null;

  // Skip sports (too unpredictable at close) — keep elections, economics, geopolitics
  const topic = (m.topic || '').toLowerCase();
  if (topic.includes('sport') || topic.includes('nba') || topic.includes('nfl') || topic.includes('mlb') || topic.includes('nhl')) return null;

  // Check if market is close to settlement (within 4 hours)
  // We detect this by checking if the market end_date is within 4 hours
  // Since we don't have end_date in DB, check via Gamma API (cached per hour)
  const cacheKey = 'settle_' + m.condition_id.slice(0, 16);
  const cachedInfo = await getState(db, cacheKey);
  const now = Math.floor(Date.now() / 1000);
  let endTime: number | null = null;
  let hasLiquidity = false;

  if (cachedInfo) {
    try {
      const p = JSON.parse(cachedInfo);
      if (now - p.ts < 3600) { endTime = p.end; hasLiquidity = p.liq; }
    } catch {}
  }

  if (endTime === null) {
    try {
      const gamma = await fetch(`${GAMMA(env)}/markets?condition_ids=${m.condition_id}`);
      if (gamma.ok) {
        const gm: any[] = await gamma.json();
        if (gm.length > 0) {
          const g = gm[0];
          // Parse end date
          const endStr = g.endDate || g.end_date_iso || g.game_start_time || '';
          if (endStr) {
            endTime = Math.floor(new Date(endStr).getTime() / 1000);
          }
          // Check volume/liquidity
          const vol = parseFloat(g.volume || g.volumeNum || '0');
          hasLiquidity = vol > 10000; // >$10k volume
          await setState(db, cacheKey, JSON.stringify({ end: endTime, liq: hasLiquidity, ts: now }));
        }
      }
    } catch {}
  }

  // Must be within 4 hours of settlement
  if (!endTime) return null;
  const hoursToEnd = (endTime - now) / 3600;
  if (hoursToEnd < 0 || hoursToEnd > 4) return null;

  // Must have sufficient liquidity (>$10k volume)
  if (!hasLiquidity) return null;

  // Get YES price
  const priceYes = cache?.askY ?? await getPrice(env, m.token_yes, 'BUY');
  if (priceYes === null) return null;

  // Price must be in the sweet spot: 0.55 - 0.85
  if (priceYes < 0.55 || priceYes > 0.85) return null;

  // Position sizing: 2-5% of balance
  const feeRate = getFeeForCategory(m.topic);
  const betPct = 0.03; // 3% of balance
  const dollarBet = Math.min(tradeSize, balance * betPct);
  if (dollarBet < 0.50) return null;
  if (balance < dollarBet) return null;

  const size = Math.min(dollarBet / priceYes, 100);
  const fee = size * priceYes * feeRate;

  // Expected value: if YES wins (prob ~= price), profit = size * (1 - priceYes) - fee
  // We buy because at 4h before settlement, prices 0.55-0.85 tend to resolve YES ~70% of the time
  // (markets are efficient but slightly underpriced close to resolution)
  const estimatedWinRate = 0.70;
  const expectedProfit = size * ((1 - priceYes) * estimatedWinRate - priceYes * (1 - estimatedWinRate)) - fee;
  if (expectedProfit < 0.005) return null;

  return {
    strategy: 'pre_settle', action: 'BUY_YES_4H',
    spread: 1 - priceYes, profit: expectedProfit,
    confidence: Math.min((0.85 - priceYes) / 0.3 + hoursToEnd / 4, 1),
    fee_rate: feeRate,
    advisory: `结算前${hoursToEnd.toFixed(1)}h | YES@${(priceYes*100).toFixed(1)}¢ | 预期${(estimatedWinRate*100).toFixed(0)}%胜率`,
    legs: [{ token: m.token_yes, side: 'BUY', price: priceYes, size }],
  };
}

// =============================================
// STRATEGY 9: World Cup Knockout Max-ROI
// Bet only on knockout-stage markets that show a real edge vs de-vigged
// bookmaker odds. Maker-only (never crosses the ask). Three sub-strategies:
//   A. Advancement (晋级盘):  52–72%, edge ≥ 3%,    stake $2–5
//   B. Strong-vs-strong draw (平局): draw 24–29%, fav 90' win <50%,
//      win-margin <22%, edge ≥ 3%,                stake $2–5
//   C. 90' favorite win:      52–61%, draw <25%,
//      win-margin >28%, edge ≥ 3.5%,              stake $2–4
// Single primary position per match, max $5. No edge → No Bet.
// =============================================

// De-vig a 3-way (home / draw / away) market into true probabilities.
// Removes the bookmaker overround so the three probs sum to 1.
function devigThreeWay(homeOdds: number, drawOdds: number, awayOdds: number): { home: number; draw: number; away: number } | null {
  if (!(homeOdds > 1) || !(drawOdds > 1) || !(awayOdds > 1)) return null;
  const rH = 1 / homeOdds, rD = 1 / drawOdds, rA = 1 / awayOdds;
  const overround = rH + rD + rA;
  if (overround <= 0) return null;
  return { home: rH / overround, draw: rD / overround, away: rA / overround };
}

// Normalize a team / country name for fuzzy matching against question text.
function normalizeTeam(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\b(fc|national team|football|soccer)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common country aliases so Polymarket phrasing matches bookmaker naming.
const TEAM_ALIASES: Record<string, string[]> = {
  'usa': ['united states', 'us', 'usmnt', 'america'],
  'south korea': ['korea republic', 'korea'],
  'iran': ['ir iran'],
  'ivory coast': ["cote d'ivoire", 'cote divoire'],
  'czechia': ['czech republic'],
};
function teamInText(team: string, text: string): boolean {
  return teamIndexInText(team, text) >= 0;
}
// Index of the first occurrence of a team (or alias) in text; -1 if absent.
function teamIndexInText(team: string, text: string): number {
  const t = normalizeTeam(team);
  let idx = t ? text.indexOf(t) : -1;
  for (const [canon, aliases] of Object.entries(TEAM_ALIASES)) {
    if (t === canon || aliases.includes(t)) {
      const candidates = [canon, ...aliases];
      for (const c of candidates) {
        const i = text.indexOf(c);
        if (i >= 0 && (idx < 0 || i < idx)) idx = i;
      }
    }
  }
  return idx;
}

// Fetch + cache de-vigged World Cup match probabilities from The Odds API.
// Cached for 6h in bot_state (knockout odds move slowly >18h out, and the
// free tier is request-limited). Returns [] when no key / no data.
async function fetchWorldCupOdds(env: Env, db: D1Database): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const cached = await getState(db, 'worldcup_odds');
  if (cached) {
    try { const p = JSON.parse(cached); if (now - p.ts < 21600 && Array.isArray(p.games)) return p.games; } catch {}
  }
  const apiKey = await getSetting(db, 'WORLDCUP_ODDS_API_KEY');
  if (!apiKey) return [];
  const sportKey = await getSetting(db, 'WORLDCUP_SPORT_KEY', 'soccer_fifa_world_cup');
  const regions = await getSetting(db, 'WORLDCUP_ODDS_REGIONS', 'us,uk,eu');
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=${regions}&markets=h2h&oddsFormat=decimal`;
    const res = await fetch(url);
    if (!res.ok) {
      await addAlert(db, 'warning', `世界杯赔率拉取失败 HTTP ${res.status}（检查 WORLDCUP_ODDS_API_KEY / sport key）`);
      return [];
    }
    const data: any[] = await res.json();
    const games: any[] = [];
    for (const g of data) {
      const home = g.home_team, away = g.away_team;
      if (!home || !away) continue;
      // Average de-vigged probs across all bookmakers for stability.
      let sH = 0, sD = 0, sA = 0, n = 0;
      for (const bk of g.bookmakers || []) {
        const mkt = (bk.markets || []).find((x: any) => x.key === 'h2h');
        if (!mkt) continue;
        const oc = mkt.outcomes || [];
        const oHome = oc.find((o: any) => o.name === home)?.price;
        const oAway = oc.find((o: any) => o.name === away)?.price;
        const oDraw = oc.find((o: any) => o.name === 'Draw' || o.name === 'Tie')?.price;
        const dv = devigThreeWay(oHome, oDraw, oAway);
        if (dv) { sH += dv.home; sD += dv.draw; sA += dv.away; n++; }
      }
      if (n === 0) continue;
      const commence = g.commence_time ? Math.floor(new Date(g.commence_time).getTime() / 1000) : null;
      games.push({ home, away, p_home: sH / n, p_draw: sD / n, p_away: sA / n, books: n, commence });
    }
    await setState(db, 'worldcup_odds', JSON.stringify({ ts: now, games }));
    return games;
  } catch (e: any) {
    await addAlert(db, 'warning', `世界杯赔率异常: ${(e.message || String(e)).slice(0, 120)}`);
    return [];
  }
}

// Classify a Polymarket knockout market from its question text.
// Returns the market type and which side (home/away) the YES token backs.
function classifyWorldCupMarket(question: string, game: any): { type: 'advance' | 'draw' | 'win90'; side: 'home' | 'away' | null } | null {
  const q = normalizeTeam(question);
  const isHome = teamInText(game.home, q);
  const isAway = teamInText(game.away, q);

  // Draw / tie market (no single team backed)
  if (/\b(draw|tie|drawn)\b/.test(q) && !/\b(win|beat|advance)\b/.test(q)) {
    return { type: 'draw', side: null };
  }
  // Advancement market (includes extra time / penalties)
  if (/\b(advance|advances|progress|qualify|reach|win the tie|go through)\b/.test(q)) {
    if (isHome && !isAway) return { type: 'advance', side: 'home' };
    if (isAway && !isHome) return { type: 'advance', side: 'away' };
    if (isHome) return { type: 'advance', side: 'home' };
    if (isAway) return { type: 'advance', side: 'away' };
    return null;
  }
  // 90-minute / regulation result market
  if (/\b(win|beat|defeat|wins|in 90|regulation|full time|90 minutes)\b/.test(q)) {
    if (isHome && !isAway) return { type: 'win90', side: 'home' };
    if (isAway && !isHome) return { type: 'win90', side: 'away' };
    // Both teams named, e.g. "Will France beat Canada?" — YES backs the subject
    // (the team named before the "beat/defeat/win against" verb).
    if (isHome && isAway) {
      const beatMatch = /\b(beat|beats|defeat|defeats|win against|wins against|to beat|over)\b/.exec(q);
      const hIdx = teamIndexInText(game.home, q);
      const aIdx = teamIndexInText(game.away, q);
      if (beatMatch) {
        // Subject is the team appearing before the verb.
        const verbIdx = beatMatch.index;
        const homeBefore = hIdx >= 0 && hIdx < verbIdx;
        const awayBefore = aIdx >= 0 && aIdx < verbIdx;
        if (homeBefore && !awayBefore) return { type: 'win90', side: 'home' };
        if (awayBefore && !homeBefore) return { type: 'win90', side: 'away' };
      }
      // Fallback: "Will A win vs B?" / "A vs B" → first-named team is the subject.
      if (hIdx >= 0 && aIdx >= 0) return { type: 'win90', side: hIdx < aIdx ? 'home' : 'away' };
    }
  }
  return null;
}

async function strategyWorldCup(env: Env, m: any, db: D1Database, tradeSize: number, balance: number, games: any[], cache?: any): Promise<any|null> {
  if (!m.token_yes || !games.length) return null;
  const q = (m.question || '').toLowerCase();
  // Quick reject: must look soccer/knockout-ish
  if (!/(world cup|wc|advance|vs\.?|beat|win|draw|round of|quarter|semi|final)/.test(q)) return null;

  // Find the match these markets belong to
  const qn = normalizeTeam(m.question || '');
  const game = games.find(g => teamInText(g.home, qn) && teamInText(g.away, qn));
  if (!game) return null;

  // Only act 18–30h before kickoff
  if (game.commence) {
    const hoursToKick = (game.commence - Math.floor(Date.now() / 1000)) / 3600;
    if (hoursToKick < 18 || hoursToKick > 30) return null;
  }

  const cls = classifyWorldCupMarket(m.question || '', game);
  if (!cls) return null;

  // Single primary position per match: skip if we already hold a WC bet on this market
  const existing = await db.prepare(
    "SELECT COUNT(*) as n FROM trades WHERE condition_id=? AND strategy='worldcup' AND status IN ('filled','submitted')"
  ).bind(m.condition_id).first<{n:number}>();
  if (existing && existing.n > 0) return null;

  // External (de-vigged) probability for THIS market's YES outcome
  const favWin90 = Math.max(game.p_home, game.p_away);       // favorite 90' win prob
  const winMargin = Math.abs(game.p_home - game.p_away);     // strength gap
  let extProb: number;
  let label: string;
  if (cls.type === 'advance') {
    // Approx advancement = 90' win + half of draw (ET/pens ~50/50). Documented approximation.
    const win90 = cls.side === 'home' ? game.p_home : game.p_away;
    extProb = win90 + 0.5 * game.p_draw;
    label = `晋级`;
  } else if (cls.type === 'draw') {
    extProb = game.p_draw;
    label = `平局`;
  } else {
    extProb = cls.side === 'home' ? game.p_home : game.p_away;
    label = `90'胜`;
  }

  // Polymarket ask for the YES token (the price we'd pay if we crossed)
  const ask = cache?.askY ?? await getPrice(env, m.token_yes, 'BUY');
  const bid = cache?.bidY ?? await getPrice(env, m.token_yes, 'SELL');
  if (ask === null || ask < 0.02 || ask > 0.98) return null;

  const edge = extProb - ask;  // positive = external thinks YES underpriced

  // --- Sub-strategy gating ---
  let stake = 0;
  const W = await getWorldCupParams(db);
  if (cls.type === 'advance') {
    // A. Advancement: ask 52–72%, edge ≥ 3%
    if (ask < W.adv_lo || ask > W.adv_hi) return null;
    if (edge < W.adv_edge) return null;
    stake = W.adv_stake_lo + (W.adv_stake_hi - W.adv_stake_lo) * Math.min(edge / 0.06, 1);
  } else if (cls.type === 'draw') {
    // B. Strong-vs-strong draw: draw ask 24–29%, fav 90' win <50%, margin <22%, edge ≥ 3%
    if (ask < W.draw_lo || ask > W.draw_hi) return null;
    if (favWin90 >= W.draw_fav_max) return null;
    if (winMargin >= W.draw_margin_max) return null;
    if (edge < W.draw_edge) return null;
    stake = W.draw_stake_lo + (W.draw_stake_hi - W.draw_stake_lo) * Math.min(edge / 0.06, 1);
  } else {
    // C. 90' favorite win: ask 52–61%, draw <25%, margin >28%, edge ≥ 3.5%
    if (ask < W.win_lo || ask > W.win_hi) return null;
    if (game.p_draw >= W.win_draw_max) return null;
    if (winMargin <= W.win_margin_min) return null;
    if (edge < W.win_edge) return null;
    stake = W.win_stake_lo + (W.win_stake_hi - W.win_stake_lo) * Math.min((edge - W.win_edge) / 0.04, 1);
  }

  // Cap stake to the per-match max and available balance
  stake = Math.min(stake, W.max_stake, tradeSize, balance);
  if (stake < W.adv_stake_lo - 0.001 && stake < 1.5) return null;
  if (balance < stake) return null;

  // MAKER price: rest below the ask. Use bid + 1 tick if it stays under ask,
  // else ask - 1 tick. Never cross the spread.
  const tick = 0.01;
  let makerPrice: number;
  if (bid !== null && bid + tick < ask) makerPrice = Math.round((bid + tick) * 100) / 100;
  else makerPrice = Math.round((ask - tick) * 100) / 100;
  if (makerPrice < 0.02) makerPrice = 0.02;
  if (makerPrice >= ask) return null; // safety: must remain maker

  const size = Math.min(stake / makerPrice, 200);
  if (size < 1) return null;

  // Maker fee is 0% on Polymarket. Profit estimate = edge captured on size.
  const expectedProfit = size * edge;

  return {
    strategy: 'worldcup', action: `WC_${cls.type.toUpperCase()}${cls.side ? '_' + cls.side.toUpperCase() : ''}`,
    spread: edge, profit: expectedProfit,
    confidence: Math.min(edge / 0.06, 1), fee_rate: 0, maker: true,
    advisory: `世界杯[${label}] ${game.home} vs ${game.away} | 外部${(extProb*100).toFixed(1)}% vs 市场ask${(ask*100).toFixed(1)}% | edge ${(edge*100).toFixed(1)}% | 挂maker@${(makerPrice*100).toFixed(0)}¢ $${stake.toFixed(2)} (${game.books}家赔率)`,
    legs: [{ token: m.token_yes, side: 'BUY', price: makerPrice, size, maker: true }],
  };
}

// World Cup strategy parameters (overridable via settings; defaults match spec).
async function getWorldCupParams(db: D1Database) {
  const num = async (k: string, d: number) => parseFloat(await getSetting(db, k, String(d))) || d;
  return {
    // A. advancement
    adv_lo: await num('WC_ADV_LO', 0.52), adv_hi: await num('WC_ADV_HI', 0.72),
    adv_edge: await num('WC_ADV_EDGE', 0.03), adv_stake_lo: await num('WC_ADV_STAKE_LO', 2), adv_stake_hi: await num('WC_ADV_STAKE_HI', 5),
    // B. draw
    draw_lo: await num('WC_DRAW_LO', 0.24), draw_hi: await num('WC_DRAW_HI', 0.29),
    draw_fav_max: await num('WC_DRAW_FAV_MAX', 0.50), draw_margin_max: await num('WC_DRAW_MARGIN_MAX', 0.22),
    draw_edge: await num('WC_DRAW_EDGE', 0.03), draw_stake_lo: await num('WC_DRAW_STAKE_LO', 2), draw_stake_hi: await num('WC_DRAW_STAKE_HI', 5),
    // C. 90' favorite win
    win_lo: await num('WC_WIN_LO', 0.52), win_hi: await num('WC_WIN_HI', 0.61),
    win_draw_max: await num('WC_WIN_DRAW_MAX', 0.25), win_margin_min: await num('WC_WIN_MARGIN_MIN', 0.28),
    win_edge: await num('WC_WIN_EDGE', 0.035), win_stake_lo: await num('WC_WIN_STAKE_LO', 2), win_stake_hi: await num('WC_WIN_STAKE_HI', 4),
    // global
    max_stake: await num('WC_MAX_STAKE', 5),
  };
}

// =============================================
// SCAN ENGINE: Run all enabled strategies
// =============================================
async function runScan(env: Env) {
  const db = env.DB;
  try {
    return await runScanInner(env);
  } catch (e: any) {
    // Log fatal scan errors to alerts so they're visible
    try {
      await db.prepare("INSERT INTO alerts(level,message) VALUES('critical',?)").bind('扫描失败: ' + (e.message || String(e)).slice(0, 200)).run();
    } catch {}
    return { error: e.message || String(e) };
  }
}

async function runScanInner(env: Env) {
  const db = env.DB;
  if ((await getState(db, 'running')) !== 'true' || (await getState(db, 'paused')) === 'true') return { skipped: true };
  const allMkts = (await db.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  if (!allMkts.length) return { skipped: true, reason: 'no markets' };

  // Cap at 20 markets per scan (20×2 orderbook = 40 subrequests, under 50 limit)
  const MAX_PER_SCAN = 20;
  let mkts = allMkts;
  if (allMkts.length > MAX_PER_SCAN) {
    let off = parseInt(await getState(db, 'scan_offset') || '0');
    mkts = [];
    for (let i = 0; i < MAX_PER_SCAN; i++) mkts.push(allMkts[(off + i) % allMkts.length]);
    await setState(db, 'scan_offset', String((off + MAX_PER_SCAN) % allMkts.length));
  }

  const minSpread = parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02'));
  const tradeSize = parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20'));
  const enabledStr = await getSetting(db, 'ENABLED_STRATEGIES', 'complement,probability,market_making,momentum,logical,weather,nobot,pre_settle');
  const enabled = enabledStr.split(',').map(s => s.trim());
  const mode = await getSetting(db, 'TRADING_MODE', 'paper');
  const cooldown = parseInt(await getSetting(db, 'TRADE_COOLDOWN_SEC', '30'));

  // Get balance: paper=simulated, real=try API then fallback to STARTING_CASH
  const startingCash = parseFloat(await getSetting(db, 'STARTING_CASH', '100'));
  let balance: number;
  if (mode === 'paper') {
    balance = await getPaperBalance(db, startingCash);
  } else {
    balance = await getAccountBalance(env);
    if (balance <= 0) balance = startingCash; // Fallback when RPC/API fails
  }

  // ============= PACED PRICE FETCH =============
  // Spread API requests over time to avoid rate limiting.
  // Strategy: 1 market at a time with small delay between markets,
  // and a longer delay between markets. This keeps avg request rate low.
  const priceCache: Record<string, { mid: number | null; askY: number | null; bidY: number | null; askN: number | null; bidN: number | null; bookY: any }> = {};

  // Configurable pacing (ms). Keeps avg request rate low without blowing past the
  // ~2min cron interval. YES/NO orderbooks are fetched in parallel per market, and
  // markets are paced apart. Tunable via settings (SCAN_MARKET_PACING_MS).
  // Defaults: 20 markets × ~1.5s ≈ 30-40s total (was ~132s, which overran the cron).
  const MARKET_PACING_MS = parseInt(await getSetting(db, 'SCAN_MARKET_PACING_MS', '1500')) || 1500;

  for (let i = 0; i < mkts.length; i++) {
    const m = mkts[i];
    if (!m.token_yes) continue;
    const cache: any = { mid: null, askY: null, bidY: null, askN: null, bidN: null, bookY: null };
    try {
      // Fetch YES and NO orderbooks concurrently (2 subrequests, no inter-leg sleep)
      const [bookY, bookN] = await Promise.all([
        getOrderbook(env, m.token_yes),
        m.token_no ? getOrderbook(env, m.token_no) : Promise.resolve(null),
      ]);
      if (bookY?.bids?.length && bookY?.asks?.length) {
        cache.bookY = bookY;
        cache.bidY = parseFloat(bookY.bids[0].price);
        cache.askY = parseFloat(bookY.asks[0].price);
        cache.mid = (cache.bidY + cache.askY) / 2;
      }
      if (bookN?.bids?.length && bookN?.asks?.length) {
        cache.bidN = parseFloat(bookN.bids[0].price);
        cache.askN = parseFloat(bookN.asks[0].price);
      }
    } catch (e: any) {
      console.error('Price fetch failed for', m.condition_id, e.message);
    }
    priceCache[m.condition_id] = cache;

    // Record snapshot inline (no extra batch loop)
    try {
      const sp = cache.mid != null && cache.askN != null ? Math.abs(1 - cache.mid - cache.askN) : null;
      await db.prepare('INSERT INTO price_snapshots(condition_id,price_yes,price_no,spread) VALUES(?,?,?,?)').bind(m.condition_id, cache.mid, cache.askN, sp).run();
    } catch {}

    // Pace between markets (skip after last)
    if (i < mkts.length - 1) await sleep(MARKET_PACING_MS);
  }

  // ============= RUN STRATEGIES SEQUENTIALLY WITH PACING =============
  // Strategies mostly use cached prices (no API calls), so a large delay here is
  // wasteful. Keep a small pace to smooth DB writes / external calls (weather,
  // gamma, AI already have their own caches). Tunable via SCAN_STRATEGY_PACING_MS.
  const opps: any[] = [];
  const STRATEGY_PACING_MS = parseInt(await getSetting(db, 'SCAN_STRATEGY_PACING_MS', '100')) || 0; // 0.1s default (was 0.5s)
  const aiSkipSet = new Set<string>(); // Skip AI for markets with non-AI signals

  // World Cup: fetch de-vigged bookmaker odds once per scan (cached 6h)
  let wcGames: any[] = [];
  if (enabled.includes('worldcup')) {
    try { wcGames = await fetchWorldCupOdds(env, db); } catch {}
  }

  for (const m of mkts) {
    const cache = priceCache[m.condition_id];
    try {
      if (enabled.includes('complement')) {
        const o = await strategyComplement(env, m, minSpread, tradeSize, cache);
        if (o) { opps.push({ ...o, market: m.question, condition_id: m.condition_id }); aiSkipSet.add(m.condition_id); }
        await sleep(STRATEGY_PACING_MS);
      }
      // Run non-AI strategies before probability to build skip set
      if (enabled.includes('weather')) {
        const o = await strategyWeather(env, m, db, tradeSize, balance, mode, cache);
        if (o) { opps.push({ ...o, market: m.question, condition_id: m.condition_id }); aiSkipSet.add(m.condition_id); }
        await sleep(STRATEGY_PACING_MS);
      }
      if (enabled.includes('nobot')) {
        const o = await strategyNoBot(env, m, tradeSize, balance, cache);
        if (o) { opps.push({ ...o, market: m.question, condition_id: m.condition_id }); aiSkipSet.add(m.condition_id); }
      }
      if (enabled.includes('pre_settle')) {
        const o = await strategyPreSettlement(env, m, db, tradeSize, balance, cache);
        if (o) { opps.push({ ...o, market: m.question, condition_id: m.condition_id }); aiSkipSet.add(m.condition_id); }
      }
      if (enabled.includes('worldcup') && wcGames.length) {
        const o = await strategyWorldCup(env, m, db, tradeSize, balance, wcGames, cache);
        if (o) { opps.push({ ...o, market: m.question, condition_id: m.condition_id }); aiSkipSet.add(m.condition_id); }
      }
      // AI probability: skip if cheaper strategies already found a signal for this market
      if (enabled.includes('probability') && !aiSkipSet.has(m.condition_id)) {
        const o = await strategyProbability(env, m, db, tradeSize, balance, mode, cache);
        if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id });
        await sleep(STRATEGY_PACING_MS);
      }
      if (enabled.includes('market_making')) {
        const o = await strategyMarketMaking(env, m, tradeSize, cache);
        if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id });
        await sleep(STRATEGY_PACING_MS);
      }
      if (enabled.includes('momentum')) {
        const o = await strategyMomentum(env, m, db, tradeSize, balance, mode, cache);
        if (o) opps.push({ ...o, market: m.question, condition_id: m.condition_id });
        await sleep(STRATEGY_PACING_MS);
      }
    } catch {}
  }

  // Logical arbitrage runs across ALL markets (not per-market)
  if (enabled.includes('logical')) {
    try {
      const logicalOpps = await strategyLogical(env, mkts, db, tradeSize, balance, mode);
      opps.push(...logicalOpps);
      const aiLogicalOpps = await strategyLogicalAI(env, mkts, db, tradeSize, balance, mode);
      opps.push(...aiLogicalOpps);
    } catch {}
  }

  // Risk controls
  const maxPosition = parseFloat(await getSetting(db, 'MAX_POSITION_SIZE_USD', '50'));
  const dailyLossLimit = parseFloat(await getSetting(db, 'DAILY_LOSS_LIMIT_USD', '20'));

  // Calculate current NET open position (BUY - SELL, today's trades only matter for daily loss)
  const positionRes = await db.prepare("SELECT COALESCE(SUM(CASE WHEN side='BUY' THEN amount_usd ELSE -amount_usd END), 0) as net FROM trades WHERE status IN ('filled','submitted')").first<{net:number}>();
  const currentPosition = Math.max(0, positionRes?.net || 0);

  // Calculate today's realized P&L (sum of net cash flow from today's trades)
  const todayPnlRes = await db.prepare("SELECT COALESCE(SUM(CASE WHEN side='SELL' THEN amount_usd ELSE -amount_usd END), 0) as pnl FROM trades WHERE status IN ('filled','submitted') AND date(created_at)=date('now')").first<{pnl:number}>();
  const dailyPnl = todayPnlRes?.pnl || 0;
  await setState(db, 'daily_pnl', dailyPnl.toString());

  // Filter: only real arbitrage with valid legs and within risk limits.
  // Use user's MIN_ARBITRAGE_SPREAD × tradeSize for ALL markets (uniform).
  // Track rejections for diagnostic logging.
  const filterStats: Record<string, number> = { no_legs: 0, sanity: 0, low_profit: 0, leg_cost: 0, position: 0, danger: 0 };
  const filteredDetails: any[] = [];

  const tradableOpps = opps.filter(o => {
    if (!o.legs || o.legs.length === 0) { filterStats.no_legs++; return false; }

    // Risk rating check: NEVER trade danger markets
    const risk = rateMarketRisk(o.market || '', o.topic || '');
    if (risk.level === 'danger') {
      filterStats.danger++;
      filteredDetails.push({ s: o.strategy, m: (o.market || '').slice(0,15), reason: 'danger:' + risk.reason });
      return false;
    }
    // Attach risk info to opportunity for downstream use
    o.risk = risk;

    if (o.profit > tradeSize * 2) { filterStats.sanity++; filteredDetails.push({ s: o.strategy, m: (o.market || '').slice(0,15), reason: 'sanity', profit: o.profit }); return false; }

    // Use user's threshold uniformly (works for both fee-free and fee markets,
    // since strategies already deducted fees from o.profit)
    // Ultra-low threshold: any opportunity with positive EV ($0.001+)
    const minProfitThreshold = 0.001;
    if (o.profit < minProfitThreshold) {
      filterStats.low_profit++;
      filteredDetails.push({ s: o.strategy, m: (o.market || '').slice(0,15), reason: 'low_profit', profit: +o.profit.toFixed(3), need: +minProfitThreshold.toFixed(3) });
      return false;
    }

    const totalLegCost = o.legs.reduce((s: number, l: any) => l.side === 'BUY' ? s + l.price * l.size : s, 0);
    if (totalLegCost > tradeSize * 1.05) { // small tolerance for rounding
      filterStats.leg_cost++;
      filteredDetails.push({ s: o.strategy, m: (o.market || '').slice(0,15), reason: 'leg_cost', cost: +totalLegCost.toFixed(2), max: tradeSize });
      return false;
    }
    if (currentPosition + totalLegCost > maxPosition) {
      filterStats.position++;
      filteredDetails.push({ s: o.strategy, m: (o.market || '').slice(0,15), reason: 'position' });
      return false;
    }
    return true;
  });

  // Save filter diagnostics for debugging
  await setState(db, 'last_filter_stats', JSON.stringify({
    total_opps: opps.length, tradable: tradableOpps.length,
    rejections: filterStats, examples: filteredDetails.slice(0, 5),
    threshold: Math.max(minSpread * tradeSize, 0.005),
    ts: Date.now()
  }));

  // Queue best opportunity for separate execution (avoids subrequest limit)
  // Trade execution happens in a separate /api/trade/execute-pending call
  // triggered by the cron worker right after the scan.
  let queued = null;
  if (tradableOpps.length > 0) {
    if (dailyPnl <= -dailyLossLimit) {
      await addAlert(db, 'critical', `日亏损已达限额 $${dailyLossLimit}，自动暂停交易`);
      await setState(db, 'paused', 'true');
    } else {
      const lastTrade = parseInt(await getState(db, 'last_trade_time') || '0');
      const now = Math.floor(Date.now() / 1000);
      if (now - lastTrade >= cooldown) {
        const best = tradableOpps.sort((a, b) => b.profit - a.profit)[0];
        // Save to pending queue (just one at a time for safety)
        await setState(db, 'pending_trade', JSON.stringify({ ...best, queued_at: now }));
        queued = best;
      }
    }
  }
  const traded = queued;

  // Always log scan summary so user knows system is alive
  const stratNames: Record<string,string> = { complement: '互补套利', probability: '概率偏差', market_making: '做市', momentum: '动量', logical: '逻辑套利', weather: '天气套利', nobot: 'No-Bot', pre_settle: '4h结算', worldcup: '世界杯淘汰赛' };
  const tradeableSummary = tradableOpps.map(o => `[${stratNames[o.strategy] || o.strategy}] ${o.market?.slice(0,20)} $${o.profit.toFixed(3)}`).join('; ');
  const advisorySummary = opps.filter(o => !o.legs?.length).map(o => `[${stratNames[o.strategy] || o.strategy}] ${o.market?.slice(0,20)} ${o.advisory || ''}`).join('; ');
  // Show top 3 closest-to-threshold opportunities that got filtered
  const closeMisses = opps
    .filter(o => o.legs?.length > 0 && o.profit > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 3)
    .map(o => `[${stratNames[o.strategy] || o.strategy}] ${o.market?.slice(0,15)} $${o.profit.toFixed(3)}`)
    .join('; ');
  const threshold = Math.max(minSpread * tradeSize, 0.005);
  await addAlert(db, 'info',
    `扫描${mkts.length}/${allMkts.length}市场 | 余额$${balance.toFixed(2)} | 持仓$${currentPosition.toFixed(0)}/$${maxPosition} | 阈值$${threshold.toFixed(3)} | 模式:${mode}`
    + (tradableOpps.length ? ` | ✅可交易${tradableOpps.length}个: ${tradeableSummary}` : ` | 无可交易机会(检测${opps.length}个)`)
    + (traded ? ` | 已${mode === 'paper' ? '模拟' : '真实'}交易[${stratNames[traded.strategy] || traded.strategy}]` : '')
    + (closeMisses && !tradableOpps.length ? ` | 💡接近: ${closeMisses}` : '')
    + (advisorySummary ? ` | 参考: ${advisorySummary}` : ''));

  const result = { scanned: mkts.length, mode, balance: Math.round(balance * 100) / 100, strategies: enabled,
    opportunities: opps.map(o => ({ strategy: o.strategy, market: o.market, action: o.action,
      spread: Math.round(o.spread * 10000) / 10000, profit: Math.round(o.profit * 100) / 100,
      confidence: Math.round(o.confidence * 100) / 100, legs: o.legs?.length || 0,
      advisory: o.advisory || '' })), traded, scanned_at: new Date().toISOString() };
  // Cache for frontend polling
  await setState(db, 'last_scan_result', JSON.stringify(result));
  return result;
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

// Cache token metadata (tick size, negRisk) in DB to avoid fetching every trade
async function getTokenMetaCached(db: D1Database, client: any, tokenId: string): Promise<{tickSize: string, negRisk: boolean}> {
  const cacheKey = 'tokmeta_' + tokenId.slice(0, 20);
  const cached = await getState(db, cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }
  let tickSize = '0.01', negRisk = false;
  try { const [ts, nr] = await Promise.all([client.getTickSize(tokenId), client.getNegRisk(tokenId)]); if (ts) tickSize = ts; negRisk = !!nr; } catch {}
  await setState(db, cacheKey, JSON.stringify({ tickSize, negRisk }));
  return { tickSize, negRisk };
}

async function executeTrade(env: Env, db: D1Database, opp: any, mode: string) {
  const t0 = Date.now();
  await setState(db, 'last_trade_time', Math.floor(t0 / 1000).toString());

  // Create client once for all legs (reused for parallel execution)
  let client: any = null;
  if (mode === 'real' && env.POLYMARKET_PRIVATE_KEY && env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET) {
    client = createClobClient(env, {
      key: env.POLYMARKET_API_KEY,
      secret: env.POLYMARKET_API_SECRET,
      passphrase: env.POLYMARKET_API_PASSPHRASE || '',
    });
  }

  // PARALLEL leg execution: all legs are placed simultaneously
  const legResults = await Promise.all((opp.legs || []).map(async (leg: any) => {
    let orderId = 'paper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let status = 'filled';

    if (mode === 'real') {
      try {
        if (!client) {
          status = 'error_no_creds';
          orderId = 'err_' + Date.now();
        } else {
          const side = leg.side === 'BUY' ? Side.BUY : Side.SELL;
          // Use cached metadata
          const { tickSize, negRisk } = await getTokenMetaCached(db, client, leg.token);
          const result = await client.createAndPostOrder(
            { tokenID: leg.token, price: leg.price, side, size: leg.size },
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
            await db.prepare("INSERT INTO alerts(level,message) VALUES('warning',?)").bind('订单被拒绝: ' + JSON.stringify(result).slice(0, 200)).run();
          }
        }
      } catch (e: any) {
        status = 'error';
        orderId = 'err_' + Date.now();
        const errDetail = `下单失败 [${opp.strategy}] ${leg.side} ${leg.size.toFixed(2)}@$${leg.price.toFixed(3)}: ${(e.message || String(e)).slice(0, 300)}`;
        await db.prepare("INSERT INTO alerts(level,message) VALUES('critical',?)").bind(errDetail).run();
      }
    }

    return { leg, orderId, status };
  }));

  // Insert all trade records in parallel
  await Promise.all(legResults.map((r: any) =>
    db.prepare('INSERT INTO trades(condition_id,side,token_id,price,size,amount_usd,order_id,status,strategy,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(opp.condition_id, r.leg.side, r.leg.token, r.leg.price, r.leg.size, r.leg.price * r.leg.size, r.orderId, r.status, opp.strategy, mode)
      .run()
  ));

  if (mode === 'paper') {
    const totalPnl = parseFloat(await getState(db, 'total_pnl') || '0') + (opp.profit || 0);
    await setState(db, 'total_pnl', totalPnl.toString());
  }

  const elapsed = Date.now() - t0;
  return { strategy: opp.strategy, market: opp.market, mode, profit: opp.profit, latency_ms: elapsed,
    orders: legResults.map((r: any) => ({ side: r.leg.side, price: r.leg.price, status: r.status, orderId: r.orderId })) };
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
  const mode = await getSetting(db, 'TRADING_MODE', 'paper');
  const startingCash = parseFloat(await getSetting(db, 'STARTING_CASH', '100'));
  const balance = mode === 'paper' ? await getPaperBalance(db, startingCash) : await getAccountBalance(c.env);
  return c.json({ running: (await getState(db, 'running')) === 'true', paused: (await getState(db, 'paused')) === 'true',
    daily_pnl: parseFloat(await getState(db, 'daily_pnl') || '0'), total_pnl: parseFloat(await getState(db, 'total_pnl') || '0'),
    trading_ready: !!(c.env.POLYMARKET_API_KEY && c.env.POLYMARKET_PRIVATE_KEY),
    mode, starting_cash: startingCash, balance,
    strategies: (await getSetting(db, 'ENABLED_STRATEGIES', 'complement,probability,market_making,momentum,logical,weather,nobot,pre_settle')).split(',') });
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
app.get('/markets/history', async c => c.json((await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active=0 ORDER BY added_at DESC LIMIT 100').all()).results));
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
  let topic = b.topic || '';
  // Auto-fetch topic from Gamma API if not provided
  if (!topic || topic === 'other') {
    try {
      const gamma = await fetch(`${GAMMA(c.env)}/markets?condition_ids=${b.condition_id}`);
      if (gamma.ok) {
        const gm: any[] = await gamma.json();
        if (gm.length > 0) {
          topic = (gm[0].category || gm[0].tag || '').toLowerCase();
        }
      }
    } catch {}
  }
  // Smart override: use keyword classifier (especially for geopolitics that Gamma mislabels)
  topic = classifyByKeywords(b.question || '', topic);
  if (!topic) topic = 'other';
  await c.env.DB.prepare('INSERT OR REPLACE INTO watched_markets(condition_id,question,token_yes,token_no,user_conviction,topic) VALUES(?,?,?,?,?,?)').bind(b.condition_id, b.question, b.token_yes || null, b.token_no || null, b.user_conviction || 0.5, topic).run();
  return c.json({ status: 'added', topic });
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

// Hot markets: fetch active high-liquidity markets and score by arbitrage potential
app.get('/markets/hot', async c => {
  try {
    // Fetch top markets from Gamma sorted by volume
    const res = await fetch(`${GAMMA(c.env)}/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false`);
    if (!res.ok) return c.json({ error: 'Failed to fetch from Gamma API' }, 500);
    const all: any[] = await res.json();

    // Filter to only binary markets with both tokens
    const binaryMarkets = all.filter((m: any) => {
      const [tY, tN] = parseClobTokens(m.clobTokenIds);
      return tY && tN && m.acceptingOrders !== false;
    });

    // Fetch live orderbook prices for top 30 and score
    const scored: any[] = [];
    const topCandidates = binaryMarkets.slice(0, 30);

    await Promise.all(topCandidates.map(async (m: any) => {
      const [tY, tN] = parseClobTokens(m.clobTokenIds);
      try {
        const [bookY, bookN] = await Promise.all([getOrderbook(c.env, tY), getOrderbook(c.env, tN)]);
        if (!bookY?.bids?.length || !bookY?.asks?.length) return;

        const bidY = parseFloat(bookY.bids[0].price);
        const askY = parseFloat(bookY.asks[0].price);
        const spreadY = askY - bidY;

        let bidN = 0, askN = 0;
        if (bookN?.bids?.length && bookN?.asks?.length) {
          bidN = parseFloat(bookN.bids[0].price);
          askN = parseFloat(bookN.asks[0].price);
        }

        // Calculate arbitrage potential
        const complementArbYes = 1 - (askY + askN); // Positive = arb opportunity (buy both)
        const complementArbNo = (bidY + bidN) - 1;  // Positive = arb opportunity (sell both)
        const bestComplementArb = Math.max(complementArbYes, complementArbNo, 0);

        // Liquidity score (orderbook depth sum)
        const liqY = (bookY.bids.slice(0, 5).reduce((s: number, b: any) => s + parseFloat(b.size) * parseFloat(b.price), 0)
                    + bookY.asks.slice(0, 5).reduce((s: number, a: any) => s + parseFloat(a.size) * parseFloat(a.price), 0));

        // Composite score: market_making potential (wide spread) + complement arb + liquidity + volume
        const volume24h = parseFloat(m.volume24hr || '0');
        const mmScore = spreadY > 0.05 ? spreadY * 100 : 0; // wider spread = better making potential
        const arbScore = bestComplementArb * 1000;
        const liqScore = Math.min(liqY / 100, 10); // capped at 10
        const volScore = Math.min(volume24h / 10000, 20); // capped at 20
        const totalScore = arbScore + mmScore + liqScore + volScore;

        scored.push({
          condition_id: m.conditionId || m.condition_id,
          question: m.question,
          slug: m.slug,
          category: m.category,
          token_yes: tY,
          token_no: tN,
          price_yes: askY,
          price_no: askN || (1 - askY),
          spread: spreadY,
          complement_gap: bestComplementArb,
          liquidity_5deep: liqY,
          volume_24h: volume24h,
          score: Math.round(totalScore * 10) / 10,
          reasons: [
            bestComplementArb > 0.01 ? `互补套利${(bestComplementArb * 100).toFixed(1)}¢` : '',
            spreadY > 0.05 ? `做市价差${(spreadY * 100).toFixed(1)}¢` : '',
            liqY > 500 ? `高流动性$${liqY.toFixed(0)}` : '',
            volume24h > 10000 ? `24h量$${(volume24h/1000).toFixed(0)}K` : '',
          ].filter(x => x),
        });
      } catch {}
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    return c.json({ markets: scored.slice(0, 20), scanned_at: new Date().toISOString() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
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
        const ev = events[0];
        const eventCategory = (ev.category || ev.tag || (ev.tags?.[0]?.label) || '').toLowerCase();
        return c.json({ event: ev.title, slug, markets: ev.markets.map((m: any) => {
          const [tY, tN] = parseClobTokens(m.clobTokenIds);
          const topic = (m.category || m.tag || eventCategory || 'other').toLowerCase();
          return { condition_id: m.conditionId || m.condition_id || '', question: m.question || m.groupItemTitle || ev.title || '',
            token_yes: tY, token_no: tN, slug: m.slug || slug, topic };
        }) });
      }
    }
    const mktRes = await fetch(`${GAMMA(c.env)}/markets?slug=${slug}&limit=10`);
    if (mktRes.ok) { const mkts: any[] = await mktRes.json();
      if (mkts.length) return c.json({ event: mkts[0].question, slug, markets: mkts.map((m: any) => {
        const [tY, tN] = parseClobTokens(m.clobTokenIds);
        const topic = (m.category || m.tag || 'other').toLowerCase();
        return { condition_id: m.conditionId || m.condition_id || '', question: m.question || '', token_yes: tY, token_no: tN, topic };
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
  const dbSecretKeys = new Set(['WORLDCUP_ODDS_API_KEY']);
  for (const r of rows.results as any[]) {
    if (dbSecretKeys.has(r.key) && r.value) {
      s[r.key] = { value: r.value.length > 8 ? r.value.slice(0, 4) + '****' + r.value.slice(-4) : '****', is_set: true };
    } else {
      s[r.key] = { value: r.value, is_set: !!r.value };
    }
  }
  for (const k of ['POLYMARKET_API_KEY','POLYMARKET_API_SECRET','POLYMARKET_API_PASSPHRASE','POLYMARKET_PRIVATE_KEY','POLYMARKET_FUNDER_ADDRESS']) { const v = (c.env as any)[k] || ''; s[k] = { value: v ? v.slice(0, 4) + '****' + v.slice(-4) : '', is_set: !!v }; }
  s['POLYMARKET_API_URL'] = { value: c.env.POLYMARKET_API_URL || 'https://clob.polymarket.com', is_set: true };
  s['GAMMA_API_URL'] = { value: c.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com', is_set: true };
  s['DATA_API_URL'] = { value: c.env.DATA_API_URL || 'https://data-api.polymarket.com', is_set: true };
  return c.json(s);
});
app.put('/settings', async c => {
  const { settings } = await c.req.json<{ settings: Record<string, string> }>(); const db = c.env.DB;
  const dbKeys = ['MAX_POSITION_SIZE_USD','DAILY_LOSS_LIMIT_USD','MAX_SINGLE_TRADE_USD','MIN_ARBITRAGE_SPREAD','POLL_INTERVAL','AI_PROVIDER','AI_API_KEY','AI_MODEL','AI_MODEL_FAST','AI_BASE_URL','TRADING_MODE','ENABLED_STRATEGIES','TRADE_COOLDOWN_SEC','AI_PROVIDERS_JSON','AI_ACTIVE_PROVIDER','STARTING_CASH',
    'SCAN_MARKET_PACING_MS','SCAN_STRATEGY_PACING_MS',
    'WORLDCUP_ODDS_API_KEY','WORLDCUP_SPORT_KEY','WORLDCUP_ODDS_REGIONS',
    'WC_ADV_LO','WC_ADV_HI','WC_ADV_EDGE','WC_ADV_STAKE_LO','WC_ADV_STAKE_HI',
    'WC_DRAW_LO','WC_DRAW_HI','WC_DRAW_FAV_MAX','WC_DRAW_MARGIN_MAX','WC_DRAW_EDGE','WC_DRAW_STAKE_LO','WC_DRAW_STAKE_HI',
    'WC_WIN_LO','WC_WIN_HI','WC_WIN_DRAW_MAX','WC_WIN_MARGIN_MIN','WC_WIN_EDGE','WC_WIN_STAKE_LO','WC_WIN_STAKE_HI','WC_MAX_STAKE'];
  for (const [k, v] of Object.entries(settings)) { if (dbKeys.includes(k) && v && !v.includes('****')) await db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(k, v).run(); }
  return c.json({ status: 'saved' }); });

// Fix broken market tokens by re-fetching from Gamma API
app.post('/markets/fix-tokens', async c => {
  const mkts = (await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  const fixed: string[] = [];
  for (const m of mkts) {
    try {
      let tY = m.token_yes, tN = m.token_no;
      let gammaTopic = '';

      // Always re-fetch Gamma to get fresh tokens AND category
      const gamma = await fetch(`${GAMMA(c.env)}/markets?condition_ids=${m.condition_id}`);
      if (gamma.ok) {
        const gm: any[] = await gamma.json();
        if (gm.length > 0) {
          const g = gm[0];
          const [gY, gN] = parseClobTokens(g.clobTokenIds);
          if (gY && gN) { tY = gY; tN = gN; }
          gammaTopic = (g.category || g.tag || '').toLowerCase();
        }
      }

      // Fallback: CLOB API for tokens
      if (!tY || tY.length < 10) {
        const clob: any = await clobGet(c.env, `/markets/${m.condition_id}`);
        if (clob && clob.tokens) {
          tY = clob.tokens.find((t: any) => t.outcome === 'Yes')?.token_id || clob.tokens[0]?.token_id || tY;
          tN = clob.tokens.find((t: any) => t.outcome === 'No')?.token_id || clob.tokens[1]?.token_id || tN;
          if (!gammaTopic) gammaTopic = (clob.category || clob.tag || '').toLowerCase();
        }
      }

      // Smart classification: override with keyword-based detection
      const topic = classifyByKeywords(m.question || '', gammaTopic) || 'other';

      await c.env.DB.prepare('UPDATE watched_markets SET token_yes=?, token_no=?, topic=? WHERE condition_id=?').bind(tY, tN, topic, m.condition_id).run();
      fixed.push(m.question.slice(0, 35) + ' → [' + topic + ']');
    } catch (e: any) { fixed.push(m.question.slice(0, 35) + ': ERROR - ' + e.message); }
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

// =============================================
// AUTO-DISCOVER: Smart market discovery across ALL profitable categories
// Searches: Weather, Economics, Finance, Earnings, Entertainment, Culture, Politics, Crypto
// Plus top 30 highest-volume active markets
// Scores by: volume + safety rating + fee advantage
// Filters out danger-rated markets
// Adds up to 10 best markets per run
// Runs every 6 hours via cron
// =============================================
app.post('/markets/auto-discover', async c => {
  const db = c.env.DB;
  const added: string[] = [];
  const MAX_NEW = 10; // Add up to 10 new markets per run

  // Get already-watched condition_ids to avoid duplicates
  const existing = (await db.prepare('SELECT condition_id FROM watched_markets').all()).results as any[];
  const existingIds = new Set(existing.map((r: any) => r.condition_id));

  // Search categories: weather + economics + entertainment + politics + finance + crypto + general
  const searchQueries = [
    // Weather (high edge)
    { url: '/markets?tag=temperature&limit=15&active=true&closed=false' },
    { url: '/markets?tag=weather&limit=15&active=true&closed=false' },
    // Economics/Finance (data-driven, safe)
    { url: '/markets?tag=economics&limit=15&active=true&closed=false' },
    { url: '/markets?tag=finance&limit=15&active=true&closed=false' },
    { url: '/markets?tag=earnings&limit=10&active=true&closed=false' },
    // Entertainment (predictable)
    { url: '/markets?tag=entertainment&limit=10&active=true&closed=false' },
    { url: '/markets?tag=culture&limit=10&active=true&closed=false' },
    // Politics (caution but liquid)
    { url: '/markets?tag=politics&limit=10&active=true&closed=false' },
    // Crypto (volatile but high volume)
    { url: '/markets?tag=crypto&limit=10&active=true&closed=false' },
    // Top 30 highest-volume active markets (any category)
    { url: '/markets?limit=30&active=true&closed=false&order=volume24hr&ascending=false' },
  ];

  // Collect all candidate markets with scoring
  const candidates: { cid: string; question: string; tY: string; tN: string; topic: string; score: number }[] = [];

  for (const query of searchQueries) {
    try {
      const res = await fetch(`${GAMMA(c.env)}${query.url}`);
      if (!res.ok) continue;
      const markets: any[] = await res.json();

      for (const m of markets) {
        const cid = m.conditionId || m.condition_id;
        if (!cid || existingIds.has(cid)) continue;

        const [tY, tN] = parseClobTokens(m.clobTokenIds);
        if (!tY || !tN) continue;

        // Skip if already a candidate
        if (candidates.some(c => c.cid === cid)) continue;

        const question = m.question || '';
        const topic = classifyByKeywords(question, (m.category || m.tag || '').toLowerCase());

        // Filter out danger-rated markets
        const risk = rateMarketRisk(question, topic);
        if (risk.level === 'danger') continue;

        // Score: volume + safety rating + fee advantage
        const volume = parseFloat(m.volume24hr || m.volume || '0');
        const volumeScore = Math.min(volume / 5000, 20); // Up to 20 points for volume
        const safetyScore = risk.level === 'safe' ? 15 : risk.level === 'caution' ? 5 : 0;
        const feeRate = getFeeForCategory(topic);
        const feeScore = feeRate === 0 ? 10 : feeRate <= 0.01 ? 5 : 0; // Bonus for low/no fees
        const score = volumeScore + safetyScore + feeScore;

        candidates.push({ cid, question, tY, tN, topic, score });
      }
      await sleep(1000); // Pace between search queries
    } catch {}
  }

  // Sort by score descending, take top MAX_NEW
  candidates.sort((a, b) => b.score - a.score);
  const toAdd = candidates.slice(0, MAX_NEW);

  for (const c of toAdd) {
    try {
      await db.prepare('INSERT OR IGNORE INTO watched_markets(condition_id,question,token_yes,token_no,topic,active) VALUES(?,?,?,?,?,1)')
        .bind(c.cid, c.question, c.tY, c.tN, c.topic).run();
      existingIds.add(c.cid);
      added.push(c.question.slice(0, 50) || c.cid);
    } catch {}
  }

  if (added.length) {
    await addAlert(db, 'info', `自动发现${added.length}个市场: ${added.slice(0, 5).join('; ')}${added.length > 5 ? '...' : ''}`);
  }

  return c.json({ discovered: added.length, markets: added });
});

// =============================================
// AUTO-CLEANUP: Move settled/expired markets to history (active=0)
// =============================================
app.post('/markets/cleanup', async c => {
  const db = c.env.DB;
  const mkts = (await db.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  const cleaned: string[] = [];

  for (const m of mkts) {
    try {
      // Check if market is closed/settled via CLOB API
      const mkt: any = await clobGet(c.env, `/markets/${m.condition_id}`);
      if (mkt && (mkt.closed === true || mkt.active === false || mkt.accepting_orders === false)) {
        await db.prepare('UPDATE watched_markets SET active=0 WHERE condition_id=?').bind(m.condition_id).run();
        cleaned.push(m.question?.slice(0, 40) || m.condition_id);
        continue;
      }

      // Also check via Gamma API for more reliable status
      const gamma = await fetch(`${GAMMA(c.env)}/markets?condition_ids=${m.condition_id}`);
      if (gamma.ok) {
        const gm: any[] = await gamma.json();
        if (gm.length > 0 && (gm[0].closed === true || gm[0].active === false || gm[0].archived === true)) {
          await db.prepare('UPDATE watched_markets SET active=0 WHERE condition_id=?').bind(m.condition_id).run();
          cleaned.push(m.question?.slice(0, 40) || m.condition_id);
        }
      }
      await sleep(500);
    } catch {}
  }

  if (cleaned.length) {
    await addAlert(db, 'info', `清理${cleaned.length}个已结算市场: ${cleaned.slice(0, 5).join('; ')}${cleaned.length > 5 ? '...' : ''}`);
  }

  return c.json({ cleaned: cleaned.length, markets: cleaned });
});

// Scan & AI
app.post('/scan', async c => {
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await runScan(c.env));
});

// Execute the pending trade from the queue (separate Worker invocation = fresh subrequest budget)
app.post('/trade/execute-pending', async c => {
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
  const db = c.env.DB;
  const pendingStr = await getState(db, 'pending_trade');
  if (!pendingStr) return c.json({ status: 'no_pending' });

  let opp: any;
  try { opp = JSON.parse(pendingStr); } catch { return c.json({ status: 'invalid' }); }
  // Stale check: skip if older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (opp.queued_at && now - opp.queued_at > 300) {
    await setState(db, 'pending_trade', '');
    return c.json({ status: 'stale', age_sec: now - opp.queued_at });
  }

  // Clear queue first to prevent double execution
  await setState(db, 'pending_trade', '');

  const mode = await getSetting(db, 'TRADING_MODE', 'paper');
  const result = await executeTrade(c.env, db, opp, mode);
  return c.json({ status: 'executed', result });
});
app.get('/scan/latest', async c => {
  const cached = await getState(c.env.DB, 'last_scan_result');
  return c.json(cached ? JSON.parse(cached) : { opportunities: [], scanned_at: null });
});
// Diagnostic endpoint: shows why opportunities were filtered
app.get('/scan/diagnostics', async c => {
  const filterStats = await getState(c.env.DB, 'last_filter_stats');
  const lastResult = await getState(c.env.DB, 'last_scan_result');
  return c.json({
    filter: filterStats ? JSON.parse(filterStats) : null,
    last_scan: lastResult ? JSON.parse(lastResult) : null,
  });
});
app.get('/fees', async c => c.json({ categories: CATEGORY_FEES, default: DEFAULT_FEE, last_verified: FEES_LAST_VERIFIED }));

// Weekly fee verification: ask AI to check if Polymarket fees changed
app.post('/fees/verify', async c => {
  const db = c.env.DB;
  const aiKey = await getSetting(db, 'AI_API_KEY');
  if (!aiKey) {
    await addAlert(db, 'warning', '无法验证手续费: AI Key 未配置');
    return c.json({ error: 'AI not configured' });
  }
  const aiProvider = await getSetting(db, 'AI_PROVIDER', 'openai');
  const aiModel = await getSetting(db, 'AI_MODEL', 'gpt-4o');
  const aiBaseUrl = await getSetting(db, 'AI_BASE_URL', 'https://api.openai.com/v1');

  const currentFees = JSON.stringify(CATEGORY_FEES, null, 2);
  const prompt = `请检查 Polymarket 当前的 taker 手续费政策是否还和以下一致 (上次验证: ${FEES_LAST_VERIFIED}):

${currentFees}

请确认每个类别的手续费百分比是否仍然准确。特别确认:
1. Geopolitics 是否仍是 0% 免手续费
2. Crypto 是否仍是 1.80%
3. 是否有新的类别添加
4. 是否有政策变化

参考来源: help.polymarket.com/articles/13364478-trading-fees, docs.polymarket.com/trading/fees

请用 JSON 格式回复:
{"unchanged": true/false, "changes": [{"category": "xxx", "old": 0.01, "new": 0.012}], "notes": "..."}`;

  try {
    let content = '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (aiProvider === 'anthropic') {
      headers['x-api-key'] = aiKey; headers['anthropic-version'] = '2023-06-01';
      const res = await fetch((aiBaseUrl || 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST', headers,
        body: JSON.stringify({ model: aiModel, max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
      });
      const data: any = await res.json(); content = data.content?.[0]?.text || '';
    } else {
      headers['Authorization'] = `Bearer ${aiKey}`;
      const res = await fetch(aiBaseUrl + '/chat/completions', {
        method: 'POST', headers,
        body: JSON.stringify({ model: aiModel, max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
      });
      const data: any = await res.json(); content = data.choices?.[0]?.message?.content || '';
    }

    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.unchanged === false && parsed.changes?.length) {
        await addAlert(db, 'critical', `⚠️ Polymarket 手续费可能已变化: ${JSON.stringify(parsed.changes)} | ${parsed.notes || ''}`);
      } else {
        await addAlert(db, 'info', `✅ 手续费验证通过 (${FEES_LAST_VERIFIED}): ${parsed.notes || '无变化'}`);
      }
      await db.prepare('INSERT INTO ai_reviews(review_type,content) VALUES(?,?)').bind('fee_verify', content).run();
      return c.json(parsed);
    }
    return c.json({ raw: content });
  } catch (e: any) {
    await addAlert(db, 'warning', '手续费验证失败: ' + e.message);
    return c.json({ error: e.message });
  }
});
app.get('/debug/balance', async c => {
  const balance = await getAccountBalance(c.env);
  const startingCash = parseFloat(await getSetting(c.env.DB, 'STARTING_CASH', '100'));
  const paperBalance = await getPaperBalance(c.env.DB, startingCash);
  return c.json({
    funder_address: c.env.POLYMARKET_FUNDER_ADDRESS,
    real_usdc_balance: balance,
    paper_balance: paperBalance,
    starting_cash: startingCash,
  });
});

// Debug: deep strategy diagnosis - tests each strategy on first 5 markets and reports WHY each fails
app.get('/debug/strategies', async c => {
  const db = c.env.DB;
  const mkts = (await db.prepare('SELECT * FROM watched_markets WHERE active=1 LIMIT 5').all()).results as any[];
  const balance = 100;
  const tradeSize = parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '5'));
  const minSpread = parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02'));
  const results: any[] = [];

  for (const m of mkts) {
    const mResult: any = { question: m.question?.slice(0, 40), topic: m.topic, token_yes: !!m.token_yes, token_no: !!m.token_no };

    // Get prices
    try {
      if (m.token_yes) {
        const book = await getOrderbook(c.env, m.token_yes);
        if (book?.bids?.length && book?.asks?.length) {
          mResult.yes_bid = parseFloat(book.bids[0].price);
          mResult.yes_ask = parseFloat(book.asks[0].price);
          mResult.yes_spread = mResult.yes_ask - mResult.yes_bid;
        } else {
          mResult.yes_error = 'no orderbook data';
        }
      }
      if (m.token_no) {
        const book = await getOrderbook(c.env, m.token_no);
        if (book?.bids?.length && book?.asks?.length) {
          mResult.no_bid = parseFloat(book.bids[0].price);
          mResult.no_ask = parseFloat(book.asks[0].price);
        }
      }
    } catch (e: any) { mResult.price_error = e.message; }

    // Test complement
    if (mResult.yes_ask != null && mResult.no_ask != null) {
      const totalAsk = mResult.yes_ask + mResult.no_ask;
      const fee = getFeeForCategory(m.topic);
      const gap = 1 - totalAsk - totalAsk * fee * 2;
      mResult.complement = { total_ask: totalAsk, fee_pct: fee, net_gap: gap, would_trigger: gap > 0.001 };
    }

    // Test market making
    if (mResult.yes_spread != null) {
      mResult.market_making = { spread: mResult.yes_spread, min_needed: 0.02, would_trigger: mResult.yes_spread >= 0.02 };
    }

    // Test nobot
    if (mResult.no_ask != null) {
      const topic = (m.topic || '').toLowerCase();
      const isSports = topic.includes('sport');
      mResult.nobot = { no_price: mResult.no_ask, max_price: 0.65, is_sports: isSports,
        would_trigger: mResult.no_ask <= 0.65 && mResult.no_ask >= 0.05 && !isSports };
    }

    // Risk rating
    mResult.risk = rateMarketRisk(m.question || '', m.topic || '');

    results.push(mResult);
  }

  return c.json({ markets_tested: results.length, settings: { tradeSize, minSpread, balance, threshold: Math.max(minSpread * tradeSize, 0.005) }, results });
});

// Debug: test if Polymarket CLOB is reachable + check for geo-blocking
app.get('/debug/geo', async c => {
  const result: any = {};
  try {
    const r = await fetch(`${CLOB(c.env)}/markets`, {
      headers: { 'CF-IPCountry': 'US', 'X-Forwarded-For': '8.8.8.8' }
    });
    result.markets_status = r.status;
    result.markets_body_preview = (await r.text()).slice(0, 300);
    result.cf_ray = r.headers.get('cf-ray');
    result.server = r.headers.get('server');
  } catch (e: any) { result.markets_error = e.message; }

  // Try a real authenticated call
  try {
    const path = '/auth/api-keys';
    const h = await authHeaders(c.env, 'GET', path);
    const r = await fetch(`${CLOB(c.env)}${path}`, { headers: h });
    result.auth_status = r.status;
    result.auth_body = (await r.text()).slice(0, 500);
  } catch (e: any) { result.auth_error = e.message; }

  // Check our outgoing IP
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    if (r.ok) result.outgoing_ip = await r.json();
  } catch {}

  // Check Cloudflare colo
  try {
    const r = await fetch('https://cloudflare.com/cdn-cgi/trace');
    if (r.ok) result.cf_trace = (await r.text()).split('\n').slice(0, 8).join(' | ');
  } catch {}

  return c.json(result);
});

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
  return c.json(r || { content: '暂无投资建议。系统将在每天凌昨2点自动生成。', created_at: '' });
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
