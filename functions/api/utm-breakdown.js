// GET /api/utm-breakdown?key=...&days=30&dimension=utm_source&utm_source=...&utm_medium=...
//
// Returns per-value breakdown of purchases grouped by the chosen dimension,
// optionally filtered by other utm_* values (cascading filters).
//
// dimension ∈ { utm_source, utm_medium, utm_campaign, utm_content, utm_term }
//
// Response: { dimension, filters, rows: [{value, sales, revenue, aov}] }
//
// Source: purchase_log (UTMs already denormalized onto the row at webhook time).
// SQL safety: dimension and filter names are strictly allowlisted before use
// so they can be interpolated into the query without injection risk.

const ALLOWED_DIMENSIONS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
]);

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const dimension = url.searchParams.get('dimension') || 'utm_source';
  if (!ALLOWED_DIMENSIONS.has(dimension)) {
    return json({ error: `dimension must be one of ${[...ALLOWED_DIMENSIONS].join(', ')}` }, 400);
  }

  const { since, until } = parseDateRange(url);

  // Build cascading filters from any other utm_* query params.
  const filterClauses = [];
  const filterBindings = [];
  const activeFilters = {};
  for (const field of ALLOWED_DIMENSIONS) {
    if (field === dimension) continue;
    const val = url.searchParams.get(field);
    if (val != null && val !== '') {
      filterClauses.push(`${field} = ?`);
      filterBindings.push(val);
      activeFilters[field] = val;
    }
  }

  const whereClause = [
    'created_at >= ?',
    'created_at <= ?',
    ...filterClauses,
  ].join(' AND ');

  const query = `
    SELECT
      COALESCE(NULLIF(${dimension}, ''), '(not set)') as value,
      COUNT(*) as sales,
      COALESCE(SUM(value), 0) as revenue,
      COALESCE(AVG(value), 0) as aov
    FROM purchase_log
    WHERE ${whereClause}
    GROUP BY value
    ORDER BY revenue DESC
  `;

  try {
    const rows = await env.DB.prepare(query).bind(since, until, ...filterBindings).all();
    return json({
      dimension,
      filters: activeFilters,
      rows: rows.results || [],
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
