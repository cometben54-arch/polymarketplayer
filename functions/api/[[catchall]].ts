/**
 * Polymarket Arbitrage Bot - Cloudflare Pages Functions API
 * Single catch-all handler for all /api/* routes.
 */

import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { cors } from 'hono/cors';
import { privateKeyToAddress } from 'viem/accounts';

// --- Types ---
interface Env {
  DB: D1Database;
  POLYMARKET_API_URL?: string;
  GAMMA_API_URL?: string;
  DATA_API_URL?: string;
  POLYMARKET_API_KEY?: string;
  POLYMARKET_API_SECRET?: string;
  POLYMARKET_API_PASSPHRASE?: string;
  POLYMARKET_PRIVATE_KEY?: string;
  POLYMARKET_FUNDER_ADDRESS?: string;
  ADMIN_PASSWORD?: string;
}

// --- Polymarket API Client ---
const CLOB = (e: Env) => (e.POLYMARKET_API_URL || 'https://clob.polymarket.com').replace(/\/$/, '');
const GAMMA = (e: Env) => (e.GAMMA_API_URL || 'https://gamma-api.polymarket.com').replace(/\/$/, '');

async function hmacSign(secret: string, msg: string): Promise<string> {
  // Decode secret: URL-safe base64 -> standard base64 -> bytes
  const std = secret.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - std.length % 4) % 4);
  const raw = atob(padded);
  const kd = Uint8Array.from(raw, c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', kd, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  // Output: URL-safe base64 WITH = padding (per official client)
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_');
}

function getSignerAddress(env: Env): string {
  // Derive the signer address from private key (this is the address the API key is bound to)
  if (!env.POLYMARKET_PRIVATE_KEY) return env.POLYMARKET_FUNDER_ADDRESS || '';
  try {
    return privateKeyToAddress(env.POLYMARKET_PRIVATE_KEY as `0x${string}`);
  } catch {
    return env.POLYMARKET_FUNDER_ADDRESS || '';
  }
}

async function authHeaders(env: Env, method: string, path: string, body = ''): Promise<Record<string, string>> {
  if (!env.POLYMARKET_API_KEY || !env.POLYMARKET_API_SECRET) return {};
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = ts + method.toUpperCase() + path + (body || '');
  const sig = await hmacSign(env.POLYMARKET_API_SECRET, message);
  const address = getSignerAddress(env);
  return {
    'POLY_ADDRESS': address,
    'POLY_API_KEY': env.POLYMARKET_API_KEY,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': ts,
    'POLY_PASSPHRASE': env.POLYMARKET_API_PASSPHRASE || '',
  };
}

async function clobGet(env: Env, path: string): Promise<any> {
  const res = await fetch(`${CLOB(env)}${path}`);
  return res.ok ? res.json() : null;
}

async function getPrice(env: Env, tokenId: string, side = 'BUY'): Promise<number | null> {
  const d: any = await clobGet(env, `/price?token_id=${tokenId}&side=${side}`);
  return d?.price ? parseFloat(d.price) : null;
}

async function getMidpoint(env: Env, tokenId: string): Promise<number | null> {
  const d: any = await clobGet(env, `/midpoint?token_id=${tokenId}`);
  return d?.mid ? parseFloat(d.mid) : null;
}

// --- DB Helpers ---
async function getState(db: D1Database, key: string): Promise<string> {
  const r = await db.prepare('SELECT value FROM bot_state WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value || '';
}
async function setState(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime("now"))').bind(key, value).run();
}
async function getSetting(db: D1Database, key: string, fb = ''): Promise<string> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value || fb;
}

