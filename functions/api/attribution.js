// GET /api/attribution?key=...&days=30
//
// Splits purchases into three groups by click identifier presence:
//   - 'meta'    → purchase had an fbc cookie (fbclid captured by middleware)
//   - 'google'  → purchase had gclid / gbraid / wbraid
//   - 'organic' → neither
//
// Also joins ad_spend to surface Meta spend, CPA, and ROAS when the sync
// cron has populated that table. Google Ads spend is a v1.1 follow-up.
//
// Response: {
//   days,
//   groups: { meta: {...}, google: {...}, organic: {...} },
//   meta_spend,         // from ad_spend (may be 0 if sync isn't configured)
//   meta_cpa,           // meta_spend / meta.sales (null if sales == 0)
//   meta_roas,          // meta.revenue / meta_spend (null if spend == 0)
//   last_synced_at,     // last successful Meta sync timestamp, or null
// }

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { since, until } = parseDateRange(url);

  try {
    const rows = await env.DB.prepare(`
      SELECT
        CASE
          WHEN fbc IS NOT NULL AND fbc != '' THEN 'meta'
          WHEN (gclid != '' AND gclid IS NOT NULL)
            OR (gbraid != '' AND gbraid IS NOT NULL)
            OR (wbraid != '' AND wbraid IS NOT NULL) THEN 'google'
          ELSE 'organic'
        END as source_type,
        COUNT(*) as sales,
        COALESCE(SUM(value), 0) as revenue
      FROM purchase_log
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY source_type
    `).bind(since, until).all();

    const groups = { meta: empty(), google: empty(), organic: empty() };
    for (const row of rows.results || []) {
      if (groups[row.source_type]) {
        groups[row.source_type] = {
          sales: Number(row.sales || 0),
          revenue: Number(row.revenue || 0),
        };
      }
    }

    // Meta spend from ad_spend table over the same window.
    const sinceDate = ymd(new Date(since * 1000));
    const untilDate = ymd(new Date(until * 1000));
    const spendRow = await env.DB.prepare(`
      SELECT COALESCE(SUM(spend_cents), 0) as spend_cents
      FROM ad_spend
      WHERE platform = 'meta' AND date >= ? AND date <= ?
    `).bind(sinceDate, untilDate).first();

    const metaSpend = Number(spendRow?.spend_cents || 0) / 100;

    // Last successful Meta sync (for "stale data" warnings in the UI).
    const syncRow = await env.DB.prepare(`
      SELECT MAX(run_at) as last_synced_at
      FROM sync_log
      WHERE platform = 'meta' AND status = 'ok'
    `).first();

    return json({
      days,
      groups,
      meta_spend: metaSpend,
      meta_cpa: groups.meta.sales > 0 ? metaSpend / groups.meta.sales : null,
      meta_roas: metaSpend > 0 ? groups.meta.revenue / metaSpend : null,
      last_synced_at: syncRow?.last_synced_at || null,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function empty() { return { sales: 0, revenue: 0 }; }

function ymd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseDateRange(url) {
  const sinceParam = url.searchParams.get('since');
  const untilParam = url.searchParams.get('until');
  if (sinceParam) {
    return {
      since: parseInt(sinceParam, 10),
      until: untilParam ? parseInt(untilParam, 10) : Math.floor(Date.now() / 1000),
    };
  }
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  return {
    since: Math.floor(Date.now() / 1000) - days * 86400,
    until: Math.floor(Date.now() / 1000),
  };
}
