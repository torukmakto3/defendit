import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { devLinksAllowed, requestMagicLink, safeNextPath } from "../src/lib/auth";
import { sameOrigin } from "../src/lib/http";

const ENV = ["VERCEL", "VERCEL_ENV", "NODE_ENV", "AUTH_DEV_LINKS", "AUTH_DEV_LINK_ALLOW", "ADMIN_EMAILS"];
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

function setEnv(name: string, value: string) {
  (process.env as Record<string, string | undefined>)[name] = value;
}

afterEach(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe("safeNextPath", () => {
  it.each([
    ["/d/abc?x=1#y", "/d/abc?x=1#y"],
    ["/", "/"],
  ])("keeps same-origin path %s", (input, out) => {
    expect(safeNextPath(input)).toBe(out);
  });

  it.each([
    null,
    "",
    "https://evil.example",
    "//evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
  ])("rejects %j", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });
});

describe("devLinksAllowed", () => {
  it("allows any non-admin address in local dev", () => {
    expect(devLinksAllowed("ana@fund.example")).toBe(true);
  });

  it("never shows a link for an admin account", () => {
    process.env.ADMIN_EMAILS = "Boss@Fund.example";
    expect(devLinksAllowed("boss@fund.example")).toBe(false);
  });

  it("is off on a deployment unless AUTH_DEV_LINKS=1", () => {
    process.env.VERCEL = "1";
    expect(devLinksAllowed("ana@fund.example")).toBe(false);
    process.env.AUTH_DEV_LINKS = "1";
    expect(devLinksAllowed("ana@fund.example")).toBe(true);
  });

  it("honours the address allowlist on a deployment", () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.AUTH_DEV_LINKS = "1";
    process.env.AUTH_DEV_LINK_ALLOW = "*@example.com, qa@fund.example";
    expect(devLinksAllowed("anyone@example.com")).toBe(true);
    expect(devLinksAllowed("qa@fund.example")).toBe(true);
    expect(devLinksAllowed("real.person@gmail.com")).toBe(false);
  });

  it("never shows a link on Vercel production, even with AUTH_DEV_LINKS=1", () => {
    setEnv("NODE_ENV", "production");
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_DEV_LINKS = "1";
    process.env.AUTH_DEV_LINK_ALLOW = "*@example.com";
    expect(devLinksAllowed("anyone@example.com")).toBe(false);
  });

  it("still allows an opted-in preview deploy and a local production process", () => {
    setEnv("NODE_ENV", "production");
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.AUTH_DEV_LINKS = "1";
    expect(devLinksAllowed("ana@fund.example")).toBe(true);

    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.AUTH_DEV_LINKS = "1";
    expect(devLinksAllowed("ana@fund.example")).toBe(true);
  });
});

describe("sameOrigin", () => {
  const req = (origin?: string) =>
    new Request("https://app.example/api/x", {
      method: "POST",
      headers: { host: "app.example", ...(origin ? { origin } : {}) },
    });

  it("accepts same-origin and origin-less requests", () => {
    expect(sameOrigin(req("https://app.example"))).toBe(true);
    expect(sameOrigin(req())).toBe(true);
  });

  it("rejects foreign or malformed origins", () => {
    expect(sameOrigin(req("https://evil.example"))).toBe(false);
    expect(sameOrigin(req("not a url"))).toBe(false);
  });
});

describe("requestMagicLink without email delivery", () => {
  it("refuses a disallowed address with 503 and no link", async () => {
    process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "defendit-auth-")), "a.db");
    process.env.VERCEL = "1";
    process.env.AUTH_DEV_LINKS = "1";
    process.env.AUTH_DEV_LINK_ALLOW = "*@example.com";
    await expect(requestMagicLink({ email: "real@gmail.com" })).rejects.toMatchObject({ status: 503 });
    await expect(requestMagicLink({ email: "qa@example.com" })).resolves.toHaveProperty("devLink");
  });

  it("refuses the on-screen link on Vercel production even for an allowed address", async () => {
    setEnv("NODE_ENV", "production");
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_DEV_LINKS = "1";
    process.env.AUTH_DEV_LINK_ALLOW = "*@example.com";
    await expect(requestMagicLink({ email: "qa@example.com" })).rejects.toMatchObject({ status: 503 });
  });
});

describe("agent request signing", () => {
  it("accepts a fresh signed body and rejects tampering, staleness and missing secrets", async () => {
    const { signAgentBody, verifyAgentRequest } = await import("../src/lib/agent-auth");
    process.env.VOICE_AGENT_SECRET = "s".repeat(40);
    const body = JSON.stringify({ sessionId: "ses_1" });
    const mk = (b: string, ts: number, sig?: string) => {
      const signed = signAgentBody(b, ts);
      return new Request("http://x/api", {
        method: "POST",
        headers: { "x-defend-timestamp": signed.ts, "x-defend-signature": sig ?? signed.signature },
        body: b,
      });
    };
    await expect(verifyAgentRequest(mk(body, Date.now()))).resolves.toEqual({ sessionId: "ses_1" });
    const good = signAgentBody(body, Date.now());
    await expect(verifyAgentRequest(new Request("http://x", { method: "POST", headers: { "x-defend-timestamp": good.ts, "x-defend-signature": good.signature }, body: body.replace("1", "2") }))).rejects.toMatchObject({ status: 401 });
    await expect(verifyAgentRequest(mk(body, Date.now() - 10 * 60_000))).rejects.toMatchObject({ status: 401 });
    const signedBeforeRemoval = mk(body, Date.now());
    delete process.env.VOICE_AGENT_SECRET;
    await expect(verifyAgentRequest(signedBeforeRemoval)).rejects.toMatchObject({ status: 503 });
  });
});
