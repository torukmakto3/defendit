import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { dueCards, generateFlashcards, restoreStudyDeck, settlePendingStudyDecks } from "../src/lib/flashcards";
import { STUDY_FILE_DELETED, STUDY_TEXT_EXPIRED } from "../src/lib/study-file";
import {
  completeDefendSession,
  creatorIngest,
  getRequestView,
  ingestDeliverable,
  purgeExpired,
  recordDefendAnswer,
  startSession,
} from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-study-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "study.db");
  process.env.DATA_ENCRYPTION_KEY = "66".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "77".repeat(32);
  delete process.env.DATABASE_URL;
});

async function signIn(email: string): Promise<User> {
  const { devLink } = await requestMagicLink({ email });
  return (await consumeMagicLink(devLink!.split("#token=")[1]))!.user;
}

async function answerAll(session: { sessionId: string; plan: { probes: { id: string }[] } }, user: User) {
  for (const [i, probe] of session.plan.probes.entries()) {
    await recordDefendAnswer({
      sessionId: session.sessionId,
      user,
      probeId: probe.id,
      answer: `Because the unit economics section shows churn near 1.2% and LTV/CAC above 3; if churn doubles the recommendation weakens first. (${i})`,
    });
  }
}

async function defend(user: User, fileName: string) {
  const ingest = await creatorIngest({
    user,
    fileName,
    buffer: memo,
    difficulty: "standard",
  });
  const session = await startSession({ token: ingest.token, user, mode: "defend" });
  await answerAll(session, user);
  const result = await completeDefendSession({ sessionId: session.sessionId, user });
  expect(result.receipt?.payload.id).toBeTruthy();
  return ingest;
}

