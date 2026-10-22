import { normalizeEmail, type User } from "./auth";
import { assertPaidChallengesOpen, billingEnabled } from "./billing";
import { challengesEnabled, TIER_LEGEND, tierForScore, type ResultTier } from "./challenge-tier";
import { consumeCredit, grantCredits, holdCredit, refundCredit } from "./credits";
import { appUrl } from "./config";
import { getDb, type Db } from "./db";
import { HttpError } from "./errors";
import { newId, newToken } from "./ids";
import { sessionBudgetUsd } from "./llm/usage";
import { rateLimit } from "./ratelimit";
import type { Difficulty, ReceiptOutcome, SignedReceipt } from "./types";

/**
 * Challenge links. A challenge is a sponsored defense: the claimer uploads
 * and defends through the normal flow, and the sponsor covers the cost.
 * Beta challenges (`sponsor_type=beta`) are free and badged "Sponsored by
 * DefendIT". Paid challenges hold a credit through `src/lib/credits.ts`
 * while BILLING_ENABLED is on, and never call a payment provider. A refund
 * returns that credit. The creator cannot claim their own link.
 *
 * Credits and sponsorship do not depend on posting or sharing. Share clicks
 * are counted and then ignored by every gate.
 */

export const SPONSOR_LABEL = "Sponsored by DefendIT";
export { challengesEnabled, TIER_LEGEND, tierForScore };
export type { ResultTier };

export type ChallengeStatus = "open" | "claimed" | "defended" | "expired" | "revoked";
export type SponsorType = "beta" | "paid";
export type ChallengeVisibility = "public" | "score_hidden" | "private";
export type ChallengeEventName =
  | "created"
  | "viewed"
  | "accepted"
  | "defended"
  | "published"
  | "result_viewed"
  | "share_clicked"
  | "reported"
  | "kept_private";

const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SLUG_LENGTH = 8;

function requireEnabled(): void {
  if (!challengesEnabled()) throw new HttpError(404, "Challenges are not available.");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Unfinished challenges (open or claimed) one challenger may have at once. */
export function openPerCreator(): number {
  return envInt("CHALLENGE_OPEN_PER_CREATOR", 3);
}

/** Challenges one challenger may create per rolling 24 hours. */
export function dailyPerCreator(): number {
  return envInt("CHALLENGE_DAILY_PER_CREATOR", 3);
}

/** Claimed, not-yet-finished challenges one defender may hold. */
export function openPerDefender(): number {
  return envInt("CHALLENGE_OPEN_PER_DEFENDER", 1);
}

/** Beta challenges created per rolling 24 hours, across everyone. Provisional. */
export function globalDailyCap(): number {
  return envInt("CHALLENGE_GLOBAL_DAILY_CAP", 25);
}

/**
 * Euro cap for sponsored beta defenses (`BETA_BUDGET_EUR`, default 150).
 * Each open or claimed beta challenge reserves one defense budget
 * (`SESSION_BUDGET_USD`, default 3). Defended ones count their recorded
 * model cost. The comparison is numeric: model cost is still stored in USD.
 */
export function betaBudgetEur(): number {
  return envNumber("BETA_BUDGET_EUR", 150);
}

function unclaimedDays(): number {
  return envInt("CHALLENGE_UNCLAIMED_DAYS", 7);
}

function finishHours(): number {
  return envInt("CHALLENGE_FINISH_HOURS", 72);
}

function minAccountAgeHours(): number {
  return envInt("CHALLENGE_MIN_ACCOUNT_AGE_HOURS", 0);
}

function createAttemptLimit(): number {
  return envInt("CHALLENGE_CREATE_LIMIT", 10);
}

function claimAttemptLimit(): number {
  return envInt("CHALLENGE_CLAIM_LIMIT", 20);
}

function claimIpLimit(): number {
  return envInt("CHALLENGE_CLAIM_IP_LIMIT", 30);
}

const DAY_SEC = 24 * 60 * 60;
const HOUR_SEC = 60 * 60;

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

function countOf(row: { n: number | string } | undefined): number {
  return Number(row?.n ?? 0);
}

function hoursFrom(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3600_000).toISOString();
}

function daysFrom(iso: string, days: number): string {
  return hoursFrom(iso, days * 24);
}

function sinceIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

