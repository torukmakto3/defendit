import { createHmac } from "crypto";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as googleCallback } from "../src/app/api/auth/google/callback/route";
import { POST as requestLink } from "../src/app/api/auth/request/route";
import { POST as creatorIngestRoute } from "../src/app/api/creator/ingest/route";
import { POST as startRoute } from "../src/app/api/sessions/start/route";
import { POST as uploadRoute } from "../src/app/api/upload/route";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { sha256Hex } from "../src/lib/crypto";
import { getDb, resetDbForTests } from "../src/lib/db";
import { ipLimitKey, RATE_LIMIT_MESSAGE } from "../src/lib/http";
import { ipHash } from "../src/lib/ip-hash";
import { ipRateKey, LIMITS } from "../src/lib/ratelimit";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

const RATE_ENV = [
  "RATE_LIMIT_LOGIN_EMAIL",
  "RATE_LIMIT_LOGIN_EMAIL_WINDOW_SEC",
  "RATE_LIMIT_LOGIN_IP",
  "RATE_LIMIT_LOGIN_IP_WINDOW_SEC",
  "RATE_LIMIT_UPLOAD_USER",
  "RATE_LIMIT_UPLOAD_USER_WINDOW_SEC",
  "RATE_LIMIT_UPLOAD_IP",
  "RATE_LIMIT_UPLOAD_IP_WINDOW_SEC",
  "RATE_LIMIT_SESSION_START_USER",
  "RATE_LIMIT_SESSION_START_USER_WINDOW_SEC",
  "RATE_LIMIT_SESSION_START_IP",
  "RATE_LIMIT_SESSION_START_IP_WINDOW_SEC",
];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-limit-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  resetDbForTests();
});

afterEach(() => {
  for (const name of RATE_ENV) delete process.env[name];
});

function postJson(path: string, body: unknown, ip: string, cookie?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "x-forwarded-for": ip,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signIn(email: string): Promise<{ user: User; cookie: string }> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
}

async function expectLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe(RATE_LIMIT_MESSAGE);
}

