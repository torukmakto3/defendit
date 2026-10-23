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
| `founding_lifetime` | founding_lifetime | €149 once, VAT included. Lifetime Pro. Each month refills to 10 defenses, 5 challenges, and 10 Learn projects. Unused defenses and challenges do not roll over. 100 spots | payment |

`dit_enterprise_base` (€490/month, VAT added, 200 defenses) is not in Checkout. It is sold by quote. `dit_enterprise_extra_unit` (€2.50, VAT added) is the invoice-item fallback for Enterprise overage. The `defense_overage` meter is not created and no meter events are sent.

Prices are loaded with `prices.list({ lookup_keys, expand: ['data.product'] })` and cached for five minutes. There are no `STRIPE_PRICE_*` variables and no price ids in production code. A missing key fails closed.

The test-mode catalog (account `acct_1UNDfOBIumCL91iA`, all `livemode: false`) is in `docs/stripe-sandbox-ids.json` and `tests/fixtures/stripe/sandbox-catalog.json`. Those ids are for docs and tests. Production resolves by lookup key.

### Founding member sandbox object

Create this in the sandbox before turning billing on. Do not hard-code the resulting price id. The app resolves `founding_lifetime`.

| Field | Value |
|---|---|
| Product name | DefendIT Founding member |
| Product description | Founding member, €149 once, lifetime Pro, 100 spots. Each month refills to 10 defenses, 5 challenges, and 10 Learn projects. Unused defenses and challenges do not roll over. |
| Price | 14900 EUR, one-time |
| Lookup key | `founding_lifetime` |
| Tax behavior | inclusive |
| Tax code | `txcd_10103000` (same consumer code as Pro and a defense) |

Checkout is `mode: payment`. Session metadata is `{ user_id, sku, lookup_key }`. `payment_intent_data.metadata` is `{ user_id, sku }`. There is no `subscription_data`. `expires_at` is about 35 minutes after the hold starts, which stays above Stripe's 30-minute minimum. A spot is reserved when the session is created, released on `checkout.session.expired` or by the purge sweep, and confirmed on the paid webhook. The database lock refuses a 101st spot.

A monthly or yearly subscriber cannot buy founding while that subscription is `active`, `trialing`, or `past_due`. Checkout returns 409 and does not reserve a spot. It does not set `cancel_at_period_end` and it does not cancel the Stripe subscription. Cancel it in the billing portal and wait until the plan is no longer in those statuses, then start founding checkout. That is the safe option: a second paid plan's renewal or end can expire the credits on the plan already stored, and cancelling at period end would leave the old subscription alive through the period. A founding membership cannot start Pro or Team checkout. Pay-as-you-go and packs still check out. Later invoices for an old subscription do not replace a lifetime plan that is already stored and do not grant a second allowance.

A `charge.refunded` or `charge.dispute.created` that matches a founding grant ends the lifetime plan, frees the spot, and claws unused founding credits in proportion to the refund. It does not expire the remaining subscription credits on top of that claw. One open spot per account. After a refund, the same account can buy again if a spot is free.

While `BILLING_ENABLED` is off, `/pricing` stays hidden. `/founding` says founding spots are coming soon and takes a waitlist email. No account is required.

## Checkout

`POST /api/billing/checkout` with `{ "sku" }` from a signed-in user. The server creates a hosted Session:

- No `payment_method_types` (dynamic payment methods).
- `adaptive_pricing.enabled` is false (EUR only, for this beta).
- `consent_collection.terms_of_service` is `required`. `custom_text.terms_of_service_acceptance` states the EU 14-day withdrawal waiver, names the product, and links to `/terms`. The sandbox needs a Terms of service URL in Settings, Public details, before that consent is accepted. Point it at `/terms`.
- `metadata` `{ user_id, sku }` on the Session, on `subscription_data`, and on `payment_intent_data`.
- `client_reference_id` is the user id.
- `subscription_data.billing_mode.type` is `flexible` for Pro and Team.
- `automatic_tax` only when `STRIPE_TAX_ENABLED=true` (default off).
- `tax_id_collection` is on.
- An existing `cus_…` is reused. Otherwise payment mode sets `customer_email` and `customer_creation: always`.
- Success URL is `/dashboard?checkout={CHECKOUT_SESSION_ID}`. Cancel is `/billing/cancel`.
- Pricing and the wallet checkout link to `/terms` with `<a href="/terms">`. This repo does not define that page, and it does not add the footer link.

Pro monthly, Pro yearly, and Team checkout return 409 while this account's plan is `active`, `trialing`, or `past_due`, including a founding lifetime plan. `/pricing`, `/founding`, and the dashboard open the billing portal instead of Checkout for those prices. A one-time defense, challenge, or pack still starts Checkout.

