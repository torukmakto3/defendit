import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as simulateBilling } from "../src/app/api/admin/billing/simulate/route";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { POST as webhook } from "../src/app/api/billing/webhook/route";
import { POST as startDefend } from "../src/app/api/sessions/start/route";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import {
  REFUND_DESTINATION,
  abortDefenseCredit,
  assertNotSelfClaim,
  attachDefenseCredit,
  beginDefenseCredit,
  closeLearnProject,
  consumeCredit,
  costTierForUser,
  costTierForUserPlan,
  countActiveLearnProjects,
  ensureBetaGrant,
  getBalance,
  getUserPlan,
  grantBetaIfFirstGoogleSignIn,
  grantCredits,
  betaDefenseCents,
  holdCredit,
  learnSlotLimit,
  linkChallengedDefense,
  refundCredit,
  setCardFingerprint,
  walletView,
} from "../src/lib/credits";
import * as credits from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { HttpError } from "../src/lib/errors";
import { resolveGoogleCallback, type GoogleOAuthTxn } from "../src/lib/google-auth";
import { applyBillingEvent, simulatePurchase, simulateRenewal } from "../src/lib/payments";
import { COST_CAP_USD, getPlan } from "../src/lib/plans";
import {
  completeDefendSession,
  creatorIngest,
  listProjects,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));
const checkoutFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "stripe", "checkout.session.completed.json"), "utf8"),
) as {
  id: string;
  data: {
    object: {
      id: string;
      client_reference_id: string;
      amount_total: number;
      currency: string;
      metadata: { user_id: string };
      line_items: { data: { price: { id: string; lookup_key: string } }[] };
    };
  };
};
const invoiceFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "stripe", "invoice.paid.json"), "utf8"),
) as {
  id: string;
  data: {
    object: {
      amount_paid: number;
      currency: string;
      metadata: { user_id: string; sku: string };
      parent: { subscription_details: { metadata: { user_id: string; sku: string } } };
      lines: { data: { pricing: { price_details: { price: { lookup_key: string } } } }[] };
    };
  };
};

const ANSWER =
  "Because the unit economics section shows churn near 1.2% and LTV/CAC above 3; if churn doubles the recommendation weakens first.";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-credits-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  delete process.env.BILLING_ENABLED;
  delete process.env.BETA_BUDGET_EUR;
  delete process.env.BETA_DEFENSE_EUR;
  delete process.env.BETA_DEFENSE_CREDITS;
  delete process.env.SUBSCRIPTION_CHALLENGE_CREDITS;
});

async function signIn(email: string): Promise<{ user: User; cookie: string }> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
}

function txn(over: Partial<GoogleOAuthTxn> = {}): GoogleOAuthTxn {
  return {
    state: "state-value-0123456789",
    codeVerifier: "a".repeat(43),
    nextPath: "/dashboard",
    exp: Date.now() + 60_000,
    ...over,
  };
}

async function answerAll(session: { sessionId: string; plan: { probes: { id: string }[] } }, user: User) {
  for (const [i, probe] of session.plan.probes.entries()) {
    try {
      await recordDefendAnswer({
        sessionId: session.sessionId,
        user,
        probeId: probe.id,
        answer: `${ANSWER} (${i})`,
      });
    } catch (e) {
      if ((e as { status?: number }).status !== 409) throw e;
    }
  }
}

async function defendToReceipt(
  session: { sessionId: string; plan: { probes: { id: string }[] } },
  user: User,
) {
  await answerAll(session, user);
  let done = await completeDefendSession({ sessionId: session.sessionId, user });
  if ("followUp" in done && done.followUp) {
    await recordDefendAnswer({
      sessionId: session.sessionId,
      user,
      probeId: done.followUp.probe.id,
      answer: `${ANSWER} (follow-up)`,
    });
    done = await completeDefendSession({ sessionId: session.sessionId, user });
  }
  if (!("receipt" in done)) throw new Error("expected a receipt");
  return done;
}

