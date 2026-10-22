import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { sha256Hex } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";
import { ipLimitKey } from "../src/lib/http";
import { ipHash, resetIpHashNotices } from "../src/lib/ip-hash";
import {
  completeDefendSession,
  creatorIngest,
  purgeExpired,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));
const ACCOUNT_ID = "usr_abcdefghij1234";
const SESSION_ID = "ses_abc123def456gh";
const RECEIPT_ID = "rcpt_abcDEF1234567890abcd";
const ID_LEAK = /usr_|ses_|rcpt_/;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-analytics-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
  process.env.ANALYTICS_ENABLED = "true";
  process.env.IP_HASH_SALT = "ab".repeat(32);
  delete process.env.DEMO_IP_SALT;
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
  referrer_domain: string | null;
  props_json: string;
}

async function events(name: string): Promise<StoredEvent[]> {
  const db = await getDb();
  return db.all<StoredEvent>(
    `SELECT name, occurred_at, referrer_domain, props_json FROM analytics_events WHERE name = ?`,
    [name],
  );
}

async function seedBucket(key: string, count: number) {
  const db = await getDb();
  await db.run(
    `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, ?)
     ON CONFLICT (bucket_key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
    [key, new Date().toISOString(), count],
  );
}

function clientRequest(ip: string) {
  return new Request("http://localhost:3000/api/analytics", { headers: { "x-forwarded-for": ip } });
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
    expect(prepared.row).not.toHaveProperty("userId");
    expect(prepared.row).not.toHaveProperty("subjectId");
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

  it("keeps the difficulty tier and drops the score", () => {
    const prepared = prepareTrack({
      name: "defense_completed",
      props: { tier: "hard", score: 84, outcome: "Defended", tierLabel: "Strong", userId: ACCOUNT_ID },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.row).not.toHaveProperty("userId");
    expect(prepared.row).not.toHaveProperty("subjectId");
    expect(prepared.row.props).toEqual({ tier: "hard" });
  });

  it("drops account-shaped props on sign-in", () => {
    const started = prepareTrack({
      name: "sign_in_started",
      props: { method: "google", userId: ACCOUNT_ID, subjectId: SESSION_ID, email: "founder@fund.example" },
    });
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
    expect(prepareTrack({ name: "challenge_created" }).ok).toBe(false);
    process.env.CHALLENGES_ENABLED = "1";
    const prepared = prepareTrack({
      name: "challenge_created",
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
      referrer: "https://t.co/abc",
      props: { utm_source: "x", utm_campaign: "loop" },
    });
    const rows = await events("landing_view");
    const row = rows.find((item) => item.occurred_at === minuteStamp(now));
    expect(row).toMatchObject({
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
            { name: "landing_view", props: { email: "a@b.co" } },
            { origin: "https://evil.example", host: "localhost:3000" },
          ),
        )
      ).status,
    ).toBe(204);
    expect((await events("landing_view")).length).toBe(before);
  });

  it("stores a receipt share from the beacon without an id", async () => {
    const res = await beacon(
      beaconRequest(
        {
          name: "receipt_shared",
          subjectId: RECEIPT_ID,
          userId: ACCOUNT_ID,
          props: { method: "copy", score: 90 },
        },
        { "x-forwarded-for": "203.0.113.21" },
      ),
    );
    expect(res.status).toBe(204);
    const rows = await events("receipt_shared");
    expect(rows.at(-1)).toMatchObject({
      props_json: JSON.stringify({ method: "copy" }),
    });
    expect(JSON.stringify(rows.at(-1))).not.toMatch(ID_LEAK);
  });

  it("no-ops challenge events unless challenges are enabled", async () => {
    delete process.env.CHALLENGES_ENABLED;
    await trackChallenge("challenge_opened");
    expect(await events("challenge_opened")).toHaveLength(0);
    process.env.CHALLENGES_ENABLED = "true";
    await trackChallenge("challenge_opened");
    delete process.env.CHALLENGES_ENABLED;
    const rows = await events("challenge_opened");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toMatch(ID_LEAK);
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
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0].props_json)).toEqual({ method: "email" });
    expect(JSON.stringify(completed[0])).not.toContain(email);
    expect(JSON.stringify(completed[0])).not.toMatch(ID_LEAK);
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
      props: { kind: "third_party", onward: "viewer", sponsor: "beta" },
    });
    await track({
      name: "challenge_created",
      now: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      props: { kind: "self", onward: "defender" },
    });
    await track({ name: "challenge_opened", now });
    await track({ name: "challenge_accepted", now });
    await track({
      name: "challenge_completed",
      now,
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

  it("counts sample demos apart from the product steps", async () => {
    const db = await getDb();
    const now = new Date("2026-10-22T12:00:00.000Z");
    const before = await funnelReport(now);
    const stamp = now.toISOString();
    await db.run(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`, [
      "usr_demofunnel0001",
      "anon@demo.defendit.invalid",
      stamp,
    ]);
    await db.run(
      `INSERT INTO defense_requests
        (id, token, owner_user_id, kind, difficulty, title, status, created_at)
       VALUES (?, ?, ?, 'demo', 'standard', 'sample', 'open', ?)`,
      ["req_demofunnel0001", "tok_demofunnel0001", "usr_demofunnel0001", stamp],
    );
    await db.run(
      `INSERT INTO deliverables
        (id, request_id, owner_user_id, mime_type, byte_length, sha256, claim_count, purge_after, created_at)
       VALUES (?, ?, ?, 'text/markdown', 4, 'abc', 0, ?, ?)`,
      ["del_demofunnel0001", "req_demofunnel0001", "usr_demofunnel0001", stamp, stamp],
    );
    await db.run(
      `INSERT INTO sessions
        (id, request_id, deliverable_id, user_id, mode, seed, status, started_at, completed_at, purge_after, channel)
       VALUES (?, ?, ?, ?, 'defend', 'seed', 'completed', ?, ?, ?, 'text')`,
      ["ses_demofunnel0001", "req_demofunnel0001", "del_demofunnel0001", "usr_demofunnel0001", stamp, stamp, stamp],
    );
    await db.run(
      `INSERT INTO receipts (id, session_id, request_id, payload_json, signature, public_key, created_at)
       VALUES (?, ?, ?, ?, 'sig', 'pk', ?)`,
      [
        "rcpt_demofunnel01",
        "ses_demofunnel0001",
        "req_demofunnel0001",
        JSON.stringify({
          payload: { outcome: "Defended", demo: { sample: true, credential: false, file: "sample" } },
        }),
        stamp,
      ],
    );
    await db.run(
      `INSERT INTO credit_ledger
        (id, user_id, kind, reason, amount, idempotency_key, purpose, ref_type, budget_cents, created_at)
       VALUES (?, ?, 'defense', 'consume', 0, 'demo-budget:req_demofunnel0001', 'demo', 'demo', 70, ?)`,
      ["led_demofunnel01", "usr_demofunnel0001", stamp],
    );
    const after = await funnelReport(now);
    expect(after.product.find((step) => step.event === "defense_started")?.count).toBe(
      before.product.find((step) => step.event === "defense_started")?.count,
    );
    expect(after.product.find((step) => step.event === "defense_completed")?.count).toBe(
      before.product.find((step) => step.event === "defense_completed")?.count,
    );
    expect(after.demo).toEqual({
      started: before.demo.started + 1,
      completed: before.demo.completed + 1,
      budget_cents: before.demo.budget_cents + 70,
    });
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
      props_json: JSON.stringify({ tier: "standard" }),
    });
    expect(JSON.stringify(startedRows[0])).not.toMatch(ID_LEAK);
    expect(JSON.stringify(startedRows[0])).not.toContain(user.id);
    expect(JSON.stringify(startedRows[0])).not.toContain(session.sessionId);

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

  it("does not record a demo defense in the event funnel", async () => {
    const db = await getDb();
    await db.run(
      `DELETE FROM analytics_events WHERE name IN ('defense_started', 'defense_completed')`,
    );
    const before = await funnelReport();
    const user = await signIn("analytics-demo-kind@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo, difficulty: "standard" });
    await db.run(`UPDATE defense_requests SET kind = 'demo' WHERE token = ?`, [ingest.token]);
    const session = await startSession({
      token: ingest.token,
      user,
      mode: "defend",
      accommodation: true,
    });
    expect(await events("defense_started")).toHaveLength(0);
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
    expect(await events("defense_completed")).toHaveLength(0);
    const after = await funnelReport();
    expect(after.product.find((step) => step.event === "defense_started")?.count).toBe(
      before.product.find((step) => step.event === "defense_started")?.count,
    );
    expect(after.product.find((step) => step.event === "defense_completed")?.count).toBe(
      before.product.find((step) => step.event === "defense_completed")?.count,
    );
  });
});