interface ChallengeRow {
  id: string;
  slug: string;
  creator_user_id: string;
  target_hint: string | null;
  subject: string;
  source_url: string | null;
  note: string | null;
  difficulty: Difficulty;
  status: string;
  sponsor_type: string;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  expires_at: string;
  finish_by: string | null;
  request_id: string | null;
  deliverable_id: string | null;
  session_id: string | null;
  receipt_id: string | null;
  visibility: string | null;
  adult_confirmed_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

function asStatus(value: string): ChallengeStatus {
  switch (value) {
    case "open":
    case "claimed":
    case "defended":
    case "expired":
    case "revoked":
      return value;
    default: {
      const unknown: never = value as never;
      throw new HttpError(500, `Unknown challenge status: ${String(unknown)}`);
    }
  }
}

function asVisibility(value: string | null): ChallengeVisibility | null {
  if (value == null) return null;
  switch (value) {
    case "public":
    case "score_hidden":
    case "private":
      return value;
    default: {
      const unknown: never = value as never;
      throw new HttpError(500, `Unknown challenge visibility: ${String(unknown)}`);
    }
  }
}

function asSponsor(value: string): SponsorType {
  switch (value) {
    case "beta":
    case "paid":
      return value;
    default: {
      const unknown: never = value as never;
      throw new HttpError(500, `Unknown sponsor type: ${String(unknown)}`);
    }
  }
}

export function sponsorLabel(sponsor: SponsorType): string {
  switch (sponsor) {
    case "beta":
      return SPONSOR_LABEL;
    case "paid":
      return "Sponsored challenge";
    default: {
      const unknown: never = sponsor;
      return unknown;
    }
  }
}

async function recordEvent(
  db: Db,
  challengeId: string,
  event: ChallengeEventName,
  userId: string | null,
  meta?: Record<string, string>,
): Promise<void> {
  await db.run(
    `INSERT INTO challenge_events (id, challenge_id, event, user_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newId("evt"),
      challengeId,
      event,
      userId,
      meta ? JSON.stringify(meta) : null,
      new Date().toISOString(),
    ],
  );
}

export async function challengeEvents(
  slug: string,
): Promise<{ event: string; meta: string | null }[]> {
  const db = await getDb();
  const row = await db.get<{ id: string }>(`SELECT id FROM challenges WHERE slug = ?`, [slug]);
  if (!row) return [];
  return db.all(
    `SELECT event, meta FROM challenge_events WHERE challenge_id = ? ORDER BY created_at`,
    [row.id],
  );
}

/** Move unclaimed and unfinished challenges past their window to expired, and refund a held credit. */
export async function expireDueChallenges(db?: Db): Promise<number> {
  const conn = db ?? (await getDb());
  const now = new Date().toISOString();
  const due = await conn.all<{ id: string; creator_user_id: string }>(
    `SELECT id, creator_user_id FROM challenges
     WHERE (status = 'open' AND expires_at < ?)
        OR (status = 'claimed' AND finish_by IS NOT NULL AND finish_by < ?)`,
    [now, now],
  );
  if (due.length === 0) return 0;
  await conn.run(
    `UPDATE challenges SET status = 'expired'
     WHERE (status = 'open' AND expires_at < ?)
        OR (status = 'claimed' AND finish_by IS NOT NULL AND finish_by < ?)`,
    [now, now],
  );
  for (const row of due) {
    await refundCredit({
      userId: row.creator_user_id,
      kind: "challenge",
      amount: 1,
      idempotencyKey: `refund:challenge:${row.id}`,
      refId: row.id,
      detail: "expiry",
      db: conn,
    });
  }
  return due.length;
}

async function loadBySlug(db: Db, slug: string): Promise<ChallengeRow | undefined> {
  return db.get<ChallengeRow>(`SELECT * FROM challenges WHERE slug = ?`, [slug]);
}

async function challengerName(db: Db, userId: string): Promise<string> {
  const row = await db.get<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = ?`,
    [userId],
  );
  const name = row?.display_name?.trim();
  return name || "A Defend It user";
}

async function optedOut(db: Db, userId: string): Promise<boolean> {
  const row = await db.get<{ user_id: string }>(
    `SELECT user_id FROM challenge_opt_outs WHERE user_id = ?`,
    [userId],
  );
  return !!row;
}

async function targetBlocked(db: Db, targetHint: string | undefined): Promise<boolean> {
  if (!targetHint?.trim()) return false;
  const handle = normalizeHandle(targetHint);
  const email = targetHint.includes("@") ? normalizeEmail(targetHint) : handle;
  const row = await db.get<{ key_value: string }>(
    `SELECT key_value FROM challenge_opt_out_keys WHERE key_value = ? OR key_value = ?`,
    [handle, email],
  );
  return !!row;
}

async function betaCommittedUsd(db: Db): Promise<number> {
  const reserve = sessionBudgetUsd();
  const spent = await db.get<{ n: number | string }>(
    `SELECT COALESCE(SUM(s.cost_usd), 0) AS n
     FROM challenges c JOIN sessions s ON s.id = c.session_id
     WHERE c.sponsor_type = 'beta' AND c.status = 'defended'`,
  );
  const reserved = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM challenges
     WHERE sponsor_type = 'beta' AND status IN ('open', 'claimed')`,
  );
  return countOf(spent) + countOf(reserved) * reserve;
}

function newSlug(): string {
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return out;
}

export interface CreateChallengeInput {
  user: User;
  subject: string;
  sourceUrl?: string;
  targetHint?: string;
  note?: string;
  difficulty: Difficulty;
  sponsorType?: SponsorType;
}

export interface CreatedChallenge {
  id: string;
  slug: string;
  url: string;
  expiresAt: string;
  sponsorLabel: string;
}

function cleanHttpUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, "Source link must be an http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Source link must be an http(s) URL.");
  }
  if (url.toString().length > 500) throw new HttpError(400, "Source link is too long.");
  return url.toString();
}

export async function createChallenge(input: CreateChallengeInput): Promise<CreatedChallenge> {
  requireEnabled();
  const sponsorType: SponsorType = input.sponsorType ?? "beta";
  if (sponsorType === "paid") assertPaidChallengesOpen();
  else if (sponsorType !== "beta") {
    const unknown: never = sponsorType;
    throw new HttpError(400, `Unknown sponsor type: ${String(unknown)}`);
  }

  const subject = input.subject.trim();
  if (subject.length < 1 || subject.length > 500) {
    throw new HttpError(400, "Describe what to defend in 500 characters or fewer.");
  }
  const sourceUrl = cleanHttpUrl(input.sourceUrl);
  const note = input.note?.trim().slice(0, 500) || null;
  const targetHint = input.targetHint?.trim().slice(0, 80) || null;
  const difficulty = input.difficulty;
  switch (difficulty) {
    case "standard":
    case "hard":
    case "expert":
      break;
    default: {
      const unknown: never = difficulty;
      throw new HttpError(400, `Unknown difficulty: ${String(unknown)}`);
    }
  }

  const limited = await rateLimit(`challenge-create:${input.user.id}`, createAttemptLimit(), DAY_SEC);
  if (!limited.ok) throw new HttpError(429, "Too many challenges. Try again later.");

  const db = await getDb();
  const account = await db.get<{ created_at: string }>(`SELECT created_at FROM users WHERE id = ?`, [
    input.user.id,
  ]);
  const minAge = minAccountAgeHours();
  if (account && minAge > 0 && Date.parse(account.created_at) > Date.now() - minAge * 3600_000) {
    throw new HttpError(403, "This account is too new to create a challenge.");
  }
  if (await targetBlocked(db, targetHint ?? undefined)) {
    throw new HttpError(403, "That person has opted out of challenges. They're on the do-not-challenge list.");
  }

  await expireDueChallenges(db);

  const now = new Date().toISOString();
  const dayAgo = sinceIso(DAY_SEC * 1000);
  const created = await db.transaction(async (tx) => {
    const open = await tx.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM challenges
       WHERE creator_user_id = ? AND sponsor_type = 'beta' AND status IN ('open', 'claimed')`,
      [input.user.id],
    );
    if (countOf(open) >= openPerCreator()) {
      throw new HttpError(403, "You already have the maximum number of open challenges.");
    }
    const today = await tx.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM challenges WHERE creator_user_id = ? AND created_at > ?`,
      [input.user.id, dayAgo],
    );
    if (countOf(today) >= dailyPerCreator()) {
      throw new HttpError(403, "You have reached today's challenge limit.");
    }
    if (targetHint) {
      const recent = await tx.all<{ target_hint: string | null }>(
        `SELECT target_hint FROM challenges WHERE creator_user_id = ? AND created_at > ?`,
        [input.user.id, dayAgo],
      );
      const needle = normalizeHandle(targetHint);
      if (recent.some((row) => row.target_hint && normalizeHandle(row.target_hint) === needle)) {
        throw new HttpError(403, "You already challenged this person today.");
      }
    }
    if (sponsorType === "beta") {
      const global = await tx.get<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM challenges WHERE sponsor_type = 'beta' AND created_at > ?`,
        [dayAgo],
      );
      if (countOf(global) >= globalDailyCap()) {
        throw new HttpError(403, "The daily challenge limit has been reached.");
      }
      const committed = await betaCommittedUsd(tx);
      if (committed + sessionBudgetUsd() > betaBudgetEur()) {
        throw new HttpError(403, "The DefendIT beta challenge budget is used up.");
      }
    }

    const id = newId("chg");
    let slug = newSlug();
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await tx.get<{ id: string }>(`SELECT id FROM challenges WHERE slug = ?`, [slug]);
      if (!clash) break;
      slug = newSlug();
    }
    const expiresAt = daysFrom(now, unclaimedDays());
    await tx.run(
      `INSERT INTO challenges
        (id, slug, creator_user_id, target_hint, subject, source_url, note, difficulty, status,
         sponsor_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      [id, slug, input.user.id, targetHint, subject, sourceUrl, note, difficulty, sponsorType, expiresAt, now],
    );
    if (sponsorType === "paid") {
      await holdCredit({
        userId: input.user.id,
        kind: "challenge",
        amount: 1,
        idempotencyKey: `hold:challenge:${id}`,
        refId: id,
        db: tx,
      });
    }
    await recordEvent(tx, id, "created", input.user.id, { sponsor: sponsorType });
    return { id, slug, expiresAt, sponsorType };
  });

  return {
    id: created.id,
    slug: created.slug,
    url: appUrl(`/c/${created.slug}`),
    expiresAt: created.expiresAt,
    sponsorLabel: sponsorLabel(created.sponsorType),
  };
}

export interface PublicChallenge {
  slug: string;
  status: ChallengeStatus;
  subject: string;
  sourceUrl: string | null;
  note: string | null;
  targetHint: string | null;
  difficulty: Difficulty;
  sponsorLabel: string;
  challengerName: string;
  expiresAt: string;
  finishBy: string | null;
  visibility: ChallengeVisibility | null;
  canClaim: boolean;
  claimBlock: string | null;
  isClaimer: boolean;
  isCreator: boolean;
  canRevoke: boolean;
  needsPublishChoice: boolean;
  defensePath: string | null;
  resultPath: string | null;
  /** Signed-in challenger only, when the defender kept the result private. */
  creatorPrivateNote: string | null;
}

async function defenseToken(db: Db, requestId: string | null): Promise<string | null> {
  if (!requestId) return null;
  const row = await db.get<{ token: string }>(`SELECT token FROM defense_requests WHERE id = ?`, [requestId]);
  return row?.token ?? null;
}

export async function getPublicChallenge(
  slug: string,
  user: User | null,
  opts?: { recordView?: boolean },
): Promise<PublicChallenge | null> {
  if (!challengesEnabled()) return null;
  if (!/^[a-z0-9]{8}$/.test(slug)) return null;
  const db = await getDb();
  await expireDueChallenges(db);
  const row = await loadBySlug(db, slug);
  if (!row) return null;
  if (opts?.recordView) await recordEvent(db, row.id, "viewed", user?.id ?? null);

  const status = asStatus(row.status);
  const visibility = asVisibility(row.visibility);
  const isCreator = !!user && user.id === row.creator_user_id;
  const isClaimer = !!user && user.id === row.claimed_by_user_id;
  const token = isClaimer ? await defenseToken(db, row.request_id) : null;

  let claimBlock: string | null = null;
  if (!user) claimBlock = "Sign in to accept this challenge.";
  else if (isCreator) claimBlock = "You created this challenge. Send the link to someone else.";
  else if (status !== "open") claimBlock = null;
  else if (await optedOut(db, user.id)) {
    claimBlock = "You opted out of challenges. You're on the do-not-challenge list.";
  }
  else {
    const held = await db.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM challenges WHERE claimed_by_user_id = ? AND status = 'claimed'`,
      [user.id],
    );
    if (countOf(held) >= openPerDefender()) {
      claimBlock = "Finish your current challenge before accepting another.";
    }
  }

  const resultPublic = status === "defended" && (visibility === "public" || visibility === "score_hidden");
  return {
    slug: row.slug,
    status,
    subject: row.subject,
    sourceUrl: row.source_url,
    note: row.note,
    targetHint: row.target_hint,
    difficulty: row.difficulty,
    sponsorLabel: sponsorLabel(asSponsor(row.sponsor_type)),
    challengerName: await challengerName(db, row.creator_user_id),
    expiresAt: row.expires_at,
    finishBy: row.finish_by,
    visibility: isCreator || isClaimer ? visibility : resultPublic ? visibility : null,
    canClaim: status === "open" && !!user && !isCreator && claimBlock == null,
    claimBlock: status === "open" ? claimBlock : null,
    isClaimer,
    isCreator,
    canRevoke: isCreator && status === "open",
    needsPublishChoice: isClaimer && status === "defended" && visibility == null,
    defensePath: token ? `/d/${token}` : null,
    resultPath: resultPublic && row.receipt_id ? `/r/${row.receipt_id}` : null,
    creatorPrivateNote:
      isCreator && visibility === "private" ? "The defender kept this result private." : null,
  };
}

