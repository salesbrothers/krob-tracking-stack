// -----------------------------------------------------------------------------
// Webhook core — platform-agnostic purchase processing.
//
// Each sales platform (Eduzz / Hotmart / Kiwify / etc.) has its own thin
// adapter file in this directory. The adapter is responsible for:
//   1. Reading the raw request body.
//   2. Verifying the platform-specific signature.
//   3. Parsing the platform's payload shape into the normalized purchase
//      object described below.
//   4. Calling processPurchase() with that normalized object.
//
// Everything else — D1 lookup, fan-out to Meta / GA4 / Google Ads, Encharge,
// ManyChat, purchase_log persistence, purchase_items persistence — lives in
// this file and is identical across platforms.
//
// Normalized purchase object (what each adapter must produce):
//
//   {
//     platform:      'eduzz' | 'hotmart' | 'kiwify' | string,
//     trk:           string,   // unique identifier threaded from page visit
//     email:         string,
//     name:          string,
//     phone:         string,
//     value:         number,
//     currency:      string,   // ISO code, e.g. 'BRL', 'USD'
//     transactionId: string,
//     productId:     string,
//     productName:   string,
//     items:         Array<{ productId, name, price: { value, currency } }>,
//     city:          string,   // optional — address city (Meta CAPI ct)
//     state:         string,   // optional — address state abbrev (Meta CAPI st)
//     country:       string,   // optional — 2-letter ISO country (Meta CAPI country)
//     zipCode:       string,   // optional — postal/zip code (Meta CAPI zp)
//     platformUtm:   { utm_source, utm_medium, utm_campaign, utm_content, utm_term },
//   }
//
// Do NOT add platform-specific branching to this file. If you find yourself
// writing `if (parsed.platform === 'hotmart')`, the right fix is to push that
// logic back into the adapter file.
// -----------------------------------------------------------------------------

import PRODUCTS_CONFIG from '../../config/products.js';

// Module-scope OAuth2 access token cache for Google Ads API.
// Reused across warm worker invocations to skip the refresh round-trip.
let googleAdsTokenCache = { token: null, expiresAt: 0 };

// -----------------------------------------------------------------------------
// Main entry point — each platform adapter calls this with a normalized object.
// -----------------------------------------------------------------------------
export async function processPurchase({ parsed, env, context }) {
  // Per-product integration config (may be null if product isn't registered).
  const productConfig = PRODUCTS_CONFIG[parsed.platform]?.[parsed.productId] || null;

  // Look up the originating checkout session (fbp, fbc, UTMs, ga_client_id, etc.)
  let checkoutData = {};
  if (parsed.trk && env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT * FROM checkout_sessions WHERE trk = ?'
      ).bind(parsed.trk).first();
      if (row) checkoutData = row;
    } catch (e) {
      console.error('D1 checkout lookup error:', e.message);
    }
  }

  const enriched = { ...parsed, productConfig, checkoutData };
  const eventId = crypto.randomUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // Fan out to handlers. Each wraps its own errors so one failing handler
  // never blocks the others.
  const handlerPromises = [];

  if (parsed.trk && checkoutData.trk) {
    handlerPromises.push(
      handleTracking({ parsed: enriched, eventId, eventTime, env })
        .then(r => ({ handler: 'tracking', ...r }))
        .catch(e => ({ handler: 'tracking', error: e.message }))
    );
  }

  if (productConfig && parsed.email) {
    handlerPromises.push(
      handleEncharge({ parsed: enriched, env })
        .then(r => ({ handler: 'encharge', ...r }))
        .catch(e => ({ handler: 'encharge', error: e.message }))
    );
  }

  if (productConfig && parsed.phone) {
    handlerPromises.push(
      handleManyChat({ parsed: enriched, env })
        .then(r => ({ handler: 'manychat', ...r }))
        .catch(e => ({ handler: 'manychat', error: e.message }))
    );
  }

  const results = await Promise.allSettled(handlerPromises);
  const resultMap = {};
  for (const r of results) {
    const val = r.status === 'fulfilled' ? r.value : { handler: 'unknown', error: r.reason?.message };
    resultMap[val.handler] = val;
  }

  // purchase_log always runs, in the background, so webhook response isn't blocked.
  context.waitUntil(
    handlePurchaseLog({ parsed: enriched, eventId, eventTime, resultMap, env })
  );

  return { eventId, handlers: Object.keys(resultMap) };
}

