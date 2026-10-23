import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as joinWaitlist } from "../src/app/api/founding/waitlist/route";
import { GET as readFeedback, POST as writeFeedback } from "../src/app/api/receipts/[id]/feedback/route";
import { GET as statsRoute } from "../src/app/api/stats/route";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { newId } from "../src/lib/ids";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-feedback-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
  process.env.STATS_TOKEN = "stats-secret";
  process.env.IP_HASH_SALT = "ip-salt";
  delete process.env.DATABASE_URL;
});

async function signIn(email: string): Promise<{ user: User; cookie: string }> {
  const { devLink } = await requestMagicLink({ email });
  const token = devLink!.split("#token=")[1];
  const res = await consumeMagicLink(token);
  return { user: res!.user, cookie: `di_session=${res!.sessionToken}` };
}

async function insertReceipt(userId: string, status = "completed"): Promise<string> {
  const db = await getDb();
  const now = new Date().toISOString();
  const requestId = newId("req");
  const deliverableId = newId("del");
  const sessionId = newId("ses");
  const receiptId = newId("rcpt");
  await db.run(
    `INSERT INTO defense_requests
      (id, token, owner_user_id, creator_user_id, kind, difficulty, title, status, created_at)
     VALUES (?, ?, ?, ?, 'upload', 'standard', 'Memo', 'ready', ?)`,
    [requestId, newId("tok"), userId, userId, now],
  );
  await db.run(
    `INSERT INTO deliverables
      (id, request_id, owner_user_id, mime_type, byte_length, sha256, claim_count, purge_after, created_at)
     VALUES (?, ?, ?, 'text/markdown', 12, 'abc', 1, ?, ?)`,
    [deliverableId, requestId, userId, now, now],
  );
  await db.run(
    `INSERT INTO sessions
      (id, request_id, deliverable_id, user_id, mode, seed, status, started_at, completed_at, purge_after, channel)
     VALUES (?, ?, ?, ?, 'defend', 'seed', ?, ?, ?, ?, 'text')`,
    [sessionId, requestId, deliverableId, userId, status, now, status === "completed" ? now : null, now],
  );
  await db.run(
    `INSERT INTO receipts (id, session_id, request_id, payload_json, signature, public_key, created_at)
     VALUES (?, ?, ?, '{}', 'sig', 'pk', ?)`,
    [receiptId, sessionId, requestId, now],
  );
  return receiptId;
}

describe("defense feedback", () => {
  it("lets the defender rate once and keeps the comment off a public response", async () => {
    const owner = await signIn("rater@fund.example");
    const other = await signIn("other@fund.example");
    const receiptId = await insertReceipt(owner.user.id);
    const anon = await readFeedback(new Request(`http://localhost/api/receipts/${receiptId}/feedback`), {
      params: Promise.resolve({ id: receiptId }),
    });
    expect(await anon.json()).toEqual({ canSubmit: false, rating: null, comment: null });

    const denied = await writeFeedback(
      new Request(`http://localhost/api/receipts/${receiptId}/feedback`, {
        method: "POST",
        headers: { cookie: other.cookie, "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ rating: 4, comment: "not mine" }),
      }),
      { params: Promise.resolve({ id: receiptId }) },
    );
    expect(denied.status).toBe(403);

    const saved = await writeFeedback(
      new Request(`http://localhost/api/receipts/${receiptId}/feedback`, {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ rating: 5, comment: "Clear questions." }),
      }),
      { params: Promise.resolve({ id: receiptId }) },
    );
    expect(saved.status).toBe(200);
    const again = await writeFeedback(
      new Request(`http://localhost/api/receipts/${receiptId}/feedback`, {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ rating: 4, comment: "Updated." }),
      }),
      { params: Promise.resolve({ id: receiptId }) },
    );
    expect(again.status).toBe(200);
    const mine = await readFeedback(
      new Request(`http://localhost/api/receipts/${receiptId}/feedback`, { headers: { cookie: owner.cookie } }),
      { params: Promise.resolve({ id: receiptId }) },
    );
    expect(await mine.json()).toEqual({ canSubmit: true, rating: 4, comment: "Updated." });

    const stats = await statsRoute(
      new Request("http://localhost/api/stats?days=all", { headers: { authorization: "Bearer stats-secret" } }),
    );
    const body = (await stats.json()) as {
      all_time: {
        feedback: { count: number; average: number; latest: { comment: string; rating: number }[] };
        waitlist_count: number;
      };
    };
    expect(body.all_time.feedback.count).toBe(1);
    expect(body.all_time.feedback.average).toBe(4);
    expect(body.all_time.feedback.latest).toEqual([
      expect.objectContaining({ rating: 4, comment: "Updated." }),
    ]);
    expect(JSON.stringify(body)).not.toContain(owner.user.email);

    const wrong = await statsRoute(
      new Request("http://localhost/api/stats", { headers: { authorization: "Bearer no" } }),
    );
    expect(wrong.status).toBe(401);
    delete process.env.STATS_TOKEN;
    const hidden = await statsRoute(new Request("http://localhost/api/stats"));
    expect(hidden.status).toBe(404);
    process.env.STATS_TOKEN = "stats-secret";
  });
});

describe("founding waitlist", () => {
  it("stores an email once and counts it on the protected stats report", async () => {
    const post = (email: string) =>
      joinWaitlist(
        new Request("http://localhost/api/founding/waitlist", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
            host: "localhost",
            "x-forwarded-for": "203.0.113.9",
          },
          body: JSON.stringify({ email }),
        }),
      );
    expect((await post("Wait@Example.com")).status).toBe(200);
    expect((await post("wait@example.com")).status).toBe(200);
    expect((await post("not-an-email")).status).toBe(400);
    const stats = await statsRoute(
      new Request("http://localhost/api/stats?days=all", { headers: { authorization: "Bearer stats-secret" } }),
    );
    const body = (await stats.json()) as { all_time: { waitlist_count: number } };
    expect(body.all_time.waitlist_count).toBe(1);
    expect(JSON.stringify(body)).not.toContain("wait@example.com");
  });
});