export interface ClaimResult {
  slug: string;
  token: string;
  defensePath: string;
}

export async function claimChallenge(opts: {
  slug: string;
  user: User;
  ip: string;
  adultConfirmed: boolean;
}): Promise<ClaimResult> {
  requireEnabled();
  if (!opts.adultConfirmed) throw new HttpError(400, "Confirm you are 18 or older.");
  if (!/^[a-z0-9]{8}$/.test(opts.slug)) throw new HttpError(404, "Challenge not found.");

  const userLimited = await rateLimit(`challenge-claim:${opts.user.id}`, claimAttemptLimit(), DAY_SEC);
  if (!userLimited.ok) throw new HttpError(429, "Too many attempts. Try again later.");
  const ipLimited = await rateLimit(`challenge-claim-ip:${opts.ip}`, claimIpLimit(), HOUR_SEC);
  if (!ipLimited.ok) throw new HttpError(429, "Too many attempts. Try again later.");

  const db = await getDb();
  if (await optedOut(db, opts.user.id)) {
    throw new HttpError(403, "You opted out of challenges. You're on the do-not-challenge list.");
  }
  await expireDueChallenges(db);

  const now = new Date().toISOString();
  const result = await db.transaction(async (tx) => {
    const row = await loadBySlug(tx, opts.slug);
    if (!row) throw new HttpError(404, "Challenge not found.");
    if (row.creator_user_id === opts.user.id) {
      throw new HttpError(403, "You created this challenge. Send the link to someone else.");
    }
    const status = asStatus(row.status);
    if (status === "expired") throw new HttpError(410, "This challenge has expired.");
    if (status === "revoked") throw new HttpError(410, "This challenge was revoked.");
    if (status !== "open" || row.claimed_by_user_id) {
      throw new HttpError(409, "This challenge has already been claimed.");
    }

    const finishBy = hoursFrom(now, finishHours());
    const claimed = await tx.run(
      `UPDATE challenges
       SET status = 'claimed', claimed_by_user_id = ?, claimed_at = ?, finish_by = ?, adult_confirmed_at = ?
       WHERE id = ? AND status = 'open' AND claimed_by_user_id IS NULL`,
      [opts.user.id, now, finishBy, now, row.id],
    );
    if (claimed.changes !== 1) throw new HttpError(409, "This challenge has already been claimed.");
    const held = await tx.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM challenges WHERE claimed_by_user_id = ? AND status = 'claimed'`,
      [opts.user.id],
    );
    if (countOf(held) > openPerDefender()) {
      throw new HttpError(403, "Finish your current challenge before accepting another.");
    }

    const requestId = newId("req");
    const token = newToken();
    await tx.run(
      `INSERT INTO defense_requests
        (id, token, owner_user_id, creator_user_id, kind, difficulty, title, notes, pinned_claims, status, created_at)
       VALUES (?, ?, ?, ?, 'receiver', ?, ?, ?, NULL, 'pending', ?)`,
      [
        requestId,
        token,
        opts.user.id,
        opts.user.id,
        row.difficulty,
        row.subject.slice(0, 200),
        row.note,
        now,
      ],
    );
    await tx.run(`UPDATE challenges SET request_id = ? WHERE id = ?`, [requestId, row.id]);
    await recordEvent(tx, row.id, "accepted", opts.user.id);
    return { token };
  });

  return { slug: opts.slug, token: result.token, defensePath: `/d/${result.token}` };
}

export async function revokeChallenge(slug: string, user: User): Promise<void> {
  requireEnabled();
  const db = await getDb();
  await expireDueChallenges(db);
  const row = await loadBySlug(db, slug);
  if (!row || row.creator_user_id !== user.id) throw new HttpError(404, "Challenge not found.");
  const updated = await db.run(
    `UPDATE challenges SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'open'`,
    [new Date().toISOString(), row.id],
  );
  if (updated.changes !== 1) throw new HttpError(409, "Only an open challenge can be revoked.");
  await refundCredit({
    userId: row.creator_user_id,
    kind: "challenge",
    amount: 1,
    idempotencyKey: `refund:challenge:${row.id}`,
    refId: row.id,
    detail: "revoke",
    db,
  });
}

export async function chooseVisibility(opts: {
  slug: string;
  user: User;
  visibility: ChallengeVisibility;
}): Promise<{ resultPath: string | null }> {
  requireEnabled();
  const visibility = opts.visibility;
  switch (visibility) {
    case "public":
    case "score_hidden":
    case "private":
      break;
    default: {
      const unknown: never = visibility;
      throw new HttpError(400, `Unknown visibility: ${String(unknown)}`);
    }
  }
  const db = await getDb();
  const row = await loadBySlug(db, opts.slug);
  if (!row || row.claimed_by_user_id !== opts.user.id) throw new HttpError(404, "Challenge not found.");
  if (asStatus(row.status) !== "defended") throw new HttpError(409, "Finish the defense before choosing.");
  const updated = await db.run(
    `UPDATE challenges SET visibility = ? WHERE id = ? AND visibility IS NULL AND status = 'defended'`,
    [visibility, row.id],
  );
  if (updated.changes !== 1) throw new HttpError(409, "A visibility choice was already saved.");

  if (visibility === "private") {
    await refundCredit({
      userId: row.creator_user_id,
      kind: "challenge",
      amount: 1,
      idempotencyKey: `refund:challenge:${row.id}`,
      refId: row.id,
      detail: "decline",
      db,
    });
    await recordEvent(db, row.id, "kept_private", opts.user.id);
    return { resultPath: null };
  }
  await consumeCredit({
    userId: row.creator_user_id,
    kind: "challenge",
    amount: 1,
    idempotencyKey: `consume:challenge:${row.id}`,
    refId: row.id,
    db,
  });
  await recordEvent(db, row.id, "published", opts.user.id, { visibility });
  return { resultPath: row.receipt_id ? `/r/${row.receipt_id}` : null };
}

export async function recordShareClick(slug: string, user: User | null, channel: "x" | "copy"): Promise<void> {
  if (!challengesEnabled()) return;
  const db = await getDb();
  const row = await loadBySlug(db, slug);
  if (!row) return;
  // A share click is only a funnel event. It does not change credits or visibility.
  await recordEvent(db, row.id, "share_clicked", user?.id ?? null, { channel });
}

export async function reportChallenge(slug: string, ip: string, note?: string): Promise<void> {
  if (!challengesEnabled()) throw new HttpError(404, "Challenges are not available.");
  const limited = await rateLimit(`challenge-report:${ip}`, 10, HOUR_SEC);
  if (!limited.ok) throw new HttpError(429, "Too many reports. Try again later.");
  const db = await getDb();
  const row = await loadBySlug(db, slug);
  if (!row) throw new HttpError(404, "Challenge not found.");
  const trimmed = note?.trim().slice(0, 500);
  await recordEvent(db, row.id, "reported", null, trimmed ? { note: trimmed } : undefined);
}

export interface OptOutState {
  optedOut: boolean;
  handles: string[];
}

export async function getOptOut(user: User): Promise<OptOutState> {
  requireEnabled();
  const db = await getDb();
  const on = await optedOut(db, user.id);
  if (!on) return { optedOut: false, handles: [] };
  const email = normalizeEmail(user.email);
  const rows = await db.all<{ key_value: string }>(
    `SELECT key_value FROM challenge_opt_out_keys WHERE user_id = ? AND key_value <> ?`,
    [user.id, email],
  );
  return { optedOut: true, handles: rows.map((row) => row.key_value) };
}

export async function setOptOut(user: User, optedOut: boolean, handles: string[]): Promise<OptOutState> {
  requireEnabled();
  const cleaned = [...new Set(handles.map(normalizeHandle).filter(Boolean))].slice(0, 8);
  for (const handle of cleaned) {
    if (handle.length > 40 || !/^[a-z0-9._-]+$/.test(handle)) {
      throw new HttpError(400, "Handles use letters, numbers, dots, dashes, and underscores.");
    }
  }
  const db = await getDb();
  const email = normalizeEmail(user.email);
  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM challenge_opt_out_keys WHERE user_id = ?`, [user.id]);
    await tx.run(`DELETE FROM challenge_opt_outs WHERE user_id = ?`, [user.id]);
    if (!optedOut) return;
    const now = new Date().toISOString();
    await tx.run(`INSERT INTO challenge_opt_outs (user_id, created_at) VALUES (?, ?)`, [user.id, now]);
    const keys = [email, ...cleaned];
    for (const key of keys) {
      const taken = await tx.get<{ user_id: string }>(
        `SELECT user_id FROM challenge_opt_out_keys WHERE key_value = ?`,
        [key],
      );
      if (taken && taken.user_id !== user.id) {
        throw new HttpError(409, "That handle is already opted out.");
      }
      await tx.run(
        `INSERT INTO challenge_opt_out_keys (user_id, key_value, created_at) VALUES (?, ?, ?)`,
        [user.id, key, now],
      );
    }
  });
  return getOptOut(user);
}

