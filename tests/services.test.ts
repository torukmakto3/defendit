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
