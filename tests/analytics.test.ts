import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as beacon } from "../src/app/api/analytics/route";
import { POST as requestLink } from "../src/app/api/auth/request/route";
import { POST as verifyLink } from "../src/app/api/auth/verify/route";
import {
  ANALYTICS_EVENTS,
  CHALLENGE_EVENTS,
  CHALLENGE_TRACK_SITES,
  buildFunnel,
  minuteStamp,
  prepareTrack,
  referrerDomain,
  type AnalyticsEventName,
} from "../src/lib/analytics";
import { funnelReport, track, trackChallenge } from "../src/lib/analytics-store";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  completeDefendSession,
  creatorIngest,
  purgeExpired,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));
const USER = "usr_abcdefghij1234";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-analytics-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
  process.env.ANALYTICS_ENABLED = "true";
  delete process.env.CHALLENGES_ENABLED;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.ADMIN_EMAILS;
});

interface StoredEvent {
  name: string;
  occurred_at: string;
  user_id: string | null;
  subject_id: string | null;
  referrer_domain: string | null;
  props_json: string;
}

async function events(name: string): Promise<StoredEvent[]> {
  const db = await getDb();
  return db.all<StoredEvent>(
    `SELECT name, occurred_at, user_id, subject_id, referrer_domain, props_json FROM analytics_events WHERE name = ?`,
    [name],
  );
}

function beaconRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/analytics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("prepareTrack privacy", () => {
  it("rounds the timestamp to the minute and keeps only utm fields", () => {
    const prepared = prepareTrack({
      name: "landing_view",
      now: new Date("2026-10-22T14:44:59.800Z"),
      userId: USER,
      subjectId: "ses_shouldnotstore",
      referrer: "https://News.YCombinator.com/item?id=1&ref=secret",
      props: {
        utm_source: "beta",
        utm_campaign: "week1",
        email: "founder@fund.example",
        score: 84,
        text: "The memo says churn is 1.2% and the whole document follows.",
        userAgent: "Mozilla/5.0",
        ip: "203.0.113.8",
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.row.occurredAt).toBe("2026-10-22T14:44:00.000Z");
    expect(prepared.row.userId).toBeNull();
    expect(prepared.row.subjectId).toBeNull();
    expect(prepared.row.referrerDomain).toBe("news.ycombinator.com");
    expect(prepared.row.props).toEqual({ utm_source: "beta", utm_campaign: "week1" });
  });

  it("drops email-like and URL-like campaign values, and IP referrers", () => {
    expect(referrerDomain("http://203.0.113.8/path")).toBeNull();
    expect(referrerDomain("http://[2001:db8::1]/a")).toBeNull();
    const prepared = prepareTrack({
      name: "landing_view",
      referrer: "http://203.0.113.8/admin",
      props: { utm_source: "founder@x.com", utm_campaign: "https://evil.example/phish" },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.row.referrerDomain).toBeNull();
    expect(prepared.row.props).toEqual({});
  });

  it("keeps a signed-in user id and the difficulty tier, and drops the score", () => {
    const prepared = prepareTrack({
      name: "defense_completed",
      userId: USER,
      subjectId: "ses_abc123def456gh",
      props: { tier: "hard", score: 84, outcome: "Defended", tierLabel: "Strong" },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.row.userId).toBe(USER);
    expect(prepared.row.subjectId).toBe("ses_abc123def456gh");
    expect(prepared.row.props).toEqual({ tier: "hard" });
  });

  it("rejects a user id that is not an account id, including on sign-in start", () => {
    const completed = prepareTrack({
      name: "sign_in_completed",
      userId: "founder@fund.example",
      props: { method: "email" },
    });
    const started = prepareTrack({
      name: "sign_in_started",
      userId: USER,
      subjectId: "di_session_secret",
      props: { method: "google" },
    });
    expect(completed.ok && completed.row.userId).toBeNull();
    expect(started.ok && started.row.userId).toBeNull();
    expect(started.ok && started.row.subjectId).toBeNull();
    expect(started.ok && started.row.props).toEqual({ method: "google" });
  });

  it("skips when analytics is off, when DNT or Sec-GPC is set, and for unknown names", () => {
    process.env.ANALYTICS_ENABLED = "false";
    expect(prepareTrack({ name: "landing_view" }).ok).toBe(false);
    process.env.ANALYTICS_ENABLED = "true";
    expect(prepareTrack({ name: "landing_view", headers: new Headers({ dnt: "1" }) }).ok).toBe(false);
    expect(prepareTrack({ name: "landing_view", headers: new Headers({ "sec-gpc": "1" }) }).ok).toBe(false);
    expect(prepareTrack({ name: "page_view" as AnalyticsEventName }).ok).toBe(false);
  });

  it("holds challenge events until CHALLENGES_ENABLED is on", () => {
    delete process.env.CHALLENGES_ENABLED;
    expect(prepareTrack({ name: "challenge_created", subjectId: "chg_abc123def456gh" }).ok).toBe(false);
    process.env.CHALLENGES_ENABLED = "1";
    const prepared = prepareTrack({
      name: "challenge_created",
      userId: USER,
      subjectId: "chg_abc123def456gh",
      props: { kind: "self", onward: "defender", sponsor: "beta", subject: "defend my README", sourceUrl: "https://x.com/a/status/1" },
    });
    delete process.env.CHALLENGES_ENABLED;
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.row.props).toEqual({ kind: "self", onward: "defender", sponsor: "beta" });
  });
});

describe("track() and retention", () => {
  it("stores a landing view with no identifier", async () => {
    const now = new Date("2026-10-22T09:01:40.000Z");
    await track({
      name: "landing_view",
      now,
      userId: USER,
      referrer: "https://t.co/abc",
      props: { utm_source: "x", utm_campaign: "loop" },
    });
    const rows = await events("landing_view");
    const row = rows.find((item) => item.occurred_at === minuteStamp(now));
    expect(row).toMatchObject({
      user_id: null,
      subject_id: null,
      referrer_domain: "t.co",
      props_json: JSON.stringify({ utm_source: "x", utm_campaign: "loop" }),
    });
  });

  it("does not store a beacon hit when DNT, Sec-GPC, or a foreign origin is set", async () => {
    const before = (await events("landing_view")).length;
    expect((await beacon(beaconRequest({ name: "landing_view", props: { utm_source: "x" } }, { dnt: "1" }))).status).toBe(204);
    expect((await beacon(beaconRequest({ name: "landing_view" }, { "sec-gpc": "1" }))).status).toBe(204);
    expect(
      (
        await beacon(
          beaconRequest(
            { name: "landing_view", userId: USER, props: { email: "a@b.co" } },
            { origin: "https://evil.example", host: "localhost:3000" },
          ),
        )
      ).status,
    ).toBe(204);
    expect((await events("landing_view")).length).toBe(before);
  });

  it("stores a receipt share from the beacon without a user id", async () => {
    const res = await beacon(
      beaconRequest({
        name: "receipt_shared",
        subjectId: "rcpt_abcDEF1234567890abcd",
        userId: USER,
        props: { method: "copy", score: 90 },
      }),
    );
    expect(res.status).toBe(204);
    const rows = await events("receipt_shared");
    expect(rows.at(-1)).toMatchObject({
      user_id: null,
      subject_id: "rcpt_abcDEF1234567890abcd",
      props_json: JSON.stringify({ method: "copy" }),
    });
  });

  it("no-ops challenge events unless challenges are enabled", async () => {
    delete process.env.CHALLENGES_ENABLED;
    await trackChallenge("challenge_opened", { subjectId: "chg_abc123def456gh", userId: USER });
    expect(await events("challenge_opened")).toHaveLength(0);
    process.env.CHALLENGES_ENABLED = "true";
    await trackChallenge("challenge_opened", { subjectId: "chg_abc123def456gh", userId: USER });
    delete process.env.CHALLENGES_ENABLED;
    const rows = await events("challenge_opened");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(USER);
  });

  it("does not write when ANALYTICS_ENABLED=false", async () => {
    process.env.ANALYTICS_ENABLED = "0";
    await track({ name: "sign_in_started", props: { method: "email" } });
    process.env.ANALYTICS_ENABLED = "true";
    expect(await events("sign_in_started")).toHaveLength(0);
  });

  it("lists every challenge event once, on the PR #44 call site", () => {
    expect(CHALLENGE_TRACK_SITES.map((site) => site.event)).toEqual([...CHALLENGE_EVENTS]);
    for (const site of CHALLENGE_TRACK_SITES) {
      expect(site.file).toBe("src/lib/challenges.ts");
      expect(site.symbol.length).toBeGreaterThan(0);
      expect(ANALYTICS_EVENTS).toContain(site.event);
    }
  });

  it("purges events older than 90 days and keeps newer ones", async () => {
    const db = await getDb();
    await db.run(`DELETE FROM analytics_events`);
    const now = new Date();
    await track({
      name: "landing_view",
      now: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000),
      props: { utm_source: "old" },
    });
    await track({
      name: "landing_view",
      now: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      props: { utm_source: "kept" },
    });
    const purged = await purgeExpired();
    expect(purged.analyticsEvents).toBe(1);
    const rows = await events("landing_view");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].props_json)).toEqual({ utm_source: "kept" });
  });

  it("records sign-in start and completion from the auth routes, without the email", async () => {
    const db = await getDb();
    await db.run(`DELETE FROM analytics_events WHERE name IN ('sign_in_started', 'sign_in_completed')`);
    const email = "analytics-route@fund.example";
    const headers = {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    };
    const requested = await requestLink(
      new Request("http://localhost:3000/api/auth/request", {
        method: "POST",
        headers,
        body: JSON.stringify({ email }),
      }),
    );
    const requestedBody = (await requested.json()) as { devLink?: string };
    expect(requested.ok).toBe(true);
    const token = requestedBody.devLink!.split("#token=")[1];
    const verified = await verifyLink(
      new Request("http://localhost:3000/api/auth/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({ token }),
      }),
    );
    expect(verified.ok).toBe(true);
    const started = await events("sign_in_started");
    const completed = await events("sign_in_completed");
    expect(started).toHaveLength(1);
    expect(JSON.parse(started[0].props_json)).toEqual({ method: "email" });
    expect(started[0].user_id).toBeNull();
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0].props_json)).toEqual({ method: "email" });
    expect(completed[0].user_id).toMatch(/^usr_[a-z0-9]+$/);
    expect(JSON.stringify(completed[0])).not.toContain(email);
  });
});