describe("Learn after the document text is deleted", () => {
  it("caches an encrypted deck when the defense deletes the text, then serves it", async () => {
    const user = await signIn("cached-deck@fund.example");
    const ingest = await defend(user, "Project-North-LOI.md");
    const db = await getDb();
    const stored = await db.get<{ text_enc: string | null; source_enc: string | null; n: number }>(
      `SELECT d.text_enc, f.source_enc, (SELECT COUNT(*) FROM flashcards WHERE deliverable_id = d.id) AS n
       FROM deliverables d JOIN flashcards f ON f.deliverable_id = d.id
       WHERE d.id = ? LIMIT 1`,
      [ingest.deliverableId],
    );
    expect(stored?.text_enc).toBeNull();
    expect(Number(stored?.n)).toBeGreaterThan(0);
    expect(stored?.source_enc).toBeTruthy();
    expect(JSON.stringify(stored)).not.toMatch(/Series B|churn/i);

    const again = await generateFlashcards({ token: ingest.token, user });
    expect(again.cached).toBe(true);
    expect(again.created).toBe(0);
    const cards = await dueCards({ user, token: ingest.token });
    expect(cards.length).toBe(again.total);
    expect(cards.some((card) => /Series B|churn|12M|payback/i.test(`${card.front} ${card.back} ${card.source ?? ""}`))).toBe(
      true,
    );

    const view = await getRequestView(ingest.token, user);
    expect(view.deliverable?.documentAvailable).toBe(false);
    expect(view.deliverable?.studyDeck).toBe(true);
    await expect(startSession({ token: ingest.token, user, mode: "learn" })).rejects.toMatchObject({ status: 410 });
  });

  it("caches the deck when the text timer passes and leaves the raw text deleted", async () => {
    const user = await signIn("text-ttl-deck@fund.example");
    const ingest = await creatorIngest({ user, fileName: "timer.md", buffer: memo, difficulty: "standard" });
    const db = await getDb();
    await db.run(`UPDATE deliverables SET text_purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await purgeExpired();
    const row = await db.get<{ text_enc: string | null; claims_enc: string | null; purged_at: string | null }>(
      `SELECT text_enc, claims_enc, purged_at FROM deliverables WHERE id = ?`,
      [ingest.deliverableId],
    );
    expect(row?.text_enc).toBeNull();
    expect(row?.claims_enc).not.toBeNull();
    expect(row?.purged_at).toBeNull();
    const cards = await dueCards({ user, token: ingest.token });
    expect(cards.length).toBeGreaterThan(0);
    const served = await generateFlashcards({ token: ingest.token, user });
    expect(served.cached).toBe(true);
    await expect(generateFlashcards({ token: ingest.token, user, regenerate: true })).rejects.toThrow(STUDY_TEXT_EXPIRED);
    expect(await dueCards({ user, token: ingest.token })).toHaveLength(cards.length);
  });

  it("does not keep a deck when the whole deliverable is past retention", async () => {
    const user = await signIn("full-purge@fund.example");
    const ingest = await creatorIngest({ user, fileName: "gone.md", buffer: memo, difficulty: "standard" });
    const db = await getDb();
    await db.run(`UPDATE deliverables SET purge_after = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await purgeExpired();
    expect(await dueCards({ user, token: ingest.token })).toHaveLength(0);
    const row = await db.get<{ text_enc: string | null; claims_enc: string | null }>(
      `SELECT text_enc, claims_enc FROM deliverables WHERE id = ?`,
      [ingest.deliverableId],
    );
    expect(row).toMatchObject({ text_enc: null, claims_enc: null });
  });

  it("asks for the same file again when the text is already gone and no deck was saved", async () => {
    const user = await signIn("restore-deck@fund.example");
    const ingest = await creatorIngest({ user, fileName: "again.md", buffer: memo, difficulty: "standard" });
    const db = await getDb();
    await db.run(`UPDATE defense_requests SET status = 'defended' WHERE token = ?`, [ingest.token]);
    await db.run(`UPDATE deliverables SET text_enc = NULL WHERE id = ?`, [ingest.deliverableId]);

    await expect(generateFlashcards({ token: ingest.token, user })).rejects.toThrow(STUDY_FILE_DELETED);
    await expect(
      restoreStudyDeck({
        token: ingest.token,
        user,
        fileName: "other.md",
        buffer: Buffer.from(`${memo.toString("utf8")}\nA different recommendation.`),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await dueCards({ user, token: ingest.token })).toHaveLength(0);

    const restored = await restoreStudyDeck({
      token: ingest.token,
      user,
      fileName: "again.md",
      buffer: memo,
    });
    expect(restored.created).toBeGreaterThan(0);
    expect(restored.cached).toBe(false);
    const after = await db.get<{ text_enc: string | null }>(`SELECT text_enc FROM deliverables WHERE id = ?`, [
      ingest.deliverableId,
    ]);
    expect(after?.text_enc).toBeNull();
    const cards = await dueCards({ user, token: ingest.token });
    expect(cards).toHaveLength(restored.total);
    const row = await db.get<{ source_enc: string }>(
      `SELECT source_enc FROM flashcards WHERE deliverable_id = ? AND source_enc IS NOT NULL LIMIT 1`,
      [ingest.deliverableId],
    );
    expect(row?.source_enc).toBeTruthy();
    expect(row?.source_enc).not.toMatch(/Series B|churn/i);

    await expect(
      ingestDeliverable({ token: ingest.token, user, fileName: "again.md", buffer: memo }),
    ).rejects.toMatchObject({ status: 409 });
    const view = await getRequestView(ingest.token, user);
    expect(view.deliverable?.documentAvailable).toBe(false);
    expect(view.deliverable?.studyDeck).toBe(true);
    expect(view.status).toBe("defended");
  });

  it("returns the receipt before a slow deck finishes", async () => {
    const previous = process.env.MOCK_FLASHCARD_DELAY_MS;
    process.env.MOCK_FLASHCARD_DELAY_MS = "800";
    try {
      const user = await signIn("deck-async@fund.example");
      const ingest = await creatorIngest({
        user,
        fileName: "async.md",
        buffer: memo,
        difficulty: "standard",
      });
      const session = await startSession({ token: ingest.token, user, mode: "defend" });
      await answerAll(session, user);
      const started = Date.now();
      const result = await completeDefendSession({
        sessionId: session.sessionId,
        user,
        waitForStudyDeck: false,
      });
      const elapsed = Date.now() - started;
      expect(result.receipt?.payload.id).toBeTruthy();
      expect(elapsed).toBeLessThan(500);
      const db = await getDb();
      const row = await db.get<{ text_enc: string | null }>(`SELECT text_enc FROM deliverables WHERE id = ?`, [
        ingest.deliverableId,
      ]);
      expect(row?.text_enc).toBeNull();
      await settlePendingStudyDecks();
      const cards = await dueCards({ user, token: ingest.token });
      expect(cards.length).toBeGreaterThan(0);
      expect(cards.some((card) => card.source)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MOCK_FLASHCARD_DELAY_MS;
      else process.env.MOCK_FLASHCARD_DELAY_MS = previous;
    }
  });
});
