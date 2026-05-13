# Digital Guru (digitalmanager.guru)

## Identity

- **Platform name**: Digital Guru
- **Webhook endpoint**: `/webhook/guru/<SLUG>`
- **Adapter file**: `functions/webhook/guru/[slug].js`
- **Sandbox availability**: No sandbox. Test with a real purchase (PIX R$ 1,00 or 100%-off coupon).

## Endpoint security — obscure URL

Same pattern as all adapters: UUID v4 stored as `env.GURU_WEBHOOK_SLUG`, compared via `guardSlug()`.

Additionally, the Guru webhook includes an `api_token` field in every payload body. When `env.GURU_API_TOKEN` is set, the adapter validates it matches. This is the Guru account-level API token (found in Painel admin → Minha Conta → seção API).

- **Signature header name**: N/A (token is in the JSON body, not a header)
- **Algorithm**: Static token comparison (`body.api_token === env.GURU_API_TOKEN`)
- **What is signed**: N/A
- **Recipient dashboard path for the signing secret**: Painel admin → Minha Conta → API → copiar API Token

## The `trk` field

- **URL parameter name on checkout URL**: `sck` (checkout source)
- **Webhook payload field path**: `body.transaction.source.checkout_source` (confirmado em 2 webhooks reais, maio 2026). Docs oficiais citam `trackings`, mas os payloads reais usam `source`. Adaptador checa ambos, priorizando `source`.
- **Character-set constraints**: UUID (36 chars) passes through without mangling. Tested with standard UUID v4 format.

Note: The Guru API Reference lists `trk` as a recognized tracking field, but it does NOT appear in webhook payloads. Use `sck` instead — it maps to `checkout_source` in the webhook's `source` object.

## Payload shape

Key fields (sanitized from a real eticket webhook):

```json
{
  "api_token": "<account_api_token>",
  "webhook_type": "eticket",
  "id": "<uuid>",
  "status": "assigned",
  "transaction": {
    "id": "<uuid>",
    "status": "approved",
    "contact": {
      "name": "Nome Completo",
      "email": "email@example.com",
      "phone_number": "11999998888",
      "phone_local_code": "55"
    },
    "product": {
      "internal_id": "<uuid>",
      "marketplace_id": "1234567890",
      "name": "Nome do Produto",
      "offer": { "id": "<uuid>", "name": "Nome da Oferta" }
    },
    "payment": {
      "total": 29,
      "currency": "BRL",
      "method": "pix",
      "installments": { "qty": 1, "value": 29 }
    },
    "source": {
      "source": null,
      "checkout_source": null,
      "utm_source": "FBAds_Instagram_Feed",
      "utm_campaign": "campaign_name",
      "utm_medium": "medium_value",
      "utm_content": "content_value",
      "utm_term": "term_value"
    }
  }
}
```

Field mapping:

| Normalized field | Payload path |
|---|---|
| `trk` | `source.checkout_source` (inside `transaction.source` for eticket, `body.source` for transaction). Order bumps: cleared to `''` |
| `email` | `body.transaction.contact.email` |
| `name` | `body.transaction.contact.name` |
| `phone` | `body.transaction.contact.phone_local_code` + `body.transaction.contact.phone_number` |
| `value` | `body.transaction.payment.total` — decimal in reais (29 = R$ 29.00) |
| `currency` | `body.transaction.payment.currency` |
| `transactionId` | `body.transaction.id` |
| `productId` | `body.transaction.product.internal_id` (fallback: `marketplace_id`) |
| `productName` | `body.transaction.product.name` |
| `items[]` | Single-item synthesized from product fields (eticket) or `body.items[]` (transaction/order bump) |
| `city` | `contact.address_city` (hashed → Meta `ct`) |
| `state` | `contact.address_state` (hashed → Meta `st`) |
| `country` | `contact.address_country` (hashed → Meta `country`) |
| `zipCode` | `contact.address_zip_code` (hashed → Meta `zp`) |
| `platformUtm.*` | `source.utm_*` (inside `transaction.source` for eticket, `body.source` for transaction) |

## Paid-sale filter

Two-level status check for etickets:

