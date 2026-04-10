/**
 * Polymarket Arbitrage Bot - Cloudflare Worker Backend
 * Handles all API routes + cron-triggered scanning.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, PolymarketClient } from './polymarket';
import { scanAllOpportunities } from './arbitrage';

type Bindings = Env;
const app = new Hono<{ Bindings: Bindings }>();

// CORS for Cloudflare Pages frontend
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// --- Helpers ---
async function getState(db: D1Database, key: string): Promise<string> {
  const r = await db.prepare('SELECT value FROM bot_state WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value || '';
}
async function setState(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime("now"))').bind(key, value).run();
}
async function getSetting(db: D1Database, key: string, fallback = ''): Promise<string> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value || fallback;
}

// --- Bot Status ---
app.get('/api/bot/status', async (c) => {
  const db = c.env.DB;
  const client = new PolymarketClient(c.env);
  return c.json({
    running: (await getState(db, 'running')) === 'true',
    paused: (await getState(db, 'paused')) === 'true',
    daily_pnl: parseFloat(await getState(db, 'daily_pnl') || '0'),
    total_pnl: parseFloat(await getState(db, 'total_pnl') || '0'),
    trading_ready: client.isTradingReady(),
  });
});

app.post('/api/bot/control', async (c) => {
  const { action } = await c.req.json<{ action: string }>();
  const db = c.env.DB;
  if (action === 'start') { await setState(db, 'running', 'true'); await setState(db, 'paused', 'false'); return c.json({ status: 'started' }); }
  if (action === 'stop') { await setState(db, 'running', 'false'); return c.json({ status: 'stopped' }); }
  if (action === 'pause') { await setState(db, 'paused', 'true'); await db.prepare("INSERT INTO alerts (level, message) VALUES ('info', 'Bot paused by user')").run(); return c.json({ status: 'paused' }); }
  if (action === 'resume') { await setState(db, 'paused', 'false'); return c.json({ status: 'resumed' }); }
  return c.json({ status: 'unknown' });
});

// --- Markets ---
app.get('/api/markets', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM watched_markets WHERE active = 1 ORDER BY added_at DESC').all();
  return c.json(rows.results);
});

app.post('/api/markets', async (c) => {
  const { condition_id, question, token_yes, token_no } = await c.req.json();
  await c.env.DB.prepare('INSERT OR REPLACE INTO watched_markets (condition_id, question, token_yes, token_no) VALUES (?, ?, ?, ?)').bind(condition_id, question, token_yes || null, token_no || null).run();
  return c.json({ status: 'added' });
});

app.delete('/api/markets/:id', async (c) => {
  await c.env.DB.prepare('UPDATE watched_markets SET active = 0 WHERE condition_id = ?').bind(c.req.param('id')).run();
  return c.json({ status: 'removed' });
});

app.get('/api/markets/search', async (c) => {
  const q = c.req.query('q') || '';
  const client = new PolymarketClient(c.env);
  try {
    const data = await client.getMarkets();
    let markets = data?.data || [];
    if (q) markets = markets.filter((m: any) => (m.question || '').toLowerCase().includes(q.toLowerCase()));
    return c.json(markets.slice(0, 20));
  } catch { return c.json([]); }
});

// --- Groups ---
app.get('/api/groups', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM arbitrage_groups WHERE active = 1').all();
  return c.json(rows.results.map((r: any) => ({ ...r, market_ids: typeof r.market_ids === 'string' ? JSON.parse(r.market_ids) : r.market_ids })));
});

app.post('/api/groups', async (c) => {
  const { name, description, market_ids, strategy } = await c.req.json();
  await c.env.DB.prepare('INSERT INTO arbitrage_groups (name, description, market_ids, strategy) VALUES (?, ?, ?, ?)').bind(name, description || '', JSON.stringify(market_ids), strategy || 'complement').run();
  return c.json({ status: 'created' });
});

app.delete('/api/groups/:id', async (c) => {
  await c.env.DB.prepare('UPDATE arbitrage_groups SET active = 0 WHERE id = ?').bind(parseInt(c.req.param('id'))).run();
  return c.json({ status: 'removed' });
});

// --- Risk ---
app.get('/api/risk', async (c) => {
  const db = c.env.DB;
  return c.json({
    max_position_size_usd: parseFloat(await getSetting(db, 'MAX_POSITION_SIZE_USD', '100')),
    daily_loss_limit_usd: parseFloat(await getSetting(db, 'DAILY_LOSS_LIMIT_USD', '50')),
    max_single_trade_usd: parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20')),
    min_arbitrage_spread: parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02')),
  });
});

app.put('/api/risk', async (c) => {
  const body = await c.req.json();
  const db = c.env.DB;
  if (body.max_position_size_usd != null) await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('MAX_POSITION_SIZE_USD', String(body.max_position_size_usd)).run();
  if (body.daily_loss_limit_usd != null) await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('DAILY_LOSS_LIMIT_USD', String(body.daily_loss_limit_usd)).run();
  if (body.max_single_trade_usd != null) await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('MAX_SINGLE_TRADE_USD', String(body.max_single_trade_usd)).run();
  if (body.min_arbitrage_spread != null) await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('MIN_ARBITRAGE_SPREAD', String(body.min_arbitrage_spread)).run();
  return c.json({ status: 'updated' });
});

// --- Trades ---
app.get('/api/trades', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const rows = await c.env.DB.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return c.json(rows.results);
});

// --- Alerts ---
app.get('/api/alerts', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const rows = await c.env.DB.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return c.json(rows.results);
});

app.post('/api/alerts/:id/resolve', async (c) => {
  await c.env.DB.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').bind(parseInt(c.req.param('id'))).run();
  return c.json({ status: 'resolved' });
});

// --- Price History ---
app.get('/api/prices/:conditionId', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100');
  const rows = await c.env.DB.prepare('SELECT * FROM price_snapshots WHERE condition_id = ? ORDER BY recorded_at DESC LIMIT ?').bind(c.req.param('conditionId'), limit).all();
  return c.json(rows.results);
});

// --- Settings ---
app.get('/api/settings', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const settings: Record<string, { value: string; is_set: boolean }> = {};
  for (const r of rows.results as any[]) {
    settings[r.key] = { value: r.value, is_set: !!r.value };
  }
  // Add env-based secrets (masked)
  const secretKeys = ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE', 'POLYMARKET_PRIVATE_KEY', 'POLYMARKET_FUNDER_ADDRESS'];
  for (const k of secretKeys) {
    const val = (c.env as any)[k] || '';
    settings[k] = { value: val ? val.slice(0, 4) + '****' + val.slice(-4) : '', is_set: !!val };
  }
  // Add API URLs
  settings['POLYMARKET_API_URL'] = { value: c.env.POLYMARKET_API_URL || '', is_set: true };
  settings['GAMMA_API_URL'] = { value: c.env.GAMMA_API_URL || '', is_set: true };
  settings['DATA_API_URL'] = { value: c.env.DATA_API_URL || '', is_set: true };
  return c.json(settings);
});

app.put('/api/settings', async (c) => {
  const { settings } = await c.req.json<{ settings: Record<string, string> }>();
  const db = c.env.DB;
  const dbKeys = ['MAX_POSITION_SIZE_USD', 'DAILY_LOSS_LIMIT_USD', 'MAX_SINGLE_TRADE_USD', 'MIN_ARBITRAGE_SPREAD', 'POLL_INTERVAL', 'PORT'];
  for (const [key, val] of Object.entries(settings)) {
    if (dbKeys.includes(key) && val && !val.includes('*')) {
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, val).run();
    }
  }
  return c.json({ status: 'saved' });
});

// --- Connection Test ---
app.get('/api/connection/test', async (c) => {
  const client = new PolymarketClient(c.env);
  const result = { api_configured: false, clob_reachable: false, auth_ok: false, message: '' };

  if (!client.isConfigured()) {
    result.message = 'API Key 未配置 (请用 wrangler secret put 设置)';
    return c.json(result);
  }
  result.api_configured = true;

  try {
    const data = await client.getMarkets();
    if (data?.data) result.clob_reachable = true;
    else { result.message = 'CLOB API 不可达'; return c.json(result); }
  } catch (e: any) {
    result.message = 'CLOB 连接失败: ' + e.message;
    return c.json(result);
  }

  try {
    const keys = await client.getApiKeys();
    if (keys) { result.auth_ok = true; result.message = '连接成功！API 认证通过'; }
    else result.message = 'API 认证失败';
  } catch (e: any) {
    result.message = '认证失败: ' + e.message;
  }
  return c.json(result);
});

// --- Scan endpoint (manual trigger) ---
app.post('/api/scan', async (c) => {
  const result = await runScanCycle(c.env);
  return c.json(result);
});

// --- Cron-triggered scan ---
async function runScanCycle(env: Env) {
  const db = env.DB;
  const running = await getState(db, 'running');
  const paused = await getState(db, 'paused');
  if (running !== 'true' || paused === 'true') return { skipped: true, reason: running !== 'true' ? 'not running' : 'paused' };

  const client = new PolymarketClient(env);
  const marketsRes = await db.prepare('SELECT * FROM watched_markets WHERE active = 1').all();
  const markets = marketsRes.results as any[];
  if (!markets.length) return { skipped: true, reason: 'no markets' };

  const groupsRes = await db.prepare('SELECT * FROM arbitrage_groups WHERE active = 1').all();
  const groups = groupsRes.results as any[];

  const minSpread = parseFloat(await getSetting(db, 'MIN_ARBITRAGE_SPREAD', '0.02'));
  const tradeSize = parseFloat(await getSetting(db, 'MAX_SINGLE_TRADE_USD', '20'));

  // Record price snapshots
  for (const m of markets) {
    try {
      const [priceYes, priceNo] = await Promise.all([
        m.token_yes ? client.getMidpoint(m.token_yes) : null,
        m.token_no ? client.getMidpoint(m.token_no) : null,
      ]);
      const spread = priceYes != null && priceNo != null ? Math.abs(1.0 - priceYes - priceNo) : null;
      await db.prepare('INSERT INTO price_snapshots (condition_id, price_yes, price_no, spread) VALUES (?, ?, ?, ?)').bind(m.condition_id, priceYes, priceNo, spread).run();
    } catch { /* skip */ }
  }

  // Scan for arbitrage
  const opportunities = await scanAllOpportunities(client, markets, groups, minSpread, tradeSize);

  if (opportunities.length > 0) {
    await db.prepare("INSERT INTO alerts (level, message) VALUES ('info', ?)").bind(`发现 ${opportunities.length} 个套利机会，价差: ${opportunities.map(o => (o.spread * 100).toFixed(2) + '%').join(', ')}`).run();
  }

  return {
    scanned: markets.length,
    opportunities: opportunities.map(o => ({
      group: o.groupName,
      strategy: o.strategy,
      spread: Math.round(o.spread * 10000) / 10000,
      expected_profit: Math.round(o.expectedProfit * 100) / 100,
      confidence: Math.round(o.confidence * 100) / 100,
      legs: o.legs.length,
    })),
  };
}

// --- Export ---
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScanCycle(env));
  },
};
