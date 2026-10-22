import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateMetadata } from "../src/app/r/[id]/layout";
import { POST as startDemo } from "../src/app/api/demo/start/route";
import { GET as dashboard } from "../src/app/api/dashboard/route";
import { POST as ingest } from "../src/app/api/creator/ingest/route";
import { GET as learnProjects } from "../src/app/api/learn/projects/route";
import { POST as createRequest } from "../src/app/api/requests/route";
import { POST as answer } from "../src/app/api/sessions/defend/answer/route";
import { GET as defendState } from "../src/app/api/sessions/defend/state/route";
import { POST as complete } from "../src/app/api/sessions/defend/complete/route";
import { POST as startSessionRoute } from "../src/app/api/sessions/start/route";
import { POST as upload } from "../src/app/api/upload/route";
import { consumeMagicLink, requestMagicLink } from "../src/lib/auth";
import { beginDefenseCredit, betaDefenseCents } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { hashDemoIp } from "../src/lib/demo";
import { resetIpHashNotices } from "../src/lib/ip-hash";
import { resultCardCopy } from "../src/lib/share-card";
import { DEMO_SAMPLE_TEXT, demoSampleBundle } from "../src/lib/demo-bundle";
import { DEMO_COPY, demoBudgetEur, demoDailyCap, demoEnabled, demoPerIpPerDay } from "../src/lib/demo-policy";
import { buildInterviewPlan } from "../src/lib/probes";
import { verifyReceipt } from "../src/lib/receipt";
import { getReceipt, listAdminSessions, listDashboard, listProjects, purgeExpired } from "../src/lib/services";
import { budgetUsdForTier } from "../src/lib/cost";
import type { Claim } from "../src/lib/types";

const harbor = readFileSync(join(__dirname, "..", "fixtures", "demo", "harbor-readme.md"), "utf8");
const lane = readFileSync(join(__dirname, "..", "fixtures", "demo", "lane-memo.md"), "utf8");

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-demo-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  process.env.DEMO_IP_SALT = "ab".repeat(32);
  process.env.DEMO_PER_IP_PER_DAY = "5";
  process.env.DEMO_DAILY_CAP = "50";
  process.env.DEMO_BUDGET_EUR = "100";
  process.env.BETA_BUDGET_EUR = "150";
  process.env.DEMO_ENABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  delete process.env.BILLING_ENABLED;
});

