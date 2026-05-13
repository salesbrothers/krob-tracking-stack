// GET /api/revenue?key=...&days=30
// Returns: { gross, sales, aov, currency, time_series: [{date, revenue, sales}] }
// Source: purchase_log (one row per successful purchase)

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const totals = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(value), 0) as gross,
        COUNT(*) as sales,
        COALESCE(AVG(value), 0) as aov,
        COALESCE(MAX(currency), 'BRL') as currency,
        COALESCE(SUM(CASE WHEN is_order_bump = 1 THEN value ELSE 0 END), 0) as ob_revenue,
        SUM(CASE WHEN is_order_bump = 1 THEN 1 ELSE 0 END) as ob_sales
      FROM purchase_log
      WHERE created_at >= ?
    `).bind(since).first();

    const series = await env.DB.prepare(`
      SELECT
        date(created_at, 'unixepoch') as date,
        COALESCE(SUM(value), 0) as revenue,
        COUNT(*) as sales
      FROM purchase_log
      WHERE created_at >= ?
      GROUP BY date(created_at, 'unixepoch')
      ORDER BY date ASC
    `).bind(since).all();

    return json({
      gross: Number(totals?.gross || 0),
      sales: Number(totals?.sales || 0),
      aov: Number(totals?.aov || 0),
      currency: totals?.currency || 'BRL',
      ob_revenue: Number(totals?.ob_revenue || 0),
      ob_sales: Number(totals?.ob_sales || 0),
      days,
      time_series: series.results || [],
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
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
