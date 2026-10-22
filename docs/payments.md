# Payments

Stripe Checkout sells the consumer price list. It is off until Luis has a Stripe **test** account and sets the variables below. Nothing in this repo is a live key.

## Two switches

`BILLING_ENABLED` is the wallet gate from the credit ledger.

- Off (unset, `false`, or anything other than `1` or `true`): the one-time beta grant still applies, Learn uploads are not capped, and a defense after the free allowance says those free defenses are used up. Sponsored defenses still count against `BETA_BUDGET_EUR` (default 150).
- On: a defense needs a credit, and Learn projects stop at the account's slot limit.

`PAYMENTS_ENABLED` is Stripe Checkout.

- Off: `/pricing` is not shown, the dashboard has no buy buttons, and `/api/billing/checkout` and `/api/billing/webhook` answer 404.
- On: a signed-in user can start Checkout. Credits are added only by the webhook.

The two flags are independent on purpose. The ledger tests turn the wallet gate on without calling Stripe, and Checkout can be tested without changing who may spend the beta grant. Set **both** when buyers should pay and the gate should apply. Leave **both** off for the beta. Turning on payments does not change the beta grant or the €150 budget.

`/api/admin/billing/simulate` is still the local stand-in. It writes the ledger and does not call Stripe.

## What a payment grants

Prices are EUR and include VAT. A defense and a challenge each cost 1 credit.

| Product | Lookup key | Price | Ledger |
|---|---|---|---|
| One defense | `dit_defense_payg` | €4 | 1 defense credit (`source: purchase`) |
| One challenge for someone else | `dit_challenge_payg` | €3 | 1 challenge credit (`source: purchase`) |
| 3-credit pack | `dit_pack_3` | €10 | 3 flexible credits, usable for a defense or a challenge |
| 8-credit pack | `dit_pack_8` | €20 | 8 flexible credits, same |

Checkout asks Stripe for those four lookup keys (`prices.list`, expanding `data.product`) and caches the result for five minutes. A missing key, two prices for one key, or an amount that is not the EUR price above fails the request and is not cached. There is no `STRIPE_PRICE_*` variable.

Pack credits are the ledger's `flex` kind, so they pay for either action. `dit_pro_monthly`, `dit_pro_yearly`, `dit_team_monthly`, `dit_enterprise_base`, and the `defense_overage` meter are reserved in `src/lib/stripe-prices.ts`. Checkout does not sell them yet.

Checkout is created on the server for a signed-in user, in `payment` mode only. `client_reference_id` and `metadata` (`user_id`, `sku`, `lookup_key`) tie the session to that account. The line item uses the price id Stripe returned for that lookup key. Success and cancel pages are `/billing/success` and `/billing/cancel`. The success page does not grant credits.

## Webhook

`POST /api/billing/webhook` runs on the Node runtime and verifies `Stripe-Signature` against the raw body. Event ids are stored in `stripe_events`. A repeat does not grant again.

- `checkout.session.completed` with `mode=payment` grants a one-time product.
- `checkout.session.completed` with `mode=subscription` does not grant. `invoice.paid` does, including the first invoice and each renewal (`billing_reason` `subscription_create` or `subscription_cycle`).
- `customer.subscription.deleted` (and an update whose status is canceled) marks the plan canceled. Credits already granted stay. The next period is not granted.
- `charge.refunded` claws back unused credits from that payment only. The balance never goes below zero. If some of those credits were already spent or held, the account is flagged (`billing_profiles.flag_reason = refund_credits_already_spent`) and the dashboard says so. Beta credits are a different source and are not taken.
- `charge.succeeded` stores the card fingerprint when Stripe sends one. A buyer cannot claim a challenge they created, including one paid with the same card. That check is `assertNotSelfClaim` and does not call Stripe.

## Environment

| Variable | Purpose |
|---|---|
| `PAYMENTS_ENABLED` | `1` or `true` turns Checkout on. Default off. |
| `BILLING_ENABLED` | `1` or `true` turns the wallet gate on. Default off. |
| `STRIPE_MODE` | `test` (default) or `live`. |
| `STRIPE_SECRET_KEY` | Secret key. Use a test key (`sk_test_…`). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from `stripe listen` or the dashboard endpoint. |
| `STRIPE_ALLOW_LIVE` | Must be exactly `true` or the process refuses to start when payments are on and the key is live, or `STRIPE_MODE=live`. |

`APP_URL` (already used for other links) is the absolute origin of the success and cancel URLs.

The server refuses to start when `PAYMENTS_ENABLED` is on and `STRIPE_SECRET_KEY` begins with `sk_live_`, or `STRIPE_MODE=live`, unless `STRIPE_ALLOW_LIVE=true`. A live key left in the environment while payments are off does not block the beta.

## Testing with the Stripe CLI

Do this after Luis has a test account. No live mode.

1. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and `stripe login` against the test account.
2. In the test-mode catalog, the one-time prices already use the lookup keys in the table above. Checkout reads them at runtime. Do not copy price ids into the environment.
3. Put the test secret key in `STRIPE_SECRET_KEY`. Leave `STRIPE_MODE=test`.
4. Set `PAYMENTS_ENABLED=true`. Set `BILLING_ENABLED=true` as well if the wallet gate should apply while you click through.
5. `npm run dev`, then in another terminal:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
```

6. Copy the `whsec_…` the CLI prints into `STRIPE_WEBHOOK_SECRET` and restart `npm run dev`.
7. Sign in, open `/pricing`, and buy a product with [test card](https://docs.stripe.com/testing) `4242 4242 4242 4242`. The dashboard updates when the CLI forwards `checkout.session.completed` or `invoice.paid`.
8. Refund the payment from the Dashboard or `stripe refunds create`. Unused credits come off the wallet. Spent credits flag the account and do not drive the balance negative.

`npm test` mocks Checkout and never calls Stripe. The signature, duplicate event, each product, renewal, refund, and live-key refusal are covered there.
