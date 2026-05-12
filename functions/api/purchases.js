export async function onRequestGet(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // Simple auth via query param — same pattern as /api/events
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const txn = url.searchParams.get('transaction_id') || '';

  try {
    const where = txn ? 'WHERE transaction_id = ?' : '';
    const binds = txn ? [txn, limit, offset] : [limit, offset];

    const { results: rows } = await env.DB.prepare(`
      SELECT
        id, created_at, event_time, trk, event_id,
        raw_email, raw_name, raw_phone,
        value, currency, transaction_id,
        product_id, product_name,
        gclid, gbraid, wbraid,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
        ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
        google_ads_status_code, google_ads_response_ok, google_ads_response_body, google_ads_payload_sent,
        CASE WHEN trk = '' THEN 1 ELSE 0 END as is_order_bump
      FROM purchase_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...binds).all();

    // Summary cards: counts over the last 24h
    const summary = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN meta_response_ok = 1 THEN 1 ELSE 0 END) AS meta_ok,
        SUM(CASE WHEN ga4_response_ok = 1 THEN 1 ELSE 0 END) AS ga4_ok,
        SUM(CASE WHEN google_ads_response_ok = 1 THEN 1 ELSE 0 END) AS gads_ok,
        SUM(CASE WHEN google_ads_response_body LIKE 'skipped:%' THEN 1 ELSE 0 END) AS gads_skipped
      FROM purchase_log
      WHERE created_at > strftime('%s','now','-1 day')
    `).first();

    return new Response(JSON.stringify({
      rows,
      summary: summary || {},
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
