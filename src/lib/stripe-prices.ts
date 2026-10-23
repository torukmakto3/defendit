/**
 * Stripe catalog lookup keys. Prices are loaded at runtime with
 * `prices.list({ lookup_keys, expand: ['data.product'] })` and cached for a
 * few minutes. There are no price-id environment variables.
 *
 * Checkout sells pay-as-you-go, packs, Pro, and Team. Enterprise base is sold
 * by Quote. The extra-unit price is the overage fallback until a meter exists.
 */

import Stripe from "stripe";
import sandboxIds from "../../docs/stripe-sandbox-ids.json";
import { HttpError } from "./errors";
import type { Sku } from "./plans";
import { stripeSdk } from "./stripe-client";

export const STRIPE_LOOKUP_KEYS = {
  defense: "dit_defense_payg",
  challenge: "dit_challenge_payg",
  pack3: "dit_pack_3",
  pack8: "dit_pack_8",
  proMonthly: "dit_pro_monthly",
  proYearly: "dit_pro_yearly",
  teamMonthly: "dit_team_monthly",
  enterpriseBase: "dit_enterprise_base",
  enterpriseExtraUnit: "dit_enterprise_extra_unit",
  foundingLifetime: "founding_lifetime",
} as const;

/** Usage meter name. The meter itself is not created yet. */
export const DEFENSE_OVERAGE_METER = "defense_overage";

export function meterEventName(): string {
  const value = process.env.STRIPE_METER_EVENT_NAME?.trim() ?? "";
  return value || DEFENSE_OVERAGE_METER;
}

const CHECKOUT_LOOKUP_KEYS = {
  defense: STRIPE_LOOKUP_KEYS.defense,
  challenge: STRIPE_LOOKUP_KEYS.challenge,
  pack3: STRIPE_LOOKUP_KEYS.pack3,
  pack8: STRIPE_LOOKUP_KEYS.pack8,
  subscription_month: STRIPE_LOOKUP_KEYS.proMonthly,
  subscription_year: STRIPE_LOOKUP_KEYS.proYearly,
  team_month: STRIPE_LOOKUP_KEYS.teamMonthly,
  founding_lifetime: STRIPE_LOOKUP_KEYS.foundingLifetime,
} as const;

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

export function lookupKeyForSku(sku: Sku): string | null {
  switch (sku) {
    case "defense":
    case "challenge":
    case "pack3":
    case "pack8":
    case "subscription_month":
    case "subscription_year":
    case "team_month":
    case "founding_lifetime":
      return CHECKOUT_LOOKUP_KEYS[sku];
    case "enterprise_month":
      return STRIPE_LOOKUP_KEYS.enterpriseBase;
    default: {
      const unknown: never = sku;
      return unknown;
    }
  }
}

export function checkoutLookupKey(sku: keyof typeof CHECKOUT_LOOKUP_KEYS): string {
  return CHECKOUT_LOOKUP_KEYS[sku];
}

/** Map a catalog lookup key back to an app sku. The extra-unit price is not a grant. */
export function skuForLookupKey(lookupKey: string): Sku | null {
  switch (lookupKey) {
    case STRIPE_LOOKUP_KEYS.defense:
      return "defense";
    case STRIPE_LOOKUP_KEYS.challenge:
      return "challenge";
    case STRIPE_LOOKUP_KEYS.pack3:
      return "pack3";
    case STRIPE_LOOKUP_KEYS.pack8:
      return "pack8";
    case STRIPE_LOOKUP_KEYS.proMonthly:
      return "subscription_month";
    case STRIPE_LOOKUP_KEYS.proYearly:
      return "subscription_year";
    case STRIPE_LOOKUP_KEYS.teamMonthly:
      return "team_month";
    case STRIPE_LOOKUP_KEYS.enterpriseBase:
      return "enterprise_month";
    case STRIPE_LOOKUP_KEYS.enterpriseExtraUnit:
      return null;
    case STRIPE_LOOKUP_KEYS.foundingLifetime:
      return "founding_lifetime";
    default:
      return null;
  }
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

export async function resolveCheckoutPrice(sku: keyof typeof CHECKOUT_LOOKUP_KEYS): Promise<ResolvedStripePrice> {
  const key = CHECKOUT_LOOKUP_KEYS[sku];
  const prices = await resolvePrices([key]);
  const price = prices.get(key);
  if (!price) throw new HttpError(502, `Stripe catalog is missing lookup key ${key}.`);
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
  const stripe = stripeSdk();
  return {
    async list(lookupKeys) {
      try {
        const list = await stripe.prices.list({
          lookup_keys: [...lookupKeys],
          expand: ["data.product"],
        });
        const found = new Set(
          list.data.map((price) => price.lookup_key).filter((key): key is string => !!key),
        );
        if (lookupKeys.some((key) => !found.has(key))) {
          await assertCatalogAccount(async () => {
            const account = await stripe.accounts.retrieve(null);
            return account.id;
          });
        }
        return list.data.map((price) => ({
          id: price.id,
          lookup_key: price.lookup_key,
          currency: price.currency,
          unit_amount: price.unit_amount,
          product: readListedProduct(price.product),
        }));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof Stripe.errors.StripeError) {
          console.error("[stripe]", e.type, e.code ?? "");
          throw new HttpError(502, "Stripe could not load the price catalog.");
        }
        throw e;
      }
    },
  };
}

/**
 * Sandbox account bundled from `docs/stripe-sandbox-ids.json`.
 * A static import is what Vercel traces into the function. A cwd read is not.
 */
const SANDBOX_STRIPE_ACCOUNT_ID = sandboxIds.account.stripe_context.startsWith("acct_")
  ? sandboxIds.account.stripe_context
  : null;

/**
 * Account the catalog is expected to live in.
 * `STRIPE_EXPECTED_ACCOUNT_ID` wins. A blank value turns the check off.
 * When that variable is unset, a non-live key uses the bundled sandbox id.
 * A live key does not assume the sandbox account.
 */
export function expectedStripeAccountId(): string | null {
  if (process.env.STRIPE_EXPECTED_ACCOUNT_ID !== undefined) {
    const fromEnv = process.env.STRIPE_EXPECTED_ACCOUNT_ID.trim();
    return fromEnv || null;
  }
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const mode = (process.env.STRIPE_MODE ?? "").trim().toLowerCase();
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_") || mode === "live") return null;
  return SANDBOX_STRIPE_ACCOUNT_ID;
}

/**
 * A key for a different Stripe account lists no prices and used to surface as
 * "missing lookup key". Say which account the key belongs to instead.
 * No expected id, or an account lookup the key cannot perform, leaves the
 * original catalog error in place.
 */
export async function assertCatalogAccount(lookupAccount: () => Promise<string | null>): Promise<void> {
  const expected = expectedStripeAccountId();
  if (!expected) return;
  let actual: string | null = null;
  try {
    actual = await lookupAccount();
  } catch (e) {
    console.error("[stripe] account check skipped", e instanceof Error ? e.message : e);
    return;
  }
  if (!actual || actual === expected) return;
  throw new HttpError(
    502,
    `Stripe secret key belongs to ${actual}, not ${expected}. This is the wrong Stripe account, so the price catalog does not match.`,
  );
}
