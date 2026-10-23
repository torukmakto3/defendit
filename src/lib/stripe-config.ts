/**
 * Stripe switch and catalog. No SDK import and no network.
 *
 * `BILLING_ENABLED` is the only payments flag. It is the wallet gate and
 * Checkout. While it is off, Stripe routes answer 402 and `/pricing` is
 * hidden. The beta grant and the €150 budget do not read a second flag.
 */

import { HttpError } from "./errors";
import { billingEnabled, formatEur, isSku, PACKS, PAYG_CENTS, skuPriceCents, type Sku } from "./plans";

const LIVE_KEY_PREFIXES = ["sk_live_", "rk_live_"] as const;

/** Live charges are refused unless `STRIPE_ALLOW_LIVE` is exactly `true`. */
export function liveStripeRefused(): boolean {
  if (!billingEnabled()) return false;
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const mode = (process.env.STRIPE_MODE ?? "test").trim().toLowerCase() || "test";
  const allowLive = process.env.STRIPE_ALLOW_LIVE === "true";
  const liveKey = LIVE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
  return (liveKey || mode === "live") && !allowLive;
}

/**
 * Kept so a caller can log a live-key misconfiguration. It does not throw:
 * checkout and the portal refuse the request, and the rest of the site stays up.
 */
export function assertStripeReady(): void {
  if (!liveStripeRefused()) return;
  console.error(
    "[stripe] BILLING_ENABLED is true with a live Stripe key or STRIPE_MODE=live, and STRIPE_ALLOW_LIVE is not true. Checkout and the portal will refuse.",
  );
}

/** `STRIPE_TAX_ENABLED=true` turns on Checkout automatic tax. Default off. */
export function stripeTaxEnabled(): boolean {
  const value = process.env.STRIPE_TAX_ENABLED;
  return value === "1" || value === "true";
}

/**
 * Checkout collects a tax id unless `STRIPE_TAX_ID_COLLECTION` is `0` or `false`.
 * Default on. A returning customer then needs `customer_update`.
 */
export function stripeTaxIdCollectionEnabled(): boolean {
  const value = process.env.STRIPE_TAX_ID_COLLECTION;
  if (value == null || value.trim() === "") return true;
  return value === "1" || value === "true";
}

const CHECKOUT_SKUS = [
  "defense",
  "challenge",
  "pack3",
  "pack8",
  "subscription_month",
  "subscription_year",
  "team_month",
] as const;

export type CheckoutSku = (typeof CHECKOUT_SKUS)[number];

/** Pay-as-you-go, packs, Pro, and Team. Enterprise is sold by Quote. */
export function isCheckoutSku(sku: Sku): sku is CheckoutSku {
  switch (sku) {
    case "defense":
    case "challenge":
    case "pack3":
    case "pack8":
    case "subscription_month":
    case "subscription_year":
    case "team_month":
      return CHECKOUT_SKUS.includes(sku);
    case "enterprise_month":
      return false;
    default: {
      const unknown: never = sku;
      return unknown;
    }
  }
}

/** Customer-facing name. The waiver must not show the raw sku. */
export function checkoutProductName(sku: string): string {
  if (!isSku(sku) || !isCheckoutSku(sku)) return "this purchase";
  switch (sku) {
    case "defense":
      return "One defense";
    case "challenge":
      return "One challenge";
    case "pack3":
      return "3-credit pack";
    case "pack8":
      return "8-credit pack";
    case "subscription_month":
      return "Pro monthly";
    case "subscription_year":
      return "Pro yearly";
    case "team_month":
      return "Team";
    default: {
      const unknown: never = sku;
      return unknown;
    }
  }
}

export function checkoutMode(sku: CheckoutSku): "payment" | "subscription" {
  switch (sku) {
    case "defense":
    case "challenge":
    case "pack3":
    case "pack8":
      return "payment";
    case "subscription_month":
    case "subscription_year":
    case "team_month":
      return "subscription";
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

export function stripePortalConfigurationId(): string | null {
  const value = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() ?? "";
  return value || null;
}

export interface CheckoutProduct {
  sku: CheckoutSku;
  name: string;
  priceLabel: string;
  detail: string;
}

/** Null while billing is off, so the pricing page and dashboard hide checkout. */
export function checkoutCatalog(): CheckoutProduct[] | null {
  if (!billingEnabled()) return null;
  return [
    {
      sku: "defense",
      name: checkoutProductName("defense"),
      priceLabel: formatEur(PAYG_CENTS.defense),
      detail: "1 defense credit for you. VAT included.",
    },
    {
      sku: "challenge",
      name: checkoutProductName("challenge"),
      priceLabel: formatEur(PAYG_CENTS.challenge),
      detail: "1 challenge credit to send to someone else. You can't claim a challenge you bought. VAT included.",
    },
    {
      sku: "pack3",
      name: checkoutProductName("pack3"),
      priceLabel: formatEur(PACKS.pack3.priceCents),
      detail: `${PACKS.pack3.credits} credits, usable for a defense or a challenge. VAT included.`,
    },
    {
      sku: "pack8",
      name: checkoutProductName("pack8"),
      priceLabel: formatEur(PACKS.pack8.priceCents),
      detail: `${PACKS.pack8.credits} credits, usable for a defense or a challenge. VAT included.`,
    },
    {
      sku: "subscription_month",
      name: checkoutProductName("subscription_month"),
      priceLabel: formatEur(skuPriceCents("subscription_month")),
      detail: "10 defenses, 5 challenges, and 10 Learn projects each period. VAT included.",
    },
    {
      sku: "subscription_year",
      name: checkoutProductName("subscription_year"),
      priceLabel: formatEur(skuPriceCents("subscription_year")),
      detail:
        "10 defenses, 5 challenges, and 10 Learn projects each month. Unused defenses and challenges do not roll over. VAT included.",
    },
    {
      sku: "team_month",
      name: checkoutProductName("team_month"),
      priceLabel: formatEur(skuPriceCents("team_month")),
      detail: "50 defenses a month. VAT is added. Not switchable with Pro in the portal.",
    },
  ];
}

export function assertSkuForSale(sku: string): CheckoutSku {
  if (!isSku(sku) || !isCheckoutSku(sku)) throw new HttpError(400, "That price is not for sale.");
  return sku;
}
