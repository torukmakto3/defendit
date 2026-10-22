/**
 * Stripe catalog lookup keys. Prices are loaded at runtime with
 * `prices.list({ lookup_keys, expand: ['data.product'] })` and cached for a
 * few minutes. There are no price-id environment variables.
 *
 * Checkout sells the one-time keys only. The plan and meter names are reserved
 * for the integration that is still coming.
 */

import Stripe from "stripe";
import { HttpError } from "./errors";

export const STRIPE_LOOKUP_KEYS = {
  defense: "dit_defense_payg",
  challenge: "dit_challenge_payg",
  pack3: "dit_pack_3",
  pack8: "dit_pack_8",
  proMonthly: "dit_pro_monthly",
  proYearly: "dit_pro_yearly",
  teamMonthly: "dit_team_monthly",
  enterpriseBase: "dit_enterprise_base",
} as const;

/** Usage meter name. Not reported yet. */
export const DEFENSE_OVERAGE_METER = "defense_overage";

/** Pay-as-you-go and packs. Subscriptions are not Checkout products yet. */
export const ONE_TIME_LOOKUP_KEYS = {
  defense: STRIPE_LOOKUP_KEYS.defense,
  challenge: STRIPE_LOOKUP_KEYS.challenge,
  pack3: STRIPE_LOOKUP_KEYS.pack3,
  pack8: STRIPE_LOOKUP_KEYS.pack8,
} as const;

export type OneTimeSku = keyof typeof ONE_TIME_LOOKUP_KEYS;

const PRICE_CACHE_MS = 5 * 60 * 1000;

export interface ResolvedStripePrice {
  lookupKey: string;
  priceId: string;
  currency: string;
  unitAmount: number;
  productId: string | null;
  productName: string | null;
}

interface ListedPrice {
  id: string;
  lookup_key: string | null;
  currency: string;
  unit_amount: number | null;
  product?: string | { id: string; name?: string | null; deleted?: boolean } | null;
}

export interface StripePriceClient {
  list(lookupKeys: readonly string[]): Promise<ListedPrice[]>;
}

let override: StripePriceClient | null = null;
let cached: { fingerprint: string; at: number; prices: Map<string, ResolvedStripePrice> } | null = null;
let stripeClient: { key: string; stripe: Stripe } | null = null;

export function checkoutLookupKey(sku: OneTimeSku): string {
  return ONE_TIME_LOOKUP_KEYS[sku];
}

/** Vitest injects a fake catalog. Pass null to use Stripe again. */
export function setStripePriceClientForTests(client: StripePriceClient | null): void {
  override = client;
  cached = null;
}

/** Makes the next resolve miss the in-memory catalog cache. */
export function expireStripePriceCacheForTests(): void {
  if (cached) cached.at = 0;
}

/**
 * Load every requested lookup key. A missing key, a key with two prices, or a
 * price with no unit amount throws and is not cached.
 */
export async function resolvePrices(lookupKeys: readonly string[]): Promise<Map<string, ResolvedStripePrice>> {
  const unique = [...new Set(lookupKeys)];
  if (unique.length === 0) return new Map();
  const fingerprint = `${process.env.STRIPE_SECRET_KEY?.trim() ?? ""}\n${unique.slice().sort().join("\n")}`;
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < PRICE_CACHE_MS) {
    return cached.prices;
  }
  const listed = await priceClient().list(unique);
  const prices = indexPrices(unique, listed);
  cached = { fingerprint, at: Date.now(), prices };
  return prices;
}

export async function resolveCheckoutPrice(sku: OneTimeSku): Promise<ResolvedStripePrice> {
  const prices = await resolvePrices(Object.values(ONE_TIME_LOOKUP_KEYS));
  const price = prices.get(ONE_TIME_LOOKUP_KEYS[sku]);
  if (!price) {
    throw new HttpError(502, `Stripe catalog is missing lookup key ${ONE_TIME_LOOKUP_KEYS[sku]}.`);
  }
  return price;
}

function indexPrices(lookupKeys: readonly string[], listed: ListedPrice[]): Map<string, ResolvedStripePrice> {
  const wanted = new Set(lookupKeys);
  const prices = new Map<string, ResolvedStripePrice>();
  for (const price of listed) {
    const lookupKey = price.lookup_key ?? "";
    if (!wanted.has(lookupKey)) continue;
    if (prices.has(lookupKey)) {
      throw new HttpError(502, `Stripe returned more than one price for lookup key ${lookupKey}.`);
    }
    if (price.unit_amount == null) {
      throw new HttpError(502, `Stripe price for lookup key ${lookupKey} has no unit amount.`);
    }
    const product = readProduct(price.product);
    prices.set(lookupKey, {
      lookupKey,
      priceId: price.id,
      currency: price.currency,
      unitAmount: price.unit_amount,
      productId: product.id,
      productName: product.name,
    });
  }
  const missing = lookupKeys.filter((key) => !prices.has(key));
  if (missing.length === 1) {
    throw new HttpError(502, `Stripe catalog is missing lookup key ${missing[0]}.`);
  }
  if (missing.length > 1) {
    throw new HttpError(502, `Stripe catalog is missing lookup keys ${missing.join(", ")}.`);
  }
  return prices;
}

function readListedProduct(product: Stripe.Price["product"]): ListedPrice["product"] {
  if (typeof product === "string") return product;
  if ("deleted" in product && product.deleted) return { id: product.id, deleted: true };
  return { id: product.id, name: product.name };
}

function readProduct(product: ListedPrice["product"]): { id: string | null; name: string | null } {
  if (!product) return { id: null, name: null };
  if (typeof product === "string") return { id: product, name: null };
  if ("deleted" in product && product.deleted) return { id: product.id, name: null };
  return { id: product.id, name: product.name ?? null };
}

function priceClient(): StripePriceClient {
  if (override) return override;
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!key) throw new HttpError(501, "Stripe is not configured");
  if (!stripeClient || stripeClient.key !== key) {
    stripeClient = { key, stripe: new Stripe(key, { typescript: true, maxNetworkRetries: 1 }) };
  }
  const stripe = stripeClient.stripe;
  return {
    async list(lookupKeys) {
      try {
        const list = await stripe.prices.list({
          lookup_keys: [...lookupKeys],
          expand: ["data.product"],
        });
        return list.data.map((price) => ({
          id: price.id,
          lookup_key: price.lookup_key,
          currency: price.currency,
          unit_amount: price.unit_amount,
          product: readListedProduct(price.product),
        }));
      } catch (e) {
        if (e instanceof Stripe.errors.StripeError) {
          console.error("[stripe]", e.type, e.code ?? "");
          throw new HttpError(502, "Stripe could not load the price catalog.");
        }
        throw e;
      }
    },
  };
}