describe("analytics_events columns", () => {
  it("has no IP, user agent, cookie, document, or id column", async () => {
    const db = await getDb();
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(analytics_events)`);
    expect(cols.map((col) => col.name).sort()).toEqual(
      ["id", "name", "occurred_at", "props_json", "referrer_domain"].sort(),
    );
  });

  it("stores no usr_, ses_, or rcpt_ id", async () => {
    const db = await getDb();
    await db.run(`DELETE FROM analytics_events`);
    process.env.CHALLENGES_ENABLED = "1";
    const smuggled = {
      name: "defense_completed" as const,
      userId: ACCOUNT_ID,
      subjectId: SESSION_ID,
      props: {
        tier: "hard",
        note: `${ACCOUNT_ID} ${SESSION_ID} ${RECEIPT_ID}`,
        receiptId: RECEIPT_ID,
      },
    };
    await track(smuggled);
    await track({
      name: "sign_in_completed",
      props: { method: "email", userId: ACCOUNT_ID, sessionId: SESSION_ID },
    });
    delete process.env.CHALLENGES_ENABLED;
    const res = await beacon(
      beaconRequest(
        {
          name: "receipt_shared",
          subjectId: RECEIPT_ID,
          userId: ACCOUNT_ID,
          props: { method: "copy", receiptId: RECEIPT_ID, sessionId: SESSION_ID },
        },
        { "x-forwarded-for": "203.0.113.20" },
      ),
    );
    expect(res.status).toBe(204);
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM analytics_events`);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.name).not.toMatch(ID_LEAK);
      expect(String(row.occurred_at)).not.toMatch(ID_LEAK);
      expect(String(row.referrer_domain ?? "")).not.toMatch(ID_LEAK);
      expect(String(row.props_json)).not.toMatch(ID_LEAK);
      expect(row).not.toHaveProperty("user_id");
      expect(row).not.toHaveProperty("subject_id");
    }
  });
});