async function openDefenseHolds(userId: string): Promise<number> {
  const row = await (await getDb()).get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM credit_ledger l
     WHERE l.user_id = ? AND l.reason = 'hold' AND l.purpose = 'defense'
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger c
         WHERE c.ref_type = 'hold' AND c.ref_id = l.id AND c.reason IN ('consume', 'refund')
       )`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

async function ledgerCount(userId: string): Promise<number> {
  const row = await (await getDb()).get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

describe("beta grant", () => {
  it("grants on first need for a magic-link account, once", async () => {
    const { user } = await signIn("magic-only@fund.example");
    const db = await getDb();
    expect(await db.get(`SELECT user_id FROM beta_grants WHERE user_id = ?`, [user.id])).toBeUndefined();
    expect(await ledgerCount(user.id)).toBe(0);

    const first = await ensureBetaGrant(user.id);
    expect(first.granted).toBe(true);
    const balance = await getBalance(user.id);
    expect(balance.defense).toBe(8);
    expect(balance.challenge).toBe(5);
    expect(balance.learnSlots).toBe(5);

    expect(await ensureBetaGrant(user.id)).toEqual({ granted: false });
    expect(await grantBetaIfFirstGoogleSignIn(user.id)).toEqual({ granted: false });
    expect((await getBalance(user.id)).defense).toBe(8);
    const grants = await db.all(`SELECT user_id FROM beta_grants WHERE user_id = ?`, [user.id]);
    expect(grants).toHaveLength(1);
  });

  it("grants 8 defenses, 5 challenges, and 5 Learn slots once per Google account", async () => {
    const exchange = async () => ({
      email: "First.Google@fund.example",
      email_verified: true as const,
      name: "Ada",
    });
    const first = await resolveGoogleCallback({
      stored: txn(),
      returnedState: "state-value-0123456789",
      code: "auth-code",
      providerError: null,
      exchange,
    });
    const balance = await getBalance(first.user.id);
    expect(balance.defense).toBe(8);
    expect(balance.challenge).toBe(5);
    expect(balance.learnSlots).toBe(5);
    expect(balance.defenseOnly).toBe(8);
    expect(balance.challengeOnly).toBe(5);

    const again = await resolveGoogleCallback({
      stored: txn({ state: "second-state-0123456789" }),
      returnedState: "second-state-0123456789",
      code: "auth-code-2",
      providerError: null,
      exchange,
    });
    expect(again.user.id).toBe(first.user.id);
    expect(await grantBetaIfFirstGoogleSignIn(first.user.id)).toEqual({ granted: false });
    const after = await getBalance(first.user.id);
    expect(after.defense).toBe(8);
    expect(after.challenge).toBe(5);
    expect(after.learnSlots).toBe(5);

    const db = await getDb();
    const grants = await db.all(`SELECT user_id FROM beta_grants WHERE user_id = ?`, [first.user.id]);
    expect(grants).toHaveLength(1);
    const rows = await db.all(
      `SELECT id FROM credit_ledger WHERE user_id = ? AND ref_type = 'beta_grant'`,
      [first.user.id],
    );
    expect(rows).toHaveLength(3);
    await expect(
      db.run(`INSERT INTO beta_grants (user_id, granted_at) VALUES (?, ?)`, [
        first.user.id,
        new Date().toISOString(),
      ]),
    ).rejects.toThrow(/UNIQUE/i);

    const wallet = await walletView(first.user.id);
    expect(wallet.plan.costTier).toBe("consumer");
    expect(wallet.plan.status).toBe("none");
    expect(wallet.prices.defense).toBe("€4");
    expect(wallet.prices.challenge).toBe("€3");
    expect(wallet.history.some((row) => row.label.includes("Beta grant"))).toBe(true);
  });

  it("tops an existing 3/2/3 grant up to 8/5/5 once", async () => {
    const { user } = await signIn("topup-old@fund.example");
    const db = await getDb();
    await db.run(`INSERT INTO beta_grants (user_id, granted_at) VALUES (?, ?)`, [
      user.id,
      new Date().toISOString(),
    ]);
    await grantCredits({
      userId: user.id,
      kind: "defense",
      amount: 3,
      reason: "grant",
      source: "beta",
      idempotencyKey: `beta:${user.id}:defense`,
    });
    await grantCredits({
      userId: user.id,
      kind: "challenge",
      amount: 2,
      reason: "grant",
      source: "beta",
      idempotencyKey: `beta:${user.id}:challenge`,
    });
    await grantCredits({
      userId: user.id,
      kind: "learn_slot",
      amount: 3,
      reason: "grant",
      source: "beta",
      idempotencyKey: `beta:${user.id}:learn_slot`,
    });
    expect(await ensureBetaGrant(user.id)).toEqual({ granted: false });
    expect(await getBalance(user.id)).toMatchObject({ defense: 8, challenge: 5, learnSlots: 5 });
    expect(await ensureBetaGrant(user.id)).toEqual({ granted: false });
    expect(await getBalance(user.id)).toMatchObject({ defense: 8, challenge: 5, learnSlots: 5 });
  });
});

describe("ledger", () => {
  it("holds, consumes, and refunds back to credit", async () => {
    expect(REFUND_DESTINATION).toBe("credit");
    const { user } = await signIn("ledger@fund.example");
    process.env.BILLING_ENABLED = "1";
    try {
      await expect(
        holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "hold-empty" }),
      ).rejects.toMatchObject({ status: 402 });
      expect(await ledgerCount(user.id)).toBe(0);
    } finally {
      delete process.env.BILLING_ENABLED;
    }

    const granted = await grantCredits({
      userId: user.id,
      kind: "defense",
      amount: 3,
      reason: "grant",
      source: "purchase",
      sponsored: false,
      idempotencyKey: "grant-defense-3",
    });
    const replay = await grantCredits({
      userId: user.id,
      kind: "defense",
      amount: 3,
      reason: "grant",
      source: "purchase",
      sponsored: false,
      idempotencyKey: "grant-defense-3",
    });
    expect(replay.id).toBe(granted.id);
    expect((await getBalance(user.id)).defense).toBe(3);
    await expect(
      grantCredits({
        userId: user.id,
        kind: "defense",
        amount: 2,
        reason: "grant",
        source: "purchase",
        idempotencyKey: "grant-defense-3",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const hold = await holdCredit({
      userId: user.id,
      kind: "defense",
      idempotencyKey: "hold-1",
    });
    expect(hold.amount).toBe(-1);
    expect(hold.sponsored).toBe(false);
    let balance = await getBalance(user.id);
    expect(balance.defense).toBe(2);
    expect(balance.held.defense).toBe(1);
    const same = await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "hold-1" });
    expect(same.id).toBe(hold.id);
    expect((await getBalance(user.id)).defense).toBe(2);

    const refunded = await refundCredit({
      userId: user.id,
      entryIdempotencyKey: "hold-1",
      idempotencyKey: "refund-hold-1",
    });
    expect(refunded.reason).toBe("refund");
    expect(refunded.amount).toBe(1);
    balance = await getBalance(user.id);
    expect(balance.defense).toBe(3);
    expect(balance.held.defense).toBe(0);

    const spent = await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "hold-2" });
    const consumed = await consumeCredit({
      userId: user.id,
      holdIdempotencyKey: spent.idempotencyKey,
      idempotencyKey: "consume-hold-2",
    });
    expect(consumed.amount).toBe(0);
    expect(consumed.reason).toBe("consume");
    expect((await getBalance(user.id)).defense).toBe(2);
    await refundCredit({
      userId: user.id,
      entryIdempotencyKey: spent.idempotencyKey,
      idempotencyKey: "refund-hold-2",
    });
    expect((await getBalance(user.id)).defense).toBe(3);
  });

  it("lets a pack pay for a defense or a challenge", async () => {
    const { user } = await signIn("pack@fund.example");
    await simulatePurchase({ userId: user.id, sku: "pack3", idempotencyKey: "pack-3" });
    let balance = await getBalance(user.id);
    expect(balance).toMatchObject({ defense: 3, challenge: 3, flex: 3, defenseOnly: 0, challengeOnly: 0 });
    await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "pack-hold" });
    balance = await getBalance(user.id);
    expect(balance).toMatchObject({ defense: 2, challenge: 2, flex: 2, defenseOnly: 0 });
  });

  it("sells a single defense or challenge at the listed price path", async () => {
    const { user } = await signIn("payg@fund.example");
    await simulatePurchase({ userId: user.id, sku: "defense", idempotencyKey: "buy-defense" });
    await simulatePurchase({ userId: user.id, sku: "challenge", idempotencyKey: "buy-challenge" });
    const balance = await getBalance(user.id);
    expect(balance.defenseOnly).toBe(1);
    expect(balance.challengeOnly).toBe(1);
    expect(balance.flex).toBe(0);
  });
});

describe("plans", () => {
  it("exposes consumer and enterprise tiers without enforcing a cap", () => {
    expect(COST_CAP_USD).toEqual({ consumer: 0.75, enterprise: 3 });
    expect(getPlan("subscription")).toMatchObject({
      costTier: "consumer",
      sessionBudgetUsd: 0.75,
      defensesPerPeriod: 10,
      challengesPerPeriod: 5,
      challengesRollOver: false,
      learnSlots: 10,
      priceCents: { month: 1100, year: 9900 },
    });
    expect(getPlan("team")).toMatchObject({
      costTier: "enterprise",
      sessionBudgetUsd: 3,
      defensesPerPeriod: 50,
      learnSlots: null,
      priceCents: { month: 14900 },
      overageCents: null,
    });
    expect(getPlan("enterprise")).toMatchObject({
      costTier: "enterprise",
      sessionBudgetUsd: 3,
      defensesPerPeriod: 200,
      priceCents: { month: 49000 },
      overageCents: 250,
    });
    expect(getPlan("payg").priceCents).toEqual({ month: null, year: null });
  });

  it("renews a subscription without stacking unused credits", async () => {
    const { user } = await signIn("sub@fund.example");
    expect((await getUserPlan(user.id)).costTier).toBe("consumer");
    expect(await costTierForUser(user.id)).toBe("consumer");
    expect(costTierForUserPlan("team")).toBe("enterprise");
    expect(costTierForUserPlan("subscription")).toBe("consumer");
    expect(costTierForUserPlan("not-a-plan")).toBe("consumer");
    await simulateRenewal({ userId: user.id, sku: "subscription_month", idempotencyKey: "period-1" });
    const assigned = await getUserPlan(user.id);
    expect(assigned.plan.costTier).toBe("consumer");
    expect(assigned.plan.sessionBudgetUsd).toBe(0.75);
    expect(assigned.status).toBe("active");
    let balance = await getBalance(user.id);
    expect(balance.defense).toBe(10);
    expect(balance.challenge).toBe(5);
    expect(balance.learnSlots).toBe(10);

    await simulateRenewal({ userId: user.id, sku: "subscription_month", idempotencyKey: "period-1" });
    balance = await getBalance(user.id);
    expect(balance.defense).toBe(10);
    expect(balance.challenge).toBe(5);

    await consumeCredit({ userId: user.id, kind: "challenge", idempotencyKey: "use-ch-1" });
    await consumeCredit({ userId: user.id, kind: "challenge", idempotencyKey: "use-ch-2" });
    expect((await getBalance(user.id)).challenge).toBe(3);

    await simulateRenewal({ userId: user.id, sku: "subscription_month", idempotencyKey: "period-2" });
    balance = await getBalance(user.id);
    expect(balance.defense).toBe(10);
    expect(balance.challenge).toBe(5);
    expect(balance.learnSlots).toBe(10);
  });

  it("grants a year as twelve periods and does not stack the next year", async () => {
    const { user } = await signIn("year@fund.example");
    await simulateRenewal({ userId: user.id, sku: "subscription_year", idempotencyKey: "year-1" });
    let balance = await getBalance(user.id);
    expect(balance.defense).toBe(120);
    expect(balance.challenge).toBe(60);
    await simulateRenewal({ userId: user.id, sku: "subscription_year", idempotencyKey: "year-2" });
    balance = await getBalance(user.id);
    expect(balance.defense).toBe(120);
    expect(balance.challenge).toBe(60);
  });

  it("reads SUBSCRIPTION_CHALLENGE_CREDITS when renewing", async () => {
    const previous = process.env.SUBSCRIPTION_CHALLENGE_CREDITS;
    process.env.SUBSCRIPTION_CHALLENGE_CREDITS = "7";
    try {
      const { user } = await signIn("sub-env@fund.example");
      await simulateRenewal({ userId: user.id, sku: "subscription_month", idempotencyKey: "period-7" });
      expect((await getBalance(user.id)).challenge).toBe(7);
      expect(getPlan("subscription").challengesPerPeriod).toBe(7);
    } finally {
      if (previous === undefined) delete process.env.SUBSCRIPTION_CHALLENGE_CREDITS;
      else process.env.SUBSCRIPTION_CHALLENGE_CREDITS = previous;
    }
  });

  it("stops a team at the included defenses and bills enterprise overage to the ledger", async () => {
    const previous = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "1";
    try {
    const team = await signIn("team@fund.example");
    await simulateRenewal({ userId: team.user.id, sku: "team_month", idempotencyKey: "team-1" });
    const teamPlan = await getUserPlan(team.user.id);
    expect(teamPlan.costTier).toBe("enterprise");
    expect(teamPlan.plan.sessionBudgetUsd).toBe(3);
    expect((await getBalance(team.user.id)).defense).toBe(50);
    expect(await learnSlotLimit(team.user.id)).toBeNull();
    await grantCredits({
      userId: team.user.id,
      kind: "defense",
      amount: -50,
      reason: "admin_adjust",
      source: "subscription",
      idempotencyKey: "drain-team",
    });
    await expect(
      holdCredit({ userId: team.user.id, kind: "defense", idempotencyKey: "team-over" }),
    ).rejects.toMatchObject({ status: 402 });
    const teamOverage = await (await getDb()).get(`SELECT id FROM billing_overages WHERE user_id = ?`, [
      team.user.id,
    ]);
    expect(teamOverage).toBeUndefined();

    const ent = await signIn("ent@fund.example");
    await simulateRenewal({ userId: ent.user.id, sku: "enterprise_month", idempotencyKey: "ent-1" });
    expect((await getBalance(ent.user.id)).defense).toBe(200);
    await grantCredits({
      userId: ent.user.id,
      kind: "defense",
      amount: -200,
      reason: "admin_adjust",
      source: "subscription",
      idempotencyKey: "drain-ent",
    });
    const hold = await holdCredit({ userId: ent.user.id, kind: "defense", idempotencyKey: "ent-over" });
    expect(hold.source).toBe("overage");
    expect(hold.sponsored).toBe(false);
    expect((await getBalance(ent.user.id)).defense).toBe(0);
    const overage = await (await getDb()).get<{ amount_cents: number; currency: string }>(
      `SELECT amount_cents, currency FROM billing_overages WHERE user_id = ?`,
      [ent.user.id],
    );
    expect(overage).toMatchObject({ amount_cents: 250, currency: "eur" });
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = previous;
    }
  });
});

describe("beta budget and sponsorship", () => {
  it("counts a sponsored defense at 0.70 EUR unless BETA_DEFENSE_EUR is set", () => {
    expect(betaDefenseCents()).toBe(70);
  });

  it("pauses sponsored defenses when the global budget is spent and still spends paid credits", async () => {
    const previousBudget = process.env.BETA_BUDGET_EUR;
    const previousDefense = process.env.BETA_DEFENSE_EUR;
    process.env.BETA_DEFENSE_EUR = "0.30";
    const db = await getDb();
    const spent = await db.get<{ n: number }>(`SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger`);
    const spentCents = Number(spent?.n ?? 0);
    process.env.BETA_BUDGET_EUR = ((spentCents + 30) / 100).toFixed(2);
    try {
      const { user } = await signIn("budget@fund.example");
      await grantCredits({
        userId: user.id,
        kind: "defense",
        amount: 2,
        reason: "grant",
        source: "beta",
        sponsored: true,
        idempotencyKey: "beta-def-2",
      });
      const first = await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "budget-hold-1" });
      expect(first.sponsored).toBe(true);
      expect(first.budgetCents).toBe(30);
      await expect(
        holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "budget-hold-2" }),
      ).rejects.toThrow(/beta budget/);
      expect((await getBalance(user.id)).defense).toBe(1);
      await expect(
        holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "budget-hold-2b" }),
      ).rejects.toThrow(/beta budget/);

      await refundCredit({
        userId: user.id,
        entryIdempotencyKey: "budget-hold-1",
        idempotencyKey: "budget-refund-1",
      });
      const again = await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "budget-hold-3" });
      expect(again.sponsored).toBe(true);
      expect(again.budgetCents).toBe(30);

      await grantCredits({
        userId: user.id,
        kind: "defense",
        amount: 1,
        reason: "purchase",
        source: "purchase",
        sponsored: false,
        idempotencyKey: "paid-during-pause",
      });
      const paid = await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: "budget-hold-paid" });
      expect(paid.sponsored).toBe(false);
      expect(paid.source).toBe("purchase");
      const counter = await db.get<{ spent_cents: number }>(
        `SELECT spent_cents FROM credit_budget WHERE id = 'beta'`,
      );
      const summed = await db.get<{ n: number }>(
        `SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger`,
      );
      expect(Number(counter?.spent_cents)).toBe(Number(summed?.n));
      expect(Number(counter?.spent_cents)).toBeLessThanOrEqual(Math.round(Number(process.env.BETA_BUDGET_EUR) * 100));
    } finally {
      if (previousBudget === undefined) delete process.env.BETA_BUDGET_EUR;
      else process.env.BETA_BUDGET_EUR = previousBudget;
      if (previousDefense === undefined) delete process.env.BETA_DEFENSE_EUR;
      else process.env.BETA_DEFENSE_EUR = previousDefense;
    }
  });

  it("lets only one of two accounts take the last slice of the beta budget", async () => {
    const previousBudget = process.env.BETA_BUDGET_EUR;
    const previousDefense = process.env.BETA_DEFENSE_EUR;
    process.env.BETA_DEFENSE_EUR = "0.30";
    const db = await getDb();
    const spent = await db.get<{ n: number }>(`SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger`);
    const cap = Number(spent?.n ?? 0) + 30;
    process.env.BETA_BUDGET_EUR = (cap / 100).toFixed(2);
    try {
      const first = await signIn("budget-race-a@fund.example");
      const second = await signIn("budget-race-b@fund.example");
      for (const [user, key] of [
        [first.user, "race-a"],
        [second.user, "race-b"],
      ] as const) {
        await grantCredits({
          userId: user.id,
          kind: "defense",
          amount: 1,
          reason: "grant",
          source: "beta",
          sponsored: true,
          idempotencyKey: key,
        });
      }
      const results = await Promise.allSettled([
        holdCredit({ userId: first.user.id, kind: "defense", idempotencyKey: "race-hold-a" }),
        holdCredit({ userId: second.user.id, kind: "defense", idempotencyKey: "race-hold-b" }),
      ]);
      const won = results.filter((result) => result.status === "fulfilled");
      expect(won).toHaveLength(1);
      const counter = await db.get<{ spent_cents: number }>(
        `SELECT spent_cents FROM credit_budget WHERE id = 'beta'`,
      );
      const summed = await db.get<{ n: number }>(`SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger`);
      expect(Number(counter?.spent_cents)).toBe(Number(summed?.n));
      expect(Number(counter?.spent_cents)).toBeLessThanOrEqual(cap);
    } finally {
      if (previousBudget === undefined) delete process.env.BETA_BUDGET_EUR;
      else process.env.BETA_BUDGET_EUR = previousBudget;
      if (previousDefense === undefined) delete process.env.BETA_DEFENSE_EUR;
      else process.env.BETA_DEFENSE_EUR = previousDefense;
    }
  });

  it("marks a defense paid with a beta credit as sponsored", async () => {
    const { user } = await signIn("sponsored@fund.example");
    await grantCredits({
      userId: user.id,
      kind: "defense",
      amount: 1,
      reason: "grant",
      source: "beta",
      sponsored: true,
      idempotencyKey: "one-beta-defense",
    });
    const ingest = await creatorIngest({
      user,
      fileName: "memo.md",
      buffer: memo,
      difficulty: "standard",
    });
    const reserved = await beginDefenseCredit(user.id);
    expect(reserved?.sponsored).toBe(true);
    const session = await startSession({
      token: ingest.token,
      user,
      mode: "defend",
      accommodation: true,
    });
    await attachDefenseCredit(user.id, reserved!.idempotencyKey, session.sessionId);
    const row = await (await getDb()).get<{ sponsored: number }>(`SELECT sponsored FROM sessions WHERE id = ?`, [
      session.sessionId,
    ]);
    expect(row?.sponsored).toBe(1);
  });
});

describe("challenged defenses", () => {
  it("grants one onward challenge credit when the defender finishes, and not for sharing", async () => {
    const challenger = await signIn("challenger@fund.example");
    const defender = await signIn("defender@fund.example");
    const ingest = await creatorIngest({
      user: defender.user,
      fileName: "memo.md",
      buffer: memo,
      difficulty: "standard",
    });
    const session = await startSession({
      token: ingest.token,
      user: defender.user,
      mode: "defend",
      accommodation: true,
    });
    await linkChallengedDefense({
      challengeId: "chal_onward",
      challengerUserId: challenger.user.id,
      defenderUserId: defender.user.id,
      sessionId: session.sessionId,
    });
    await defendToReceipt(session, defender.user);
    expect((await getBalance(defender.user.id)).challenge).toBe(1);
    await completeDefendSession({ sessionId: session.sessionId, user: defender.user });
    expect((await getBalance(defender.user.id)).challenge).toBe(1);

    const other = await creatorIngest({
      user: defender.user,
      fileName: "memo.md",
      buffer: memo,
      difficulty: "standard",
    });
    const plain = await startSession({
      token: other.token,
      user: defender.user,
      mode: "defend",
      accommodation: true,
    });
    await defendToReceipt(plain, defender.user);
    expect((await getBalance(defender.user.id)).challenge).toBe(1);

    const columns = await (await getDb()).all<{ name: string }>(`PRAGMA table_info(credit_challenge_claims)`);
    const names = columns.map((column) => column.name);
    expect(names).not.toContain("shared");
    expect(names).not.toContain("posted");
  });

  it("rejects a self-claim by user and by card fingerprint", async () => {
    const creator = await signIn("self-creator@fund.example");
    const other = await signIn("self-other@fund.example");
    await expect(
      linkChallengedDefense({
        challengeId: "chal_self",
        challengerUserId: creator.user.id,
        defenderUserId: creator.user.id,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const row = await (await getDb()).get(`SELECT challenge_id FROM credit_challenge_claims WHERE challenge_id = ?`, [
      "chal_self",
    ]);
    expect(row).toBeUndefined();

    await expect(
      assertNotSelfClaim({ creatorUserId: creator.user.id, claimerUserId: creator.user.id }),
    ).rejects.toMatchObject({ status: 403 });

    await setCardFingerprint(creator.user.id, "card_same");
    await setCardFingerprint(other.user.id, "card_same");
    await expect(
      assertNotSelfClaim({ creatorUserId: creator.user.id, claimerUserId: other.user.id }),
    ).rejects.toMatchObject({ status: 403 });

    await setCardFingerprint(other.user.id, "card_other");
    await expect(
      assertNotSelfClaim({ creatorUserId: creator.user.id, claimerUserId: other.user.id }),
    ).resolves.toBeUndefined();
  });
});

describe("learn slots", () => {
  it("does not cap uploads while billing is off", async () => {
    delete process.env.BILLING_ENABLED;
    const { user } = await signIn("learn-open@fund.example");
    await grantCredits({
      userId: user.id,
      kind: "learn_slot",
      amount: 1,
      reason: "grant",
      source: "beta",
      idempotencyKey: "learn-open-slot",
    });
    await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    expect(await countActiveLearnProjects(user.id)).toBe(2);
  });

  it("frees a slot on close without changing document retention", async () => {
    const previous = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "1";
    try {
    const { user } = await signIn("learn@fund.example");
    await grantCredits({
      userId: user.id,
      kind: "learn_slot",
      amount: 1,
      reason: "grant",
      source: "beta",
      idempotencyKey: "one-slot",
    });
    expect(await countActiveLearnProjects(user.id)).toBe(0);
    expect(await learnSlotLimit(user.id)).toBe(1);

    const first = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    expect(await countActiveLearnProjects(user.id)).toBe(1);
    await expect(
      creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" }),
    ).rejects.toMatchObject({ status: 402 });

    const db = await getDb();
    const before = await db.get<{ text_enc: string | null; purge_after: string }>(
      `SELECT text_enc, purge_after FROM deliverables WHERE id = ?`,
      [first.deliverableId],
    );
    expect(before?.text_enc).toBeTruthy();
    await closeLearnProject(user.id, first.token);
    const after = await db.get<{ text_enc: string | null; purge_after: string }>(
      `SELECT text_enc, purge_after FROM deliverables WHERE id = ?`,
      [first.deliverableId],
    );
    expect(after?.text_enc).toBe(before?.text_enc);
    expect(after?.purge_after).toBe(before?.purge_after);
    expect(await countActiveLearnProjects(user.id)).toBe(0);

    const third = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const listed = await listProjects(user);
    expect(listed.map((project) => project.token)).toContain(third.token);
    expect(listed.map((project) => project.token)).not.toContain(first.token);
    await expect(closeLearnProject(user.id, "missing-token")).rejects.toMatchObject({ status: 404 });
    const open = await (await getDb()).get<{ learn_open: number }>(
      `SELECT learn_open FROM credit_wallets WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(open?.learn_open)).toBe(await countActiveLearnProjects(user.id));
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = previous;
    }
  });

  it("drops the slot counter when an open project has expired or been purged", async () => {
    const previous = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "1";
    try {
      const { user } = await signIn("learn-purge@fund.example");
      await grantCredits({
        userId: user.id,
        kind: "learn_slot",
        amount: 1,
        reason: "grant",
        source: "beta",
        idempotencyKey: "learn-purge-slot",
      });
      const first = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
      await expect(
        creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" }),
      ).rejects.toMatchObject({ status: 402 });

      const db = await getDb();
      await db.run(`UPDATE deliverables SET purge_after = ?, purged_at = ? WHERE id = ?`, [
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        first.deliverableId,
      ]);
      expect(await countActiveLearnProjects(user.id)).toBe(0);

      const again = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
      expect(again.token).not.toBe(first.token);
      expect(await countActiveLearnProjects(user.id)).toBe(1);
      const open = await db.get<{ learn_open: number }>(
        `SELECT learn_open FROM credit_wallets WHERE user_id = ?`,
        [user.id],
      );
      expect(Number(open?.learn_open)).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = previous;
    }
  });

  it("lets only one of two simultaneous uploads take the last Learn slot", async () => {
    const previous = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "1";
    try {
      const { user } = await signIn("learn-race@fund.example");
      await grantCredits({
        userId: user.id,
        kind: "learn_slot",
        amount: 1,
        reason: "grant",
        source: "beta",
        idempotencyKey: "learn-race-slot",
      });
      const results = await Promise.allSettled([
        creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" }),
        creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" }),
      ]);
      expect(await countActiveLearnProjects(user.id)).toBe(1);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const open = await (await getDb()).get<{ learn_open: number }>(
        `SELECT learn_open FROM credit_wallets WHERE user_id = ?`,
        [user.id],
      );
      expect(Number(open?.learn_open ?? 0)).toBe(await countActiveLearnProjects(user.id));
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = previous;
    }
  });
});

