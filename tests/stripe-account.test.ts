import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/errors";
import { assertCatalogAccount, expectedStripeAccountId } from "../src/lib/stripe-prices";

const SANDBOX_ACCOUNT = "acct_1UNDfOBIumCL91iA";

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {
    STRIPE_EXPECTED_ACCOUNT_ID: process.env.STRIPE_EXPECTED_ACCOUNT_ID,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_MODE: process.env.STRIPE_MODE,
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("expected Stripe account", () => {
  it("uses the sandbox file when no account is configured", () => {
    delete process.env.STRIPE_EXPECTED_ACCOUNT_ID;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_MODE;
    expect(expectedStripeAccountId()).toBe(SANDBOX_ACCOUNT);
  });

  it("prefers STRIPE_EXPECTED_ACCOUNT_ID", () => {
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = "acct_expected";
    expect(expectedStripeAccountId()).toBe("acct_expected");
  });

  it("stays off when the expected id is blank or the key is live", () => {
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = "  ";
    expect(expectedStripeAccountId()).toBeNull();

    delete process.env.STRIPE_EXPECTED_ACCOUNT_ID;
    process.env.STRIPE_MODE = "live";
    expect(expectedStripeAccountId()).toBeNull();

    delete process.env.STRIPE_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_live_other";
    expect(expectedStripeAccountId()).toBeNull();

    process.env.STRIPE_SECRET_KEY = "rk_live_other";
    expect(expectedStripeAccountId()).toBeNull();
  });
});

describe("catalog account check", () => {
  it("does not call Stripe when no account is expected", async () => {
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = "";
    let called = false;
    await assertCatalogAccount(async () => {
      called = true;
      return "acct_other";
    });
    expect(called).toBe(false);
  });

  it("names the key's account instead of a missing lookup key", async () => {
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = SANDBOX_ACCOUNT;
    await expect(assertCatalogAccount(async () => SANDBOX_ACCOUNT)).resolves.toBeUndefined();

    await expect(assertCatalogAccount(async () => "acct_wrong")).rejects.toMatchObject({
      status: 502,
    });
    try {
      await assertCatalogAccount(async () => "acct_wrong");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const message = e instanceof Error ? e.message : "";
      expect(message).toContain("acct_wrong");
      expect(message).toContain(SANDBOX_ACCOUNT);
      expect(message).toMatch(/wrong Stripe account/);
      expect(message).not.toMatch(/missing lookup key/);
    }
  });

  it("keeps the catalog error when the account lookup fails", async () => {
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = SANDBOX_ACCOUNT;
    await expect(
      assertCatalogAccount(async () => {
        throw new Error("permission denied");
      }),
    ).resolves.toBeUndefined();
  });
});
