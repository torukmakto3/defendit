# Payments

Stripe Checkout in test mode. `BILLING_ENABLED` is the only switch. While it is off, the beta grant and the €150 budget behave as they do today, `/pricing` is hidden, and every Stripe route answers **402 Billing is not enabled**. No card is required.

Turning it on opens Checkout and applies the wallet gate (paid defenses, Learn slot caps). Customers are classic Stripe Customers (`cus_…`), stored on `billing_profiles.stripe_customer_id`. Subscriptions are stored on `user_plans.stripe_subscription_id`. Accounts v2 is not used: Checkout, the portal, invoices, and the meter’s customer mapping all take a classic customer id.

## What Checkout sells

| Lookup key | SKU | Price | Mode |
|---|---|---|---|
| `dit_defense_payg` | defense | €4 VAT included | payment |
| `dit_challenge_payg` | challenge | €3 VAT included | payment |
| `dit_pack_3` | pack3 | €10 VAT included, 3 flex credits | payment |
| `dit_pack_8` | pack8 | €20 VAT included, 8 flex credits | payment |
| `dit_pro_monthly` | subscription_month | €11/month VAT included | subscription |
| `dit_pro_yearly` | subscription_year | €99/year VAT included. Each month refills to 10 defenses, 5 challenges, and 10 Learn projects. Unused defenses and challenges do not roll over | subscription |
| `dit_team_monthly` | team_month | €149/month, VAT added | subscription |

`dit_enterprise_base` (€490/month, VAT added, 200 defenses) is not in Checkout. It is sold by quote. `dit_enterprise_extra_unit` (€2.50, VAT added) is the invoice-item fallback for Enterprise overage. The `defense_overage` meter is not created and no meter events are sent.

Prices are loaded with `prices.list({ lookup_keys, expand: ['data.product'] })` and cached for five minutes. There are no `STRIPE_PRICE_*` variables and no price ids in production code. A missing key fails closed.

The test-mode catalog (account `acct_1UNDfOBIumCL91iA`, all `livemode: false`) is in `docs/stripe-sandbox-ids.json` and `tests/fixtures/stripe/sandbox-catalog.json`. Those ids are for docs and tests. Production resolves by lookup key.

## Checkout

`POST /api/billing/checkout` with `{ "sku" }` from a signed-in user. The server creates a hosted Session:

- No `payment_method_types` (dynamic payment methods).
- `adaptive_pricing.enabled` is false (EUR only).
- `metadata` `{ user_id, sku }` on the Session, on `subscription_data`, and on `payment_intent_data`.
- `client_reference_id` is the user id.
- `subscription_data.billing_mode.type` is `flexible` for Pro and Team.
- `automatic_tax` only when `STRIPE_TAX_ENABLED=true` (default off).
- `tax_id_collection` is on.
- An existing `cus_…` is reused. Otherwise payment mode sets `customer_email` and `customer_creation: always`.
- Success URL is `/dashboard?checkout={CHECKOUT_SESSION_ID}`. Cancel is `/billing/cancel`.

`POST /api/billing/portal` opens the Customer Portal for the stored customer. Return URL is `/dashboard`. Set `STRIPE_PORTAL_CONFIGURATION_ID` to pin a configuration. The sandbox default `bpc_1UTNuQBIumCL91iAG7sGZYLQ` is not hard-coded. The portal can show invoices, update the payment method, email, address, and tax id, cancel at period end, and switch Pro monthly and yearly. Team and Enterprise are not switchable there.

## Webhooks

`POST /api/billing/webhook`. Node runtime, raw body, `Stripe.webhooks.constructEvent`. A bad signature is 400.

The same Stripe event id is acknowledged once. Credits are keyed on the Checkout session id (`stripe:cs_…`) or the invoice id (`stripe:in_…`), so a new event id for the same object does not grant again.