Checkout is limited per account (`checkout:<user>`) and per hashed IP. The IP bucket is checked first. A request that is already over a limit is rejected with 429 and is not written again, so retrying does not move `window_start` and does not add to `checkout:<user>`.

`POST /api/billing/portal` opens the Customer Portal for the stored customer. Return URL is `/dashboard`. Set `STRIPE_PORTAL_CONFIGURATION_ID` to pin a configuration. The sandbox default `bpc_1UTNuQBIumCL91iAG7sGZYLQ` is not hard-coded. The portal can show invoices, update the payment method, email, address, and tax id, cancel at period end, and switch Pro monthly and yearly. Team and Enterprise are not switchable there. Founding is not a Stripe subscription, so the portal cannot switch it to Pro.

## Webhooks

`POST /api/billing/webhook`. Node runtime, raw body, `Stripe.webhooks.constructEvent`. A bad signature is 400.

The same Stripe event id is acknowledged once. Credits are keyed on the Checkout session id (`stripe:cs_…`) or the invoice id (`stripe:in_…`), so a new event id for the same object does not grant again.

| Event | Effect |
|---|---|
| `checkout.session.completed` | Store the customer. One-time sku, `payment_status=paid`: grant from the line’s lookup key. Subscription mode: store the subscription and grant nothing. A one-time purchase reads the card fingerprint from the PaymentIntent's latest charge. A subscription Session usually has no PaymentIntent, so the fingerprint is stored from the invoice payment instead. A deleted subscription is not set active again. |
| `checkout.session.async_payment_succeeded` | Same grant as completed, same session id. |
| `checkout.session.async_payment_failed` | No grant. A notice on the dashboard. |
| `checkout.session.expired` | Release a founding spot that is still reserved for that Checkout session. No grant. |
| `invoice.paid` | `subscription_create`, `subscription_cycle`, or `subscription_update`. The sku comes from the non-proration line's `lookup_key`, then `parent.subscription_details.metadata`. `invoice.metadata` is ignored. Proration lines are not granted. The payment intent and charge are read from `invoicePayments.list({ invoice })`, not from `invoice.charge` or `invoice.payment_intent`. A monthly plan grants its allowance once (Pro 10 defenses, 5 challenges, 10 Learn slots; Team 50; Enterprise 200). Yearly Pro grants month 0 only, keyed `refill:<subscription id>:<period index>`, and stores that payment on the grant row. |
| `invoice.payment_failed` | `past_due` only when `markPlanPastDue` updates the stored subscription (it returns whether a row changed). The "Payment failed" notice is set when that update lands, or when the invoice subscription id already equals `user_plans.stripe_subscription_id` (a repeat failure on a plan that is already past due). Credits stay. A different subscription does not mark the plan past due and does not set the notice. |
| `customer.subscription.updated` | Sync plan, interval, status, `cancel_at_period_end`. The price `lookup_key` wins over metadata, so a portal switch from monthly to yearly sticks. No grant. An older event does not overwrite a newer one. `paused`, `incomplete`, and any unknown status are stored as non-active. The write happens when the stored subscription id is null, equals this event, or the stored plan is no longer `active` or `trialing`. An old or incomplete subscription does not replace an active plan. |
| `customer.subscription.deleted` | Plan returns to pay as you go only when the deleted id is the one stored on the plan. Unused subscription defenses and challenges expire in that case. Purchased, pack, and beta credits stay. A different subscription does not change the plan and does not expire credits. |
| `charge.refunded` | Claw back unspent credits from the grants with that charge or payment intent. Another purchase is left alone. Removal is capped at the bucket balance minus the credits still outstanding on the user's other unrefunded grants in that bucket, and never goes below zero. A subscription top-up has already expired earlier months, so those rows do not reserve the current balance. A partial refund removes `floor(credits × amount_refunded / amount)` and does not stop yearly refills. A refund with no charge amount removes the whole grant. Flag the account if the latest month, or the purchase, was already spent. A full refund of yearly Pro sets `refills_stopped` so later months are not granted. It does not mark the subscription terminal and it does not cancel the subscription in Stripe. The next paid invoice clears the flag and grants. |
| `charge.dispute.created` | Same clawback for the whole grant, and flag the account. A yearly dispute sets `refills_stopped` the same way a full refund does, without canceling in Stripe. |
| `invoice.created` | If the customer has unbilled Enterprise overage rows, add `dit_enterprise_extra_unit` × that count. |
| `invoice.finalized` | Ignored. `invoice.paid` is the grant. |
| `credit_note.created` | Logged. No ledger change. |
| `cash_balance.funds_available` | Logged. `invoice.paid` is the settlement. |
| `customer_cash_balance_transaction.created` | Logged. |
| `payment_method.attached` / `payment_method.detached` | Logged. |
| `charge.succeeded` | Stores the card fingerprint when it arrives. Checkout does not wait for this event. |

