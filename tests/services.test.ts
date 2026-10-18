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
  reconcileTurns,
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

function answersFor(plan: { probes: { id: string; question: string }[] }): TurnRecord[] {
  return plan.probes.map((p, i) => ({
    id: `t${i}`,
    probeId: p.id,
    question: p.question,
    answer: `Because the unit economics section shows churn near 1.2% and LTV/CAC above 3; if churn doubles the recommendation weakens first. (${i})`,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    latencyMs: 6000 + i * 1700,
    followUpIndex: 0,
  }));
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

    const defend = await startSession({ token: ingest.token, user, mode: "defend" });
    const result = await completeDefendSession({
      sessionId: defend.sessionId,
      user,
      turns: answersFor(defend.plan),
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
      startSession({ token: ingest.token, user, mode: "defend" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      completeDefendSession({ sessionId: defend.sessionId, user, turns: answersFor(defend.plan) }),
    ).rejects.toMatchObject({ status: 409 });

    const dash = await listDashboard(user);
    expect(dash[0].receiptId).toBe(p.id);
  });

  it("leaves the name off the receipt unless the creator opts in", async () => {
    const { user } = await signIn("quiet@fund.example");
    user.display_name = "Quiet Person";
    const ingest = await creatorIngest({ user, fileName: "m.md", buffer: memo });
    const defend = await startSession({ token: ingest.token, user, mode: "defend" });
    const r = await completeDefendSession({
      sessionId: defend.sessionId,
      user,
      turns: answersFor(defend.plan),
    });
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

  it("uses server questions and drops unknown or duplicate probes", () => {
    const base = { startedAt: "", endedAt: "", latencyMs: 5000, followUpIndex: 0 };
    const turns = reconcileTurns(plan, [
      { ...base, id: "a", probeId: "p1", question: "Easy swapped question", answer: "x" },
      { ...base, id: "b", probeId: "p1", question: "dup", answer: "y" },
      { ...base, id: "c", probeId: "zzz", question: "injected", answer: "z" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].question).toBe("Real Q1");
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
    const a = await startSession({ token: ingest.token, user, mode: "defend" });
    const b = await startSession({ token: ingest.token, user, mode: "defend" });
    await completeDefendSession({ sessionId: a.sessionId, user, turns: answersFor(a.plan) });
    await expect(
      completeDefendSession({ sessionId: b.sessionId, user, turns: answersFor(b.plan) }),
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
    const s = await startSession({ token: ingest.token, user, mode: "defend" });
    const results = await Promise.allSettled([
      completeDefendSession({ sessionId: s.sessionId, user, turns: answersFor(s.plan) }),
      completeDefendSession({ sessionId: s.sessionId, user, turns: answersFor(s.plan) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("refuses a re-upload after the deliverable was defended", async () => {
    const { user } = await signIn("swap@fund.example");
    const ingest = await creatorIngest({ user, fileName: "s.md", buffer: memo });
    const s = await startSession({ token: ingest.token, user, mode: "defend" });
    await completeDefendSession({ sessionId: s.sessionId, user, turns: answersFor(s.plan) });
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
    await expect(startSession({ token: ingest.token, user, mode: "defend" })).resolves.toBeDefined();
    expect((await getRequestView(ingest.token, user)).deliverable?.documentAvailable).toBe(false);

    await db.run(`UPDATE deliverables SET purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await expect(startSession({ token: ingest.token, user, mode: "defend" })).rejects.toMatchObject({ status: 410 });
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
    const s = await startSession({ token: ingest.token, user, mode: "defend" });
    const r = await completeDefendSession({ sessionId: s.sessionId, user, turns: answersFor(s.plan) });
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