export interface DefenderPreview {
  slug: string;
  subject: string;
  score: number;
  tier: ResultTier;
  outcome: ReceiptOutcome;
  receiptPath: string;
  visibility: ChallengeVisibility | null;
}

export async function getDefenderPreview(slug: string, user: User): Promise<DefenderPreview> {
  requireEnabled();
  const db = await getDb();
  const row = await loadBySlug(db, slug);
  if (!row || row.claimed_by_user_id !== user.id) throw new HttpError(404, "Challenge not found.");
  if (!row.receipt_id) throw new HttpError(409, "Finish the defense before choosing.");
  const receipt = await db.get<{ payload_json: string }>(`SELECT payload_json FROM receipts WHERE id = ?`, [
    row.receipt_id,
  ]);
  if (!receipt) throw new HttpError(404, "Receipt not found.");
  const signed = JSON.parse(receipt.payload_json) as SignedReceipt;
  const score = signed.payload.score;
  return {
    slug: row.slug,
    subject: row.subject,
    score,
    tier: tierForScore(score),
    outcome: signed.payload.outcome,
    receiptPath: `/r/${row.receipt_id}`,
    visibility: asVisibility(row.visibility),
  };
}

export interface PublicResult {
  slug: string;
  receiptId: string;
  audience: "public" | "defender";
  visibility: ChallengeVisibility | "pending";
  tier: ResultTier | null;
  score: number | null;
  showScore: boolean;
  headline: string;
  verifyPath: string | null;
  sponsorLabel: string;
  subject: string;
  legend: string;
  shareUrl: string;
}