describe("rate limit configuration", () => {
  it("hashes an IP into the bucket and leaves the address out", () => {
    const ip = "203.0.113.44";
    const key = ipRateKey("upload", ip);
    expect(key).toBe(`upload:ip:${ipHash(ip)}`);
    expect(key).not.toContain(ip);
    expect(ipHash(ip)).not.toBe(sha256Hex(ip));
    const req = new Request("http://localhost/api/upload", { headers: { "x-forwarded-for": ip } });
    expect(ipLimitKey("upload", req)).toBe(key);
  });

  it("keys the hash with IP_HASH_SALT, or DEMO_IP_SALT when that is unset", () => {
    const ip = "203.0.113.9";
    const savedSalt = process.env.IP_HASH_SALT;
    const savedDemo = process.env.DEMO_IP_SALT;
    try {
      process.env.IP_HASH_SALT = "ab".repeat(32);
      delete process.env.DEMO_IP_SALT;
      expect(ipHash(ip)).toBe(createHmac("sha256", Buffer.from("ab".repeat(32), "hex")).update(ip).digest("hex"));

      delete process.env.IP_HASH_SALT;
      process.env.DEMO_IP_SALT = "cd".repeat(32);
      expect(ipHash(ip)).toBe(createHmac("sha256", Buffer.from("cd".repeat(32), "hex")).update(ip).digest("hex"));

      delete process.env.DEMO_IP_SALT;
      vi.stubEnv("NODE_ENV", "production");
      expect(() => ipHash(ip)).toThrow(/IP_HASH_SALT is not set/);
    } finally {
      vi.unstubAllEnvs();
      if (savedSalt === undefined) delete process.env.IP_HASH_SALT;
      else process.env.IP_HASH_SALT = savedSalt;
      if (savedDemo === undefined) delete process.env.DEMO_IP_SALT;
      else process.env.DEMO_IP_SALT = savedDemo;
    }
  });

  it("uses the previous budgets when the env vars are unset", () => {
    expect(LIMITS.loginPerEmail).toMatchObject({ limit: 5, windowSec: 15 * 60 });
    expect(LIMITS.loginPerIp).toMatchObject({ limit: 20, windowSec: 15 * 60 });
    expect(LIMITS.ingestPerUser).toMatchObject({ limit: 20, windowSec: 24 * 60 * 60 });
    expect(LIMITS.uploadPerIp).toMatchObject({ limit: 30, windowSec: 24 * 60 * 60 });
    expect(LIMITS.sessionStartPerUser).toMatchObject({ limit: 60, windowSec: 60 * 60 });
    expect(LIMITS.sessionStartPerIp).toMatchObject({ limit: 30, windowSec: 60 * 60 });
    expect(LIMITS.learnTurnPerUser.limit).toBe(120);
    expect(LIMITS.defendAnswerPerUser.limit).toBe(300);
    expect(LIMITS.defendCompletePerUser.limit).toBe(20);
    expect(LIMITS.requestCreatePerUser.limit).toBe(50);
    expect(LIMITS.challengeCreatePerUser).toMatchObject({ limit: 10, windowSec: 24 * 60 * 60 });
    expect(LIMITS.challengeClaimPerUser).toMatchObject({ limit: 20, windowSec: 24 * 60 * 60 });
    expect(LIMITS.challengeClaimPerIp).toMatchObject({ limit: 30, windowSec: 60 * 60 });
    expect(LIMITS.challengeSharePerIp).toMatchObject({ limit: 30, windowSec: 60 * 60 });
    expect(LIMITS.challengeResultViewPerIp).toMatchObject({ limit: 60, windowSec: 60 * 60 });
    expect(LIMITS.challengeReportPerIp).toMatchObject({ limit: 10, windowSec: 60 * 60 });
  });

  it("reads a positive integer from the environment", () => {
    process.env.RATE_LIMIT_SESSION_START_IP = "7";
    process.env.RATE_LIMIT_SESSION_START_IP_WINDOW_SEC = "120";
    expect(LIMITS.sessionStartPerIp.limit).toBe(7);
    expect(LIMITS.sessionStartPerIp.windowSec).toBe(120);
  });

  it("logs a bad limit once and uses the default", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.RATE_LIMIT_UPLOAD_IP = "0";
      expect(LIMITS.uploadPerIp.limit).toBe(30);
      expect(LIMITS.uploadPerIp.limit).toBe(30);
      const logged = spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("RATE_LIMIT_UPLOAD_IP"));
      expect(logged).toHaveLength(1);
      process.env.RATE_LIMIT_UPLOAD_IP = "4";
      expect(LIMITS.uploadPerIp.limit).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps Google sign-in up when the IP limit is not a number", async () => {
    process.env.RATE_LIMIT_LOGIN_IP = "nope";
    const res = await googleCallback(new Request("http://127.0.0.1:3000/api/auth/google/callback"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
  });
});

describe("sign-in email sends", () => {
  it("limits per hashed email and per hashed IP, and does not store the address", async () => {
    process.env.RATE_LIMIT_LOGIN_EMAIL = "1";
    process.env.RATE_LIMIT_LOGIN_IP = "1";
    const emailIp = "198.51.100.10";
    const otherIp = "198.51.100.11";
    const sharedIp = "198.51.100.12";

    const first = await requestLink(postJson("/api/auth/request", { email: "limit-email@fund.example" }, emailIp));
    expect(first.status).toBe(200);
    const again = await requestLink(
      postJson("/api/auth/request", { email: "Limit-Email@fund.example" }, otherIp),
    );
    await expectLimited(again);

    process.env.RATE_LIMIT_LOGIN_EMAIL = "10";
    const other = await requestLink(postJson("/api/auth/request", { email: "one@fund.example" }, sharedIp));
    expect(other.status).toBe(200);
    const neighbor = await requestLink(postJson("/api/auth/request", { email: "two@fund.example" }, sharedIp));
    await expectLimited(neighbor);

    const db = await getDb();
    const rows = await db.all<{ bucket_key: string }>(`SELECT bucket_key FROM rate_limits`);
    const keys = rows.map((row) => row.bucket_key);
    const stored = keys.join("\n");
    expect(stored).not.toContain(emailIp);
    expect(stored).not.toContain(otherIp);
    expect(stored).not.toContain(sharedIp);
    expect(keys).toContain(`login:email:${sha256Hex("limit-email@fund.example")}`);
    expect(keys).toContain(ipRateKey("login", emailIp));
    expect(keys).toContain(ipRateKey("login", sharedIp));
  });
});