// --- Arbitrage Detection ---
async function detectComplementArb(env: Env, cid: string, tY: string, tN: string, minSpread: number, tradeSize: number) {
  if (!tY || !tN) return null;
  const [pY, pN] = await Promise.all([getPrice(env, tY, 'BUY'), getPrice(env, tN, 'BUY')]);
  if (pY === null || pN === null) return null;
  const total = pY + pN;
  if (total < 1.0 - minSpread) {
    const sp = 1.0 - total, sh = tradeSize / total;
    return { group: `comp_${cid.slice(0, 8)}`, strategy: 'complement', spread: sp, expected_profit: sh * sp, confidence: Math.min(sp / 0.05, 1), legs: 2 };
  }
  const [bY, bN] = await Promise.all([getPrice(env, tY, 'SELL'), getPrice(env, tN, 'SELL')]);
  if (bY === null || bN === null) return null;
  const totalB = bY + bN;
  if (totalB > 1.0 + minSpread) {
    const sp = totalB - 1.0, sh = tradeSize / totalB;
    return { group: `comp_${cid.slice(0, 8)}`, strategy: 'complement', spread: sp, expected_profit: sh * sp, confidence: Math.min(sp / 0.05, 1), legs: 2 };
  }
  return null;
}

// --- Scan Cycle ---
async function runScan(env: Env) {
  const db = env.DB;
  if ((await getState(db, 'running')) !== 'true' || (await getState(db, 'paused')) === 'true') return { skipped: true };
  const mkts = (await db.prepare('SELECT * FROM watched_markets WHERE active=1').all()).results as any[];
  if (!mkts.length) return { skipped: true, reason: 'no markets' };
  const minSpread = parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02'));
  const tradeSize = parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20'));

  // Price snapshots
  for (const m of mkts) {
    try {
      const [pY, pN] = await Promise.all([m.token_yes ? getMidpoint(env, m.token_yes) : null, m.token_no ? getMidpoint(env, m.token_no) : null]);
      const sp = pY != null && pN != null ? Math.abs(1 - pY - pN) : null;
      await db.prepare('INSERT INTO price_snapshots (condition_id,price_yes,price_no,spread) VALUES(?,?,?,?)').bind(m.condition_id, pY, pN, sp).run();
    } catch {}
  }

  // Detect arb
  const opps: any[] = [];
  for (const m of mkts) {
    try {
      const o = await detectComplementArb(env, m.condition_id, m.token_yes || '', m.token_no || '', minSpread, tradeSize);
      if (o) opps.push(o);
    } catch {}
  }

  if (opps.length) await db.prepare("INSERT INTO alerts(level,message) VALUES('info',?)").bind(`发现${opps.length}个套利机会`).run();
  return { scanned: mkts.length, opportunities: opps };
}

// --- Hono App ---
const app = new Hono<{ Bindings: Env }>().basePath('/api');
app.use('*', cors());

// Bot
app.get('/bot/status', async c => {
  const db = c.env.DB;
  return c.json({ running: (await getState(db, 'running')) === 'true', paused: (await getState(db, 'paused')) === 'true', daily_pnl: parseFloat(await getState(db, 'daily_pnl') || '0'), total_pnl: parseFloat(await getState(db, 'total_pnl') || '0'), trading_ready: !!(c.env.POLYMARKET_API_KEY && c.env.POLYMARKET_PRIVATE_KEY) });
});

app.post('/bot/control', async c => {
  const { action } = await c.req.json<{ action: string }>();
  const db = c.env.DB;
  if (action === 'start') { await setState(db, 'running', 'true'); await setState(db, 'paused', 'false'); }
  else if (action === 'stop') await setState(db, 'running', 'false');
  else if (action === 'pause') { await setState(db, 'paused', 'true'); await db.prepare("INSERT INTO alerts(level,message) VALUES('info','Bot paused')").run(); }
  else if (action === 'resume') await setState(db, 'paused', 'false');
  return c.json({ status: action });
});

