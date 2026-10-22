import {
  FUNNEL_DAYS,
  buildFunnel,
  isAnalyticsEvent,
  prepareTrack,
  type AnalyticsEventName,
  type ChallengeEventName,
  type FunnelReport,
  type TrackInput,
  analyticsRetentionCutoff,
} from "./analytics";
import { getDb, type Db } from "./db";
import { newId } from "./ids";

/**
 * Record one funnel event. Failures are swallowed so a tracking error never
 * breaks sign-in, a defense, or a share. No-ops when ANALYTICS_ENABLED is false.
 * Challenge events also no-op unless CHALLENGES_ENABLED is 1 or true.
 */
export async function track(input: TrackInput): Promise<void> {
  try {
    const prepared = prepareTrack(input);
    if (!prepared.ok) return;
    const db = await getDb();
    await db.run(
      `INSERT INTO analytics_events
        (id, name, occurred_at, user_id, subject_id, referrer_domain, props_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("aev"),
        prepared.row.name,
        prepared.row.occurredAt,
        prepared.row.userId,
        prepared.row.subjectId,
        prepared.row.referrerDomain,
        JSON.stringify(prepared.row.props),
      ],
    );
  } catch (e) {
    console.error("[analytics]", e instanceof Error ? e.message : e);
  }
}

/** Typed helper for PR #44. Same privacy rules and CHALLENGES_ENABLED guard as `track`. */
export async function trackChallenge(
  name: ChallengeEventName,
  input: Omit<TrackInput, "name"> = {},
): Promise<void> {
  await track({ ...input, name });
}

/** Delete events older than 90 days. Called from the existing purge job. */
export async function purgeOldAnalyticsEvents(db: Db, now = new Date()): Promise<number> {
  const result = await db.run(`DELETE FROM analytics_events WHERE occurred_at < ?`, [
    analyticsRetentionCutoff(now),
  ]);
  return result.changes;
}

/** Counts and step conversions for the last 7 days. No user ids or props beyond kind and onward. */
export async function funnelReport(now = new Date()): Promise<FunnelReport> {
  const since = new Date(now.getTime() - FUNNEL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  const rows = await db.all<{ name: string; n: number | string }>(
    `SELECT name, COUNT(*) AS n FROM analytics_events WHERE occurred_at >= ? GROUP BY name`,
    [since],
  );
  const counts: Partial<Record<AnalyticsEventName, number>> = {};
  for (const row of rows) {
    if (!isAnalyticsEvent(row.name)) continue;
    counts[row.name] = Number(row.n);
  }
  const createdRows = await db.all<{ props_json: string }>(
    `SELECT props_json FROM analytics_events WHERE name = ? AND occurred_at >= ?`,
    ["challenge_created", since],
  );
  const created = createdRows.map((row) => readCreatedProps(row.props_json));
  return buildFunnel({ counts, created, since });
}

function readCreatedProps(propsJson: string): { kind?: string; onward?: string } {
  try {
    const props = JSON.parse(propsJson) as { kind?: unknown; onward?: unknown };
    return {
      kind: typeof props.kind === "string" ? props.kind : undefined,
      onward: typeof props.onward === "string" ? props.onward : undefined,
    };
  } catch {
    return {};
  }
}
