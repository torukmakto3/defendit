import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { tierForScore } from "../src/lib/challenge-tier";
import {
  assertChallengeAllowsWork,
  challengeEvents,
  claimChallenge,
  createChallenge,
  chooseVisibility,
  revokeChallenge,
  betaBudgetEur,
  expireDueChallenges,
  getPublicChallenge,
  ledgerForSlug,
  publicResultLines,
  receiptGate,
  recordResultView,
  recordShareClick,
  setOptOut,
} from "../src/lib/challenges";
import { getBalance, grantCredits, holdCredit, refundCredit } from "../src/lib/credits";
import { getDb } from "../src/lib/db";
import { HttpError } from "../src/lib/errors";
import {
  completeDefendSession,
  ingestDeliverable,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";
import { verifySignature } from "../src/lib/crypto";
import type { SignedReceipt } from "../src/lib/types";

const DOC_SECRET = "DOCSECRET_zephyr_8811";
const TRANSCRIPT_SECRET = "TRANSCRIPTSECRET_plover_441";
const SUBJECT = "Public challenge subject about a launch plan";
const doc = Buffer.from(
  `${DOC_SECRET} is the load-bearing retention claim in this memo. Unit economics depend on a 1.2% monthly churn and an LTV/CAC above 3. If churn doubles, the recommendation to proceed weakens first. Market sizing uses a top-down estimate and the plan assumes retention holds. `.repeat(
    4,
  ),
);
const ANSWER = `Because the unit economics section shows churn near 1.2% and LTV/CAC above 3; if churn doubles the recommendation weakens first. ${TRANSCRIPT_SECRET}`;

const ENV_KEYS = [
  "CHALLENGES_ENABLED",
  "BILLING_ENABLED",
  "CHALLENGE_OPEN_PER_CREATOR",
  "CHALLENGE_DAILY_PER_CREATOR",
  "CHALLENGE_OPEN_PER_DEFENDER",
  "CHALLENGE_GLOBAL_DAILY_CAP",
  "BETA_BUDGET_EUR",
  "CHALLENGE_MIN_ACCOUNT_AGE_HOURS",
  "CHALLENGE_CREATE_LIMIT",
  "CHALLENGE_CLAIM_LIMIT",
  "CHALLENGE_CLAIM_IP_LIMIT",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let seq = 0;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-challenges-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
  process.env.CHALLENGES_ENABLED = "1";
  process.env.BILLING_ENABLED = "";
  process.env.CHALLENGE_OPEN_PER_CREATOR = "10";
  process.env.CHALLENGE_DAILY_PER_CREATOR = "10";
  process.env.CHALLENGE_OPEN_PER_DEFENDER = "1";
  process.env.CHALLENGE_GLOBAL_DAILY_CAP = "100";
  process.env.BETA_BUDGET_EUR = "1000";
  process.env.CHALLENGE_MIN_ACCOUNT_AGE_HOURS = "0";
  process.env.CHALLENGE_CREATE_LIMIT = "30";
  process.env.CHALLENGE_CLAIM_LIMIT = "30";
  process.env.CHALLENGE_CLAIM_IP_LIMIT = "50";
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function signIn(email: string): Promise<User> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return res!.user;
}

function nextEmail(label: string): string {
  seq += 1;
  return `${label}-${seq}@challenge.example`;
}

function nextIp(): string {
  seq += 1;
  return `198.51.100.${(seq % 200) + 1}`;
}

async function defend(user: User, token: string) {
  await ingestDeliverable({ token, user, fileName: "memo.md", buffer: doc });
  const session = await startSession({ token, user, mode: "defend" });
  for (const probe of session.plan.probes) {
    await recordDefendAnswer({
      sessionId: session.sessionId,
      user,
      probeId: probe.id,
      answer: ANSWER,
    });
  }
  let result = await completeDefendSession({ sessionId: session.sessionId, user });
  if ("followUp" in result && result.followUp) {
    await recordDefendAnswer({
      sessionId: session.sessionId,
      user,
      probeId: result.followUp.probe.id,
      answer: ANSWER,
    });
    result = await completeDefendSession({ sessionId: session.sessionId, user });
  }
  if (!("receipt" in result)) throw new Error("expected a receipt");
  return result.receipt;
}

describe("result tiers", () => {
  it("maps the receipt score onto Strong, Defended, and Still sharpening", () => {
    expect(tierForScore(85)).toBe("Strong");
    expect(tierForScore(100)).toBe("Strong");
    expect(tierForScore(70)).toBe("Defended");
    expect(tierForScore(84)).toBe("Defended");
    expect(tierForScore(69)).toBe("Still sharpening");
    expect(tierForScore(0)).toBe("Still sharpening");
  });
});

describe("challenge links", () => {
  it("stays off unless CHALLENGES_ENABLED=1", async () => {
    process.env.CHALLENGES_ENABLED = "0";
    const user = await signIn(nextEmail("off"));
    await expect(createChallenge({ user, subject: SUBJECT, difficulty: "standard" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a paid challenge while billing is off and writes no credit", async () => {
    const before = await (await getDb()).get<{ n: number }>(`SELECT COUNT(*) AS n FROM credit_ledger`);
    const user = await signIn(nextEmail("paid-off"));
    await expect(
      createChallenge({ user, subject: SUBJECT, difficulty: "standard", sponsorType: "paid" }),
    ).rejects.toMatchObject({ status: 402 });
    const after = await (await getDb()).get<{ n: number }>(`SELECT COUNT(*) AS n FROM credit_ledger`);
    expect(Number(after?.n)).toBe(Number(before?.n));
    for (const file of ["src/lib/billing.ts", "src/lib/credits.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/from ["']stripe["']/);
      expect(source).not.toMatch(/require\(["']stripe["']\)/);
    }
  });

  it("defaults the beta budget to €150", () => {
    delete process.env.BETA_BUDGET_EUR;
    expect(betaBudgetEur()).toBe(150);
  });

  it("grants once, and a refund returns the held credit", async () => {
    const user = await signIn(nextEmail("wallet"));
    const key = `grant:${user.id}`;
    await grantCredits({ userId: user.id, kind: "challenge", amount: 1, idempotencyKey: key });
    await grantCredits({ userId: user.id, kind: "challenge", amount: 1, idempotencyKey: key });
    expect((await getBalance(user.id)).challenge).toBe(1);

    const refId = `ref-${user.id}`;
    await holdCredit({
      userId: user.id,
      kind: "challenge",
      amount: 1,
      idempotencyKey: `hold:${refId}`,
      refId,
    });
    expect((await getBalance(user.id)).challenge).toBe(0);
    await refundCredit({
      userId: user.id,
      kind: "challenge",
      amount: 1,
      idempotencyKey: `refund:${refId}`,
      refId,
      detail: "revoke",
    });
    await refundCredit({
      userId: user.id,
      kind: "challenge",
      amount: 1,
      idempotencyKey: `refund:${refId}`,
      refId,
      detail: "revoke",
    });
    expect((await getBalance(user.id)).challenge).toBe(1);
    const rows = await (await getDb()).all<{ reason: string; detail: string | null }>(
      `SELECT reason, detail FROM credit_ledger WHERE user_id = ? ORDER BY created_at, id`,
      [user.id],
    );
    expect(rows.map((row) => row.reason).sort()).toEqual(["grant", "hold", "refund"]);
    expect(rows.some((row) => /card/i.test(`${row.reason} ${row.detail ?? ""}`))).toBe(false);
  });

  it("lets the first signed-in adult claim, and tells the next person it is taken", async () => {
    const creator = await signIn(nextEmail("creator"));
    const first = await signIn(nextEmail("first"));
    const second = await signIn(nextEmail("second"));
    const created = await createChallenge({
      user: creator,
      subject: SUBJECT,
      difficulty: "standard",
      targetHint: "@someone",
    });
    const anon = await getPublicChallenge(created.slug, null, { recordView: true });
    expect(anon?.subject).toBe(SUBJECT);
    expect(anon?.sponsorLabel).toBe("Sponsored by DefendIT");
    expect(JSON.stringify(anon)).not.toContain(creator.email);

    await expect(
      claimChallenge({ slug: created.slug, user: first, ip: nextIp(), adultConfirmed: false }),
    ).rejects.toMatchObject({ status: 400 });

    const claimed = await claimChallenge({ slug: created.slug, user: first, ip: nextIp(), adultConfirmed: true });
    expect(claimed.defensePath).toMatch(/^\/d\//);
    const row = await (await getDb()).get<{ adult_confirmed_at: string | null }>(
      `SELECT adult_confirmed_at FROM challenges WHERE slug = ?`,
      [created.slug],
    );
    expect(row?.adult_confirmed_at).toBeTruthy();

    await expect(
      claimChallenge({ slug: created.slug, user: second, ip: nextIp(), adultConfirmed: true }),
    ).rejects.toThrow(/already been claimed/i);
    await expect(
      claimChallenge({ slug: created.slug, user: creator, ip: nextIp(), adultConfirmed: true }),
    ).rejects.toThrow(/you created this challenge/i);
  });

  it("blocks an opted-out handle or email, and blocks that user from claiming", async () => {
    const quiet = await signIn(nextEmail("quiet"));
    await setOptOut(quiet, true, ["Ada"]);
    const creator = await signIn(nextEmail("creator-opt"));
    await expect(
      createChallenge({ user: creator, subject: SUBJECT, difficulty: "standard", targetHint: "@ada" }),
    ).rejects.toThrow(/opted out/i);
    await expect(
      createChallenge({
        user: creator,
        subject: SUBJECT,
        difficulty: "standard",
        targetHint: quiet.email.toUpperCase(),
      }),
    ).rejects.toThrow(/opted out/i);

    const open = await createChallenge({ user: creator, subject: "Open to anyone else", difficulty: "standard" });
    await expect(
      claimChallenge({ slug: open.slug, user: quiet, ip: nextIp(), adultConfirmed: true }),
    ).rejects.toThrow(/opted out/i);
  });

  it("enforces open, daily, global, budget, defender, handle, and rate limits", async () => {
    const creator = await signIn(nextEmail("caps"));
    process.env.CHALLENGE_OPEN_PER_CREATOR = "1";
    const first = await createChallenge({ user: creator, subject: "First open", difficulty: "standard" });
    await expect(
      createChallenge({ user: creator, subject: "Second open", difficulty: "standard" }),
    ).rejects.toThrow(/maximum number of open/i);
    await revokeChallenge(first.slug, creator);
    await createChallenge({ user: creator, subject: "After revoke", difficulty: "standard" });

    process.env.CHALLENGE_OPEN_PER_CREATOR = "10";
    process.env.CHALLENGE_DAILY_PER_CREATOR = "1";
    const dailyUser = await signIn(nextEmail("daily"));
    await createChallenge({ user: dailyUser, subject: "Daily one", difficulty: "standard" });
    await expect(
      createChallenge({ user: dailyUser, subject: "Daily two", difficulty: "standard" }),
    ).rejects.toThrow(/today's challenge limit/i);

    const db = await getDb();
    const existing = await db.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM challenges WHERE sponsor_type = 'beta' AND created_at > ?`,
      [new Date(Date.now() - 24 * 3600_000).toISOString()],
    );
    process.env.CHALLENGE_DAILY_PER_CREATOR = "10";
    process.env.CHALLENGE_GLOBAL_DAILY_CAP = String(Number(existing?.n ?? 0));
    const globalUser = await signIn(nextEmail("global"));
    await expect(
      createChallenge({ user: globalUser, subject: "Over the global cap", difficulty: "standard" }),
    ).rejects.toThrow(/daily challenge limit/i);

    process.env.CHALLENGE_GLOBAL_DAILY_CAP = "100";
    process.env.BETA_BUDGET_EUR = "0";
    const budgetUser = await signIn(nextEmail("budget"));
    await expect(
      createChallenge({ user: budgetUser, subject: "Over budget", difficulty: "standard" }),
    ).rejects.toThrow(/budget/i);

    process.env.BETA_BUDGET_EUR = "1000";
    const challenger = await signIn(nextEmail("two-links"));
    const a = await createChallenge({ user: challenger, subject: "Slot A", difficulty: "standard" });
    const b = await createChallenge({ user: challenger, subject: "Slot B", difficulty: "standard" });
    const defender = await signIn(nextEmail("one-defense"));
    await claimChallenge({ slug: a.slug, user: defender, ip: nextIp(), adultConfirmed: true });
    await expect(
      claimChallenge({ slug: b.slug, user: defender, ip: nextIp(), adultConfirmed: true }),
    ).rejects.toThrow(/finish your current challenge/i);

    const repeat = await signIn(nextEmail("repeat"));
    const handle = `person${seq}`;
    await createChallenge({ user: repeat, subject: "Same person", difficulty: "standard", targetHint: `@${handle}` });
    await expect(
      createChallenge({ user: repeat, subject: "Same person again", difficulty: "standard", targetHint: handle }),
    ).rejects.toThrow(/already challenged this person/i);

    process.env.CHALLENGE_CREATE_LIMIT = "1";
    const rushed = await signIn(nextEmail("rushed"));
    await createChallenge({ user: rushed, subject: "Rate one", difficulty: "standard" });
    await expect(createChallenge({ user: rushed, subject: "Rate two", difficulty: "standard" })).rejects.toMatchObject({
      status: 429,
    });

    process.env.CHALLENGE_CLAIM_IP_LIMIT = "1";
    const ip = nextIp();
    const left = await signIn(nextEmail("ip-a"));
    const right = await signIn(nextEmail("ip-b"));
    const claimerA = await signIn(nextEmail("ip-c1"));
    const claimerB = await signIn(nextEmail("ip-c2"));
    const linkA = await createChallenge({ user: left, subject: "IP A", difficulty: "standard" });
    const linkB = await createChallenge({ user: right, subject: "IP B", difficulty: "standard" });
    await claimChallenge({ slug: linkA.slug, user: claimerA, ip, adultConfirmed: true });
    await expect(claimChallenge({ slug: linkB.slug, user: claimerB, ip, adultConfirmed: true })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("shows expired and revoked states and refunds a held paid credit", async () => {
    process.env.BILLING_ENABLED = "1";
    const creator = await signIn(nextEmail("life"));
    const expired = await createChallenge({
      user: creator,
      subject: "Will expire",
      difficulty: "standard",
      sponsorType: "paid",
    });
    const revoked = await createChallenge({
      user: creator,
      subject: "Will revoke",
      difficulty: "standard",
      sponsorType: "paid",
    });
    const db = await getDb();
    await db.run(`UPDATE challenges SET expires_at = ? WHERE slug = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      expired.slug,
    ]);
    expect((await getPublicChallenge(expired.slug, null))?.status).toBe("expired");
    const claimer = await signIn(nextEmail("late"));
    await expect(
      claimChallenge({ slug: expired.slug, user: claimer, ip: nextIp(), adultConfirmed: true }),
    ).rejects.toThrow(/expired/i);
    const expiredLedger = await ledgerForSlug(expired.slug);
    expect(expiredLedger.map((row) => row.action).sort()).toEqual(["hold", "refund"]);
    expect(expiredLedger.some((row) => row.reason === "expiry")).toBe(true);
    expect(expiredLedger.reduce((sum, row) => sum + row.amount, 0)).toBe(0);

    await revokeChallenge(revoked.slug, creator);
    expect((await getPublicChallenge(revoked.slug, null))?.status).toBe("revoked");
    expect((await ledgerForSlug(revoked.slug)).some((row) => row.reason === "revoke")).toBe(true);
    expect((await getBalance(creator.id)).challenge).toBe(0);
    await expect(
      claimChallenge({ slug: revoked.slug, user: claimer, ip: nextIp(), adultConfirmed: true }),
    ).rejects.toThrow(/revoked/i);
  });

  it("publishes a score, a tier without a number, or nothing, and never the document", async () => {
    const published = await run(SUBJECT, "public", "beta");
    const gate = await receiptGate(published.receipt.payload.id, null);
    expect(gate.httpStatus).toBe(200);
    expect(gate.result?.showScore).toBe(true);
    expect(gate.result?.score).toBe(published.receipt.payload.score);
    expect(gate.result?.tier).toBe(tierForScore(published.receipt.payload.score));
    expect(gate.result?.verifyPath).toBe(`/verify/${published.receipt.payload.id}`);
    expect(verifySignature(published.receipt.payload, published.receipt.signature, published.receipt.publicKey)).toBe(
      true,
    );
    const surface = JSON.stringify({ lines: publicResultLines(gate.result!), result: gate.result });
    expect(surface).not.toContain(DOC_SECRET);
    expect(surface).not.toContain(TRANSCRIPT_SECRET);
    expect(surface).not.toContain(published.creator.email);
    expect(surface).not.toContain(published.defender.email);
    const payload = JSON.stringify(published.receipt.payload);
    expect(payload).not.toContain(DOC_SECRET);
    expect(payload).not.toContain(TRANSCRIPT_SECRET);

    const hidden = await run("Hidden tier subject", "score_hidden", "paid");
    const hiddenGate = await receiptGate(hidden.receipt.payload.id, null);
    expect(hiddenGate.includeReceipt).toBe(false);
    expect(hiddenGate.result?.showScore).toBe(false);
    expect(hiddenGate.result?.score).toBeNull();
    expect(hiddenGate.result?.verifyPath).toBeNull();
    expect(hiddenGate.result?.headline).toBe("Defended");
    expect(hiddenGate.result?.tier).toBeTruthy();
    const hiddenJson = JSON.stringify(hiddenGate.result);
    expect(hiddenJson).not.toContain(DOC_SECRET);
    expect(hiddenJson).not.toContain(TRANSCRIPT_SECRET);
    expect(hiddenJson).not.toContain(`"score":${hidden.receipt.payload.score}`);
    const ledger = await ledgerForSlug(hidden.created.slug);
    expect(ledger.map((row) => row.action).sort()).toEqual(["consume", "grant", "hold"]);
    expect((await getBalance(hidden.defender.id)).challenge).toBe(1);
    expect((await getBalance(hidden.creator.id)).challenge).toBe(-1);

    const kept = await run("Private subject line", "private", "paid");
    const privateGate = await receiptGate(kept.receipt.payload.id, null);
    expect(privateGate.httpStatus).toBe(404);
    expect(privateGate.result).toBeNull();
    const anon = await getPublicChallenge(kept.created.slug, null);
    expect(anon?.creatorPrivateNote).toBeNull();
    expect(anon?.resultPath).toBeNull();
    expect(JSON.stringify(anon)).not.toContain(DOC_SECRET);
    expect(JSON.stringify(anon)).not.toContain(TRANSCRIPT_SECRET);
    expect(JSON.stringify(anon).toLowerCase()).not.toContain("declin");
    const creatorView = await getPublicChallenge(kept.created.slug, kept.creator);
    expect(creatorView?.creatorPrivateNote).toMatch(/private/i);
    const defenderGate = await receiptGate(kept.receipt.payload.id, kept.defender);
    expect(defenderGate.includeReceipt).toBe(true);
    expect((await ledgerForSlug(kept.created.slug)).some((row) => row.reason === "decline")).toBe(true);
    expect((await getBalance(kept.creator.id)).challenge).toBe(0);
    expect((await getBalance(kept.defender.id)).challenge).toBe(1);

    const names = (await challengeEvents(published.created.slug)).map((row) => row.event);
    expect(names).toEqual(expect.arrayContaining(["created", "viewed", "accepted", "defended", "published"]));
    expect(names).not.toContain("share_clicked");
    await recordShareClick(published.created.slug, null, "copy");
    await recordResultView(published.receipt.payload.id, null);
    const after = (await challengeEvents(published.created.slug)).map((row) => row.event);
    expect(after).toEqual(expect.arrayContaining(["share_clicked", "result_viewed"]));
    expect(await ledgerForSlug(published.created.slug)).toEqual([{ action: "grant", reason: null, amount: 1 }]);
    expect((await getBalance(published.defender.id)).challenge).toBe(1);
  }, 60_000);

  it("closes the defense window after the finish deadline", async () => {
    const creator = await signIn(nextEmail("window"));
    const defender = await signIn(nextEmail("window-d"));
    const created = await createChallenge({ user: creator, subject: SUBJECT, difficulty: "standard" });
    const claimed = await claimChallenge({
      slug: created.slug,
      user: defender,
      ip: nextIp(),
      adultConfirmed: true,
    });
    const db = await getDb();
    await db.run(`UPDATE challenges SET finish_by = ? WHERE slug = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      created.slug,
    ]);
    const row = await db.get<{ request_id: string }>(`SELECT request_id FROM challenges WHERE slug = ?`, [
      created.slug,
    ]);
    await expect(assertChallengeAllowsWork(row!.request_id)).rejects.toBeInstanceOf(HttpError);
    await expect(
      ingestDeliverable({ token: claimed.token, user: defender, fileName: "memo.md", buffer: doc }),
    ).rejects.toThrow(/expired/i);
    await expireDueChallenges();
  });
});

async function run(
  subject: string,
  visibility: "public" | "score_hidden" | "private",
  sponsorType: "beta" | "paid",
) {
  if (sponsorType === "paid") process.env.BILLING_ENABLED = "1";
  const creator = await signIn(nextEmail("run-c"));
  const defender = await signIn(nextEmail("run-d"));
  const created = await createChallenge({ user: creator, subject, difficulty: "standard", sponsorType });
  const claimed = await claimChallenge({ slug: created.slug, user: defender, ip: nextIp(), adultConfirmed: true });
  await getPublicChallenge(created.slug, null, { recordView: true });
  const receipt = await defend(defender, claimed.token);
  await chooseVisibility({ slug: created.slug, user: defender, visibility });
  return { created, creator, defender, receipt: receipt as SignedReceipt };
}