describe("defense gate", () => {
  it("grants beta credits on the first defense for a magic-link user, even when the server is deployed", async () => {
    const previousVercel = process.env.VERCEL;
    const previousBilling = process.env.BILLING_ENABLED;
    delete process.env.BILLING_ENABLED;
    try {
      const { user, cookie } = await signIn("deployed-magic@fund.example");
      expect(await ledgerCount(user.id)).toBe(0);
      process.env.VERCEL = "1";
      const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
      const res = await startDefend(
        new Request("http://localhost/api/sessions/start", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation: true }),
        }),
      );
      expect(res.status).toBe(200);
      const balance = await getBalance(user.id);
      expect(balance.defense).toBe(7);
      expect(balance.challenge).toBe(5);
      expect(balance.learnSlots).toBe(5);
      expect(balance.held.defense).toBe(1);
      const grants = await (await getDb()).all(`SELECT user_id FROM beta_grants WHERE user_id = ?`, [user.id]);
      expect(grants).toHaveLength(1);
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
      if (previousBilling === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = previousBilling;
    }
  });

  it("blocks the defense after the free allowance, and lets the budget stop one sooner", async () => {
    delete process.env.BILLING_ENABLED;
    const { user, cookie } = await signIn("allowance@fund.example");
    await ensureBetaGrant(user.id);
    expect((await getBalance(user.id)).defense).toBe(8);
    for (let i = 1; i <= 8; i++) {
      const held = await holdCredit({ userId: user.id, kind: "defense", idempotencyKey: `allowance-hold-${i}` });
      await consumeCredit({
        userId: user.id,
        holdIdempotencyKey: held.idempotencyKey,
        idempotencyKey: `allowance-consume-${i}`,
      });
    }
    expect((await getBalance(user.id)).defense).toBe(0);
    const fourth = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ token: "missing", mode: "defend", accommodation: true }),
      }),
    );
    expect(fourth.status).toBe(402);
    expect(await fourth.json()).toEqual({ error: "You've used your 8 free beta defenses" });
    expect((await getBalance(user.id)).defense).toBe(0);
    const extended = await (await getDb()).get(
      `SELECT id FROM credit_ledger WHERE user_id = ? AND ref_type = 'beta_extend'`,
      [user.id],
    );
    expect(extended).toBeUndefined();

    const previousBudget = process.env.BETA_BUDGET_EUR;
    const previousDefense = process.env.BETA_DEFENSE_EUR;
    const previousCredits = process.env.BETA_DEFENSE_CREDITS;
    process.env.BETA_DEFENSE_EUR = "0.30";
    process.env.BETA_DEFENSE_CREDITS = "4";
    try {
      const early = await signIn("budget-before-allowance@fund.example");
      await ensureBetaGrant(early.user.id);
      expect((await getBalance(early.user.id)).defense).toBe(4);
      const db = await getDb();
      const spent = await db.get<{ n: number }>(`SELECT COALESCE(SUM(budget_cents), 0) AS n FROM credit_ledger`);
      process.env.BETA_BUDGET_EUR = ((Number(spent?.n ?? 0) + 30) / 100).toFixed(2);
      await holdCredit({ userId: early.user.id, kind: "defense", idempotencyKey: "early-budget-1" });
      await expect(
        holdCredit({ userId: early.user.id, kind: "defense", idempotencyKey: "early-budget-2" }),
      ).rejects.toThrow(/beta budget/);
      expect((await getBalance(early.user.id)).defense).toBe(3);
    } finally {
      if (previousBudget === undefined) delete process.env.BETA_BUDGET_EUR;
      else process.env.BETA_BUDGET_EUR = previousBudget;
      if (previousDefense === undefined) delete process.env.BETA_DEFENSE_EUR;
      else process.env.BETA_DEFENSE_EUR = previousDefense;
      if (previousCredits === undefined) delete process.env.BETA_DEFENSE_CREDITS;
      else process.env.BETA_DEFENSE_CREDITS = previousCredits;
    }
  });

  it("requires a defense credit once billing is on and the grant is spent, and refunds a failed start", async () => {
    const previous = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "1";
    const blocked = await signIn("gated@fund.example");
    await ensureBetaGrant(blocked.user.id);
    await grantCredits({
      userId: blocked.user.id,
      kind: "defense",
      amount: -8,
      reason: "admin_adjust",
      source: "beta",
      idempotencyKey: "drain-gated",
    });
    const denied = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie: blocked.cookie, "content-type": "application/json" },
        body: JSON.stringify({ token: "missing", mode: "defend", accommodation: true }),
      }),
    );
    expect(denied.status).toBe(402);
    expect(await denied.json()).toMatchObject({ error: expect.stringMatching(/defense credit/) });
    const sessions = await (await getDb()).get(`SELECT id FROM sessions WHERE user_id = ?`, [blocked.user.id]);
    expect(sessions).toBeUndefined();
    if (previous === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = previous;

    const payer = await signIn("refund-start@fund.example");
    await grantCredits({
      userId: payer.user.id,
      kind: "defense",
      amount: 1,
      reason: "purchase",
      source: "purchase",
      idempotencyKey: "one-paid-defense",
    });
    const failed = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie: payer.cookie, "content-type": "application/json" },
        body: JSON.stringify({ token: "not-a-real-token", mode: "defend", accommodation: true }),
      }),
    );
    expect(failed.ok).toBe(false);
    expect((await getBalance(payer.user.id)).defense).toBe(9);

    const ingest = await creatorIngest({
      user: payer.user,
      fileName: "memo.md",
      buffer: memo,
      difficulty: "standard",
    });
    const reserved = await beginDefenseCredit(payer.user.id);
    const session = await startSession({
      token: ingest.token,
      user: payer.user,
      mode: "defend",
      accommodation: true,
    });
    await attachDefenseCredit(payer.user.id, reserved!.idempotencyKey, session.sessionId);
    await abortDefenseCredit(payer.user.id, reserved!.idempotencyKey, session.sessionId);
    expect((await getBalance(payer.user.id)).defense).toBe(9);
    await expect(
      completeDefendSession({ sessionId: session.sessionId, user: payer.user }),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("refunds the previous unfinished defense when Begin is clicked again", async () => {
    const { user, cookie } = await signIn("retry-defend@fund.example");
    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "hard" });
    const start = (accommodation: boolean) =>
      startDefend(
        new Request("http://localhost/api/sessions/start", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation }),
        }),
      );

    const firstRes = await start(false);
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as { sessionId: string };
    expect((await getBalance(user.id)).held.defense).toBe(1);
    expect((await getBalance(user.id)).defense).toBe(7);
    expect(await openDefenseHolds(user.id)).toBe(1);

    const secondRes = await start(true);
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as { sessionId: string; plan: { probes: { id: string }[] } };
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await getBalance(user.id)).held.defense).toBe(1);
    expect((await getBalance(user.id)).defense).toBe(7);
    expect(await openDefenseHolds(user.id)).toBe(1);
    const abandoned = await (await getDb()).get<{ status: string }>(`SELECT status FROM sessions WHERE id = ?`, [
      first.sessionId,
    ]);
    expect(abandoned?.status).toBe("abandoned");
    await expect(completeDefendSession({ sessionId: first.sessionId, user })).rejects.toMatchObject({ status: 402 });

    await defendToReceipt(second, user);
    expect((await getBalance(user.id)).held.defense).toBe(0);
    expect((await getBalance(user.id)).defense).toBe(7);
    expect(await openDefenseHolds(user.id)).toBe(0);

    const thirdRes = await start(true);
    expect(thirdRes.status).toBe(409);
    expect((await getBalance(user.id)).held.defense).toBe(0);
    expect((await getBalance(user.id)).defense).toBe(7);
    expect(await openDefenseHolds(user.id)).toBe(0);

    const another = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "hard" });
    const fourthRes = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ token: another.token, mode: "defend", accommodation: true }),
      }),
    );
    expect(fourthRes.status).toBe(200);
    expect((await getBalance(user.id)).held.defense).toBe(1);
    expect((await getBalance(user.id)).defense).toBe(6);
    expect(await openDefenseHolds(user.id)).toBe(1);
  });

  it("refunds a streamed defense that fails before a session exists and keeps a single hold when it starts", async () => {
    const { user, cookie } = await signIn("stream-defend@fund.example");
    const failed = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ token: "missing", mode: "defend", accommodation: true }),
      }),
    );
    expect(failed.status).toBe(200);
    expect(failed.headers.get("content-type")).toContain("application/x-ndjson");
    const failLines = (await failed.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(failLines.at(-1)?.type).toBe("error");
    expect((await getBalance(user.id)).defense).toBe(8);
    expect((await getBalance(user.id)).held.defense).toBe(0);
    expect(await openDefenseHolds(user.id)).toBe(0);
    expect(await (await getDb()).get(`SELECT id FROM sessions WHERE user_id = ?`, [user.id])).toBeUndefined();

    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const stream = () =>
      startDefend(
        new Request("http://localhost/api/sessions/start", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation: true }),
        }),
      );
    const readReady = async (res: Response) => {
      expect(res.status).toBe(200);
      const lines = (await res.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; sessionId?: string });
      expect(lines[0]?.type).toBe("question");
      expect(lines.at(-1)?.type).toBe("ready");
      return lines.at(-1)?.sessionId ?? "";
    };

    const firstId = await readReady(await stream());
    expect((await getBalance(user.id)).held.defense).toBe(1);
    expect((await getBalance(user.id)).defense).toBe(7);
    expect(await openDefenseHolds(user.id)).toBe(1);

    const secondId = await readReady(await stream());
    expect(secondId).not.toBe(firstId);
    expect((await getBalance(user.id)).held.defense).toBe(1);
    expect((await getBalance(user.id)).defense).toBe(7);
    expect(await openDefenseHolds(user.id)).toBe(1);
    const abandoned = await (await getDb()).get<{ status: string }>(`SELECT status FROM sessions WHERE id = ?`, [
      firstId,
    ]);
    expect(abandoned?.status).toBe("abandoned");
  });

  it("runs two starts at once without refunding a fresh unattached hold", async () => {
    const { user, cookie } = await signIn("concurrent-defend@fund.example");
    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const start = () =>
      startDefend(
        new Request("http://localhost/api/sessions/start", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation: true }),
        }),
      );

    const [firstRes, secondRes] = await Promise.all([start(), start()]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    const first = (await firstRes.json()) as { sessionId: string };
    const second = (await secondRes.json()) as { sessionId: string };
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await openDefenseHolds(user.id)).toBe(2);
    expect((await getBalance(user.id)).held.defense).toBe(2);
    expect((await getBalance(user.id)).defense).toBe(6);
    const db = await getDb();
    const sessions = await db.all<{ id: string; status: string }>(
      `SELECT id, status FROM sessions WHERE user_id = ? AND mode = 'defend'`,
      [user.id],
    );
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.status === "in_progress")).toBe(true);
    for (const row of sessions) {
      const link = await db.get<{ hold_idempotency_key: string }>(
        `SELECT hold_idempotency_key FROM defense_holds WHERE session_id = ?`,
        [row.id],
      );
      const holdKey = link?.hold_idempotency_key;
      expect(holdKey).toEqual(expect.any(String));
      if (!holdKey) throw new Error("missing hold");
      const settled = await db.get(
        `SELECT c.id FROM credit_ledger h
         JOIN credit_ledger c ON c.ref_type = 'hold' AND c.ref_id = h.id AND c.reason IN ('consume', 'refund')
         WHERE h.idempotency_key = ?`,
        [holdKey],
      );
      expect(settled).toBeUndefined();
    }

    const stale = await beginDefenseCredit(user.id);
    await db.run(`UPDATE credit_ledger SET created_at = ? WHERE idempotency_key = ?`, [
      new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      stale.idempotencyKey,
    ]);
    const fresh = await beginDefenseCredit(user.id);
    await beginDefenseCredit(user.id);
    const staleRefund = await db.get(
      `SELECT c.id FROM credit_ledger h
       JOIN credit_ledger c ON c.ref_type = 'hold' AND c.ref_id = h.id AND c.reason = 'refund'
       WHERE h.idempotency_key = ?`,
      [stale.idempotencyKey],
    );
    const freshRefund = await db.get(
      `SELECT c.id FROM credit_ledger h
       JOIN credit_ledger c ON c.ref_type = 'hold' AND c.ref_id = h.id AND c.reason = 'refund'
       WHERE h.idempotency_key = ?`,
      [fresh.idempotencyKey],
    );
    expect(staleRefund).toBeTruthy();
    expect(freshRefund).toBeUndefined();
  });

  it("abandons a start that tries to attach a refunded hold", async () => {
    const { user } = await signIn("replaced-defend@fund.example");
    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const reserved = await beginDefenseCredit(user.id);
    await refundCredit({
      userId: user.id,
      entryIdempotencyKey: reserved.idempotencyKey,
      idempotencyKey: `refund:${reserved.idempotencyKey}`,
    });
    const session = await startSession({
      token: ingest.token,
      user,
      mode: "defend",
      accommodation: true,
    });
    await expect(attachDefenseCredit(user.id, reserved.idempotencyKey, session.sessionId)).rejects.toMatchObject({
      status: 409,
      message: "This start was replaced by a newer one.",
    });
    const row = await (await getDb()).get<{ status: string }>(`SELECT status FROM sessions WHERE id = ?`, [
      session.sessionId,
    ]);
    expect(row?.status).toBe("abandoned");
    expect(await openDefenseHolds(user.id)).toBe(0);
    await expect(attachDefenseCredit(user.id, reserved.idempotencyKey, session.sessionId)).rejects.toMatchObject({
      message: "This start was replaced by a newer one.",
    });
  });

  it("refunds the hold when attach fails before the link is saved", async () => {
    const { user, cookie } = await signIn("attach-fail@fund.example");
    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const spy = vi.spyOn(credits, "attachDefenseCredit").mockRejectedValueOnce(new HttpError(500, "attach failed"));
    try {
      const res = await startDefend(
        new Request("http://localhost/api/sessions/start", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation: true }),
        }),
      );
      expect(res.status).toBe(200);
      const lines = (await res.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; error?: string });
      expect(lines.at(-1)).toMatchObject({ type: "error", error: "attach failed" });
      expect(await openDefenseHolds(user.id)).toBe(0);
      expect((await getBalance(user.id)).defense).toBe(8);
      expect((await getBalance(user.id)).held.defense).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the receipt when the hold was refunded before grading", async () => {
    const { user, cookie } = await signIn("refunded-receipt@fund.example");
    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const res = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; plan: { probes: { id: string }[] } };
    const db = await getDb();
    const hold = await db.get<{ idempotency_key: string }>(
      `SELECT l.idempotency_key FROM defense_holds h
       JOIN credit_ledger l ON l.idempotency_key = h.hold_idempotency_key
       WHERE h.session_id = ?`,
      [body.sessionId],
    );
    await refundCredit({
      userId: user.id,
      entryIdempotencyKey: hold!.idempotency_key,
      idempotencyKey: `refund:${hold!.idempotency_key}`,
    });
    expect((await getBalance(user.id)).defense).toBe(8);
    expect((await getBalance(user.id)).held.defense).toBe(0);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const done = await defendToReceipt(body, user);
      expect(done.receipt?.payload.id).toEqual(expect.any(String));
      expect(spy.mock.calls.some((call) => String(call[0]).includes("no charge"))).toBe(true);
      const again = await completeDefendSession({ sessionId: body.sessionId, user });
      expect(again).toMatchObject({ idempotent: true });
      expect((await getBalance(user.id)).defense).toBe(8);
      expect((await getBalance(user.id)).held.defense).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("consumes the held credit when the defense reaches a receipt", async () => {
    const { user, cookie } = await signIn("consume-route@fund.example");
    await grantCredits({
      userId: user.id,
      kind: "defense",
      amount: 1,
      reason: "purchase",
      source: "purchase",
      idempotencyKey: "route-defense",
    });
    const ingest = await creatorIngest({ user, fileName: "memo.md", buffer: memo, difficulty: "standard" });
    const res = await startDefend(
      new Request("http://localhost/api/sessions/start", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ token: ingest.token, mode: "defend", accommodation: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await getBalance(user.id)).defense).toBe(8);
    expect((await getBalance(user.id)).held.defense).toBe(1);
    const body = (await res.json()) as { sessionId: string; plan: { probes: { id: string }[] } };
    await defendToReceipt(body, user);
    const balance = await getBalance(user.id);
    expect(balance.defense).toBe(8);
    expect(balance.held.defense).toBe(0);
  });
});