describe("uploads and session start", () => {
  it("limits uploads per hashed IP across the upload routes", async () => {
    process.env.RATE_LIMIT_UPLOAD_IP = "1";
    process.env.RATE_LIMIT_UPLOAD_USER = "20";
    const { cookie } = await signIn("upload-limit@fund.example");
    const ip = "203.0.113.20";
    const form = new FormData();
    form.set("difficulty", "standard");
    form.set("file", new File([memo], "memo.md", { type: "text/markdown" }));
    const first = await creatorIngestRoute(
      new Request("http://localhost/api/creator/ingest", {
        method: "POST",
        headers: { origin: "http://localhost", host: "localhost", cookie, "x-forwarded-for": ip },
        body: form,
      }),
    );
    expect(first.status).toBe(200);

    const second = await uploadRoute(
      new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { origin: "http://localhost", host: "localhost", cookie, "x-forwarded-for": ip },
        body: new FormData(),
      }),
    );
    await expectLimited(second);

    const db = await getDb();
    const row = await db.get<{ bucket_key: string }>(`SELECT bucket_key FROM rate_limits WHERE bucket_key = ?`, [
      ipRateKey("upload", ip),
    ]);
    expect(row?.bucket_key).toBe(ipRateKey("upload", ip));
    expect(row?.bucket_key).not.toContain(ip);
  });

  it("limits session start per account and per hashed IP", async () => {
    process.env.RATE_LIMIT_SESSION_START_USER = "10";
    process.env.RATE_LIMIT_SESSION_START_IP = "1";
    const { cookie } = await signIn("start-ip@fund.example");
    const form = new FormData();
    form.set("difficulty", "standard");
    form.set("file", new File([memo], "memo.md", { type: "text/markdown" }));
    const uploaded = await creatorIngestRoute(
      new Request("http://localhost/api/creator/ingest", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          host: "localhost",
          cookie,
          "x-forwarded-for": "203.0.113.30",
        },
        body: form,
      }),
    );
    expect(uploaded.status).toBe(200);
    const created = (await uploaded.json()) as { token: string };
    const start = (ip: string) =>
      startRoute(
        postJson("/api/sessions/start", { token: created.token, mode: "learn" }, ip, cookie),
      );

    const ip = "203.0.113.31";
    expect((await start(ip)).status).toBe(200);
    await expectLimited(await start(ip));

    process.env.RATE_LIMIT_SESSION_START_IP = "10";
    process.env.RATE_LIMIT_SESSION_START_USER = "1";
    const account = await signIn("start-user@fund.example");
    const secondForm = new FormData();
    secondForm.set("difficulty", "standard");
    secondForm.set("file", new File([memo], "memo.md", { type: "text/markdown" }));
    const secondUpload = await creatorIngestRoute(
      new Request("http://localhost/api/creator/ingest", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          host: "localhost",
          cookie: account.cookie,
          "x-forwarded-for": "203.0.113.40",
        },
        body: secondForm,
      }),
    );
    const second = (await secondUpload.json()) as { token: string };
    const startAsUser = (ip: string) =>
      startRoute(
        postJson("/api/sessions/start", { token: second.token, mode: "learn" }, ip, account.cookie),
      );
    expect((await startAsUser("203.0.113.41")).status).toBe(200);
    await expectLimited(await startAsUser("203.0.113.42"));
  });
});
