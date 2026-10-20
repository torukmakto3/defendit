import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  createSessionForEmail,
  googleAuthConfigured,
  normalizeEmail,
  safeNextPath,
  type User,
} from "./auth";
import { appUrl } from "./config";
import { isDeployed } from "./secrets";

/** Registered in the Google Cloud OAuth client. Do not change without updating that client. */
export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
export const GOOGLE_OAUTH_COOKIE = "di_google_oauth";
export const GOOGLE_OAUTH_TTL_SEC = 10 * 60;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GoogleAuthErrorCode =
  | "state_mismatch"
  | "expired"
  | "unverified_email"
  | "missing_email"
  | "denied"
  | "invalid_token"
  | "not_configured"
  | "wrong_host";

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;
  constructor(code: GoogleAuthErrorCode, message: string) {
    super(message);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

export interface GoogleOAuthTxn {
  state: string;
  codeVerifier: string;
  nextPath: string;
  exp: number;
}

export interface GoogleClaims {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

const tokenResponse = z.object({
  id_token: z.string().min(1),
});

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function googleJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return jwks;
}

export function googleRedirectUri(): string {
  return appUrl(GOOGLE_CALLBACK_PATH);
}

export function googleOAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: isDeployed(),
    sameSite: "lax" as const,
    path: GOOGLE_CALLBACK_PATH,
    maxAge: GOOGLE_OAUTH_TTL_SEC,
  };
}

export function requestHost(req: Request): string | null {
  const raw = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (raw) {
    const host = raw.split(",")[0]?.trim();
    if (host) return host;
  }
  try {
    return new URL(req.url).host || null;
  } catch {
    return null;
  }
}