describe("funnel query", () => {
  it("computes step conversion, acceptance, share-back, and onward k", () => {
    const report = buildFunnel({
      since: "2026-10-15T00:00:00.000Z",
      counts: {
        landing_view: 4,
        sign_in_started: 2,
        sign_in_completed: 1,
        defense_started: 1,
        defense_completed: 0,
        receipt_shared: 0,
        challenge_created: 4,
        challenge_opened: 2,
        challenge_accepted: 1,
        challenge_declined: 1,
        challenge_completed: 1,
        challenge_shared_back: 1,
      },
      created: [
        { kind: "self", onward: "defender" },
        { kind: "third_party", onward: "viewer" },
        { kind: "third_party" },
        {},
      ],
    });
    expect(report.product.map((step) => [step.event, step.count, step.conversion])).toEqual([
      ["landing_view", 4, null],
      ["sign_in_started", 2, 0.5],
      ["sign_in_completed", 1, 0.5],
      ["defense_started", 1, 1],
      ["defense_completed", 0, 0],
      ["receipt_shared", 0, null],
    ]);
    expect(report.challenge.find((step) => step.event === "challenge_accepted")?.conversion).toBe(0.5);
    expect(report.challenge.find((step) => step.event === "challenge_completed")?.conversion).toBe(1);
    expect(report.challenge.find((step) => step.event === "challenge_shared_back")?.conversion).toBe(1);
    expect(report.declined).toEqual({ count: 1, conversion: 0.5 });
    expect(report.onwardCount).toBe(2);
    expect(report.onwardK).toBe(2);
    expect(report.selfChallenges).toBe(1);
    expect(report.thirdPartyChallenges).toBe(2);
    expect(report.unspecifiedChallenges).toBe(1);
  });

  it("counts the last 7 days from the table and ignores older events", async () => {
    const db = await getDb();
    await db.run(`DELETE FROM analytics_events`);
    const now = new Date("2026-10-22T12:00:00.000Z");
    process.env.CHALLENGES_ENABLED = "1";
    await track({ name: "landing_view", now, props: { utm_source: "x" } });
    await track({ name: "landing_view", now: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) });
    await track({ name: "sign_in_started", now, props: { method: "email" } });
    await track({
      name: "challenge_created",
      now,
      userId: USER,
      subjectId: "chg_recent00000001",
      props: { kind: "third_party", onward: "viewer", sponsor: "beta" },
    });
    await track({
      name: "challenge_created",
      now: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      userId: USER,
      subjectId: "chg_old00000000001",
      props: { kind: "self", onward: "defender" },
    });
    await track({ name: "challenge_opened", now, subjectId: "chg_recent00000001" });
    await track({ name: "challenge_accepted", now, userId: USER, subjectId: "chg_recent00000001" });
    await track({
      name: "challenge_completed",
      now,
      userId: USER,
      subjectId: "chg_recent00000001",
      props: { tier: "standard", score: 91 },
    });
    delete process.env.CHALLENGES_ENABLED;

    const report = await funnelReport(now);
    expect(report.days).toBe(7);
    expect(report.product.find((step) => step.event === "landing_view")?.count).toBe(1);
    expect(report.product.find((step) => step.event === "sign_in_started")?.conversion).toBe(1);
    expect(report.challenge.find((step) => step.event === "challenge_created")?.count).toBe(1);
    expect(report.challenge.find((step) => step.event === "challenge_accepted")?.conversion).toBe(1);
    expect(report.challenge.find((step) => step.event === "challenge_completed")?.conversion).toBe(1);
    expect(report.onwardK).toBe(1);
    expect(report.selfChallenges).toBe(0);
    expect(report.thirdPartyChallenges).toBe(1);
    const stored = await events("challenge_completed");
    expect(stored[0].props_json).toBe(JSON.stringify({ tier: "standard" }));
  });
});

