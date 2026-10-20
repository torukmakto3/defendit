import { createHash } from "crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAdmin } from "../src/lib/auth";
import { getDb, resetDbForTests } from "../src/lib/db";
import {
  beginGoogleOAuth,
  decodeOAuthTxn,
  GOOGLE_OAUTH_COOKIE,
  identityFromVerifiedClaims,
  nextPathFromRequest,
  resolveGoogleCallback,
  type GoogleClaims,
  type GoogleOAuthTxn,
} from "../src/lib/google-auth";
import { GET as startGoogle } from "../src/app/api/auth/google/route";
import { GET as googleCallback } from "../src/app/api/auth/google/callback/route";
import { GET as authProviders } from "../src/app/api/auth/providers/route";

const ENV = [
  "VERCEL",
  "VERCEL_ENV",
  "NODE_ENV",
  "AUTH_DEV_LINKS",
  "AUTH_DEV_LINK_ALLOW",
  "ADMIN_EMAILS",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "DATABASE_PATH",
];
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

function setEnv(name: string, value: string) {
  (process.env as Record<string, string | undefined>)[name] = value;
}

function txn(over: Partial<GoogleOAuthTxn> = {}): GoogleOAuthTxn {
  return {
    state: "state-value-0123456789",
    codeVerifier: "a".repeat(43),
    nextPath: "/admin",
    exp: Date.now() + 60_000,
    ...over,
  };
}

beforeEach(() => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "defendit-google-")), "t.db");
  resetDbForTests();
  process.env.GOOGLE_CLIENT_ID = "client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.APP_URL = "http://localhost:3000";
});

afterEach(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  resetDbForTests();
});

describe("Google authorization request", () => {
  it("sends PKCE S256, state, and the configured redirect URI", () => {
    process.env.APP_URL = "https://defendit-two.vercel.app";
    const started = beginGoogleOAuth("/admin?auth_error=denied");
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://defendit-two.vercel.app/api/auth/google/callback",
    );
    expect(url.searchParams.get("state")).toBe(started.txn.state);
    const challenge = createHash("sha256").update(started.txn.codeVerifier).digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(started.txn.nextPath).toBe("/admin");
    expect(decodeOAuthTxn(started.cookieValue)?.codeVerifier).toBe(started.txn.codeVerifier);
  });

  it("keeps a same-origin return path and drops a foreign referer", () => {
    const req = new Request("http://localhost:3000/api/auth/google", {
      headers: { host: "localhost:3000", referer: "http://localhost:3000/dashboard?auth_error=denied" },
    });
    expect(nextPathFromRequest(req, null)).toBe("/dashboard");
    const foreign = new Request("http://localhost:3000/api/auth/google", {
      headers: { host: "localhost:3000", referer: "https://evil.example/phish" },
    });
    expect(nextPathFromRequest(foreign, null)).toBe("/");
  });
});

