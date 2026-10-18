import { randomBytes } from "crypto";
import { appUrl } from "./config";
import { sha256Hex } from "./crypto";
import { getDb } from "./db";
import { newId } from "./ids";
import { isDeployed } from "./secrets";

/**
 * Passwordless email sign-in.
 * - Link tokens are 256-bit, single use, 15 minutes, stored only as SHA-256.
 * - The token travels in the URL fragment (#token=), so it never reaches
 *   server logs or Referer headers; the verify page POSTs it after a click,
 *   which also stops email link scanners from consuming it.
 * - Sessions are 256-bit random cookies, stored only as SHA-256.
 */
export const SESSION_COOKIE = "di_session";
const LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export interface User {
  id: string;
  email: string;
  display_name: string | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Post-login redirect target: same-origin path only. Browsers strip tabs and
 * newlines from URLs, so "/\t/evil.com" would otherwise become "//evil.com".
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001F\u007F\\]/.test(next)) return "/";
  try {
    const base = "http://same-origin.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function matchesPattern(email: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  return p.startsWith("*@") ? email.endsWith(p.slice(1)) : email === p;
}

/**
 * Showing the sign-in link on screen means anyone can sign in as any email,
 * so it is only for local dev or a throwaway test deploy:
 * - never for admin accounts;
 * - on a deployment only with AUTH_DEV_LINKS=1, and only for addresses
 *   matching AUTH_DEV_LINK_ALLOW (e.g. "*@example.com") when that is set.
 */
export function devLinksAllowed(email: string): boolean {
  if (isAdminEmail(email)) return false;
  if (!isDeployed()) return true;
  if (process.env.AUTH_DEV_LINKS !== "1") return false;
  const allow = (process.env.AUTH_DEV_LINK_ALLOW || "").split(",").filter((p) => p.trim());
  return allow.length === 0 || allow.some((p) => matchesPattern(email, p));
}

export async function requestMagicLink(opts: {
  email: string;
  nextPath?: string;
}): Promise<{ devLink?: string }> {
  const email = normalizeEmail(opts.email);
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const db = await getDb();
  await db.run(
    `INSERT INTO login_tokens (token_hash, email, next_path, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      sha256Hex(token),
      email,
      safeNextPath(opts.nextPath),
      new Date(now.getTime() + LINK_TTL_MS).toISOString(),
      now.toISOString(),
    ],
  );

  const link = appUrl(`/auth/verify#token=${token}`);
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    await sendEmail(email, link);
    return {};
  }
  if (devLinksAllowed(email)) {
    console.info(`[auth] sign-in link for ${email} (dev mode, not emailed)`);
    return { devLink: link };
  }
  throw new Error("Email sign-in is not configured on this server.");
}

async function sendEmail(to: string, link: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to,
      subject: "Your Defend It sign-in link",
      text: `Sign in to Defend It:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
    }),
  });
  if (!res.ok) throw new Error(`Email delivery failed (${res.status})`);
}

/** Exchange a link token for a session. Single use, atomic. */
export async function consumeMagicLink(token: string): Promise<{
  user: User;
  sessionToken: string;
  nextPath: string;
} | null> {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const hash = sha256Hex(token);

  return db.transaction(async (tx) => {
    const claimed = await tx.run(
      `UPDATE login_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      [nowIso, hash, nowIso],
    );
    if (claimed.changes !== 1) return null;
    const row = await tx.get<{ email: string; next_path: string | null }>(
      `SELECT email, next_path FROM login_tokens WHERE token_hash = ?`,
      [hash],
    );
    if (!row) return null;

    // Two first-time sign-ins for one email can race; the unique email wins either way.
    await tx.run(
      `INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, NULL, ?)
       ON CONFLICT (email) DO NOTHING`,
      [newId("usr"), row.email, nowIso],
    );
    const user = await tx.get<User>(
      `SELECT id, email, display_name FROM users WHERE email = ?`,
      [row.email],
    );
    if (!user) return null;

    const sessionToken = randomBytes(32).toString("base64url");
    await tx.run(
      `INSERT INTO auth_sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      [
        sha256Hex(sessionToken),
        user.id,
        new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString(),
        nowIso,
      ],
    );
    return { user, sessionToken, nextPath: safeNextPath(row.next_path) };
  });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export async function getUserFromRequest(req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const db = await getDb();
  const row = await db.get<User>(
    `SELECT u.id, u.email, u.display_name
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
    [sha256Hex(token), new Date().toISOString()],
  );
  return row ?? null;
}

export async function endSession(req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  const db = await getDb();
  await db.run(`DELETE FROM auth_sessions WHERE id_hash = ?`, [sha256Hex(token)]);
}

export async function setDisplayName(userId: string, name: string | null) {
  const db = await getDb();
  await db.run(`UPDATE users SET display_name = ? WHERE id = ?`, [
    name ? name.trim().slice(0, 80) : null,
    userId,
  ]);
}

function isAdminEmail(email: string): boolean {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  return admins.includes(normalizeEmail(email));
}

export function isAdmin(user: User | null): boolean {
  return !!user && isAdminEmail(user.email);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isDeployed(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  };
}