describe("billing stub", () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    calls.length = 0;
    delete process.env.BILLING_ENABLED;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  function spyFetch() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      throw new Error("stripe network is not allowed");
    }) as typeof fetch;
  }

  it("makes no network call and hides checkout while payments are off", async () => {
    const payments = readFileSync(join(__dirname, "..", "src", "lib", "payments.ts"), "utf8");
    const credits = readFileSync(join(__dirname, "..", "src", "lib", "credits.ts"), "utf8");
    const checkoutRoute = readFileSync(join(__dirname, "..", "src", "app", "api", "billing", "checkout", "route.ts"), "utf8");
    for (const source of [payments, credits, checkoutRoute]) {
      expect(source).not.toContain("api.stripe.com");
    }
    expect(payments).not.toMatch(/fetch\s*\(/);
    const example = readFileSync(join(__dirname, "..", ".env.example"), "utf8");
    expect(example).toContain("BILLING_ENABLED=false");
    expect(example).not.toContain("PAYMENTS_ENABLED");
    expect(example).toContain("STRIPE_SECRET_KEY");
    expect(example).toContain("STRIPE_TAX_ENABLED=false");
    expect(example).not.toMatch(/sk_live_[A-Za-z0-9]{8,}/);
    expect(example).not.toContain("STRIPE_PRICE_");

    spyFetch();
    const { user, cookie } = await signIn("billing-off@fund.example");
    for (const flag of [undefined, "false"] as const) {
      if (flag === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = flag;
      const checkoutRes = await checkout(
        new Request("http://localhost/api/billing/checkout", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ sku: "defense" }),
        }),
      );
      expect(checkoutRes.status).toBe(402);
      expect(await checkoutRes.json()).toEqual({ error: "Billing is not enabled" });
      const hook = await webhook(
        new Request("http://localhost/api/billing/webhook", { method: "POST", body: "{}" }),
      );
      expect(hook.status).toBe(402);
      expect(await hook.json()).toEqual({ error: "Billing is not enabled" });
    }
    expect(calls).toEqual([]);

    await refundCredit({
      userId: user.id,
      entryIdempotencyKey: "missing-for-spy",
      idempotencyKey: "refund-missing",
    }).catch((error: unknown) => {
      expect((error as { status?: number }).status).toBe(404);
    });
    expect(calls).toEqual([]);
  });

  it("still makes no network call when payments are on, because Stripe is not configured", async () => {
    spyFetch();
    process.env.BILLING_ENABLED = "true";
    const { cookie } = await signIn("billing-on@fund.example");
    const checkoutRes = await checkout(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ sku: "pack3" }),
      }),
    );
    expect(checkoutRes.status).toBe(501);
    expect(await checkoutRes.json()).toEqual({ error: "Stripe is not configured" });
    const hook = await webhook(
      new Request("http://localhost/api/billing/webhook", { method: "POST", body: "{}" }),
    );
    expect(hook.status).toBe(501);
    expect(await hook.json()).toEqual({ error: "Stripe is not configured" });
    expect(calls).toEqual([]);
  });

  it("applies checkout and invoice fixtures idempotently and rejects a mismatched price", async () => {
    spyFetch();
    const buyer = await signIn("fixture-pack@fund.example");
    const pack = structuredClone(checkoutFixture);
    pack.data.object.client_reference_id = buyer.user.id;
    pack.data.object.metadata.user_id = buyer.user.id;
    const first = await applyBillingEvent(pack);
    expect(first.duplicate).toBe(false);
    expect((await getBalance(buyer.user.id)).flex).toBe(3);
    const second = await applyBillingEvent(pack);
    expect(second.duplicate).toBe(true);
    expect((await getBalance(buyer.user.id)).flex).toBe(3);

    const priced = structuredClone(pack);
    priced.id = "evt_bad_price";
    priced.data.object.id = "cs_bad_price";
    priced.data.object.line_items.data[0].price.lookup_key = "dit_pack_8";
    await expect(applyBillingEvent(priced)).rejects.toMatchObject({
      status: 400,
      message: "Price does not match the plan.",
    });
    const cheap = structuredClone(pack);
    cheap.id = "evt_cheap_amount";
    cheap.data.object.id = "cs_test_pack3";
    cheap.data.object.amount_total = 999;
    cheap.data.object.currency = "usd";
    const cheapResult = await applyBillingEvent(cheap);
    expect(cheapResult.duplicate).toBe(true);
    expect((await getBalance(buyer.user.id)).flex).toBe(3);

    const member = await signIn("fixture-sub@fund.example");
    const invoice = structuredClone(invoiceFixture);
    invoice.data.object.parent.subscription_details.metadata.user_id = member.user.id;
    await applyBillingEvent(invoice);
    let balance = await getBalance(member.user.id);
    expect(balance.defense).toBe(10);
    expect(balance.challenge).toBe(5);
    expect(balance.learnSlots).toBe(10);
    const replay = await applyBillingEvent(invoice);
    expect(replay.duplicate).toBe(true);
    balance = await getBalance(member.user.id);
    expect(balance.defense).toBe(10);
    expect(balance.challenge).toBe(5);
    expect(calls).toEqual([]);
  });

  it("lets a local simulate route write the ledger without calling Stripe", async () => {
    spyFetch();
    const anonymous = await simulateBilling(
      new Request("http://localhost/api/admin/billing/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "purchase", sku: "defense", idempotencyKey: "sim-anon" }),
      }),
    );
    expect(anonymous.status).toBe(401);

    const { user, cookie } = await signIn("simulate@fund.example");
    const res = await simulateBilling(
      new Request("http://localhost/api/admin/billing/simulate", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "purchase", sku: "defense", idempotencyKey: "sim-defense" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await getBalance(user.id)).defenseOnly).toBe(1);
    expect(calls).toEqual([]);
  });
});
