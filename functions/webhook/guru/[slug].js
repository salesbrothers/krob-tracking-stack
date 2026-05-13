// -----------------------------------------------------------------------------
// Digital Guru (digitalmanager.guru) webhook adapter.
//
// URL shape: /webhook/guru/<GURU_WEBHOOK_SLUG>
// The per-recipient UUID stored in env.GURU_WEBHOOK_SLUG gates the endpoint.
//
// Platform specifics (confirmed against real webhooks, May 2026):
//
//   Guru sends TWO structurally different webhook shapes:
//
//   1. `webhook_type: "eticket"` — ticket/event products.
//      Transaction data lives INSIDE `body.transaction.*`.
//      Status: `body.transaction.status`.
//      UTMs/sck: `body.transaction.source.*`.
//
//   2. `webhook_type: "transaction"` — standalone products and ORDER BUMPS.
//      Transaction data lives at the ROOT of `body.*`.
//      Status: `body.status`.
//      UTMs/sck: `body.source.*`.
//      Order bumps have `body.is_order_bump === 1` and `body.items[]`.
//
//   Both share the same field names once you find the right nesting level.
//   The adapter detects the shape via `body.webhook_type` and normalizes.
//
//   - `api_token` in body is the account-level API token (fixed per account).
//   - `trk` is passed as `?sck=<uuid>` and returned in `source.checkout_source`.
//   - `payment.total` is DECIMAL in reais (29 = R$ 29.00), not centavos.
//   - Paid event: `status === 'approved'`.
//   - Phone arrives split: `contact.phone_local_code` + `contact.phone_number`.
//   - UTMs are natively captured in `source.*`.
//   - Guru retries on non-200; `purchase_log.transaction_id` unique index dedupes.
//   - Each product in a multi-product order (main + order bumps) arrives as a
//     SEPARATE webhook call. Each gets its own `transaction_id` (`body.id` or
//     `body.transaction.id`).
//   - ORDER BUMP TRACKING STRATEGY: order bumps (`is_order_bump === 1`) are
//     logged to D1 (purchase_log + purchase_items) for the dashboard, but do
//     NOT fire Meta CAPI / GA4 / Google Ads events. This prevents duplicate
//     Purchase events that inflate conversion count and distort CPA/ROAS.
//     Achieved by clearing `trk` for order bumps — _core.js skips the
//     tracking fan-out when trk is empty, but still writes purchase_log.
// -----------------------------------------------------------------------------

import { processPurchase } from '../_core.js';
import { guardSlug } from '../_utils.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;

  const slugFailure = guardSlug(params.slug, env.GURU_WEBHOOK_SLUG);
  if (slugFailure) return slugFailure;

  try {
    const body = await request.json();

    // Validate api_token when GURU_API_TOKEN is configured.
    if (env.GURU_API_TOKEN && body.api_token !== env.GURU_API_TOKEN) {
      return new Response(
        JSON.stringify({ error: 'not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ---------------------------------------------------------------------------
    // Detect payload shape and normalize to a flat set of variables.
    //
    // eticket:    body.transaction.{status, contact, product, payment, source, id}
    // transaction: body.{status, contact, product, payment, source, id}
    // ---------------------------------------------------------------------------
    const isEticket = body.webhook_type === 'eticket';
    const tx = isEticket ? (body.transaction || {}) : body;

    const status = tx.status || '';
    const transactionId = tx.id || (isEticket ? '' : body.id) || '';

    // Only process approved transactions.
    if (status !== 'approved') {
      return new Response(
        JSON.stringify({ ok: true, skipped: 'not approved',
          status, webhook_type: body.webhook_type,
          is_order_bump: body.is_order_bump || 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const isOrderBump = !isEticket && body.is_order_bump === 1;

    const contact = tx.contact || {};
    const product = tx.product || {};
    const payment = tx.payment || {};
    const source = tx.source || {};

    const phone = contact.phone_number
      ? (contact.phone_local_code || '') + contact.phone_number
      : '';

    const value = parseFloat(payment.total) || 0;
    const currency = payment.currency || 'BRL';
    const productIdStr = String(product.internal_id || product.marketplace_id || '');

    // Build items array. Transaction (order bump) webhooks include `body.items[]`;
    // eticket webhooks don't — synthesize a single item from `product`.
    let items;
    const rawItems = !isEticket && Array.isArray(body.items) ? body.items : [];
    if (rawItems.length > 0) {
      items = rawItems.map(it => ({
        productId: String(it.internal_id || it.marketplace_id || it.id || ''),
        name: it.name || '',
        quantity: parseInt(it.qty, 10) || 1,
        price: {
          value: parseFloat(it.unit_value) || 0,
          currency,
        },
      }));
    } else {
      items = [{
        productId: productIdStr,
        name: product.name || '',
        price: { value, currency },
      }];
    }

    // Order bumps: clear trk so _core.js logs to D1 but skips Meta/GA4/Google Ads.
    // This prevents duplicate Purchase events that inflate conversion count.
    const trk = isOrderBump ? '' : (source.checkout_source || '');

    const parsed = {
      platform: 'guru',
      trk,
      isOrderBump,
      email: contact.email || '',
      name: contact.name || '',
      phone,
      value,
      currency,
      transactionId,
      productId: productIdStr,
      productName: product.name || '',
      items,
      // Address / demographic fields for Meta CAPI Advanced Matching.
      // Guru exposes address_city, address_state, address_country,
      // address_zip_code inside the contact object. Gender and date of
      // birth are NOT available in Guru webhooks.
      city: contact.address_city || '',
      state: contact.address_state || '',
      country: contact.address_country || '',
      zipCode: contact.address_zip_code || '',
      platformUtm: {
        utm_source: source.utm_source || '',
        utm_medium: source.utm_medium || '',
        utm_campaign: source.utm_campaign || '',
        utm_content: source.utm_content || '',
        utm_term: source.utm_term || '',
      },
    };

    const result = await processPurchase({ parsed, env, context });

    return new Response(
      JSON.stringify({ ok: true, event_id: result.eventId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Guru webhook error:', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