function req(path: string, body: unknown, ip: string, cookie?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost",
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function openDemo(ip: string, sample?: string) {
  const res = await startDemo(req("/api/demo/start", sample ? { sample } : {}, ip));
  const json = await res.json();
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  return { status: res.status, json, cookie, setCookie };
}

describe("sample demo policy", () => {
  it("defaults the kill switch, the per-IP limit, the daily cap, and the sample budget", () => {
    const enabled = process.env.DEMO_ENABLED;
    const perIp = process.env.DEMO_PER_IP_PER_DAY;
    const cap = process.env.DEMO_DAILY_CAP;
    const budget = process.env.DEMO_BUDGET_EUR;
    delete process.env.DEMO_ENABLED;
    delete process.env.DEMO_PER_IP_PER_DAY;
    delete process.env.DEMO_DAILY_CAP;
    delete process.env.DEMO_BUDGET_EUR;
    expect(demoEnabled()).toBe(false);
    expect(demoPerIpPerDay()).toBe(3);
    expect(demoDailyCap()).toBe(20);
    expect(demoBudgetEur()).toBe(20);
    process.env.DEMO_ENABLED = "1";
    expect(demoEnabled()).toBe(true);
    process.env.DEMO_ENABLED = "true";
    expect(demoEnabled()).toBe(true);
    process.env.DEMO_ENABLED = "0";
    expect(demoEnabled()).toBe(false);
    process.env.DEMO_ENABLED = "false";
    expect(demoEnabled()).toBe(false);
    process.env.DEMO_ENABLED = "yes";
    expect(demoEnabled()).toBe(false);
    if (enabled === undefined) delete process.env.DEMO_ENABLED;
    else process.env.DEMO_ENABLED = enabled;
    process.env.DEMO_PER_IP_PER_DAY = perIp;
    process.env.DEMO_DAILY_CAP = cap;
    if (budget === undefined) delete process.env.DEMO_BUDGET_EUR;
    else process.env.DEMO_BUDGET_EUR = budget;
  });

  it("uses a three-question blueprint with a planted error", () => {
    const claims: Claim[] = [
      { id: "c1", text: "Harbor keeps notes as Markdown files on one machine.", section: "Notes", sourceSpan: "Markdown", stakes: "high", kind: "claim" },
      { id: "c2", text: "The index assumes each workspace stays under 2,000 notes.", section: "Assumptions", sourceSpan: "2,000 notes", stakes: "high", kind: "assumption", figures: ["2,000"] },
    ];
    const plan = buildInterviewPlan({ claims, difficulty: "standard", seed: "demo-shape", shape: "demo" });
    expect(plan.difficulty).toBe("standard");
    expect(plan.probes).toHaveLength(3);
    expect(plan.probes.some((probe) => probe.type === "planted_error")).toBe(true);
    expect(buildInterviewPlan({ claims, difficulty: "standard", seed: "full" }).probes).toHaveLength(5);
    expect(harbor.toLowerCase()).toContain("assum");
    expect(lane.toLowerCase()).toContain("assum");
    expect(harbor).not.toMatch(/lorem ipsum|copyright/i);
    expect(lane).not.toMatch(/lorem ipsum|copyright/i);
    expect(DEMO_SAMPLE_TEXT["harbor-readme"]).toBe(harbor);
    expect(DEMO_SAMPLE_TEXT["lane-memo"]).toBe(lane);
    const bundled = demoSampleBundle("harbor-readme");
    expect(bundled.claims.length).toBeGreaterThanOrEqual(3);
    expect(bundled.prefetch.restPhrased).toBe(true);
    expect(bundled.prefetch.plan.probes).toHaveLength(3);
    expect(bundled.prefetch.plan.probes[0]?.question.length).toBeGreaterThan(10);
    expect(demoSampleBundle("harbor-readme").prefetch.plan.probes[0]?.id).toBe(bundled.prefetch.plan.probes[0]?.id);
  });
});

describe("sample demo admission", () => {
  it("refuses when the kill switch is off", async () => {
    process.env.DEMO_ENABLED = "false";
    const opened = await openDemo("203.0.113.10");
    expect(opened.status).toBe(403);
    expect(opened.json.error).toBe(DEMO_COPY.disabled);
    process.env.DEMO_ENABLED = "1";
    const db = await getDb();
    const users = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@demo.defendit.invalid'`);
    expect(Number(users?.n)).toBe(0);
  });

  it("returns 503 when no usable salt can key the IP hash", async () => {
    const salt = process.env.DEMO_IP_SALT;
    const named = process.env.IP_HASH_SALT;
    process.env.VERCEL = "1";
    process.env.DEMO_ENABLED = "1";
    delete process.env.DEMO_IP_SALT;
    delete process.env.IP_HASH_SALT;
    resetIpHashNotices();
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const opened = await openDemo("203.0.113.90");
      expect(opened.status).toBe(503);
      expect(opened.json.error).toBe(DEMO_COPY.unavailable);
      expect(JSON.stringify(logged)).toContain("IP_HASH_SALT");
      expect(JSON.stringify(opened.json)).not.toContain("openssl");
      process.env.IP_HASH_SALT = "cd".repeat(32);
      const withShared = await openDemo("203.0.113.91");
      expect(withShared.status).toBe(200);
    } finally {
      spy.mockRestore();
      delete process.env.VERCEL;
      if (salt === undefined) delete process.env.DEMO_IP_SALT;
      else process.env.DEMO_IP_SALT = salt;
      if (named === undefined) delete process.env.IP_HASH_SALT;
      else process.env.IP_HASH_SALT = named;
      process.env.DEMO_ENABLED = "1";
    }
  });

  it("stops demos at the sample cap before the signed-in beta budget is touched", async () => {
    const previousDemo = process.env.DEMO_BUDGET_EUR;
    const previousBeta = process.env.BETA_BUDGET_EUR;
    const betaBefore = await spent();
    process.env.BETA_BUDGET_EUR = "0";
    const whileBetaEmpty = await openDemo("203.0.113.11");
    expect(whileBetaEmpty.status).toBe(200);
    expect(await spent()).toBe(betaBefore);
    process.env.BETA_BUDGET_EUR = previousBeta;

    const db = await getDb();
    const already = await demoSpent();
    process.env.DEMO_BUDGET_EUR = ((already + betaDefenseCents()) / 100).toFixed(2);
    const room = await openDemo("203.0.113.12");
    expect(room.status).toBe(200);
    expect(await spent()).toBe(betaBefore);
    expect(await demoSpent()).toBe(already + betaDefenseCents());
    const blocked = await openDemo("203.0.113.13");
    expect(blocked.status).toBe(503);
    expect(blocked.json.error).toBe(DEMO_COPY.budget);
    expect(blocked.json.error).toContain("Samples are paused");
    expect(await spent()).toBe(betaBefore);

    const { user } = await signIn("still-funded@fund.example");
    const held = await beginDefenseCredit(user.id);
    expect(held.sponsored).toBe(true);
    expect(await spent()).toBe(betaBefore + betaDefenseCents());
    const beta = await db.get<{ spent_cents: number }>(
      `SELECT spent_cents FROM credit_budget WHERE id = 'beta'`,
    );
    const demo = await db.get<{ spent_cents: number }>(
      `SELECT spent_cents FROM credit_budget WHERE id = 'demo'`,
    );
    expect(Number(beta?.spent_cents)).toBe(betaBefore + betaDefenseCents());
    expect(Number(demo?.spent_cents)).toBe(already + betaDefenseCents());

    if (previousDemo === undefined) delete process.env.DEMO_BUDGET_EUR;
    else process.env.DEMO_BUDGET_EUR = previousDemo;
  });

  it("stops a network after its daily sample allowance and never stores the raw IP", async () => {
    process.env.DEMO_PER_IP_PER_DAY = "1";
    const ip = "203.0.113.44";
    const first = await openDemo(ip);
    expect(first.status).toBe(200);
    expect(first.json.demo).toBe(true);
    expect(first.cookie.startsWith("di_demo=")).toBe(true);
    expect(/httponly/i.test(first.setCookie)).toBe(true);
    const second = await openDemo(ip);
    expect(second.status).toBe(429);
    expect(second.json.error).toBe(DEMO_COPY.ip);
    const db = await getDb();
    const keys = await db.all<{ bucket_key: string }>(`SELECT bucket_key FROM rate_limits`);
    expect(keys.some((row) => row.bucket_key.includes(ip))).toBe(false);
    const hashed = keys.filter((row) => row.bucket_key.startsWith("demo:ip:"));
    expect(hashed.length).toBeGreaterThan(0);
    expect(hashed.every((row) => /^demo:ip:[0-9a-f]{64}$/.test(row.bucket_key))).toBe(true);
    expect(hashed.some((row) => row.bucket_key === `demo:ip:${hashDemoIp(ip)}`)).toBe(true);
    process.env.DEMO_PER_IP_PER_DAY = "5";
  });

  it("stops everyone once the global daily cap is reached", async () => {
    const db = await getDb();
    await db.run(`DELETE FROM rate_limits WHERE bucket_key = 'demo:day'`);
    process.env.DEMO_DAILY_CAP = "1";
    const first = await openDemo("203.0.113.21", "lane-memo");
    expect(first.status).toBe(200);
    expect(first.json.title).toBe("Lane design memo");
    const second = await openDemo("203.0.113.22");
    expect(second.status).toBe(429);
    expect(second.json.error).toBe(DEMO_COPY.global);
    process.env.DEMO_DAILY_CAP = "50";
  });
});

