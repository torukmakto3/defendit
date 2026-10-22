/**
 * Stripe switches and webhook signature check. No SDK import and no network.
 *
 * `BILLING_ENABLED` is the wallet gate (learn caps, paid-defense 402). It does
 * not talk to Stripe. `PAYMENTS_ENABLED` is Checkout. While it is off, payment
 * routes answer 404 and the pricing page is hidden. The beta grant and the
 * €150 budget do not read `PAYMENTS_ENABLED`.
 *
 * Set both when buyers should pay and the wallet gate should apply.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { HttpError } from "./errors";
import { formatEur, isSku, PACKS, PAYG_CENTS, type Sku } from "./plans";

const LIVE_KEY_PREFIX = "sk_live_";

export function paymentsEnabled(): boolean {
  const value = process.env.PAYMENTS_ENABLED;
  return value === "1" || value === "true";
}

/** Live charges are refused unless `STRIPE_ALLOW_LIVE` is exactly `true`. */
export function liveStripeRefused(): boolean {
  if (!paymentsEnabled()) return false;
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const mode = (process.env.STRIPE_MODE ?? "test").trim().toLowerCase() || "test";
  const allowLive = process.env.STRIPE_ALLOW_LIVE === "true";
  return (key.startsWith(LIVE_KEY_PREFIX) || mode === "live") && !allowLive;
}

/**
 * Called when the server starts. A deployment with payments on and a live
 * key does not become ready unless `STRIPE_ALLOW_LIVE=true`.
 */
export function assertStripeReady(): void {
  if (!liveStripeRefused()) return;
  throw new Error(
    "Refusing to start: PAYMENTS_ENABLED is true with a live Stripe key or STRIPE_MODE=live, and STRIPE_ALLOW_LIVE is not true.",
  );
}

const CHECKOUT_SKUS = ["defense", "challenge", "pack3", "pack8"] as const;

export type CheckoutSku = (typeof CHECKOUT_SKUS)[number];

/** One-time Checkout only. Plans stay on the ledger until the integration plan lands. */
export function isCheckoutSku(sku: Sku): sku is CheckoutSku {
  switch (sku) {
    case "defense":
    case "challenge":
    case "pack3":
    case "pack8":
      return CHECKOUT_SKUS.includes(sku);
    case "subscription_month":
    case "subscription_year":
    case "team_month":
    case "enterprise_month":
      return false;
    default: {
      const unknown: never = sku;
      return unknown;
    }
  }
}

export function stripeSecretKey(): string | null {
  const value = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  return value || null;
}

export function stripeWebhookSecret(): string | null {
  const value = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  return value || null;
}

export interface CheckoutProduct {
  sku: CheckoutSku;
  name: string;
  priceLabel: string;
  detail: string;
}

/** Null while payments are off, so the pricing page and dashboard hide checkout. */
export function checkoutCatalog(): CheckoutProduct[] | null {
  if (!paymentsEnabled()) return null;
  return [
    {
      sku: "defense",
      name: "One defense",
      priceLabel: formatEur(PAYG_CENTS.defense),
      detail: "1 defense credit for you.",
    },
    {
      sku: "challenge",
      name: "One challenge",
      priceLabel: formatEur(PAYG_CENTS.challenge),
      detail: "1 challenge credit to send to someone else. You can't claim a challenge you bought.",
    },
    {
      sku: "pack3",
      name: "3-credit pack",
      priceLabel: formatEur(PACKS.pack3.priceCents),
      detail: `${PACKS.pack3.credits} credits, usable for a defense or a challenge.`,
    },
    {
      sku: "pack8",
      name: "8-credit pack",
      priceLabel: formatEur(PACKS.pack8.priceCents),
      detail: `${PACKS.pack8.credits} credits, usable for a defense or a challenge.`,
    },
  ];
}

export function assertSkuForSale(sku: string): CheckoutSku {
  if (!isSku(sku) || !isCheckoutSku(sku)) throw new HttpError(400, "That price is not for sale.");
  return sku;
}

const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Stripe-Signature is `t=<unix>,v1=<hex>`. The MAC is HMAC-SHA256 of
 * `${t}.${rawBody}` with the webhook secret. No request leaves this process.
 */
export function verifyStripeSignature(payload: string, header: string | null, secret: string): unknown {
  if (!header || !secret) throw new HttpError(400, "Invalid Stripe signature.");
  let timestamp = "";
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const eq = item.indexOf("=");
    if (eq === -1) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) {
    throw new HttpError(400, "Invalid Stripe signature.");
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > SIGNATURE_TOLERANCE_SEC) throw new HttpError(400, "Invalid Stripe signature.");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const ok = signatures.some((sig) => {
    const got = Buffer.from(sig, "utf8");
    if (got.length !== expectedBuf.length) return false;
    return timingSafeEqual(got, expectedBuf);
  });
  if (!ok) throw new HttpError(400, "Invalid Stripe signature.");
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new HttpError(400, "Invalid Stripe payload.");
  }
}
