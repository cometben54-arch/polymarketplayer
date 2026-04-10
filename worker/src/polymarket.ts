/**
 * Polymarket CLOB / Gamma / Data API client for Cloudflare Workers.
 */

export interface Env {
  DB: D1Database;
  POLYMARKET_API_URL: string;
  GAMMA_API_URL: string;
  DATA_API_URL: string;
  POLYMARKET_API_KEY?: string;
  POLYMARKET_API_SECRET?: string;
  POLYMARKET_API_PASSPHRASE?: string;
  POLYMARKET_PRIVATE_KEY?: string;
  POLYMARKET_FUNDER_ADDRESS?: string;
  ADMIN_PASSWORD?: string;
}

// HMAC-SHA256 signing for authenticated endpoints
async function hmacSign(secret: string, message: string): Promise<string> {
  const keyData = Uint8Array.from(atob(secret.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function authHeaders(env: Env, method: string, path: string, body = ''): Promise<Record<string, string>> {
  if (!env.POLYMARKET_API_KEY || !env.POLYMARKET_API_SECRET) return {};
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacSign(env.POLYMARKET_API_SECRET, ts + method.toUpperCase() + path + body);
  return {
    'POLY_HMAC_KEY': env.POLYMARKET_API_KEY,
    'POLY_HMAC_SIGNATURE': sig,
    'POLY_HMAC_TIMESTAMP': ts,
    'POLY_HMAC_PASSPHRASE': env.POLYMARKET_API_PASSPHRASE || '',
  };
}

export class PolymarketClient {
  constructor(private env: Env) {}

  private get clobUrl() { return (this.env.POLYMARKET_API_URL || 'https://clob.polymarket.com').replace(/\/$/, ''); }
  private get gammaUrl() { return (this.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com').replace(/\/$/, ''); }
  private get dataUrl() { return (this.env.DATA_API_URL || 'https://data-api.polymarket.com').replace(/\/$/, ''); }

  // --- CLOB public endpoints ---

  async getMarkets(cursor = ''): Promise<any> {
    const params = cursor ? `?next_cursor=${cursor}` : '';
    const res = await fetch(`${this.clobUrl}/markets${params}`);
    return res.ok ? res.json() : { data: [] };
  }

  async getMarket(conditionId: string): Promise<any> {
    const res = await fetch(`${this.clobUrl}/markets/${conditionId}`);
    return res.ok ? res.json() : null;
  }

  async getPrice(tokenId: string, side: string = 'BUY'): Promise<number | null> {
    const res = await fetch(`${this.clobUrl}/price?token_id=${tokenId}&side=${side}`);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.price ? parseFloat(data.price) : null;
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const res = await fetch(`${this.clobUrl}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.mid ? parseFloat(data.mid) : null;
  }

  async getOrderbook(tokenId: string): Promise<any> {
    const res = await fetch(`${this.clobUrl}/book?token_id=${tokenId}`);
    return res.ok ? res.json() : null;
  }

  // --- CLOB authenticated endpoints ---

  async getApiKeys(): Promise<any> {
    const path = '/auth/api-keys';
    const headers = await authHeaders(this.env, 'GET', path);
    const res = await fetch(`${this.clobUrl}${path}`, { headers });
    return res.ok ? res.json() : null;
  }

  async getOpenOrders(): Promise<any[]> {
    const path = '/data/orders';
    const headers = await authHeaders(this.env, 'GET', path);
    const res = await fetch(`${this.clobUrl}${path}`, { headers });
    if (!res.ok) return [];
    const data: any = await res.json();
    return Array.isArray(data) ? data : data.data || [];
  }

  // --- Gamma API ---

  async searchMarkets(query: string, limit = 10): Promise<any[]> {
    const res = await fetch(`${this.gammaUrl}/markets?slug=${encodeURIComponent(query)}&limit=${limit}&active=true`);
    return res.ok ? res.json() : [];
  }

  // --- Data API ---

  async getPositions(address?: string): Promise<any[]> {
    const addr = address || this.env.POLYMARKET_FUNDER_ADDRESS;
    if (!addr) return [];
    const res = await fetch(`${this.dataUrl}/positions?user=${addr}`);
    return res.ok ? res.json() : [];
  }

  // --- Checks ---

  isConfigured(): boolean {
    return !!(this.env.POLYMARKET_API_KEY && this.env.POLYMARKET_API_SECRET && this.env.POLYMARKET_API_PASSPHRASE);
  }

  isTradingReady(): boolean {
    return this.isConfigured() && !!this.env.POLYMARKET_PRIVATE_KEY;
  }
}
