import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  consumeMagicLink,
  getUserFromRequest,
  requestMagicLink,
  type User,
} from "../src/lib/auth";
import { sha256Hex, verifySignature } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";
import { rateLimit } from "../src/lib/ratelimit";
import {
  completeDefendSession,
  createDefenseRequest,
  creatorIngest,
  getAdminSessionDetail,
  getReceipt,
  getRequestView,
  ingestDeliverable,
  learnCoachTurn,
  listDashboard,
  publicProbes,
  purgeExpired,
  recordDefendAnswer,
  recordVoiceAnswer,
  voicePlan,
  startSession,
} from "../src/lib/services";
import type { InterviewPlan, TurnRecord } from "../src/lib/types";


const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-test-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "33".repeat(32);
  delete process.env.DATABASE_URL;
});

async function signIn(email: string): Promise<{ user: User; cookie: string }> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
}

/** Answer every probe through the server, in plan order (idempotent across racing callers). */
async function answerAll(session: { sessionId: string; plan: { probes: { id: string }[] } }, user: User) {
  for (const [i, p] of session.plan.probes.entries()) {
    try {
      await recordDefendAnswer({
        sessionId: session.sessionId,
        user,
        probeId: p.id,
        answer: `Because the unit economics section shows churn near 1.2% and LTV/CAC above 3; if churn doubles the recommendation weakens first. (${i})`,
      });
    } catch (e) {
      if ((e as { status?: number }).status !== 409) throw e;
    }
  }
}