function resultFromRow(row: ChallengeRow, signed: SignedReceipt, audience: "public" | "defender"): PublicResult {
  const visibility = asVisibility(row.visibility);
  const score = signed.payload.score;
  const tier = tierForScore(score);
  const published = visibility === "public" || visibility === "score_hidden";
  const showScore = audience === "defender" || visibility === "public";
  let headline = "Defended";
  if (visibility === "public") headline = tier;
  else if (visibility === "score_hidden") headline = "Defended";
  else if (audience === "defender" && visibility == null) headline = tier;
  return {
    slug: row.slug,
    receiptId: signed.payload.id,
    audience,
    visibility: visibility ?? "pending",
    tier: published || audience === "defender" ? tier : null,
    score: showScore ? score : null,
    showScore,
    headline,
    verifyPath: visibility === "public" ? `/verify/${signed.payload.id}` : null,
    sponsorLabel: sponsorLabel(asSponsor(row.sponsor_type)),
    subject: row.subject,
    legend: TIER_LEGEND,
    shareUrl: appUrl(`/r/${signed.payload.id}`),
  };
}

/** Strings the public result page and OG card are allowed to render. */
export function publicResultLines(result: PublicResult): string[] {
  const lines = [result.sponsorLabel, result.headline, result.subject, result.legend];
  if (result.tier) lines.push(result.tier);
  if (result.showScore && result.score != null) lines.push(String(result.score));
  if (result.visibility === "score_hidden") lines.push("Defended");
  return lines;
}

