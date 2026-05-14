/**
 * Cron Worker - Calls the Pages Functions API on a schedule.
 * Deploy this as a separate Cloudflare Worker.
 *
 * Schedule:
 * - Every 2 minutes: POST /api/scan (arbitrage scanning)
 * - Every hour (minute 0): POST /api/ai-review { type: "hourly" }
 * - Daily at 1:00 AM UTC: POST /api/ai-review { type: "daily" }
 * - Daily at 2:00 AM UTC: POST /api/ai-advisory (investment advice)
 * - Weekly Mondays at 3:00 AM UTC: POST /api/fees/verify (verify Polymarket fee schedule)
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

    // Every 2 minutes: scan + execute pending trade (separate Worker invocations
    // to stay under Cloudflare's 50-subrequest-per-invocation limit)
    if (cronPattern === '*/2 * * * *') {
      ctx.waitUntil((async () => {
        try {
          // Step 1: Scan for opportunities (queues best one to DB)
          const scanRes = await fetch(`${baseUrl}/api/scan`, { method: 'POST', headers });
          const scanData = await scanRes.json();
          console.log('Scan result:', JSON.stringify(scanData).slice(0, 300));

          // Step 2: Execute any pending trade (fresh subrequest budget)
          // Wait 2s before triggering to let the queue be written
          await new Promise(r => setTimeout(r, 2000));
          const execRes = await fetch(`${baseUrl}/api/trade/execute-pending`, { method: 'POST', headers });
          const execData = await execRes.json();
          console.log('Trade execute:', JSON.stringify(execData).slice(0, 300));
        } catch (e: any) {
          console.error('Cron cycle failed:', e.message);
        }
      })());
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

    // Every hour (at minute 0): auto-discover weather markets + cleanup expired
    if (cronPattern === '0 * * * *') {
      ctx.waitUntil((async () => {
        try {
          // Step 1: Discover new weather markets
          const discRes = await fetch(`${baseUrl}/api/markets/auto-discover`, { method: 'POST', headers });
          const discData = await discRes.json();
          console.log('Auto-discover:', JSON.stringify(discData).slice(0, 300));

          // Wait 5s between operations
          await new Promise(r => setTimeout(r, 5000));

          // Step 2: Cleanup expired/settled markets
          const cleanRes = await fetch(`${baseUrl}/api/markets/cleanup`, { method: 'POST', headers });
          const cleanData = await cleanRes.json();
          console.log('Cleanup:', JSON.stringify(cleanData).slice(0, 300));
        } catch (e: any) {
          console.error('Discover/cleanup failed:', e.message);
        }
      })());
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

    // Weekly Mondays at 3:00 AM UTC: verify Polymarket fee schedule
    if (cronPattern === '0 3 * * 1') {
      ctx.waitUntil(
        fetch(`${baseUrl}/api/fees/verify`, { method: 'POST', headers })
          .then(r => r.json())
          .then(d => console.log('Fee verification:', JSON.stringify(d).slice(0, 500)))
          .catch(e => console.error('Fee verify failed:', e.message))
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