The line check compares lookup key, or the catalog price id when the line has no lookup key. It does not compare `amount_total`.

Checkout for a subscription uses the same rule as `customer.subscription.updated`: it does not replace an active or trialing plan whose stored subscription id is different. Returning customers are sent with `customer_update.name` and `customer_update.address` set to `auto`, which Stripe requires when `customer` and tax id collection are both set.

## Yearly Pro refill

`dit_pro_yearly` is billed once a year and refilled every month. Stripe's `invoice.paid` grants month 0. `grantDueSubscriptionRefills` grants each later month the subscription is still inside. The purge cron runs it for every due subscription. The dashboard and the start of a Learn or Defend session run it for that user. There is no separate worker.

Founding uses the same monthly top-up. Month 0 is granted from the paid Checkout session, keyed `refill:founding_<user id>:0`. Later months come from the same refill job, with no 12-grant cap and no period end. The plan interval stays `lifetime`.

Each subscription stores `current_period_start`, `current_period_end`, `grant_anchor` (the subscription start, or `billing_cycle_anchor`), and `last_granted_period_index`. The period index is the number of UTC monthly anniversaries of that anchor, clamped to the last day of a short month (31 January lands on 28 February, or 29 in a leap year). The ledger key is `refill:<subscription id>:<period index>`, so the invoice and the job cannot both credit the same month. A paid year gets at most 12 grants. The next yearly invoice starts the next run of 12.

A refill tops up to the allowance. Unused subscription defenses and challenges expire, then the month's 10 and 5 are granted. Learn slots top up to 10. Purchased, pack, and beta credits stay. Nothing rolls over.

Each month is also a `stripe_grants` row. The invoice month stores that year's payment intent and charge. Later months copy the newest grant at or before that month, so year 2 is not linked to year 1's charge. A refund or dispute matches only the months tied to that payment. A partial refund claws the proportional credits and leaves refills running. A full refund or a dispute sets `refills_stopped` and does not cancel the Stripe subscription. The next `invoice.paid` clears the flag and grants the new year. Months that were already topped up (expired) do not, by themselves, flag the account. A shortfall on the latest month does.

The job grants a subscription only when its status is `active` or `trialing`, it is not past `current_period_end`, it has not been deleted, and `refills_stopped` is not set. `customer.subscription.deleted`, status `unpaid`, and status `canceled` stop further refills. A full refund or a dispute stops them without canceling in Stripe. `cancel_at_period_end` does not, while the status is still active and the period has not ended. A missed run catches up the months in between and does not grant them twice.

## Environment

| Variable | Purpose |
|---|---|
| `BILLING_ENABLED` | `1` or `true` turns the wallet gate and Checkout on. Default off. Routes answer 402 when off. |
| `STRIPE_SECRET_KEY` | Restricted key. Sandbox key in preview and dev. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for this endpoint. |
| `STRIPE_MODE` | `test` by default. |
| `STRIPE_TAX_ENABLED` | `true` enables `automatic_tax`. Default off. |
| `STRIPE_TAX_ID_COLLECTION` | `0` or `false` turns off Checkout tax id collection. Default on. A saved customer sends `customer_update` for name and address. |
| `STRIPE_EXPECTED_ACCOUNT_ID` | Optional. When a catalog lookup misses, compare `accounts.retrieve` with this id and say the key is for the wrong account. Blank turns the check off. Unset uses the sandbox id in `docs/stripe-sandbox-ids.json` for a non-live key, and skips the check for a live key. |
| `STRIPE_METER_EVENT_NAME` | Optional. Default `defense_overage`. Not sent. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Optional portal configuration id. |
| `APP_URL` | Origin for success, cancel, and portal return URLs. |
| `STRIPE_ALLOW_LIVE` | Must be exactly `true` to allow `sk_live_`, `rk_live_`, or `STRIPE_MODE=live`. Leave unset. |

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is not used.

The restricted key needs permission to write Checkout Sessions, Customers, Subscriptions, the customer portal, Invoices, and Invoice Items, and to read Products, Prices, Charges, Refunds, Events, Invoice Payments, and PaymentIntents.

A live key while billing is off does not block the beta. With billing on, checkout and the portal answer 403 unless `STRIPE_ALLOW_LIVE=true`. That misconfiguration does not stop the rest of the site.

## Local listener

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,charge.succeeded,invoice.created,invoice.finalized,credit_note.created,cash_balance.funds_available,customer_cash_balance_transaction.created,payment_method.attached,payment_method.detached
```

Put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`. Set `BILLING_ENABLED=true` and the sandbox restricted key. The dev server must restart so it reads the new environment. A live key does not stop that process; the checkout and portal routes refuse it.