describe("defense wiring", () => {
  async function signIn(email: string): Promise<User> {
    const { devLink } = await requestMagicLink({ email });
    const token = devLink!.split("#token=")[1];
    const res = await consumeMagicLink(token);
    return res!.user;
  }

  async function answerAll(session: { sessionId: string; plan: { probes: { id: string }[] } }, user: User) {
    for (const [i, probe] of session.plan.probes.entries()) {
      await recordDefendAnswer({
        sessionId: session.sessionId,
        user,
        probeId: probe.id,
        answer: `Because the unit economics section shows churn near 1.2% and LTV/CAC above 3. (${i})`,
      });
    }
  }

  it("records tier on defend start and completion, and skips learn and a Do Not Track start", async () => {
    const db = await getDb();
    await db.run(
      `DELETE FROM analytics_events WHERE name IN ('defense_started', 'defense_completed', 'learn_opened')`,
    );
    const user = await signIn("analytics-defend@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    await startSession({
      token: ingest.token,
      user,
      mode: "defend",
      accommodation: true,
      analyticsHeaders: new Headers({ dnt: "1" }),
    });
    expect(await events("defense_started")).toHaveLength(0);
    await startSession({ token: ingest.token, user, mode: "learn" });
    expect(await events("defense_started")).toHaveLength(0);
    expect(await events("learn_opened")).toHaveLength(1);

    const session = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    const startedRows = await events("defense_started");
    expect(startedRows).toHaveLength(1);
    expect(startedRows[0]).toMatchObject({
      user_id: user.id,
      subject_id: session.sessionId,
      props_json: JSON.stringify({ tier: "standard" }),
    });

    await answerAll(session, user);
    const first = await completeDefendSession({ sessionId: session.sessionId, user });
    if (first.followUp) {
      await recordDefendAnswer({
        sessionId: session.sessionId,
        user,
        probeId: first.followUp.probe.id,
        answer: "The assumption that holds the case is the churn rate staying near 1.2%.",
      });
      await completeDefendSession({ sessionId: session.sessionId, user });
    }
    await completeDefendSession({ sessionId: session.sessionId, user });
    const done = await events("defense_completed");
    expect(done).toHaveLength(1);
    expect(JSON.parse(done[0].props_json)).toEqual({ tier: "standard" });
    expect(done[0].props_json).not.toMatch(/score|Defended|Strong/);
  });
});

describe("analytics_events columns", () => {
  it("has no IP, user agent, cookie, or document column", async () => {
    const db = await getDb();
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(analytics_events)`);
    expect(cols.map((col) => col.name).sort()).toEqual(
      ["id", "name", "occurred_at", "props_json", "referrer_domain", "subject_id", "user_id"].sort(),
    );
  });
});