// -----------------------------------------------------------------------------
// HANDLER: Tracking — Meta CAPI + GA4 + Google Ads (needs checkoutData)
// -----------------------------------------------------------------------------
async function handleTracking({ parsed, eventId, eventTime, env }) {
  const { email, name, phone, value, currency, transactionId, productId, productName, items, checkoutData, productConfig, city, state, country, zipCode } = parsed;

  const hashedEm = await sha256(email);
  const nameParts = splitName(name);
  const hashedFn = await sha256(normalizeName(nameParts.fn));
  const hashedLn = await sha256(normalizeName(nameParts.ln));
  const hashedPh = await sha256(normalizePhone(phone, env.DEFAULT_COUNTRY_CODE));
  const hashedExternalId = await sha256(checkoutData.external_id || '');

  // Address fields — Meta CAPI expects lowercase, SHA-256 hashed.
  // ct = city, st = state (2-letter abbrev), zp = zip (digits only),
  // country = 2-letter ISO lowercase.
  const hashedCt = await sha256(normalizeName(city || ''));
  const hashedSt = await sha256(normalizeName(state || ''));
  const hashedZp = await sha256((zipCode || '').replace(/\D/g, ''));
  const hashedCountry = await sha256(normalizeName(country || ''));

  // Build a single item list both Meta and GA4 consume. Adapters should
  // always ship items[], but if an adapter hits an edge case and leaves
  // it empty we synthesize a single-item fallback from the top-level
  // product fields so `contents`/`items` stay non-empty for ROAS.
  const itemList = (Array.isArray(items) && items.length)
    ? items
    : [{ productId: productId || '', name: productName || '', price: { value, currency } }];
  const contents = itemList.map(it => ({
    id: String(it.productId || ''),
    quantity: parseInt(it.quantity, 10) || 1,
    item_price: parseFloat(it?.price?.value) || 0,
  }));
  const ga4Items = itemList.map(it => ({
    item_id: String(it.productId || ''),
    item_name: it.name || '',
    price: parseFloat(it?.price?.value) || 0,
    quantity: parseInt(it.quantity, 10) || 1,
    currency: it?.price?.currency || currency,
  }));

  const [metaResult, ga4Result, googleAdsResult] = await Promise.allSettled([
    sendToMeta({ checkoutData, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, hashedCt, hashedSt, hashedZp, hashedCountry, eventId, eventTime, value, currency, productName, contents, env }),
    sendToGA4({ checkoutData, hashedEm, transactionId, value, currency, ga4Items, env }),
    sendToGoogleAds({ checkoutData, productConfig, hashedEm, transactionId, value, currency, eventTime, env }),
  ]);

  // Parse Meta response
  let metaStatusCode = 0, metaResponseOk = 0, metaResponseBody = '', metaPayloadSent = null;
  if (metaResult?.status === 'fulfilled' && metaResult.value) {
    const v = metaResult.value;
    metaPayloadSent = v.payload;
    if (v.skipped) {
      metaResponseBody = `skipped: ${v.skipped}`;
    } else if (v.response) {
      metaStatusCode = v.response.status;
      metaResponseOk = v.response.ok ? 1 : 0;
      try { metaResponseBody = await v.response.text(); } catch (e) { metaResponseBody = `Read error: ${e.message}`; }
    }
  } else if (metaResult?.status === 'rejected') {
    metaResponseBody = `Fetch error: ${metaResult.reason?.message || 'unknown'}`;
  }

  // Parse GA4 response
  let ga4StatusCode = 0, ga4ResponseOk = 0, ga4ResponseBody = '', ga4PayloadSent = null;
  if (ga4Result?.status === 'fulfilled' && ga4Result.value) {
    const v = ga4Result.value;
    ga4PayloadSent = v.payload;
    if (v.skipped) {
      ga4ResponseBody = `skipped: ${v.skipped}`;
    } else if (v.response) {
      ga4StatusCode = v.response.status;
      ga4ResponseOk = v.response.ok ? 1 : 0;
      try { ga4ResponseBody = await v.response.text(); } catch (e) { ga4ResponseBody = `Read error: ${e.message}`; }
    }
  } else if (ga4Result?.status === 'rejected') {
    ga4ResponseBody = `Fetch error: ${ga4Result.reason?.message || 'unknown'}`;
  }

  // Parse Google Ads response. HTTP 200 is not enough — partialFailureError
  // can hold per-row rejections, so inspect the body on success.
  let googleAdsStatusCode = 0, googleAdsResponseOk = 0, googleAdsResponseBody = '', googleAdsPayloadSent = null;
  if (googleAdsResult?.status === 'fulfilled' && googleAdsResult.value) {
    const v = googleAdsResult.value;
    googleAdsPayloadSent = v.payload;
    if (v.skipped) {
      googleAdsResponseBody = `skipped: ${v.skipped}`;
    } else if (v.response) {
      googleAdsStatusCode = v.response.status;
      try { googleAdsResponseBody = await v.response.text(); } catch (e) { googleAdsResponseBody = `Read error: ${e.message}`; }
      if (v.response.ok) {
        let partialErr = null;
        try {
          const parsedBody = JSON.parse(googleAdsResponseBody);
          partialErr = parsedBody?.partialFailureError || null;
        } catch (_) { /* non-JSON body, leave partialErr null */ }
        googleAdsResponseOk = partialErr ? 0 : 1;
      }
    }
  } else if (googleAdsResult?.status === 'rejected') {
    googleAdsResponseBody = `Fetch error: ${googleAdsResult.reason?.message || 'unknown'}`;
  }

  return {
    metaStatusCode, metaResponseOk, metaResponseBody, metaPayloadSent,
    ga4StatusCode, ga4ResponseOk, ga4ResponseBody, ga4PayloadSent,
    googleAdsStatusCode, googleAdsResponseOk, googleAdsResponseBody, googleAdsPayloadSent,
    hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId,
  };
}