export interface ReceiptGate {
  mode: "standard" | "challenge";
  httpStatus: 200 | 404;
  includeReceipt: boolean;
  result: PublicResult | null;
}

/**
 * What `/r/{id}` may return. A private or not-yet-chosen challenge result is
 * not public. Score-hidden results omit the receipt payload so the number
 * is not in the JSON. The defender can still see their own receipt.
 */
export async function receiptGate(receiptId: string, user: User | null): Promise<ReceiptGate> {
  const db = await getDb();
  const row = await db.get<ChallengeRow>(`SELECT * FROM challenges WHERE receipt_id = ?`, [receiptId]);
  if (!row) return { mode: "standard", httpStatus: 200, includeReceipt: true, result: null };

  const receipt = await db.get<{ payload_json: string }>(`SELECT payload_json FROM receipts WHERE id = ?`, [
    receiptId,
  ]);
  if (!receipt) return { mode: "challenge", httpStatus: 404, includeReceipt: false, result: null };
  const signed = JSON.parse(receipt.payload_json) as SignedReceipt;
  const defender = !!user && user.id === row.claimed_by_user_id;
  const visibility = asVisibility(row.visibility);

  if (visibility === "private" || visibility == null) {
    if (!defender) return { mode: "challenge", httpStatus: 404, includeReceipt: false, result: null };
    return {
      mode: "challenge",
      httpStatus: 200,
      includeReceipt: true,
      result: resultFromRow(row, signed, "defender"),
    };
  }

  const result = resultFromRow(row, signed, defender ? "defender" : "public");
  return {
    mode: "challenge",
    httpStatus: 200,
    includeReceipt: result.showScore,
    result,
  };
}