// Markets
app.get('/markets', async c => { const r = await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active=1 ORDER BY added_at DESC').all(); return c.json(r.results); });
app.post('/markets', async c => { const b = await c.req.json(); await c.env.DB.prepare('INSERT OR REPLACE INTO watched_markets(condition_id,question,token_yes,token_no) VALUES(?,?,?,?)').bind(b.condition_id, b.question, b.token_yes || null, b.token_no || null).run(); return c.json({ status: 'added' }); });
app.delete('/markets/:id', async c => { await c.env.DB.prepare('UPDATE watched_markets SET active=0 WHERE condition_id=?').bind(c.req.param('id')).run(); return c.json({ status: 'removed' }); });
app.get('/markets/search', async c => {
  const q = (c.req.query('q') || '').toLowerCase();
  try {
    const res = await fetch(`${GAMMA(c.env)}/markets?limit=20&active=true`);
    let data: any[] = res.ok ? await res.json() : [];
    if (q) data = data.filter((m: any) => ((m.question || '') + (m.slug || '')).toLowerCase().includes(q));
    return c.json(data.slice(0, 20));
  } catch { return c.json([]); }
});

// Groups
app.get('/groups', async c => { const r = await c.env.DB.prepare('SELECT * FROM arbitrage_groups WHERE active=1').all(); return c.json(r.results.map((x: any) => ({ ...x, market_ids: JSON.parse(x.market_ids || '[]') }))); });
app.post('/groups', async c => { const b = await c.req.json(); await c.env.DB.prepare('INSERT INTO arbitrage_groups(name,description,market_ids,strategy) VALUES(?,?,?,?)').bind(b.name, b.description || '', JSON.stringify(b.market_ids), b.strategy || 'complement').run(); return c.json({ status: 'created' }); });
app.delete('/groups/:id', async c => { await c.env.DB.prepare('UPDATE arbitrage_groups SET active=0 WHERE id=?').bind(+c.req.param('id')).run(); return c.json({ status: 'removed' }); });

// Risk
app.get('/risk', async c => {
  const db = c.env.DB;
  return c.json({ max_position_size_usd: parseFloat(await getSetting(db, 'MAX_POSITION_SIZE_USD', '100')), daily_loss_limit_usd: parseFloat(await getSetting(db, 'DAILY_LOSS_LIMIT_USD', '50')), max_single_trade_usd: parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20')), min_arbitrage_spread: parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02')) });
});
app.put('/risk', async c => {
  const b = await c.req.json(); const db = c.env.DB;
  for (const [k, v] of Object.entries(b)) { if (v != null) await db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(k.toUpperCase().replace(/([a-z])([A-Z])/g, '$1_$2'), String(v)).run(); }
  return c.json({ status: 'updated' });
});