/** Origin of the browser request, honoring the proxy headers Vercel sets. */
export function requestOrigin(req: Request): string {
  const host = requestHost(req);
  if (!host) return new URL(req.url).origin;
  const forwarded = req.headers.get("x-forwarded-proto");
  const proto = forwarded
    ? forwarded.split(",")[0]?.trim() || "https"
    : new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function googleRedirectMatchesHost(host: string | null): boolean {
  if (!host) return false;
  return new URL(googleRedirectUri()).host === host;
}

export function nextPathWithoutAuthError(next: string | null | undefined): string {
  const safe = safeNextPath(next);
  const url = new URL(safe, "http://same-origin.invalid");
  url.searchParams.delete("auth_error");
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function pathWithAuthError(next: string | null | undefined, code: string): string {
  const url = new URL(nextPathWithoutAuthError(next), "http://same-origin.invalid");
  url.searchParams.set("auth_error", code);
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function nextPathFromRequest(req: Request, explicit: string | null): string {
  if (explicit) return nextPathWithoutAuthError(explicit);
  const referer = req.headers.get("referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    if (url.host !== requestHost(req)) return "/";
    return nextPathWithoutAuthError(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return "/";
  }
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function encodeOAuthTxn(txn: GoogleOAuthTxn): string {
  return Buffer.from(
    JSON.stringify({
      state: txn.state,
      codeVerifier: txn.codeVerifier,
      nextPath: txn.nextPath,
      exp: txn.exp,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeOAuthTxn(value: string | null | undefined): GoogleOAuthTxn | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<GoogleOAuthTxn>;
    if (typeof parsed.state !== "string" || !STATE_RE.test(parsed.state)) return null;
    if (typeof parsed.codeVerifier !== "string" || !VERIFIER_RE.test(parsed.codeVerifier)) return null;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return null;
    if (typeof parsed.nextPath !== "string") return null;
    return {
      state: parsed.state,
      codeVerifier: parsed.codeVerifier,
      nextPath: nextPathWithoutAuthError(parsed.nextPath),
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export function beginGoogleOAuth(
  nextPath: string | null | undefined,
  now = Date.now(),
): { authorizationUrl: string; cookieValue: string; txn: GoogleOAuthTxn } {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!googleAuthConfigured() || !clientId) {
    throw new GoogleAuthError("not_configured", "Google sign-in is not configured");
  }
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const txn: GoogleOAuthTxn = {
    state,
    codeVerifier,
    nextPath: nextPathWithoutAuthError(nextPath),
    exp: now + GOOGLE_OAUTH_TTL_SEC * 1000,
  };
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  // Lets the owner pick the Google account that has the admin email verified.
  url.searchParams.set("prompt", "select_account");
  return { authorizationUrl: url.toString(), cookieValue: encodeOAuthTxn(txn), txn };
}

/**
 * Accept a signature-checked ID token payload. `email_verified` must be the
 * boolean true; the string "true" is rejected. Email is lowercased.
 */
export function identityFromVerifiedClaims(claims: GoogleClaims): { email: string; name: string | null } {
  if (claims.email_verified !== true) {
    throw new GoogleAuthError("unverified_email", "Google has not verified this email address");
  }
  const email = typeof claims.email === "string" ? normalizeEmail(claims.email) : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new GoogleAuthError("missing_email", "Google did not share an email address");
  }
  const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 80) : "";
  return { email, name: name || null };
}

export function assertOAuthState(
  stored: GoogleOAuthTxn | null,
  returnedState: string | null,
  now: number,
): GoogleOAuthTxn {
  if (!stored || !returnedState || !safeEqual(stored.state, returnedState)) {
    throw new GoogleAuthError("state_mismatch", "Sign-in state did not match");
  }
  if (stored.exp <= now) {
    throw new GoogleAuthError("expired", "Sign-in attempt expired");
  }
  return stored;
}

/** Exchange the authorization code and verify the ID token signature, issuer, and audience. */
export async function exchangeGoogleCode(code: string, codeVerifier: string): Promise<GoogleClaims> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError("not_configured", "Google sign-in is not configured");
  }
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
    });
  } catch (e) {
    console.error("[auth] google token endpoint", e instanceof Error ? e.message : e);
    throw new GoogleAuthError("invalid_token", "Google token exchange failed");
  }
  if (!res.ok) {
    console.error("[auth] google token endpoint status", res.status);
    throw new GoogleAuthError("invalid_token", "Google token exchange failed");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GoogleAuthError("invalid_token", "Google token exchange failed");
  }
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) {
    throw new GoogleAuthError("invalid_token", "Google did not return an ID token");
  }
  try {
    const { payload } = await jwtVerify(parsed.data.id_token, googleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      clockTolerance: 60,
    });
    return {
      email: payload["email"],
      email_verified: payload["email_verified"],
      name: payload["name"],
    };
  } catch (e) {
    console.error("[auth] google id token", e instanceof Error ? e.message : e);
    throw new GoogleAuthError("invalid_token", "Google ID token could not be verified");
  }
}

export async function resolveGoogleCallback(input: {
  stored: GoogleOAuthTxn | null;
  returnedState: string | null;
  code: string | null;
  providerError: string | null;
  now?: number;
  exchange?: (code: string, codeVerifier: string) => Promise<GoogleClaims>;
}): Promise<{ user: User; sessionToken: string; nextPath: string }> {
  const txn = assertOAuthState(input.stored, input.returnedState, input.now ?? Date.now());
  if (input.providerError) {
    const code: GoogleAuthErrorCode = input.providerError === "access_denied" ? "denied" : "invalid_token";
    throw new GoogleAuthError(code, "Google did not complete sign-in");
  }
  if (!input.code || input.code.length > 2048) {
    throw new GoogleAuthError("invalid_token", "Missing authorization code");
  }
  const exchange = input.exchange ?? exchangeGoogleCode;
  let claims: GoogleClaims;
  try {
    claims = await exchange(input.code, txn.codeVerifier);
  } catch (e) {
    if (e instanceof GoogleAuthError) throw e;
    throw new GoogleAuthError("invalid_token", "Google token exchange failed");
  }
  const identity = identityFromVerifiedClaims(claims);
  const session = await createSessionForEmail(identity.email, identity.name);
  return { ...session, nextPath: nextPathWithoutAuthError(txn.nextPath) };
}