// -----------------------------------------------------------------------------
// HANDLER: Encharge — email marketing
// -----------------------------------------------------------------------------
async function handleEncharge({ parsed, env }) {
  if (!env.ENCHARGE_API_KEY) {
    return { statusCode: 0, responseOk: 0, responseBody: 'Missing ENCHARGE_API_KEY' };
  }

  const { email, name, productConfig } = parsed;
  if (!productConfig?.enchargeTag) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No enchargeTag for this product' };
  }
  const nameParts = splitName(name);

  const response = await fetch('https://api.encharge.io/v1/people', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Encharge-Token': env.ENCHARGE_API_KEY,
    },
    body: JSON.stringify({
      email: email,
      firstName: nameParts.fn,
      tags: productConfig.enchargeTag,
    }),
  });

  let responseBody = '';
  try { responseBody = await response.text(); } catch (e) { responseBody = `Read error: ${e.message}`; }

  return {
    statusCode: response.status,
    responseOk: response.ok ? 1 : 0,
    responseBody: responseBody,
  };
}

// -----------------------------------------------------------------------------
// HANDLER: ManyChat — create subscriber + add tag
// -----------------------------------------------------------------------------
async function handleManyChat({ parsed, env }) {
  if (!env.MANYCHAT_KEY) {
    return { statusCode: 0, responseOk: 0, responseBody: 'Missing MANYCHAT_KEY' };
  }

  const { name, phone, productConfig } = parsed;
  if (!productConfig?.manychatTagId) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No manychatTagId for this product' };
  }
  const nameParts = splitName(name);
  const manychatPhone = formatPhoneForManyChat(phone, env.DEFAULT_COUNTRY_CODE);

  if (!manychatPhone) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No valid phone for ManyChat' };
  }

  const authHeaders = {
    'Authorization': `Bearer ${env.MANYCHAT_KEY}`,
    'Content-Type': 'application/json',
  };

  // Step 1: create subscriber
  let subscriberId = '';
  let createBody = '';

  const createRes = await fetch('https://api.manychat.com/fb/subscriber/createSubscriber', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      first_name: nameParts.fn,
      last_name: nameParts.ln,
      whatsapp_phone: manychatPhone,
    }),
  });

  try { createBody = await createRes.text(); } catch (e) { createBody = `Read error: ${e.message}`; }

  if (!createRes.ok) {
    return {
      statusCode: createRes.status,
      responseOk: 0,
      responseBody: `createSubscriber failed: ${createBody}`,
    };
  }

  // Step 2: extract subscriber_id and add tag
  try {
    const createData = JSON.parse(createBody);
    subscriberId = createData.data?.id || '';
  } catch (e) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `Parse error: ${e.message} | body: ${createBody}` };
  }

  if (!subscriberId) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `No subscriber_id in response: ${createBody}` };
  }

  const tagRes = await fetch('https://api.manychat.com/fb/subscriber/addTag', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      subscriber_id: subscriberId,
      tag_id: productConfig.manychatTagId,
    }),
  });

  let tagBody = '';
  try { tagBody = await tagRes.text(); } catch (e) { tagBody = `Read error: ${e.message}`; }

  return {
    statusCode: tagRes.status,
    responseOk: tagRes.ok ? 1 : 0,
    responseBody: `createSubscriber: ${createBody} | addTag: ${tagBody}`,
  };
}