describe("beacon rate limits", () => {
  it("keys the per-client bucket on a hash of the IP", async () => {
    const ip = "203.0.113.10";
    const before = (await events("receipt_shared")).length;
    const res = await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "share" } }, { "x-forwarded-for": ip }),
    );
    expect(res.status).toBe(204);
    expect((await events("receipt_shared")).length).toBe(before + 1);
    const db = await getDb();
    const key = ipLimitKey("analytics:m", clientRequest(ip));
    expect(key).toBe(`analytics:m:ip:${ipHash(ip)}`);
    expect(ipHash(ip)).not.toBe(sha256Hex(ip));
    const row = await db.get<{ bucket_key: string }>(
      `SELECT bucket_key FROM rate_limits WHERE bucket_key = ?`,
      [key],
    );
    expect(row?.bucket_key).toBe(key);
    const leaked = await db.get<{ bucket_key: string }>(
      `SELECT bucket_key FROM rate_limits WHERE bucket_key LIKE ?`,
      [`%${ip}%`],
    );
    expect(leaked).toBeUndefined();
  });

  it("drops the 31st beacon from the same client in a minute", async () => {
    const ip = "203.0.113.11";
    const key = ipLimitKey("analytics:m", clientRequest(ip));
    if (!key) throw new Error("expected a salt");
    await seedBucket(key, 30);
    const before = (await events("receipt_shared")).length;
    const res = await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "copy" } }, { "x-forwarded-for": ip }),
    );
    expect(res.status).toBe(204);
    expect((await events("receipt_shared")).length).toBe(before);
  });

  it("drops a beacon after 300 from the same client in a day", async () => {
    const ip = "203.0.113.12";
    const key = ipLimitKey("analytics:d", clientRequest(ip));
    if (!key) throw new Error("expected a salt");
    await seedBucket(key, 300);
    const before = (await events("receipt_shared")).length;
    await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "copy" } }, { "x-forwarded-for": ip }),
    );
    expect((await events("receipt_shared")).length).toBe(before);
  });

  it("stores one landing_view per hashed client within 60s and still stores repeat shares", async () => {
    const landingIp = "203.0.113.14";
    const beforeLanding = (await events("landing_view")).length;
    await beacon(
      beaconRequest({ name: "landing_view", props: { utm_source: "x" } }, { "x-forwarded-for": landingIp }),
    );
    await beacon(
      beaconRequest({ name: "landing_view", props: { utm_source: "x" } }, { "x-forwarded-for": landingIp }),
    );
    expect((await events("landing_view")).length).toBe(beforeLanding + 1);

    const shareIp = "203.0.113.15";
    const beforeShare = (await events("receipt_shared")).length;
    await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "copy" } }, { "x-forwarded-for": shareIp }),
    );
    await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "share" } }, { "x-forwarded-for": shareIp }),
    );
    expect((await events("receipt_shared")).length).toBe(beforeShare + 2);
  });

  it("does not charge the global bucket when the client minute or day cap is already full", async () => {
    const db = await getDb();
    async function bucketCount(key: string): Promise<number> {
      const row = await db.get<{ count: number | string }>(
        `SELECT count FROM rate_limits WHERE bucket_key = ?`,
        [key],
      );
      return Number(row?.count ?? 0);
    }

    const minuteIp = "203.0.113.16";
    const minuteKey = ipLimitKey("analytics:m", clientRequest(minuteIp));
    if (!minuteKey) throw new Error("expected a salt");
    await seedBucket(minuteKey, 30);
    const beforeEvents = (await events("receipt_shared")).length;
    const globalBefore = await bucketCount("analytics:beacon");
    await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "copy" } }, { "x-forwarded-for": minuteIp }),
    );
    expect((await events("receipt_shared")).length).toBe(beforeEvents);
    expect(await bucketCount("analytics:beacon")).toBe(globalBefore);

    const dayIp = "203.0.113.17";
    const dayKey = ipLimitKey("analytics:d", clientRequest(dayIp));
    if (!dayKey) throw new Error("expected a salt");
    await seedBucket(dayKey, 300);
    const globalMid = await bucketCount("analytics:beacon");
    await beacon(
      beaconRequest({ name: "receipt_shared", props: { method: "share" } }, { "x-forwarded-for": dayIp }),
    );
    expect(await bucketCount("analytics:beacon")).toBe(globalMid);
  });

  it("drops a beacon once the global minute cap is full", async () => {
    const db = await getDb();
    await seedBucket("analytics:beacon", 120);
    try {
      const before = (await events("receipt_shared")).length;
      await beacon(
        beaconRequest(
          { name: "receipt_shared", props: { method: "copy" } },
          { "x-forwarded-for": "203.0.113.13" },
        ),
      );
      expect((await events("receipt_shared")).length).toBe(before);
    } finally {
      await db.run(`DELETE FROM rate_limits WHERE bucket_key = ?`, ["analytics:beacon"]);
    }
  });

  it("skips IP buckets when ipHash returns null and still applies the global cap", async () => {
    const ip = "203.0.113.18";
    const minuteKey = ipLimitKey("analytics:m", clientRequest(ip));
    const dayKey = ipLimitKey("analytics:d", clientRequest(ip));
    if (!minuteKey || !dayKey) throw new Error("expected a salt");
    await seedBucket(minuteKey, 30);
    await seedBucket(dayKey, 300);

    const savedSalt = process.env.IP_HASH_SALT;
    const savedDemo = process.env.DEMO_IP_SALT;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await getDb();
    try {
      resetIpHashNotices();
      delete process.env.IP_HASH_SALT;
      delete process.env.DEMO_IP_SALT;
      expect(ipHash(ip)).toBeNull();
      expect(ipLimitKey("analytics:m", clientRequest(ip))).toBeNull();

      async function sideKeys(): Promise<string[]> {
        const rows = await db.all<{ bucket_key: string }>(
          `SELECT bucket_key FROM rate_limits
           WHERE bucket_key LIKE 'analytics:%' AND bucket_key != 'analytics:beacon'
           ORDER BY bucket_key`,
        );
        return rows.map((row) => row.bucket_key);
      }

      const beforeEvents = (await events("receipt_shared")).length;
      const globalBefore = await db.get<{ count: number | string }>(
        `SELECT count FROM rate_limits WHERE bucket_key = ?`,
        ["analytics:beacon"],
      );
      const keysBefore = await sideKeys();
      await beacon(
        beaconRequest({ name: "receipt_shared", props: { method: "copy" } }, { "x-forwarded-for": ip }),
      );
      expect((await events("receipt_shared")).length).toBe(beforeEvents + 1);
      const globalAfter = await db.get<{ count: number | string }>(
        `SELECT count FROM rate_limits WHERE bucket_key = ?`,
        ["analytics:beacon"],
      );
      expect(Number(globalAfter?.count ?? 0)).toBe(Number(globalBefore?.count ?? 0) + 1);
      expect(await sideKeys()).toEqual(keysBefore);

      await seedBucket("analytics:beacon", 120);
      const blockedBefore = (await events("receipt_shared")).length;
      await beacon(
        beaconRequest({ name: "receipt_shared", props: { method: "share" } }, { "x-forwarded-for": ip }),
      );
      expect((await events("receipt_shared")).length).toBe(blockedBefore);
      expect(await sideKeys()).toEqual(keysBefore);
    } finally {
      if (savedSalt === undefined) delete process.env.IP_HASH_SALT;
      else process.env.IP_HASH_SALT = savedSalt;
      if (savedDemo === undefined) delete process.env.DEMO_IP_SALT;
      else process.env.DEMO_IP_SALT = savedDemo;
      spy.mockRestore();
      await db.run(`DELETE FROM rate_limits WHERE bucket_key = ?`, ["analytics:beacon"]);
    }
  });
});