describe("Google callback", () => {
  it("rejects a state mismatch before exchanging the code", async () => {
    let called = false;
    const stored = txn();
    await expect(
      resolveGoogleCallback({
        stored,
        returnedState: "different-state-value",
        code: "auth-code",
        providerError: null,
        exchange: async () => {
          called = true;
          return { email: "a@b.example", email_verified: true };
        },
      }),
    ).rejects.toMatchObject({ code: "state_mismatch" });
    expect(called).toBe(false);
  });

  it("rejects an expired attempt and a cancelled consent without creating a user", async () => {
    await expect(
      resolveGoogleCallback({
        stored: txn({ exp: Date.now() - 1 }),
        returnedState: "state-value-0123456789",
        code: "auth-code",
        providerError: null,
        exchange: async () => ({ email: "a@b.example", email_verified: true }),
      }),
    ).rejects.toMatchObject({ code: "expired" });

    let called = false;
    await expect(
      resolveGoogleCallback({
        stored: txn(),
        returnedState: "state-value-0123456789",
        code: "auth-code",
        providerError: "access_denied",
        exchange: async () => {
          called = true;
          return { email: "a@b.example", email_verified: true };
        },
      }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(called).toBe(false);
    const row = await (await getDb()).get(`SELECT id FROM users`);
    expect(row).toBeUndefined();
  });

  it("rejects an unverified email, including the string true, and does not insert a user", async () => {
    process.env.ADMIN_EMAILS = "LuisNunez1940@hotmail.com";
    const unverified: GoogleClaims[] = [
      { email: "LUISNUNEZ1940@hotmail.com", email_verified: false },
      { email: "LUISNUNEZ1940@hotmail.com", email_verified: "true" },
      { email_verified: true },
    ];
    for (const claims of unverified) {
      await expect(
        resolveGoogleCallback({
          stored: txn(),
          returnedState: "state-value-0123456789",
          code: "auth-code",
          providerError: null,
          exchange: async () => claims,
        }),
      ).rejects.toMatchObject({
        code: claims.email_verified === true ? "missing_email" : "unverified_email",
      });
    }
    const row = await (await getDb()).get(`SELECT id FROM users WHERE email = ?`, [
      "luisnunez1940@hotmail.com",
    ]);
    expect(row).toBeUndefined();
    expect(() =>
      identityFromVerifiedClaims({ email: "a@b.example", email_verified: "true" }),
    ).toThrow(expect.objectContaining({ code: "unverified_email" }));
  });

  it("signs the admin in when the verified Google email matches ADMIN_EMAILS, ignoring case", async () => {
    process.env.ADMIN_EMAILS = "LuisNunez1940@hotmail.com";
    const first = await resolveGoogleCallback({
      stored: txn(),
      returnedState: "state-value-0123456789",
      code: "auth-code",
      providerError: null,
      exchange: async () => ({
        email: "LUISNUNEZ1940@hotmail.com",
        email_verified: true,
        name: "Luis Nunez",
      }),
    });
    expect(first.user.email).toBe("luisnunez1940@hotmail.com");
    expect(first.user.display_name).toBe("Luis Nunez");
    expect(first.nextPath).toBe("/admin");
    expect(isAdmin(first.user)).toBe(true);

    const again = await resolveGoogleCallback({
      stored: txn({ state: "second-state-0123456789" }),
      returnedState: "second-state-0123456789",
      code: "auth-code-2",
      providerError: null,
      exchange: async () => ({
        email: "luisnunez1940@hotmail.com",
        email_verified: true,
        name: "Someone Else",
      }),
    });
    expect(again.user.id).toBe(first.user.id);
    expect(again.user.display_name).toBe("Luis Nunez");
    expect(isAdmin(again.user)).toBe(true);
    const rows = await (await getDb()).all(`SELECT id FROM users WHERE email = ?`, [
      "luisnunez1940@hotmail.com",
    ]);
    expect(rows).toHaveLength(1);
  });

  it("signs a verified non-admin in without admin access", async () => {
    process.env.ADMIN_EMAILS = "LuisNunez1940@hotmail.com";
    const result = await resolveGoogleCallback({
      stored: txn({ nextPath: "/dashboard" }),
      returnedState: "state-value-0123456789",
      code: "auth-code",
      providerError: null,
      exchange: async () => ({ email: "Other.Person@gmail.com", email_verified: true, name: "Ana" }),
    });
    expect(result.user.email).toBe("other.person@gmail.com");
    expect(isAdmin(result.user)).toBe(false);
    expect(result.nextPath).toBe("/dashboard");
  });

  it("redirects a mismatched callback and does not start Google from the wrong host", async () => {
    const started = beginGoogleOAuth("/dashboard");
    const callback = await googleCallback(
      new Request("http://localhost:3000/api/auth/google/callback?state=not-the-state&code=abc", {
        headers: {
          host: "localhost:3000",
          cookie: `${GOOGLE_OAUTH_COOKIE}=${started.cookieValue}`,
        },
      }),
    );
    expect(callback.status).toBeGreaterThanOrEqual(300);
    expect(callback.status).toBeLessThan(400);
    expect(callback.headers.get("location")).toBe(
      "http://localhost:3000/dashboard?auth_error=state_mismatch",
    );

    process.env.APP_URL = "https://defendit-two.vercel.app";
    const wrongHost = await startGoogle(new Request("http://localhost:3000/api/auth/google"));
    expect(wrongHost.headers.get("location")).toBe("http://localhost:3000/?auth_error=wrong_host");

    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const hidden = await startGoogle(new Request("http://localhost:3000/api/auth/google"));
    expect(hidden.status).toBe(404);
  });

  it("redirects to Google with the state cookie when the host matches", async () => {
    const res = await startGoogle(
      new Request("http://localhost:3000/api/auth/google?next=/admin", {
        headers: { host: "localhost:3000" },
      }),
    );
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(location).toContain("code_challenge_method=S256");
    expect(location).toContain(
      `redirect_uri=${encodeURIComponent("http://localhost:3000/api/auth/google/callback")}`,
    );
    const cookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.join("\n").toLowerCase()).toContain("httponly");
    expect(cookies.join("\n")).toContain(GOOGLE_OAUTH_COOKIE);
  });
});

describe("sign-in methods", () => {
  it("hides email links on Vercel production and hides Google when it is not configured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    setEnv("NODE_ENV", "production");
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    process.env.AUTH_DEV_LINKS = "1";
    expect(await (await authProviders()).json()).toEqual({ google: false, email: false });

    process.env.GOOGLE_CLIENT_ID = "client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(await (await authProviders()).json()).toEqual({ google: true, email: false });

    process.env.VERCEL_ENV = "preview";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(await (await authProviders()).json()).toEqual({ google: false, email: true });
  });
});