/** Funnel count for a published result page. Sharing is not involved. */
export async function recordResultView(receiptId: string, user: User | null): Promise<void> {
  const db = await getDb();
  const row = await db.get<{ id: string; visibility: string | null; claimed_by_user_id: string | null }>(
    `SELECT id, visibility, claimed_by_user_id FROM challenges WHERE receipt_id = ?`,
    [receiptId],
  );
  if (!row) return;
  const visibility = asVisibility(row.visibility);
  if (visibility !== "public" && visibility !== "score_hidden") return;
  if (user && user.id === row.claimed_by_user_id) return;
  await recordEvent(db, row.id, "result_viewed", user?.id ?? null);
}

/** OG copy for a challenge landing card. No document text. */
export async function challengeCardCopy(slug: string): Promise<{
  kicker: string;
  title: string;
  subtitle: string;
  foot: string;
} | null> {
  const view = await getPublicChallenge(slug, null);
  if (!view) return null;
  return {
    kicker: view.sponsorLabel,
    title: view.subject.slice(0, 90),
    subtitle: "Optional. Your own file, a short text interview. You choose whether the result is public.",
    foot:
      view.sponsorLabel === "Sponsored by DefendIT"
        ? "Free in beta, sponsored by DefendIT"
        : "You choose what is public.",
  };
}