// -----------------------------------------------------------------------------
// HANDLER: Purchase Log — D1 insert (always runs, background)
// -----------------------------------------------------------------------------
async function handlePurchaseLog({ parsed, eventId, eventTime, resultMap, env }) {
  if (!env.DB) return;

  const { trk, email, name, phone, value, currency, transactionId, productId, productName, checkoutData, platformUtm, items } = parsed;
  const tracking = resultMap.tracking || {};
  const encharge = resultMap.encharge || {};
  const manychat = resultMap.manychat || {};

  const createdAt = Math.floor(Date.now() / 1000);
  let purchaseId = null;

  try {
    const result = await env.DB.prepare(`
      INSERT INTO purchase_log (
        trk, event_id, event_time,
        raw_email, raw_name, raw_phone,
        hashed_em, hashed_fn, hashed_ln, hashed_ph, hashed_external_id,
        client_ip_address, client_user_agent, fbp, fbc,
        value, currency, transaction_id,
        event_source_url,
        meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
        ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
        google_ads_status_code, google_ads_response_ok, google_ads_response_body, google_ads_payload_sent,
        gclid, gbraid, wbraid,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        product_id, product_name,
        encharge_status_code, encharge_response_ok, encharge_response_body,
        manychat_status_code, manychat_response_ok, manychat_response_body,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trk || '', eventId, eventTime,
      email, name, phone,
      tracking.hashedEm || '', tracking.hashedFn || '', tracking.hashedLn || '',
      tracking.hashedPh || '', tracking.hashedExternalId || '',
      checkoutData.ip_address || '', checkoutData.user_agent || '',
      checkoutData.fbp || '', checkoutData.fbc || '',
      parseFloat(value) || 0, currency, transactionId,
      checkoutData.event_source_url || '',
      tracking.metaStatusCode || 0, tracking.metaResponseOk || 0, tracking.metaResponseBody || '', tracking.metaPayloadSent ?? null,
      tracking.ga4StatusCode || 0, tracking.ga4ResponseOk || 0, tracking.ga4ResponseBody || '', tracking.ga4PayloadSent ?? null,
      tracking.googleAdsStatusCode || 0, tracking.googleAdsResponseOk || 0, tracking.googleAdsResponseBody || '', tracking.googleAdsPayloadSent ?? null,
      checkoutData.gclid || '', checkoutData.gbraid || '', checkoutData.wbraid || '',
      // UTMs prefer what the sales platform echoes back in the webhook
      // (platformUtm, authoritative when present), then fall back to what
      // the sales page persisted to checkout_sessions (checkoutData).
      // Platforms like Hotmart that don't carry UTMs natively rely on
      // the fallback + the sck-merge recovery in their adapter.
      platformUtm.utm_source || checkoutData.utm_source || '',
      platformUtm.utm_medium || checkoutData.utm_medium || '',
      platformUtm.utm_campaign || checkoutData.utm_campaign || '',
      platformUtm.utm_content || checkoutData.utm_content || '',
      platformUtm.utm_term || checkoutData.utm_term || '',
      productId || '', productName || '',
      encharge.statusCode || 0, encharge.responseOk || 0, encharge.responseBody || '',
      manychat.statusCode || 0, manychat.responseOk || 0, manychat.responseBody || '',
      createdAt
    ).run();

    purchaseId = result.meta?.last_row_id ?? null;
  } catch (e) {
    console.error('D1 purchase_log error:', e.message);
    return;
  }

  if (purchaseId == null) {
    console.error('D1 purchase_log: no last_row_id returned, skipping purchase_items insert', { transactionId });
    return;
  }

  const itemList = Array.isArray(items) ? items : [];
  if (itemList.length === 0) {
    return;
  }

  try {
    const itemStmt = env.DB.prepare(`
      INSERT INTO purchase_items (
        purchase_id, transaction_id, product_id, product_name,
        value, currency, created_at,
        utm_source, utm_campaign, utm_medium, utm_content, utm_term
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = itemList.map(item => itemStmt.bind(
      purchaseId,
      transactionId || null,
      String(item.productId || ''),
      item.name || null,
      parseFloat(item?.price?.value) || 0,
      item?.price?.currency || currency || 'BRL',
      createdAt,
      platformUtm.utm_source || checkoutData.utm_source || null,
      platformUtm.utm_campaign || checkoutData.utm_campaign || null,
      platformUtm.utm_medium || checkoutData.utm_medium || null,
      platformUtm.utm_content || checkoutData.utm_content || null,
      platformUtm.utm_term || checkoutData.utm_term || null,
    ));

    await env.DB.batch(batch);
  } catch (e) {
    // Lines failed but parent succeeded — roll back parent so SUM(items) == header invariant holds.
    console.error('D1 purchase_items error, rolling back parent purchase_log row', {
      transactionId, purchaseId, error: e.message,
    });
    try {
      await env.DB.prepare('DELETE FROM purchase_log WHERE id = ?').bind(purchaseId).run();
    } catch (rollbackErr) {
      console.error('CRITICAL: purchase_log rollback failed — manual reconciliation needed', {
        transactionId, purchaseId, error: rollbackErr.message,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// META CAPI — Purchase with full navigation data from D1
// -----------------------------------------------------------------------------
async function sendToMeta({ checkoutData, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, hashedCt, hashedSt, hashedZp, hashedCountry, eventId, eventTime, value, currency, productName, contents, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'missing meta env', payload: null, response: null };
  }

  const metaUserData = {
    client_ip_address: checkoutData.ip_address || '',
    client_user_agent: checkoutData.user_agent || '',
  };

  if (hashedEm) metaUserData.em = [hashedEm];
  if (hashedFn) metaUserData.fn = [hashedFn];
  if (hashedLn) metaUserData.ln = [hashedLn];
  if (hashedPh) metaUserData.ph = [hashedPh];
  if (hashedExternalId) metaUserData.external_id = [hashedExternalId];
  if (checkoutData.fbp) metaUserData.fbp = checkoutData.fbp;
  if (checkoutData.fbc) metaUserData.fbc = checkoutData.fbc;

  // Address / demographic fields — Meta Advanced Matching.
  // Each field is SHA-256 hashed after normalization (lowercase, trim).
  // https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
  if (hashedCt) metaUserData.ct = [hashedCt];
  if (hashedSt) metaUserData.st = [hashedSt];
  if (hashedZp) metaUserData.zp = [hashedZp];
  if (hashedCountry) metaUserData.country = [hashedCountry];

  // Purchase custom_data per Meta spec: currency + value are required;
  // content_type + content_ids + contents + content_name + num_items are
  // strongly recommended so catalog attribution and product-level ROAS
  // work in Ads Manager.
  const customData = {
    value: parseFloat(value) || 0,
    currency: currency,
    content_type: 'product',
  };
  if (contents && contents.length) {
    customData.contents = contents;
    const ids = contents.map(c => c.id).filter(Boolean);
    if (ids.length) customData.content_ids = ids;
    customData.num_items = contents.length;
  }
  if (productName) customData.content_name = productName;

  const metaPayload = {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: eventId,
      event_source_url: checkoutData.event_source_url || '',
      action_source: 'website',
      user_data: metaUserData,
      custom_data: customData,
    }],
  };

  if (env.META_TEST_EVENT_CODE) {
    metaPayload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  const payloadJson = JSON.stringify(metaPayload);
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -----------------------------------------------------------------------------
// GA4 Measurement Protocol — Purchase
// -----------------------------------------------------------------------------
async function sendToGA4({ checkoutData, hashedEm, transactionId, value, currency, ga4Items, env }) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return { skipped: 'missing ga4 env', payload: null, response: null };
  }

  const gaClientId = checkoutData.ga_client_id || `${Date.now()}.${Math.floor(Math.random() * 1000000000)}`;

  const purchaseParams = {
    transaction_id: transactionId,
    value: parseFloat(value) || 0,
    currency: currency,
    engagement_time_msec: 100,
  };
  if (ga4Items && ga4Items.length) purchaseParams.items = ga4Items;

  const ga4Payload = {
    client_id: gaClientId,
    events: [{
      name: 'purchase',
      params: purchaseParams,
    }],
  };

  if (hashedEm) {
    ga4Payload.user_properties = { email: { value: hashedEm } };
  }

  const payloadJson = JSON.stringify(ga4Payload);
  const response = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -----------------------------------------------------------------------------
// GOOGLE ADS API — uploadClickConversions (v21 REST)
// -----------------------------------------------------------------------------
// Pinning v21 in the URL: Google Ads SDKs (google-ads-api, google-ads-node) lag
// the REST API and break with "API version not found" — call REST directly.
async function getGoogleAdsAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (googleAdsTokenCache.token && googleAdsTokenCache.expiresAt > now + 30) {
    return googleAdsTokenCache.token;
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error('Google Ads token refresh failed:', resp.status, errBody);
    return null;
  }

  const data = await resp.json();
  if (!data.access_token) {
    console.error('Google Ads token refresh: no access_token in response', data);
    return null;
  }

  googleAdsTokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) - 60,
  };
  return data.access_token;
}

// Format unix seconds → "YYYY-MM-DD HH:MM:SS±HH:MM" in the recipient's
// configured timezone. Default is -03:00 (São Paulo, DST-free since 2019).
// Google Ads rejects conversions whose timestamp precedes the click with
// CONVERSION_PRECEDES_GCLID, so the offset must match the ad account's TZ.
function formatConversionDateTime(unixSeconds, offsetString) {
  const tz = offsetString || '-03:00';
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!match) {
    const d = new Date(unixSeconds * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const offsetSeconds = sign * (parseInt(match[2], 10) * 3600 + parseInt(match[3], 10) * 60);
  const shifted = new Date((unixSeconds + offsetSeconds) * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${tz}`;
}

async function sendToGoogleAds({ checkoutData, productConfig, hashedEm, transactionId, value, currency, eventTime, env }) {
  if (!env.GOOGLE_ADS_CUSTOMER_ID || !env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ||
      !env.GOOGLE_ADS_DEVELOPER_TOKEN || !env.GOOGLE_ADS_CLIENT_ID ||
      !env.GOOGLE_ADS_CLIENT_SECRET || !env.GOOGLE_ADS_REFRESH_TOKEN) {
    return { skipped: 'missing google ads env', payload: null, response: null };
  }

  if (!productConfig?.googleAdsConversionActionId) {
    return { skipped: 'no conversion action configured', payload: null, response: null };
  }

  // Click identifier required (gclid > wbraid > gbraid). Enhanced Conversions
  // for Leads is a different API surface and not handled here.
  const gclid = checkoutData.gclid || '';
  const wbraid = checkoutData.wbraid || '';
  const gbraid = checkoutData.gbraid || '';
  if (!gclid && !wbraid && !gbraid) {
    return { skipped: 'no click id', payload: null, response: null };
  }

  const accessToken = await getGoogleAdsAccessToken(env);
  if (!accessToken) {
    return { skipped: 'oauth token unavailable', payload: null, response: null };
  }

  const customerId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, '');
  const loginCustomerId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');

  const conversion = {
    conversionAction: `customers/${customerId}/conversionActions/${productConfig.googleAdsConversionActionId}`,
    conversionDateTime: formatConversionDateTime(eventTime, env.TIMEZONE_OFFSET),
    conversionValue: parseFloat(value) || 0,
    currencyCode: currency || 'BRL',
    orderId: String(transactionId || ''),
  };
  if (gclid) conversion.gclid = gclid;
  else if (wbraid) conversion.wbraid = wbraid;
  else if (gbraid) conversion.gbraid = gbraid;

  if (hashedEm) {
    conversion.userIdentifiers = [{ hashedEmail: hashedEm }];
  }

  const body = {
    conversions: [conversion],
    partialFailure: true,
    validateOnly: false,
  };

  const payloadJson = JSON.stringify(body);
  const response = await fetch(
    `https://googleads.googleapis.com/v21/customers/${customerId}:uploadClickConversions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': loginCustomerId,
        'Content-Type': 'application/json',
      },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
async function sha256(value) {
  if (!value) return '';
  const normalized = value.toLowerCase().trim();
  const encoded = new TextEncoder().encode(normalized);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Meta CAPI expects phone digits INCLUDING country code + area code
// (ex: `16505554444` or `5511987654321`). Purchase webhooks from sales
// platforms sometimes ship the number already prefixed, sometimes not;
// detect and prepend as needed. `countryCode` defaults to 55 (Brazil);
// recipients elsewhere set `env.DEFAULT_COUNTRY_CODE` — see the
// "decisions the recipient must make" table in CLAUDE.md.
function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  // Already starts with the configured country code at a plausible
  // total length → leave as-is.
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) {
    return digits;
  }
  // Plausibly a locally-formatted number (no country code yet) → prepend.
  if (digits.length >= 8 && digits.length <= 11) {
    return cc + digits;
  }
  // Any other length (likely an already-international foreign number
  // whose country code isn't our default) → leave untouched.
  return digits;
}

// Meta Advanced Matching spec for fn/ln is lowercase only — do NOT strip
// punctuation/accents. Meta's graph preserves apostrophes, hyphens, and
// diacritics; stripping them breaks hash matches for names like
// "O'Brien", "Garcia-Rodriguez", "João".
function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return { fn: parts[0] || '', ln: parts.slice(1).join(' ') || '' };
}

// ManyChat's WhatsApp API accepts the same "digits + country code" format
// Meta CAPI requires, so we reuse normalizePhone. Kept as a named helper
// so the intent at the call site stays explicit.
function formatPhoneForManyChat(phone, countryCode) {
  return normalizePhone(phone, countryCode);
}