// Trades & Alerts
app.get('/trades', async c => { const r = await c.env.DB.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').bind(+(c.req.query('limit') || '50')).all(); return c.json(r.results); });
app.get('/alerts', async c => { const r = await c.env.DB.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').bind(+(c.req.query('limit') || '50')).all(); return c.json(r.results); });
app.post('/alerts/:id/resolve', async c => { await c.env.DB.prepare('UPDATE alerts SET resolved=1 WHERE id=?').bind(+c.req.param('id')).run(); return c.json({ status: 'resolved' }); });

// Prices
app.get('/prices/:cid', async c => { const r = await c.env.DB.prepare('SELECT * FROM price_snapshots WHERE condition_id=? ORDER BY recorded_at DESC LIMIT ?').bind(c.req.param('cid'), +(c.req.query('limit') || '100')).all(); return c.json(r.results); });

// Settings (stored in D1)
app.get('/settings', async c => {
  const db = c.env.DB; const rows = await db.prepare('SELECT key,value FROM settings').all();
  const s: Record<string, any> = {};
  for (const r of rows.results as any[]) s[r.key] = { value: r.value, is_set: !!r.value };
  for (const k of ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE', 'POLYMARKET_PRIVATE_KEY', 'POLYMARKET_FUNDER_ADDRESS']) {
    const v = (c.env as any)[k] || '';
    s[k] = { value: v ? v.slice(0, 4) + '****' + v.slice(-4) : '', is_set: !!v };
  }
  s['POLYMARKET_API_URL'] = { value: c.env.POLYMARKET_API_URL || 'https://clob.polymarket.com', is_set: true };
  s['GAMMA_API_URL'] = { value: c.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com', is_set: true };
  s['DATA_API_URL'] = { value: c.env.DATA_API_URL || 'https://data-api.polymarket.com', is_set: true };
  return c.json(s);
});
app.put('/settings', async c => {
  const { settings } = await c.req.json<{ settings: Record<string, string> }>();
  const db = c.env.DB; const dbKeys = ['MAX_POSITION_SIZE_USD', 'DAILY_LOSS_LIMIT_USD', 'MAX_SINGLE_TRADE_USD', 'MIN_ARBITRAGE_SPREAD', 'POLL_INTERVAL'];
  for (const [k, v] of Object.entries(settings)) { if (dbKeys.includes(k) && v && !v.includes('*')) await db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(k, v).run(); }
  return c.json({ status: 'saved' });
});

// Debug: check which env vars are available
app.get('/debug/env', async c => {
  const keys = ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE', 'POLYMARKET_PRIVATE_KEY', 'POLYMARKET_FUNDER_ADDRESS', 'POLYMARKET_API_URL', 'GAMMA_API_URL', 'DATA_API_URL'];
  const status: Record<string, any> = {};
  for (const k of keys) {
    const v = (c.env as any)[k];
    status[k] = { exists: v !== undefined && v !== null && v !== '', type: typeof v, length: v ? String(v).length : 0 };
  }
  status['DB_BOUND'] = { exists: !!c.env.DB };
  // Show derived signer address vs funder address
  try {
    const signer = getSignerAddress(c.env);
    status['DERIVED_SIGNER_ADDRESS'] = signer;
    status['FUNDER_ADDRESS'] = c.env.POLYMARKET_FUNDER_ADDRESS || '';
    status['ADDRESSES_MATCH'] = signer.toLowerCase() === (c.env.POLYMARKET_FUNDER_ADDRESS || '').toLowerCase();
  } catch (e: any) { status['ADDRESS_ERROR'] = e.message; }
  return c.json(status);
});

// Connection test
app.get('/connection/test', async c => {
  const result: any = { api_configured: false, clob_reachable: false, auth_ok: false, message: '' };

  // Check env vars first
  const apiKey = c.env.POLYMARKET_API_KEY;
  const apiSecret = c.env.POLYMARKET_API_SECRET;
  const passphrase = c.env.POLYMARKET_API_PASSPHRASE;

  if (!apiKey) { result.message = 'POLYMARKET_API_KEY 未配置 (在 Cloudflare Pages > Settings > Environment variables 添加)'; return c.json(result); }
  if (!apiSecret) { result.message = 'POLYMARKET_API_SECRET 未配置'; return c.json(result); }
  if (!passphrase) { result.message = 'POLYMARKET_API_PASSPHRASE 未配置'; return c.json(result); }
  result.api_configured = true;

  // Test CLOB public endpoint
  try {
    const res = await fetch(`${CLOB(c.env)}/markets`);
    if (res.ok) { result.clob_reachable = true; }
    else { result.message = 'CLOB API 返回 HTTP ' + res.status; return c.json(result); }
  } catch (e: any) { result.message = 'CLOB 连接失败: ' + e.message; return c.json(result); }

  // Test L2 authenticated endpoint
  try {
    const path = '/auth/api-keys';
    const h = await authHeaders(c.env, 'GET', path);
    const res = await fetch(`${CLOB(c.env)}${path}`, { headers: h });
    const body = await res.text();
    if (res.ok) { result.auth_ok = true; result.message = '连接成功！API 认证通过'; }
    else { result.message = 'API 认证失败 (HTTP ' + res.status + '): ' + body.slice(0, 200); }
  } catch (e: any) { result.message = '认证失败: ' + e.message; }
  return c.json(result);
});

// Manual scan
app.post('/scan', async c => c.json(await runScan(c.env)));

// Export for Pages Functions
export const onRequest = handle(app);
