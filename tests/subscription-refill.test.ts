import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink } from "../src/lib/auth";
import { consumeCredit, endPaidPlan, getBalance, grantSubscriptionMonth } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import {
  addUtcMonths,
  grantDueSubscriptionRefills,
  grantYearlyInvoiceMonth,
  monthlyAnniversaryIndex,
} from "../src/lib/subscription-refill";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-refill-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "44".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "55".repeat(32);
  delete process.env.DATABASE_URL;
  delete process.env.BILLING_ENABLED;
});

async function signIn(email: string): Promise<string> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return res!.user.id;
}

async function defenseGrants(userId: string): Promise<number[]> {
  const rows = await (await getDb()).all<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM credit_ledger
     WHERE user_id = ? AND kind = 'defense' AND amount > 0`,
    [userId],
  );
  return rows
    .map((row) => Number(row.idempotency_key.split(":")[2]))
    .sort((a, b) => a - b);
}

describe("monthly anniversaries", () => {
  it("clamps 31 January to the last day of February", () => {
    const anchor = new Date(Date.UTC(2026, 0, 31, 15, 30, 0));
    const leap = new Date(Date.UTC(2024, 0, 31, 15, 30, 0));
    expect(addUtcMonths(anchor, 1).toISOString()).toBe("2026-02-28T15:30:00.000Z");
    expect(addUtcMonths(leap, 1).toISOString()).toBe("2024-02-29T15:30:00.000Z");
    expect(addUtcMonths(anchor, 12).toISOString()).toBe("2027-01-31T15:30:00.000Z");
    expect(monthlyAnniversaryIndex(anchor, new Date(anchor.getTime() - 1))).toBe(-1);
    expect(monthlyAnniversaryIndex(anchor, anchor)).toBe(0);
    expect(monthlyAnniversaryIndex(anchor, new Date(Date.UTC(2026, 1, 27, 23, 59)))).toBe(0);
    expect(monthlyAnniversaryIndex(anchor, new Date(Date.UTC(2026, 1, 28, 15, 30)))).toBe(1);
    expect(monthlyAnniversaryIndex(leap, new Date(Date.UTC(2024, 1, 28, 15, 30)))).toBe(0);
    expect(monthlyAnniversaryIndex(leap, new Date(Date.UTC(2024, 1, 29, 15, 30)))).toBe(1);
  });
});

describe("yearly refill job", () => {
  const anchor = new Date(Date.UTC(2026, 0, 31));
  const periodEnd = new Date(Date.UTC(2027, 0, 31));

  async function openYear(email: string, subscriptionId: string, end = periodEnd): Promise<string> {
    const userId = await signIn(email);
    await grantSubscriptionMonth({
      userId,
      planId: "subscription",
      subscriptionId,
      periodIndex: 0,
      periodStart: anchor.toISOString(),
      periodEnd: end.toISOString(),
      grantAnchor: anchor.toISOString(),
      activate: true,
    });
    return userId;
  }

  it("does not grant February until the clamped anniversary", async () => {
    const userId = await openYear("feb@refill.example", "sub_feb");
    const before = await grantDueSubscriptionRefills({
      userId,
      now: new Date(Date.UTC(2026, 1, 27, 23, 59)),
    });
    expect(before.granted).toBe(0);
    expect(await defenseGrants(userId)).toEqual([0]);

    const onDay = await grantDueSubscriptionRefills({
      userId,
      now: new Date(Date.UTC(2026, 1, 28)),
    });
    expect(onDay.granted).toBe(1);
    expect(await defenseGrants(userId)).toEqual([0, 1]);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });

    const leapUser = await openYear("leap@refill.example", "sub_leap", new Date(Date.UTC(2025, 0, 31)));
    const db = await getDb();
    const leapAnchor = new Date(Date.UTC(2024, 0, 31)).toISOString();
    await db.run(
      `UPDATE user_plans SET grant_anchor = ?, current_period_start = ?, current_period_end = ? WHERE user_id = ?`,
      [leapAnchor, leapAnchor, new Date(Date.UTC(2025, 0, 31)).toISOString(), leapUser],
    );
    const stillJanuary = await grantDueSubscriptionRefills({
      userId: leapUser,
      now: new Date(Date.UTC(2024, 1, 28, 12)),
    });
    expect(stillJanuary.granted).toBe(0);
    const leapDay = await grantDueSubscriptionRefills({
      userId: leapUser,
      now: new Date(Date.UTC(2024, 1, 29)),
    });
    expect(leapDay.granted).toBe(1);
    expect(await defenseGrants(leapUser)).toEqual([0, 1]);
  });

  it("catches up a missed cron once and tops up to the allowance", async () => {
    const userId = await openYear("catchup@refill.example", "sub_catchup");
    await consumeCredit({ userId, kind: "defense", idempotencyKey: "spent-1" });
    await consumeCredit({ userId, kind: "defense", idempotencyKey: "spent-2" });
    await consumeCredit({ userId, kind: "defense", idempotencyKey: "spent-3" });
    await consumeCredit({ userId, kind: "defense", idempotencyKey: "spent-4" });
    expect((await getBalance(userId)).defense).toBe(6);

    const april = new Date(Date.UTC(2026, 3, 30));
    const first = await grantDueSubscriptionRefills({ userId, now: april });
    expect(first.granted).toBe(3);
    expect(await defenseGrants(userId)).toEqual([0, 1, 2, 3]);
    expect(await getBalance(userId)).toMatchObject({ defense: 10, challenge: 5, learnSlots: 10 });

    const again = await grantDueSubscriptionRefills({ userId, now: april });
    expect(again.granted).toBe(0);
    expect(await defenseGrants(userId)).toEqual([0, 1, 2, 3]);
    const learn = await (await getDb()).all(
      `SELECT id FROM credit_ledger WHERE user_id = ? AND kind = 'learn_slot' AND amount > 0`,
      [userId],
    );
    expect(learn).toHaveLength(1);
  });

  it("lets two concurrent runs grant each month once", async () => {
    const userId = await openYear("race@refill.example", "sub_race");
    const april = new Date(Date.UTC(2026, 3, 30));
    const [left, right] = await Promise.all([
      grantDueSubscriptionRefills({ userId, now: april }),
      grantDueSubscriptionRefills({ userId, now: april }),
    ]);
    expect(left.granted + right.granted).toBe(3);
    expect(await defenseGrants(userId)).toEqual([0, 1, 2, 3]);
    expect((await getBalance(userId)).defense).toBe(10);
    const third = await grantDueSubscriptionRefills({ userId, now: april });
    expect(third.granted).toBe(0);
  });

  it("stops after cancellation, unpaid, or the period end, and keeps a scheduled cancel", async () => {
    const deleted = await openYear("deleted@refill.example", "sub_deleted");
    await endPaidPlan(deleted, "sub_deleted");
    const afterDelete = await grantDueSubscriptionRefills({
      userId: deleted,
      now: new Date(Date.UTC(2026, 3, 30)),
    });
    expect(afterDelete.granted).toBe(0);
    expect((await getBalance(deleted)).defense).toBe(0);

    const unpaid = await openYear("unpaid@refill.example", "sub_unpaid");
    const db = await getDb();
    await db.run(`UPDATE user_plans SET status = 'unpaid' WHERE user_id = ?`, [unpaid]);
    expect(
      (await grantDueSubscriptionRefills({ userId: unpaid, now: new Date(Date.UTC(2026, 2, 31)) })).granted,
    ).toBe(0);
    expect((await getBalance(unpaid)).defense).toBe(10);

    const canceled = await openYear("canceled@refill.example", "sub_canceled");
    await db.run(`UPDATE user_plans SET status = 'canceled' WHERE user_id = ?`, [canceled]);
    expect(
      (await grantDueSubscriptionRefills({ userId: canceled, now: new Date(Date.UTC(2026, 2, 31)) })).granted,
    ).toBe(0);

    const ended = await openYear("ended@refill.example", "sub_ended");
    expect((await grantDueSubscriptionRefills({ userId: ended, now: periodEnd })).granted).toBe(0);
    expect(await defenseGrants(ended)).toEqual([0]);

    const scheduled = await openYear("scheduled@refill.example", "sub_scheduled");
    await db.run(`UPDATE user_plans SET cancel_at_period_end = 1 WHERE user_id = ?`, [scheduled]);
    const kept = await grantDueSubscriptionRefills({
      userId: scheduled,
      now: new Date(Date.UTC(2026, 2, 31)),
    });
    expect(kept.granted).toBe(2);
    expect(await defenseGrants(scheduled)).toEqual([0, 1, 2]);
  });

  it("grants at most 12 months in a paid year, then month 0 of the next invoice", async () => {
    const farEnd = new Date(Date.UTC(2029, 0, 31));
    const userId = await openYear("cap@refill.example", "sub_cap", farEnd);
    const month14 = addUtcMonths(anchor, 14);
    const caught = await grantDueSubscriptionRefills({ userId, now: month14 });
    expect(caught.granted).toBe(11);
    expect(await defenseGrants(userId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect((await grantDueSubscriptionRefills({ userId, now: month14 })).granted).toBe(0);

    const next = await grantYearlyInvoiceMonth({
      userId,
      planId: "subscription",
      subscriptionId: "sub_cap",
      anchor: addUtcMonths(anchor, 12),
      periodStart: addUtcMonths(anchor, 12),
      periodEnd: addUtcMonths(anchor, 24),
    });
    expect(next.periodIndex).toBe(12);
    expect(next.granted).toBe(true);
    expect(await defenseGrants(userId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect((await getBalance(userId)).defense).toBe(10);

    const replay = await grantYearlyInvoiceMonth({
      userId,
      planId: "subscription",
      subscriptionId: "sub_cap",
      anchor,
      periodStart: addUtcMonths(anchor, 12),
      periodEnd: addUtcMonths(anchor, 24),
    });
    expect(replay.granted).toBe(false);
    expect(replay.periodIndex).toBe(12);
    expect((await getBalance(userId)).defense).toBe(10);
  });
});
