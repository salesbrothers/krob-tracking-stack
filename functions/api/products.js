// GET /api/products?key=...&days=30
// Returns: {
//   products: [{product_id, product_name, revenue, sales, aov}],
//   time_series: [{date, product_id, product_name, sales, revenue}],
// }
// Source: purchase_items (one row per line item in a purchase).

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { since, until } = parseDateRange(url);

  try {
    const products = await env.DB.prepare(`
      SELECT
        product_id,
        COALESCE(MAX(product_name), product_id) as product_name,
        COALESCE(SUM(value), 0) as revenue,
        COUNT(*) as sales,
        COALESCE(AVG(value), 0) as aov,
        COALESCE(MAX(currency), 'BRL') as currency
      FROM purchase_items
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY product_id
      ORDER BY revenue DESC
    `).bind(since, until).all();

    const series = await env.DB.prepare(`
      SELECT
        date(created_at, 'unixepoch') as date,
        product_id,
        COALESCE(MAX(product_name), product_id) as product_name,
        COUNT(*) as sales,
        COALESCE(SUM(value), 0) as revenue
      FROM purchase_items
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY date(created_at, 'unixepoch'), product_id
      ORDER BY date ASC
    `).bind(since, until).all();

    return json({
      days,
      products: products.results || [],
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
