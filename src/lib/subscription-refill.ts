/**
 * Yearly Pro refills one month at a time. Stripe sends `invoice.paid` once
 * a year for `dit_pro_yearly`, so month 0 is granted there and later months
 * are granted here. Each month tops up to the allowance (unused subscription
 * defenses and gifts do not roll over). At most 12 grants per paid year.
 *
 * The purge cron runs this for every due subscription. The dashboard and
 * session start run it for that user. Both are idempotent.
 */

import { grantSubscriptionMonth } from "./credits";
import { getDb, type Param } from "./db";
import { HttpError } from "./errors";
import { isPlanId, type PlanId } from "./plans";

const GRANTS_PER_PAID_YEAR = 12;

interface YearlyRow {
  user_id: string;
  plan_id: string;
  stripe_subscription_id: string;
  current_period_start: string;
  current_period_end: string;
  grant_anchor: string;
  last_granted_period_index: number | string | null;
}

/** Add calendar months in UTC, clamping to the last day of a short month. */
export function addUtcMonths(anchor: Date, months: number): Date {
  if (!Number.isInteger(months)) throw new HttpError(400, "Refill month is not valid.");
  const shifted = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * How many monthly anniversaries of `anchor` have been reached by `at`.
 * The anchor itself is index 0. A time before the anchor is -1.
 */
export function monthlyAnniversaryIndex(anchor: Date, at: Date): number {
  if (at.getTime() < anchor.getTime()) return -1;
  let months =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth());
  if (addUtcMonths(anchor, months).getTime() > at.getTime()) months -= 1;
  return months;
}

export async function grantYearlyInvoiceMonth(input: {
  userId: string;
  planId: PlanId;
  subscriptionId: string;
  anchor: Date;
  periodStart: Date;
  periodEnd: Date;
  /** False when a newer event already canceled the subscription. */
  activate?: boolean;
}) {
  const db = await getDb();
  const existing = await db.get<{ grant_anchor: string | null; stripe_subscription_id: string | null }>(
    `SELECT grant_anchor, stripe_subscription_id FROM user_plans WHERE user_id = ?`,
    [input.userId],
  );
  const stored =
    existing?.stripe_subscription_id === input.subscriptionId && existing.grant_anchor
      ? new Date(existing.grant_anchor)
      : null;
  const anchor = stored && !Number.isNaN(stored.getTime()) ? stored : input.anchor;
  const periodIndex = monthlyAnniversaryIndex(anchor, input.periodStart);
  if (periodIndex < 0) throw new HttpError(400, "Invoice period starts before the subscription.");
  const result = await grantSubscriptionMonth({
    userId: input.userId,
    planId: input.planId,
    subscriptionId: input.subscriptionId,
    periodIndex,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    grantAnchor: anchor.toISOString(),
    activate: input.activate !== false,
  });
  return { ...result, periodIndex };
}

/** Remember the Stripe period on a yearly subscription without granting. */
export async function syncYearlySubscriptionWindow(input: {
  userId: string;
  subscriptionId: string;
  anchor: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}): Promise<void> {
  if (!input.anchor && !input.periodStart && !input.periodEnd) return;
  const db = await getDb();
  const anchor = input.anchor?.toISOString() ?? null;
  await db.run(
    `UPDATE user_plans SET
       stripe_subscription_id = ?,
       current_period_start = COALESCE(?, current_period_start),
       current_period_end = COALESCE(?, current_period_end),
       grant_anchor = CASE
         WHEN stripe_subscription_id IS NOT NULL AND stripe_subscription_id != ? THEN ?
         ELSE COALESCE(grant_anchor, ?)
       END,
       last_granted_period_index = CASE
         WHEN stripe_subscription_id IS NOT NULL AND stripe_subscription_id != ? THEN NULL
         ELSE last_granted_period_index
       END,
       updated_at = ?
     WHERE user_id = ?`,
    [
      input.subscriptionId,
      input.periodStart?.toISOString() ?? null,
      input.periodEnd?.toISOString() ?? null,
      input.subscriptionId,
      anchor,
      anchor,
      input.subscriptionId,
      new Date().toISOString(),
      input.userId,
    ],
  );
}

/**
 * Grant every missing Pro month for active or trialing yearly subscriptions
 * that are still inside the Stripe period. Canceled, unpaid, and ended
 * subscriptions are left alone. Pass `userId` to do one account.
 */