| Event | Effect |
|---|---|
| `checkout.session.completed` | Store the customer. One-time sku, `payment_status=paid`: grant from the line’s lookup key. Subscription mode: store the subscription and grant nothing. |
| `checkout.session.async_payment_succeeded` | Same grant as completed, same session id. |
| `checkout.session.async_payment_failed` | No grant. A notice on the dashboard. |
| `invoice.paid` | `subscription_create`, `subscription_cycle`, or `subscription_update`. The sku comes from `parent.subscription_details.metadata` or the line lookup key, not `invoice.metadata`. A monthly plan grants its allowance once (Pro 10 defenses, 5 challenges, 10 Learn slots; Team 50; Enterprise 200). Yearly Pro grants month 0 only, keyed `refill:<subscription id>:<period index>`. |
| `invoice.payment_failed` | `past_due` and a portal notice. Credits stay. |
| `customer.subscription.updated` | Sync plan, interval, status, `cancel_at_period_end`. No grant. |
| `customer.subscription.deleted` | Plan returns to pay as you go. Unused subscription defenses and challenges expire. Purchased, pack, and beta credits stay. |
| `charge.refunded` | Claw back unspent credits from that purchase. Never below zero. Flag the account if some were already spent. |
| `charge.dispute.created` | Same clawback, and flag the account. |
| `invoice.created` | If the customer has unbilled Enterprise overage rows, add `dit_enterprise_extra_unit` × that count. |
| `invoice.finalized` | Ignored. `invoice.paid` is the grant. |
| `credit_note.created` | Logged. No ledger change. |
| `cash_balance.funds_available` | Logged. `invoice.paid` is the settlement. |
| `customer_cash_balance_transaction.created` | Logged. |
| `payment_method.attached` / `payment_method.detached` | Logged. |
| `charge.succeeded` | Stores the card fingerprint used to block a self-claim. |

The line check compares lookup key, or the catalog price id when the line has no lookup key. It does not compare `amount_total`.

## Yearly Pro refill

`dit_pro_yearly` is billed once a year and refilled every month. Stripe's `invoice.paid` grants month 0. `grantDueSubscriptionRefills` grants each later month the subscription is still inside. The purge cron runs it for every due subscription. The dashboard and the start of a Learn or Defend session run it for that user. There is no separate worker.

Each subscription stores `current_period_start`, `current_period_end`, `grant_anchor` (the subscription start, or `billing_cycle_anchor`), and `last_granted_period_index`. The period index is the number of UTC monthly anniversaries of that anchor, clamped to the last day of a short month (31 January lands on 28 February, or 29 in a leap year). The ledger key is `refill:<subscription id>:<period index>`, so the invoice and the job cannot both credit the same month. A paid year gets at most 12 grants. The next yearly invoice starts the next run of 12.

A refill tops up to the allowance. Unused subscription defenses and challenges expire, then the month's 10 and 5 are granted. Learn slots top up to 10. Purchased, pack, and beta credits stay. Nothing rolls over.

The job grants a subscription only when its status is `active` or `trialing`, it is not past `current_period_end`, and it has not been deleted. `customer.subscription.deleted`, status `unpaid`, and status `canceled` stop further refills. `cancel_at_period_end` does not, while the status is still active and the period has not ended. A missed run catches up the months in between and does not grant them twice.

## Environment

| Variable | Purpose |
|---|---|
| `BILLING_ENABLED` | `1` or `true` turns the wallet gate and Checkout on. Default off. Routes answer 402 when off. |
| `STRIPE_SECRET_KEY` | Restricted key. Sandbox key in preview and dev. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for this endpoint. |
| `STRIPE_MODE` | `test` by default. |
| `STRIPE_TAX_ENABLED` | `true` enables `automatic_tax`. Default off. |
| `STRIPE_METER_EVENT_NAME` | Optional. Default `defense_overage`. Not sent. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Optional portal configuration id. |
| `APP_URL` | Origin for success, cancel, and portal return URLs. |
| `STRIPE_ALLOW_LIVE` | Must be exactly `true` to allow `sk_live_`, `rk_live_`, or `STRIPE_MODE=live`. Leave unset. |

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is not used.

The restricted key needs permission to write Checkout Sessions, Customers, Subscriptions, the customer portal, Invoices, and Invoice Items, and to read Products, Prices, Charges, Refunds, and Events.

A live key while billing is off does not block the beta. With billing on, the process refuses to start unless `STRIPE_ALLOW_LIVE=true`.

## Local listener

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,invoice.created,invoice.finalized,credit_note.created,cash_balance.funds_available,customer_cash_balance_transaction.created,payment_method.attached,payment_method.detached
```

Put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`. Set `BILLING_ENABLED=true` and the sandbox restricted key. The dev server must restart so the startup check sees the key.
