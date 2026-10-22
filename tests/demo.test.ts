import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as startDemo } from "../src/app/api/demo/start/route";
import { GET as dashboard } from "../src/app/api/dashboard/route";
import { POST as ingest } from "../src/app/api/creator/ingest/route";
import { GET as learnProjects } from "../src/app/api/learn/projects/route";
import { POST as createRequest } from "../src/app/api/requests/route";
import { POST as answer } from "../src/app/api/sessions/defend/answer/route";
import { POST as complete } from "../src/app/api/sessions/defend/complete/route";
import { POST as startSessionRoute } from "../src/app/api/sessions/start/route";
import { POST as upload } from "../src/app/api/upload/route";
import { consumeMagicLink, requestMagicLink } from "../src/lib/auth";
import { betaDefenseCents } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { hashDemoIp } from "../src/lib/demo";
import { DEMO_COPY, demoDailyCap, demoEnabled, demoPerIpPerDay } from "../src/lib/demo-policy";
import { buildInterviewPlan } from "../src/lib/probes";
import { verifyReceipt } from "../src/lib/receipt";
import { getReceipt, listAdminSessions, listDashboard, listProjects } from "../src/lib/services";
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
  process.env.BETA_BUDGET_EUR = "150";
  delete process.env.DEMO_ENABLED;
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
  it("defaults the kill switch, the per-IP limit, and the daily cap", () => {
    const enabled = process.env.DEMO_ENABLED;
    const perIp = process.env.DEMO_PER_IP_PER_DAY;
    const cap = process.env.DEMO_DAILY_CAP;
    delete process.env.DEMO_ENABLED;
    delete process.env.DEMO_PER_IP_PER_DAY;
    delete process.env.DEMO_DAILY_CAP;
    expect(demoEnabled()).toBe(true);
    expect(demoPerIpPerDay()).toBe(3);
    expect(demoDailyCap()).toBe(200);
    process.env.DEMO_ENABLED = "0";
    expect(demoEnabled()).toBe(false);
    if (enabled === undefined) delete process.env.DEMO_ENABLED;
    else process.env.DEMO_ENABLED = enabled;
    process.env.DEMO_PER_IP_PER_DAY = perIp;
    process.env.DEMO_DAILY_CAP = cap;
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
  });
});

describe("sample demo admission", () => {
  it("refuses when the kill switch is off", async () => {
    process.env.DEMO_ENABLED = "false";
    const opened = await openDemo("203.0.113.10");
    expect(opened.status).toBe(403);
    expect(opened.json.error).toBe(DEMO_COPY.disabled);
    delete process.env.DEMO_ENABLED;
    const db = await getDb();
    const users = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@demo.defendit.invalid'`);
    expect(Number(users?.n)).toBe(0);
  });

  it("refuses without spending the budget when the beta fund is exhausted", async () => {
    const previous = process.env.BETA_BUDGET_EUR;
    process.env.BETA_BUDGET_EUR = "0";
    const before = await spent();
    const opened = await openDemo("203.0.113.11");
    expect(opened.status).toBe(503);
    expect(opened.json.error).toBe(DEMO_COPY.budget);
    expect(await spent()).toBe(before);
    process.env.BETA_BUDGET_EUR = previous;
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
  it("signs a demo receipt and keeps the anonymous pass off every other feature", async () => {
    const ip = "203.0.113.77";
    const before = await spent();
    const opened = await openDemo(ip);
    expect(opened.status).toBe(200);
    expect(opened.json.title).toBe("Harbor README");
    expect(opened.json.questions).toBe(3);
    expect(await spent()).toBe(before + betaDefenseCents());

    const started = await startSessionRoute(
      req("/api/sessions/start", { token: opened.json.token, mode: "defend" }, ip, opened.cookie),
    );
    const startJson = await started.json();
    expect(started.status).toBe(200);
    expect(startJson.channel).toBe("text");
    expect(startJson.demo).toBe(true);
    expect(startJson.probes).toHaveLength(3);
    expect(JSON.stringify(startJson)).not.toContain("expectedFocus");

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

    const db = await getDb();
    const session = await db.get<{ cost_tier: string; budget_usd: number; channel: string; purge_after: string }>(
      `SELECT cost_tier, budget_usd, channel, purge_after FROM sessions WHERE id = ?`,
      [startJson.sessionId],
    );
    expect(session?.cost_tier).toBe("consumer");
    expect(session?.budget_usd).toBe(budgetUsdForTier("consumer"));
    expect(session?.channel).toBe("text");
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

    await db.run(`UPDATE receipts SET purge_after = ? WHERE id = ?`, ["2000-01-01T00:00:00.000Z", payload.id]);
    expect(await getReceipt(payload.id)).toBeNull();
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