describe("sample demo defense", () => {
  it("reloads a sample interview onto the same session", async () => {
    const ip = "203.0.113.88";
    const opened = await openDemo(ip);
    expect(opened.status).toBe(200);
    const before = await defendState(
      new Request(`http://localhost/api/sessions/defend/state?token=${encodeURIComponent(opened.json.token)}`, {
        headers: { cookie: opened.cookie },
      }),
    );
    expect(before.status).toBe(404);

    const started = await startSessionRoute(
      req("/api/sessions/start", { token: opened.json.token, mode: "defend" }, ip, opened.cookie),
    );
    const startJson = await started.json();
    expect(started.status).toBe(200);
    const first = (startJson.probes as { id: string }[])[0];
    const saved = await answer(
      req(
        "/api/sessions/defend/answer",
        {
          sessionId: startJson.sessionId,
          probeId: first.id,
          answer: "Harbor indexes Markdown on one machine. The 2,000-note assumption is what would break it.",
        },
        ip,
        opened.cookie,
      ),
    );
    expect(saved.status).toBe(200);

    const resumed = await defendState(
      new Request(`http://localhost/api/sessions/defend/state?token=${encodeURIComponent(opened.json.token)}`, {
        headers: { cookie: opened.cookie },
      }),
    );
    expect(resumed.status).toBe(200);
    const body = await resumed.json();
    expect(body.sessionId).toBe(startJson.sessionId);
    expect(body).toMatchObject({ status: "in_progress", answered: 1, total: 3, demo: true });
    expect(body.probes).toHaveLength(3);
    expect(JSON.stringify(body.probes)).not.toContain("expectedFocus");

    const stranger = await defendState(
      new Request(`http://localhost/api/sessions/defend/state?token=${encodeURIComponent(opened.json.token)}`),
    );
    expect(stranger.status).toBe(401);

    const db = await getDb();
    const sessions = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions s JOIN defense_requests r ON r.id = s.request_id WHERE r.token = ?`,
      [opened.json.token],
    );
    expect(Number(sessions?.n)).toBe(1);
  });

  it("blocks a sample already in progress when the kill switch is turned off", async () => {
    const ip = "203.0.113.89";
    const opened = await openDemo(ip);
    expect(opened.status).toBe(200);
    const started = await startSessionRoute(
      req("/api/sessions/start", { token: opened.json.token, mode: "defend" }, ip, opened.cookie),
    );
    const startJson = await started.json();
    expect(started.status).toBe(200);
    const probeId = (startJson.probes as { id: string }[])[0].id;
    process.env.DEMO_ENABLED = "false";
    try {
      const state = await defendState(
        new Request(`http://localhost/api/sessions/defend/state?token=${encodeURIComponent(opened.json.token)}`, {
          headers: { cookie: opened.cookie },
        }),
      );
      expect(state.status).toBe(403);
      expect((await state.json()).error).toBe(DEMO_COPY.disabled);
      const saved = await answer(
        req(
          "/api/sessions/defend/answer",
          { sessionId: startJson.sessionId, probeId, answer: "The assumption is the 2,000-note index." },
          ip,
          opened.cookie,
        ),
      );
      expect(saved.status).toBe(403);
      expect((await saved.json()).error).toBe(DEMO_COPY.disabled);
      const again = await startSessionRoute(
        req("/api/sessions/start", { token: opened.json.token, mode: "defend" }, ip, opened.cookie),
      );
      expect(again.status).toBe(403);
      expect((await again.json()).error).toBe(DEMO_COPY.disabled);
    } finally {
      process.env.DEMO_ENABLED = "1";
    }
    const resumed = await defendState(
      new Request(`http://localhost/api/sessions/defend/state?token=${encodeURIComponent(opened.json.token)}`, {
        headers: { cookie: opened.cookie },
      }),
    );
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).sessionId).toBe(startJson.sessionId);
  });

  it("signs a demo receipt and keeps the anonymous pass off every other feature", async () => {
    const ip = "203.0.113.77";
    const before = await spent();
    const demoBefore = await demoSpent();
    const opened = await openDemo(ip);
    expect(opened.status).toBe(200);
    expect(opened.json.title).toBe("Harbor README");
    expect(opened.json.questions).toBe(3);
    expect(await spent()).toBe(before);
    expect(await demoSpent()).toBe(demoBefore + betaDefenseCents());

    const db = await getDb();
    const openedCalls = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM llm_calls c
       JOIN defense_requests r ON r.id = c.request_id
       WHERE r.token = ?`,
      [opened.json.token],
    );
    expect(Number(openedCalls?.n)).toBe(0);
    const planted = await db.get<{ id: string; user_id: string }>(
      `SELECT id, creator_user_id AS user_id FROM defense_requests WHERE token = ?`,
      [opened.json.token],
    );
    const now = new Date().toISOString();
    // A revoked beta challenge on the same request would block a real defense
    // and would reserve another euro slice. A sample must ignore both.
    await db.run(
      `INSERT INTO challenges (
         id, slug, creator_user_id, subject, difficulty, status, sponsor_type,
         claimed_by_user_id, expires_at, request_id, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'standard', 'revoked', 'beta', ?, ?, ?, ?, ?)`,
      [
        "chg_demo_isolation",
        "demo-isolation",
        planted!.user_id,
        "Not a sample",
        planted!.user_id,
        now,
        planted!.id,
        now,
        now,
      ],
    );

    const started = await startSessionRoute(
      req("/api/sessions/start", { token: opened.json.token, mode: "defend" }, ip, opened.cookie),
    );
    const startJson = await started.json();
    expect(started.status).toBe(200);
    expect(startJson.channel).toBe("text");
    expect(startJson.demo).toBe(true);
    expect(startJson.probes).toHaveLength(3);
    expect(JSON.stringify(startJson)).not.toContain("expectedFocus");
    const startedCalls = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM llm_calls WHERE request_id = ?`,
      [planted!.id],
    );
    expect(Number(startedCalls?.n)).toBe(0);

    for (const probe of startJson.probes as { id: string; type: string }[]) {
      const saved = await answer(
        req(
          "/api/sessions/defend/answer",
          {
            sessionId: startJson.sessionId,
            probeId: probe.id,
            answer:
              probe.type === "planted_error"
                ? "The line changed the 2,000-note assumption. That is the figure Harbor relies on."
                : "Harbor indexes Markdown on one machine. The assumption that would break it is a workspace over 2,000 notes.",
          },
          ip,
          opened.cookie,
        ),
      );
      expect(saved.status).toBe(200);
    }

    const done = await complete(
      req(
        "/api/sessions/defend/complete",
        { sessionId: startJson.sessionId, showName: true },
        ip,
        opened.cookie,
      ),
    );
    const doneJson = await done.json();
    expect(done.status).toBe(200);
    expect(doneJson.challenge ?? null).toBeNull();
    const payload = doneJson.receipt.payload;
    expect(payload.demo).toEqual(
      expect.objectContaining({
        sample: true,
        credential: false,
        file: "Harbor README",
      }),
    );
    expect(payload.creator).toBeUndefined();
    expect(payload.difficulty).toBe("standard");
    expect(verifyReceipt(doneJson.receipt)).toBe(true);
    expect(JSON.stringify(doneJson.receipt)).not.toContain("separate search service");
    expect(JSON.stringify(doneJson.receipt)).not.toContain("demo.defendit.invalid");

    const session = await db.get<{ cost_tier: string; budget_usd: number; channel: string; purge_after: string }>(
      `SELECT cost_tier, budget_usd, channel, purge_after FROM sessions WHERE id = ?`,
      [startJson.sessionId],
    );
    expect(session?.cost_tier).toBe("consumer");
    expect(session?.budget_usd).toBe(budgetUsdForTier("consumer"));
    expect(session?.channel).toBe("text");
    expect(await spent()).toBe(before);
    expect(await demoSpent()).toBe(demoBefore + betaDefenseCents());
    const challengeBudget = await db.get(`SELECT id FROM credit_ledger WHERE ref_type = 'challenge_defense'`);
    expect(challengeBudget).toBeUndefined();
    const claim = await db.get(`SELECT challenge_id FROM credit_challenge_claims WHERE request_id = ?`, [
      planted!.id,
    ]);
    expect(claim).toBeUndefined();
    const challengeRow = await db.get<{ status: string; session_id: string | null }>(
      `SELECT status, session_id FROM challenges WHERE id = ?`,
      ["chg_demo_isolation"],
    );
    expect(challengeRow).toEqual({ status: "revoked", session_id: null });
    const keptFor = new Date(session!.purge_after).getTime() - Date.now();
    expect(keptFor).toBeGreaterThan(23 * 3600_000);
    expect(keptFor).toBeLessThan(25 * 3600_000);

    const text = await db.get<{ text_enc: string | null; cards: number }>(
      `SELECT d.text_enc, (SELECT COUNT(*) FROM flashcards f WHERE f.deliverable_id = d.id) AS cards
       FROM deliverables d JOIN defense_requests r ON r.id = d.request_id WHERE r.token = ?`,
      [opened.json.token],
    );
    expect(text?.text_enc).toBeNull();
    expect(Number(text?.cards)).toBe(0);

    const learn = await startSessionRoute(
      req("/api/sessions/start", { token: opened.json.token, mode: "learn" }, ip, opened.cookie),
    );
    expect(learn.status).toBe(403);
    const projects = await learnProjects(new Request("http://localhost/api/learn/projects", { headers: { cookie: opened.cookie } }));
    expect(projects.status).toBe(401);
    const challenge = await createRequest(
      req("/api/requests", { difficulty: "standard", title: "A challenge" }, ip, opened.cookie),
    );
    expect(challenge.status).toBe(401);
    const ownFile = await ingest(
      new Request("http://localhost/api/creator/ingest", {
        method: "POST",
        headers: { origin: "http://localhost", host: "localhost", cookie: opened.cookie },
        body: new FormData(),
      }),
    );
    expect(ownFile.status).toBe(401);
    const replaced = await upload(
      new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { origin: "http://localhost", host: "localhost", cookie: opened.cookie },
        body: new FormData(),
      }),
    );
    expect(replaced.status).toBe(401);
    const home = await dashboard(new Request("http://localhost/api/dashboard", { headers: { cookie: opened.cookie } }));
    expect(home.status).toBe(401);

    const { user, cookie } = await signIn("owner@fund.example");
    const dash = await listDashboard(user);
    expect(dash.some((row) => row.receiptId === payload.id)).toBe(false);
    const admin = await listAdminSessions();
    expect(admin.sessions.some((row) => row.id === startJson.sessionId)).toBe(false);
    const hub = await listProjects(user);
    expect(hub.some((row) => row.token === opened.json.token)).toBe(false);
    const steal = await upload(
      new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { origin: "http://localhost", host: "localhost", cookie },
        body: fileForm(opened.json.token),
      }),
    );
    expect(steal.status).toBe(403);

    const card = await resultCardCopy(payload.id);
    expect(card.title).toBe("Sample demo · Not a credential");
    expect(card.score).toBeNull();
    expect(card.visibility).toBe("demo");
    expect(`${card.title} ${card.subtitle} ${card.description} ${card.foot}`).not.toContain(String(payload.score));
    const meta = await generateMetadata({ params: Promise.resolve({ id: payload.id }) });
    expect(meta.title).toBe("Sample demo · Not a credential · DefendIT");
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.description)).not.toMatch(/\d/);

    await db.run(`UPDATE receipts SET purge_after = ? WHERE id = ?`, ["2000-01-01T00:00:00.000Z", payload.id]);
    expect(await getReceipt(payload.id)).toBeNull();
    const expired = await resultCardCopy(payload.id);
    expect(expired.score).toBeNull();
    expect(expired.visibility).not.toBe("demo");
    expect(expired.title).toBe("Understanding receipt");
    const expiredMeta = await generateMetadata({ params: Promise.resolve({ id: payload.id }) });
    expect(expiredMeta.robots).toBeUndefined();
  });

  it("deletes the demo user and defense request when the pass expires", async () => {
    const opened = await openDemo("203.0.113.61");
    expect(opened.status).toBe(200);
    const db = await getDb();
    const pass = await db.get<{ user_id: string; request_id: string }>(
      `SELECT p.user_id, p.request_id
       FROM demo_passes p JOIN defense_requests r ON r.id = p.request_id
       WHERE r.token = ?`,
      [opened.json.token],
    );
    expect(pass?.user_id).toBeTruthy();
    const { user } = await signIn("kept@fund.example");
    const live = await openDemo("203.0.113.62");
    expect(live.status).toBe(200);
    await db.run(`UPDATE demo_passes SET expires_at = ? WHERE request_id = ?`, [
      "2000-01-01T00:00:00.000Z",
      pass!.request_id,
    ]);
    await purgeExpired();
    expect(await db.get(`SELECT id FROM defense_requests WHERE id = ?`, [pass!.request_id])).toBeUndefined();
    expect(await db.get(`SELECT id FROM users WHERE id = ?`, [pass!.user_id])).toBeUndefined();
    const kept = await db.get<{ id: string }>(`SELECT id FROM users WHERE id = ?`, [user.id]);
    expect(kept?.id).toBe(user.id);
    const liveUser = await db.get<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN demo_passes p ON p.user_id = u.id
       JOIN defense_requests r ON r.id = p.request_id
       WHERE r.token = ?`,
      [live.json.token],
    );
    expect(liveUser?.id).toBeTruthy();
    const ledger = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM credit_ledger WHERE purpose = 'demo' AND ref_id = ?`,
      [pass!.request_id],
    );
    expect(Number(ledger?.n)).toBe(1);
  });

  it("clears expired demo rate-limit keys and leaves other buckets", async () => {
    const db = await getDb();
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    await db.run(
      `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES ('demo:ip:aa', ?, 1)`,
      [old],
    );
    await db.run(
      `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES ('start:ip:keepme', ?, 1)`,
      [old],
    );
    await purgeExpired();
    const keys = await db.all<{ bucket_key: string }>(`SELECT bucket_key FROM rate_limits`);
    const names = keys.map((row) => row.bucket_key);
    expect(names).not.toContain("demo:ip:aa");
    expect(names).toContain("start:ip:keepme");
  });

  it("will not send a sign-in link to a sample principal", async () => {
    await expect(requestMagicLink({ email: "person@demo.defendit.invalid" })).rejects.toMatchObject({
      status: 400,
    });
  });
});

async function spent(): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ spent_cents: number | null }>(
    `SELECT spent_cents FROM credit_budget WHERE id = 'beta'`,
  );
  return Number(row?.spent_cents ?? 0);
}

async function demoSpent(): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ spent_cents: number | null }>(
    `SELECT spent_cents FROM credit_budget WHERE id = 'demo'`,
  );
  return Number(row?.spent_cents ?? 0);
}

async function signIn(email: string) {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
}

function fileForm(token: string) {
  const form = new FormData();
  form.set("token", token);
  form.set("file", new File([harbor], "own.md", { type: "text/markdown" }));
  return form;
}