1. **E-ticket lifecycle status** (`body.status`): `open` → `invited` → `assigned` → `checked_in` (or `canceled`). Only `invited` means "payment confirmed, ticket issued". The adapter returns 200 + skip for all other statuses.
2. **Payment status** (`body.transaction.status`): `approved` is the only one processed. Others (`pending`, `canceled`, `refunded`, `chargeback`, `expired`) are acknowledged with 200 but not processed.

For transaction webhooks (`webhook_type: "transaction"`), only the payment status check applies (`body.status === 'approved'`).

**CRITICAL**: Guru fires the eticket webhook on EVERY lifecycle transition (assigned, checked_in, etc.), not just on purchase. Without the `body.status === 'invited'` filter, each ticket generates duplicate purchase records every time its status changes. This was discovered in production — an `assigned` event arrived days after the original purchase and created a ghost purchase with no attribution data.

## Known gotchas

- **E-ticket vs payment status**: The top-level `body.status` is the e-ticket lifecycle status (invited/assigned/checked_in/etc.), NOT the payment status. The payment status lives at `body.transaction.status`. Both must be checked for etickets.
- Phone number arrives split into `phone_local_code` (country code, e.g. "55") and `phone_number` (digits). The adapter concatenates them.
- `payment.total` is already in reais (decimal), not centavos. No division needed (unlike Kiwify which uses cents).
- `webhook_type` can be `"eticket"` or `"transaction"` — both carry the full transaction object, but etickets require the extra lifecycle filter.
- UTMs are natively captured by Guru in `transaction.source.*` — this is a bonus for attribution even when the `trk` chain is missing.
- The `infrastructure` object does NOT include `facebook_browser_id` or `ga_id` — these must be captured on the sales page before redirect.
- **Address fields** are available inside `contact.*`: `address_city`, `address_state`, `address_country`, `address_zip_code`. The adapter extracts these and _core.js hashes them for Meta CAPI Advanced Matching (`ct`, `st`, `country`, `zp`).

## TWO webhook shapes

Guru sends structurally different payloads depending on `webhook_type`:

### 1. `eticket` — ticket/event products
Transaction data nests inside `body.transaction.*`:
```
body.transaction.status
body.transaction.contact.*
body.transaction.product.*
body.transaction.payment.*
body.transaction.source.checkout_source  (← trk)
```

### 2. `transaction` — standalone products and ORDER BUMPS
Transaction data lives at the ROOT of `body.*`:
```
body.status
body.contact.*
body.product.*
body.payment.*
body.source.checkout_source  (← trk)
body.is_order_bump  (1 = order bump)
body.items[]
```

The adapter detects the shape via `body.webhook_type` and normalizes both to the same parsed object.

## Order bump handling

Each product in a multi-product order (main + order bumps) arrives as a **separate webhook call** with its own `transaction_id`. Order bumps have `body.is_order_bump === 1`.

Strategy: order bumps are logged to D1 (`purchase_log` + `purchase_items`) for the dashboard, but do **NOT** fire Meta CAPI / GA4 / Google Ads events. This prevents duplicate Purchase events that inflate conversion count and distort CPA/ROAS. Achieved by clearing `trk` to empty string — `_core.js` skips the tracking fan-out when trk is empty but still writes `purchase_log`.

## Verification test

1. Note the webhook URL from deploy: `https://escola-da-pele.pages.dev/webhook/guru/<slug>`
2. In the Guru dashboard: configure the webhook URL for transaction events.
3. Fire a real test purchase (PIX de R$ 1,00 or cupom 100% off).
4. Query `purchase_log`:
   ```
   npx wrangler d1 execute escola-da-pele-db --remote --command \
     "SELECT transaction_id, trk, value, currency, meta_response_ok FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
5. Hit `/webhook/guru/wrong-slug` — expect 404.

## Environment variables

| Name | Required | Description |
|---|---|---|
| `GURU_WEBHOOK_SLUG` | Yes | UUID v4 that gates the webhook URL |
| `GURU_API_TOKEN` | Recommended | Account API token for payload validation (Painel → Minha Conta → API) |