/** OG copy for a receipt. Challenge results follow visibility. No document text. */
export async function resultCardCopy(receiptId: string): Promise<{
  kicker: string;
  title: string;
  subtitle: string;
  foot: string;
  score: string | null;
}> {
  const gate = await receiptGate(receiptId, null);
  if (gate.result && gate.result.audience === "public") {
    const show = gate.result.showScore && gate.result.score != null;
    return {
      kicker: gate.result.sponsorLabel,
      title: show ? `Defended · ${gate.result.tier ?? "Defended"}` : "Defended",
      subtitle: show ? gate.result.subject.slice(0, 80) : (gate.result.tier ?? ""),
      foot: show ? "Signed receipt" : "Score not shown",
      score: show ? String(gate.result.score) : null,
    };
  }
  if (gate.mode === "challenge") {
    return { kicker: "Defend It", title: "Defend It", subtitle: "Understanding receipt", foot: "", score: null };
  }
  const db = await getDb();
  const receipt = await db.get<{ payload_json: string }>(`SELECT payload_json FROM receipts WHERE id = ?`, [
    receiptId,
  ]);
  if (!receipt) {
    return { kicker: "Defend It", title: "Understanding receipt", subtitle: "", foot: "", score: null };
  }
  const signed = JSON.parse(receipt.payload_json) as SignedReceipt;
  return {
    kicker: "Understanding receipt",
    title: signed.payload.outcome,
    subtitle: tierForScore(signed.payload.score),
    foot: "Defend It",
    score: String(signed.payload.score),
  };
}

export async function assertChallengeAllowsWork(requestId: string): Promise<void> {
  const db = await getDb();
  await expireDueChallenges(db);
  const row = await db.get<{ status: string }>(`SELECT status FROM challenges WHERE request_id = ?`, [requestId]);
  if (!row) return;
  const status = asStatus(row.status);
  switch (status) {
    case "open":
    case "claimed":
    case "defended":
      return;
    case "expired":
      throw new HttpError(410, "This challenge has expired.");
    case "revoked":
      throw new HttpError(410, "This challenge was revoked.");
    default: {
      const unknown: never = status;
      throw new HttpError(410, `This challenge is closed (${String(unknown)}).`);
    }
  }
}

export async function noteChallengeUpload(requestId: string, deliverableId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE challenges SET deliverable_id = ? WHERE request_id = ? AND deliverable_id IS NULL`,
    [deliverableId, requestId],
  );
}

export async function noteChallengeSession(requestId: string, sessionId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `UPDATE challenges SET session_id = ? WHERE request_id = ? AND status = 'claimed'`,
    [sessionId, requestId],
  );
}

export async function noteChallengeDefended(
  requestId: string,
  ids: { sessionId: string; deliverableId: string; receiptId: string },
): Promise<void> {
  const db = await getDb();
  const row = await db.get<{ id: string; status: string; claimed_by_user_id: string | null }>(
    `SELECT id, status, claimed_by_user_id FROM challenges WHERE request_id = ?`,
    [requestId],
  );
  if (!row) return;
  if (row.status !== "claimed" && row.status !== "defended") return;
  await db.run(
    `UPDATE challenges
     SET status = 'defended', session_id = ?, deliverable_id = ?, receipt_id = ?
     WHERE request_id = ? AND status IN ('claimed', 'defended')`,
    [ids.sessionId, ids.deliverableId, ids.receiptId, requestId],
  );
  if (row.status === "claimed") await recordEvent(db, row.id, "defended", row.claimed_by_user_id);
  // #39 owns the wallet rules. Completing a defense you were challenged into
  // grants one challenge credit, once, whether or not the result is shared.
  if (row.claimed_by_user_id) {
    await grantCredits({
      userId: row.claimed_by_user_id,
      kind: "challenge",
      amount: 1,
      idempotencyKey: `onward-challenge:${row.id}`,
      refId: row.id,
      db,
    });
  }
}

export async function challengeCompletionHint(
  requestId: string,
): Promise<{ slug: string; needsChoice: boolean } | null> {
  const db = await getDb();
  const row = await db.get<{ slug: string; visibility: string | null; status: string }>(
    `SELECT slug, visibility, status FROM challenges WHERE request_id = ?`,
    [requestId],
  );
  if (!row || row.status !== "defended") return null;
  return { slug: row.slug, needsChoice: row.visibility == null };
}

export async function ledgerForSlug(
  slug: string,
): Promise<{ action: string; reason: string | null; amount: number }[]> {
  const db = await getDb();
  const row = await loadBySlug(db, slug);
  if (!row) return [];
  const entries = await db.all<{ reason: string; detail: string | null; amount: number | string }>(
    `SELECT reason, detail, amount FROM credit_ledger WHERE ref_id = ? ORDER BY created_at, id`,
    [row.id],
  );
  return entries.map((entry) => ({
    action: entry.reason,
    reason: entry.detail,
    amount: Number(entry.amount),
  }));
}

export function paidChallengesEnabled(): boolean {
  return billingEnabled();
}