export async function grantDueSubscriptionRefills(opts?: {
  userId?: string;
  now?: Date;
}): Promise<{ granted: number }> {
  const now = opts?.now ?? new Date();
  const params: Param[] = [now.toISOString()];
  let userClause = "";
  if (opts?.userId) {
    userClause = " AND user_id = ?";
    params.push(opts.userId);
  }
  const db = await getDb();
  const rows = await db.all<YearlyRow>(
    `SELECT user_id, plan_id, stripe_subscription_id, current_period_start, current_period_end,
            grant_anchor, last_granted_period_index
     FROM user_plans
     WHERE interval = 'year'
       AND status IN ('active', 'trialing')
       AND stripe_subscription_id IS NOT NULL
       AND grant_anchor IS NOT NULL
       AND current_period_start IS NOT NULL
       AND current_period_end IS NOT NULL
       AND current_period_end > ?${userClause}`,
    params,
  );
  let granted = 0;
  for (const row of rows) {
    if (!isPlanId(row.plan_id)) continue;
    granted += await refillRow(row, now);
  }
  return { granted };
}

/** Dashboard and session start. A failure does not block the page. */
export async function refillUserIfDue(userId: string): Promise<void> {
  try {
    await grantDueSubscriptionRefills({ userId });
  } catch (e) {
    console.error("[refill]", e instanceof Error ? e.message : e);
  }
}

async function refillRow(row: YearlyRow, now: Date): Promise<number> {
  const anchor = new Date(row.grant_anchor);
  const periodStart = new Date(row.current_period_start);
  const periodEnd = new Date(row.current_period_end);
  if (
    Number.isNaN(anchor.getTime()) ||
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime()) ||
    now.getTime() >= periodEnd.getTime()
  ) {
    return 0;
  }
  const origin = monthlyAnniversaryIndex(anchor, periodStart);
  const due = monthlyAnniversaryIndex(anchor, now);
  if (origin < 0 || due < origin) return 0;
  const target = Math.min(due, origin + GRANTS_PER_PAID_YEAR - 1);
  const last = row.last_granted_period_index == null ? null : Number(row.last_granted_period_index);
  const start = last == null ? origin : last + 1;
  if (!isPlanId(row.plan_id)) return 0;
  let granted = 0;
  for (let index = start; index <= target; index += 1) {
    const result = await grantSubscriptionMonth({
      userId: row.user_id,
      planId: row.plan_id,
      subscriptionId: row.stripe_subscription_id,
      periodIndex: index,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      grantAnchor: anchor.toISOString(),
      activate: false,
    });
    await recordRefillGrants(row.user_id, row.stripe_subscription_id, index, result.grants);
    if (result.granted) granted += 1;
  }
  return granted;
}

/**
 * Each refill month is a stripe_grants row tied to the yearly invoice payment,
 * so a refund of that payment matches every month. Month 0 is written by the
 * webhook; later months copy its invoice, payment intent, and charge.
 */
async function recordRefillGrants(
  userId: string,
  subscriptionId: string,
  periodIndex: number,
  grants: { kind: string; source: string; credits: number }[],
): Promise<void> {
  const rows = grants.filter((grant) => grant.credits > 0);
  if (rows.length === 0) return;
  const db = await getDb();
  const prior = await db.get<{
    invoice_id: string | null;
    payment_intent_id: string | null;
    charge_id: string | null;
    sku: string;
    event_id: string;
  }>(
    `SELECT invoice_id, payment_intent_id, charge_id, sku, event_id
     FROM stripe_grants
     WHERE user_id = ? AND id LIKE ?
     ORDER BY created_at
     LIMIT 1`,
    [userId, `refill:${subscriptionId}:%`],
  );
  const now = new Date().toISOString();
  const grantKey = `refill:${subscriptionId}:${periodIndex}`;
  for (const grant of rows) {
    await db.run(
      `INSERT INTO stripe_grants
        (id, user_id, event_id, sku, kind, source, credits, checkout_session_id, invoice_id,
         payment_intent_id, charge_id, refunded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        `${grantKey}:${grant.kind}`,
        userId,
        prior?.event_id ?? grantKey,
        prior?.sku ?? "subscription_year",
        grant.kind,
        grant.source,
        grant.credits,
        prior?.invoice_id ?? null,
        prior?.payment_intent_id ?? null,
        prior?.charge_id ?? null,
        now,
      ],
    );
  }
}
