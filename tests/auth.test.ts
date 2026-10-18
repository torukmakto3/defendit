import { afterEach, describe, expect, it } from "vitest";
import { devLinksAllowed, safeNextPath } from "../src/lib/auth";
import { sameOrigin } from "../src/lib/http";

const ENV = ["VERCEL", "AUTH_DEV_LINKS", "AUTH_DEV_LINK_ALLOW", "ADMIN_EMAILS"];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
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
    process.env.AUTH_DEV_LINKS = "1";
    process.env.AUTH_DEV_LINK_ALLOW = "*@example.com, qa@fund.example";
    expect(devLinksAllowed("anyone@example.com")).toBe(true);
    expect(devLinksAllowed("qa@fund.example")).toBe(true);
    expect(devLinksAllowed("real.person@gmail.com")).toBe(false);
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
