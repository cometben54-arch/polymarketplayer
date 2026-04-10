/**
 * Cron Worker - Calls the Pages Functions API on a schedule.
 * Deploy this as a separate Cloudflare Worker.
 *
 * Schedule:
 * - Every 2 minutes: POST /api/scan (arbitrage scanning)
 * - Every hour (minute 0): POST /api/ai-review { type: "hourly" }
 * - Daily at 1:00 AM UTC: POST /api/ai-review { type: "daily" }
 * - Daily at 2:00 AM UTC: POST /api/ai-advisory (investment advice)
 */

interface Env {
  PAGES_URL: string; // e.g. "https://polymarketplayer.pages.dev"
  CRON_SECRET?: string; // optional auth token
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const baseUrl = (env.PAGES_URL || 'https://polymarketplayer.pages.dev').replace(/\/$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.CRON_SECRET) headers['X-Cron-Secret'] = env.CRON_SECRET;

    const cronPattern = event.cron;

    // Every 2 minutes: scan
    if (cronPattern === '*/2 * * * *') {
      ctx.waitUntil(
        fetch(`${baseUrl}/api/scan`, { method: 'POST', headers })
          .then(r => r.json())
          .then(d => console.log('Scan result:', JSON.stringify(d)))
          .catch(e => console.error('Scan failed:', e.message))
      );
    }

    // Every hour (at minute 0): AI hourly review
    if (cronPattern === '0 * * * *') {
      ctx.waitUntil(
        fetch(`${baseUrl}/api/ai-review`, { method: 'POST', headers, body: JSON.stringify({ type: 'hourly' }) })
          .then(r => r.json())
          .then(d => console.log('Hourly AI review:', JSON.stringify(d).slice(0, 200)))
          .catch(e => console.error('AI review failed:', e.message))
      );
    }

    // Daily at 1:00 AM UTC: AI daily summary
    if (cronPattern === '0 1 * * *') {
      ctx.waitUntil(
        fetch(`${baseUrl}/api/ai-review`, { method: 'POST', headers, body: JSON.stringify({ type: 'daily' }) })
          .then(r => r.json())
          .then(d => console.log('Daily AI summary:', JSON.stringify(d).slice(0, 500)))
          .catch(e => console.error('Daily summary failed:', e.message))
      );
    }

    // Daily at 2:00 AM UTC: AI investment advisory
    if (cronPattern === '0 2 * * *') {
      ctx.waitUntil(
        fetch(`${baseUrl}/api/ai-advisory`, { method: 'POST', headers })
          .then(r => r.json())
          .then(d => console.log('Advisory generated:', JSON.stringify(d).slice(0, 500)))
          .catch(e => console.error('Advisory failed:', e.message))
      );
    }
  },

  // Also support manual trigger via HTTP
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response(JSON.stringify({
      status: 'Cron Worker running',
      pages_url: env.PAGES_URL || 'not configured',
      info: 'This worker runs on cron schedule. Triggers: */2 scan, hourly AI review, 1am daily summary'
    }), { headers: { 'Content-Type': 'application/json' } });
  }
};