describe("magic-link auth", () => {
  it("creates a session from a one-time link", async () => {
    const { user, cookie } = await signIn("Ana@Fund.Example");
    expect(user.email).toBe("ana@fund.example");
    const req = new Request("http://x/", { headers: { cookie } });
    expect((await getUserFromRequest(req))?.id).toBe(user.id);
  });

  it("refuses to reuse a link", async () => {
    const { devLink } = await requestMagicLink({ email: "reuse@x.example" });
    const token = devLink!.split("#token=")[1];
    expect(await consumeMagicLink(token)).not.toBeNull();
    expect(await consumeMagicLink(token)).toBeNull();
  });

  it("refuses an expired link", async () => {
    const { devLink } = await requestMagicLink({ email: "late@x.example" });
    const token = devLink!.split("#token=")[1];
    const db = await getDb();
    await db.run(`UPDATE login_tokens SET expires_at = ? WHERE token_hash = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      sha256Hex(token),
    ]);
    expect(await consumeMagicLink(token)).toBeNull();
  });

  it("rejects a forged session cookie", async () => {
    const req = new Request("http://x/", { headers: { cookie: "di_session=forged" } });
    expect(await getUserFromRequest(req)).toBeNull();
  });
});

describe("creator flow: process and purge", () => {
  it("issues a minimal signed receipt and purges the document text", async () => {
    const { user } = await signIn("creator@fund.example");
    const db = await getDb();
    await db.run(`UPDATE users SET display_name = 'Ana Analyst' WHERE id = ?`, [user.id]);
    user.display_name = "Ana Analyst";

    const ingest = await creatorIngest({ user, fileName: "Project-North-LOI.md", buffer: memo });
    expect(ingest.sha256).toBe(sha256Hex(memo));

    // Nothing readable at rest.
    const row = await db.get<Record<string, unknown>>(
      `SELECT * FROM deliverables WHERE id = ?`,
      [ingest.deliverableId],
    );
    const rowText = JSON.stringify(row);
    expect(rowText).not.toContain("Series B");
    expect(rowText).not.toContain("Project-North");

    const learn = await startSession({ token: ingest.token, user, mode: "learn" });
    const turn = await learnCoachTurn({ sessionId: learn.sessionId, user });
    expect(turn.coachMessage.length).toBeGreaterThan(0);

    const defend = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    await answerAll(defend, user);
    const result = await completeDefendSession({
      sessionId: defend.sessionId,
      user,
      showName: true,
    });

    const p = result.receipt.payload;
    expect(p.version).toBe("defend-it-receipt-v2");
    expect(p.deliverable.sha256).toBe(sha256Hex(memo));
    expect(p.creator?.displayName).toBe("Ana Analyst");
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain("creator@fund.example");
    expect(serialized).not.toContain("Project-North");
    expect(serialized).not.toContain("churn");
    expect(verifySignature(p, result.receipt.signature, result.receipt.publicKey)).toBe(true);
    expect((await getReceipt(p.id))?.payload.id).toBe(p.id);

    const after = await db.get<{ text_enc: string | null; claims_enc: string | null }>(
      `SELECT text_enc, claims_enc FROM deliverables WHERE id = ?`,
      [ingest.deliverableId],
    );
    expect(after?.text_enc).toBeNull();
    expect(after?.claims_enc).not.toBeNull();

    await expect(
      startSession({ token: ingest.token, user, mode: "learn" }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      startSession({ token: ingest.token, user, mode: "defend", accommodation: true }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      completeDefendSession({ sessionId: defend.sessionId, user }),
    ).rejects.toMatchObject({ status: 409 });

    const dash = await listDashboard(user);
    expect(dash[0].receiptId).toBe(p.id);
  });

  it("leaves the name off the receipt unless the creator opts in", async () => {
    const { user } = await signIn("quiet@fund.example");
    user.display_name = "Quiet Person";
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo });
    const defend = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    await answerAll(defend, user);
    const r = await completeDefendSession({ sessionId: defend.sessionId, user });
    expect(r.receipt.payload.creator).toBeUndefined();
  });

  it("purges claims, transcripts and file names after the retention window", async () => {
    const { user } = await signIn("ttl@fund.example");
    const ingest = await creatorIngest({ user, fileName: "ttl.md", buffer: memo });
    const db = await getDb();
    const past = new Date(Date.now() - 1000).toISOString();
    await db.run(`UPDATE deliverables SET purge_after = ? WHERE id = ?`, [past, ingest.deliverableId]);
    await purgeExpired();
    const row = await db.get<Record<string, string | null>>(
      `SELECT file_name_enc, text_enc, claims_enc, purged_at FROM deliverables WHERE id = ?`,
      [ingest.deliverableId],
    );
    expect(row).toMatchObject({ file_name_enc: null, text_enc: null, claims_enc: null });
    expect(row?.purged_at).not.toBeNull();
  });
});

describe("access control", () => {
  it("blocks another account from a creator's defense", async () => {
    const { user: owner } = await signIn("owner@fund.example");
    const { user: intruder } = await signIn("intruder@evil.example");
    const ingest = await creatorIngest({ user: owner, fileName: "o.md", buffer: memo });

    await expect(
      startSession({ token: ingest.token, user: intruder, mode: "learn" }),
    ).rejects.toMatchObject({ status: 403 });
    const view = await getRequestView(ingest.token, intruder);
    expect(view.deliverable).toBeNull();

    const learn = await startSession({ token: ingest.token, user: owner, mode: "learn" });
    await expect(
      learnCoachTurn({ sessionId: learn.sessionId, user: intruder }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lets the first uploader claim a receiver link, then locks it", async () => {
    const { user: receiver } = await signIn("partner@fund.example");
    const { user: creator } = await signIn("associate@fund.example");
    const { user: other } = await signIn("other@fund.example");
    const req = await createDefenseRequest({
      owner: receiver,
      kind: "receiver",
      difficulty: "standard",
      title: "Q3 memo",
    });

    await ingestDeliverable({ token: req.token, user: creator, fileName: "q3.md", buffer: memo });
    await expect(
      ingestDeliverable({ token: req.token, user: other, fileName: "x.md", buffer: memo }),
    ).rejects.toMatchObject({ status: 403 });

    const receiverView = await getRequestView(req.token, receiver);
    expect(receiverView.isOwner).toBe(true);
    expect(receiverView.deliverable?.sha256).toBe(sha256Hex(memo));
    expect((await listDashboard(receiver))[0].role).toBe("receiver");
  });
});

describe("interview integrity", () => {
  const plan: InterviewPlan = {
    seed: "s",
    difficulty: "hard",
    probes: [
      { id: "p1", claimId: "c1", type: "explain_back", question: "Real Q1", expectedFocus: "secret focus" },
      { id: "p2", claimId: "c2", type: "counterfactual", question: "Real Q2", expectedFocus: "secret 2" },
    ],
  };

  it("hides expected answers from the client", () => {
    expect(JSON.stringify(publicProbes(plan))).not.toContain("secret");
  });

  it("records answers only in plan order, with server-side timing", async () => {
    const { user } = await signIn("order@fund.example");
    const ingest = await creatorIngest({ user, fileName: "o.md", buffer: memo });
    const s1 = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    const [first, second] = s1.plan.probes;
    await expect(
      recordDefendAnswer({ sessionId: s1.sessionId, user, probeId: second.id, answer: "skip ahead" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      recordDefendAnswer({ sessionId: s1.sessionId, user, probeId: first.id, answer: "   " }),
    ).rejects.toMatchObject({ status: 400 });
    const r = await recordDefendAnswer({ sessionId: s1.sessionId, user, probeId: first.id, answer: "first" });
    expect(r).toMatchObject({ answered: 1, done: false });
    await expect(
      recordDefendAnswer({ sessionId: s1.sessionId, user, probeId: first.id, answer: "again" }),
    ).rejects.toMatchObject({ status: 409 });

    const db = await getDb();
    const row = await db.get<{ transcript_enc: string }>(`SELECT transcript_enc FROM sessions WHERE id = ?`, [
      s1.sessionId,
    ]);
    const { decryptJson } = await import("../src/lib/vault");
    const turns = decryptJson<TurnRecord[]>(row!.transcript_enc, `sessions.transcript:${s1.sessionId}`)!;
    expect(turns[0].question).toBe(first.question);
    expect(turns[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(turns[0].latencyMs).toBeLessThan(60_000);
  });

  it("refuses to grade a defense with no recorded answers", async () => {
    const { user } = await signIn("empty@fund.example");
    const ingest = await creatorIngest({ user, fileName: "e.md", buffer: memo });
    const s1 = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    await expect(completeDefendSession({ sessionId: s1.sessionId, user })).rejects.toMatchObject({ status: 400 });
  });
});

describe("rate limiting", () => {
  it("blocks after the limit within a window", async () => {
    const key = `test:${Math.random()}`;
    expect((await rateLimit(key, 2, 60)).ok).toBe(true);
    expect((await rateLimit(key, 2, 60)).ok).toBe(true);
    const third = await rateLimit(key, 2, 60);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("one receipt per deliverable", () => {
  it("refuses a second receipt from a parallel Defend session", async () => {
    const { user } = await signIn("bestofn@fund.example");
    const ingest = await creatorIngest({ user, fileName: "n.md", buffer: memo });
    const a = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    const b = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    await answerAll(a, user).then(() => completeDefendSession({ sessionId: a.sessionId, user }));
    await expect(
      answerAll(b, user).then(() => completeDefendSession({ sessionId: b.sessionId, user })),
    ).rejects.toMatchObject({ status: 409 });
    const db = await getDb();
    const n = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM receipts r JOIN defense_requests q ON q.id = r.request_id WHERE q.token = ?`,
      [ingest.token],
    );
    expect(Number(n?.n)).toBe(1);
  });

  it("grades a double-submitted session once", async () => {
    const { user } = await signIn("double@fund.example");
    const ingest = await creatorIngest({ user, fileName: "d.md", buffer: memo });
    const s = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    const results = await Promise.allSettled([
      answerAll(s, user).then(() => completeDefendSession({ sessionId: s.sessionId, user })),
      answerAll(s, user).then(() => completeDefendSession({ sessionId: s.sessionId, user })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("refuses a re-upload after the deliverable was defended", async () => {
    const { user } = await signIn("swap@fund.example");
    const ingest = await creatorIngest({ user, fileName: "s.md", buffer: memo });
    const s = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    await answerAll(s, user).then(() => completeDefendSession({ sessionId: s.sessionId, user }));
    await expect(
      ingestDeliverable({ token: ingest.token, user, fileName: "other.md", buffer: Buffer.from(`${memo}\nedited`) }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("no plaintext leftovers", () => {
  it("never stores the file name as the request title", async () => {
    const { user } = await signIn("title@fund.example");
    const ingest = await creatorIngest({ user, fileName: "Project-Falcon-LOI.md", buffer: memo });
    const db = await getDb();
    const row = await db.get<{ title: string }>(`SELECT title FROM defense_requests WHERE token = ?`, [ingest.token]);
    expect(row?.title).not.toContain("Falcon");
    expect((await getRequestView(ingest.token, user)).title).toBe("Project-Falcon-LOI");
    const dash = await listDashboard(user);
    expect(dash.find((r) => r.token === ingest.token)?.title).toBe("Project-Falcon-LOI");
  });

  it("leaves no request behind when a file can't be parsed", async () => {
    const { user } = await signIn("orphan@fund.example");
    const db = await getDb();
    const before = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM defense_requests`);
    await expect(
      creatorIngest({ user, fileName: "tiny.txt", buffer: Buffer.from("too short") }),
    ).rejects.toMatchObject({ status: 400 });
    const after = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM defense_requests`);
    expect(Number(after?.n)).toBe(Number(before?.n));
  });
});

describe("expiry without the purge job", () => {
  it("treats expired document text as deleted even before purge runs", async () => {
    const { user } = await signIn("lazy@fund.example");
    const ingest = await creatorIngest({ user, fileName: "l.md", buffer: memo });
    const db = await getDb();
    await db.run(`UPDATE deliverables SET text_purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await expect(startSession({ token: ingest.token, user, mode: "learn" })).rejects.toMatchObject({ status: 410 });
    // Claims are still within retention, so a defense can still start.
    await expect(startSession({ token: ingest.token, user, mode: "defend", accommodation: true })).resolves.toBeDefined();
    expect((await getRequestView(ingest.token, user)).deliverable?.documentAvailable).toBe(false);

    await db.run(`UPDATE deliverables SET purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await expect(startSession({ token: ingest.token, user, mode: "defend", accommodation: true })).rejects.toMatchObject({ status: 410 });
  });

  it("purges only document text when the text TTL passes", async () => {
    const { user } = await signIn("textttl@fund.example");
    const ingest = await creatorIngest({ user, fileName: "t.md", buffer: memo });
    const db = await getDb();
    await db.run(`UPDATE deliverables SET text_purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await purgeExpired();
    const row = await db.get<Record<string, string | null>>(
      `SELECT text_enc, claims_enc, file_name_enc, purged_at FROM deliverables WHERE id = ?`,
      [ingest.deliverableId],
    );
    expect(row?.text_enc).toBeNull();
    expect(row?.claims_enc).not.toBeNull();
    expect(row?.file_name_enc).not.toBeNull();
    expect(row?.purged_at).toBeNull();
  });

  it("purges transcripts and grades after the retention window", async () => {
    const { user } = await signIn("sessttl@fund.example");
    const ingest = await creatorIngest({ user, fileName: "st.md", buffer: memo });
    const s = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    const r = await answerAll(s, user).then(() => completeDefendSession({ sessionId: s.sessionId, user }));
    const db = await getDb();
    await db.run(`UPDATE sessions SET purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      s.sessionId,
    ]);
    await purgeExpired();
    const detail = await getAdminSessionDetail(s.sessionId);
    expect(detail?.session.purged).toBe(true);
    expect(detail?.grades).toHaveLength(0);
    expect((await getReceipt(r.receipt.payload.id))?.payload.id).toBe(r.receipt.payload.id);
  });
});

describe("receiver links", () => {
  it("stops the requester from claiming their own link", async () => {
    const { user: receiver } = await signIn("selfclaim@fund.example");
    const req = await createDefenseRequest({
      owner: receiver,
      kind: "receiver",
      difficulty: "standard",
      title: "Self",
    });
    expect((await getRequestView(req.token, receiver)).canClaim).toBe(false);
    await expect(
      ingestDeliverable({ token: req.token, user: receiver, fileName: "x.md", buffer: memo }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("receipt claim metrics", () => {
  it("signs anonymous per-claim scores and shows labels only to the creator", async () => {
    const { receiptClaimLabels } = await import("../src/lib/services");
    const { user } = await signIn("metrics@fund.example");
    const { user: other } = await signIn("metrics-other@fund.example");
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo });
    const s = await startSession({ token: ingest.token, user, mode: "defend", accommodation: true });
    await answerAll(s, user);
    const r = await completeDefendSession({ sessionId: s.sessionId, user });
    const scores = r.receipt.payload.claimScores!;
    expect(scores.length).toBe(new Set(s.plan.probes.map((p) => p.claimId)).size);
    expect(scores.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)).toBe(true);
    expect(verifySignature(r.receipt.payload, r.receipt.signature, r.receipt.publicKey)).toBe(true);

    const labels = await receiptClaimLabels(r.receipt.payload.id, user);
    expect(labels).toHaveLength(scores.length);
    expect(await receiptClaimLabels(r.receipt.payload.id, other)).toBeNull();
  });
});

describe("voice interviews", () => {
  it("requires voice for Hard, refuses typed answers, and records the agent's timed answers", async () => {
    const { user } = await signIn("voice@fund.example");
    const ingest = await creatorIngest({ user, fileName: "v.md", buffer: memo, difficulty: "hard" });
    const s = await startSession({ token: ingest.token, user, mode: "defend" });
    expect(s.channel).toBe("voice");
    await expect(
      recordDefendAnswer({ sessionId: s.sessionId, user, probeId: s.plan.probes[0].id, answer: "typed" }),
    ).rejects.toMatchObject({ status: 409 });

    const plan = await voicePlan(s.sessionId);
    expect(plan.probes[0].question).toBe(s.plan.probes[0].question);
    expect(JSON.stringify(plan)).not.toContain("expectedFocus");

    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    await expect(
      recordVoiceAnswer({ sessionId: s.sessionId, probeId: plan.probes[0].id, answer: "x", questionEndedAt: iso(now - 864e5), answerStartedAt: iso(now - 1000), answerEndedAt: iso(now) }),
    ).rejects.toMatchObject({ status: 400 });
    for (const [i, p] of plan.probes.entries()) {
      const t = Date.now();
      await recordVoiceAnswer({
        sessionId: s.sessionId,
        probeId: p.id,
        answer: `Spoken answer ${i}: churn near 1.2% and payback of 11 months carry the case.`,
        questionEndedAt: iso(t - 900),
        answerStartedAt: iso(t - 650),
        answerEndedAt: iso(t - 50),
      });
    }
    const r = await completeDefendSession({ sessionId: s.sessionId, user });
    expect(r.receipt.payload.interviewMode).toBe("voice");
  });

  it("marks a typed Hard defense as an accommodation, and keeps Standard typed", async () => {
    const { user } = await signIn("accommodation@fund.example");
    const hard = await creatorIngest({ user, fileName: "a.md", buffer: memo, difficulty: "hard" });
    const s = await startSession({ token: hard.token, user, mode: "defend", accommodation: true });
    expect(s.channel).toBe("text_accommodation");
    await answerAll(s, user);
    expect((await completeDefendSession({ sessionId: s.sessionId, user })).receipt.payload.interviewMode).toBe("text-accommodation");

    const std = await creatorIngest({ user, fileName: "b.md", buffer: memo, difficulty: "standard" });
    expect((await startSession({ token: std.token, user, mode: "defend" })).channel).toBe("text");
  });
});

describe("voice answer timing", () => {
  it("accepts an answer that starts before the examiner finishes (barge-in)", async () => {
    const { user } = await signIn("bargein@fund.example");
    const ingest = await creatorIngest({ user, fileName: "bi.md", buffer: memo, difficulty: "hard" });
    const s = await startSession({ token: ingest.token, user, mode: "defend" });
    const plan = await voicePlan(s.sessionId);
    const t = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    // Started talking 3 s before the question audio ended; a stale start from a retry is also earlier.
    await expect(
      recordVoiceAnswer({ sessionId: s.sessionId, probeId: plan.probes[0].id, answer: "Ring-fencing in the SPV documents decides who is affected.", questionEndedAt: iso(t - 500), answerStartedAt: iso(t - 3500), answerEndedAt: iso(t - 10) }),
    ).resolves.toMatchObject({ answered: 1 });
    // Still refuses times outside the session.
    await expect(
      recordVoiceAnswer({ sessionId: s.sessionId, probeId: plan.probes[1].id, answer: "x", questionEndedAt: iso(t - 864e5), answerStartedAt: iso(t - 864e5), answerEndedAt: iso(t) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
