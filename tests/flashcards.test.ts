import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { dueCards, generateFlashcards, listProjects, reviewCard } from "../src/lib/flashcards";
import { creatorIngest, purgeExpired } from "../src/lib/services";

const memo = readFileSync(join(__dirname, "..", "fixtures", "sample-memo.md"));

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "defendit-cards-"));
  process.env.MOCK_LLM = "1";
  process.env.DATABASE_PATH = join(dir, "cards.db");
  process.env.DATA_ENCRYPTION_KEY = "44".repeat(32);
  process.env.DEFEND_IT_SIGNING_SEED = "55".repeat(32);
  delete process.env.DATABASE_URL;
});

async function signIn(email: string): Promise<User> {
  const { devLink } = await requestMagicLink({ email });
  return (await consumeMagicLink(devLink!.split("#token=")[1]))!.user;
}

describe("flashcards", () => {
  it("generates cards from a deliverable's claims, once", async () => {
    const user = await signIn("cards@fund.example");
    const ingest = await creatorIngest({ user, fileName: "north.md", buffer: memo });
    const first = await generateFlashcards({ token: ingest.token, user });
    expect(first.created).toBeGreaterThan(2);
    const again = await generateFlashcards({ token: ingest.token, user });
    expect(again.created).toBe(0);
    expect(again.total).toBe(first.total);

    const db = await getDb();
    const row = await db.get<Record<string, string>>(`SELECT * FROM flashcards LIMIT 1`);
    expect(JSON.stringify(row)).not.toMatch(/churn|Series B/i);
  });

  it("shows new cards as due and schedules them forward after review", async () => {
    const user = await signIn("review@fund.example");
    const ingest = await creatorIngest({ user, fileName: "r.md", buffer: memo });
    await generateFlashcards({ token: ingest.token, user });
    const due = await dueCards({ user, token: ingest.token });
    expect(due.length).toBeGreaterThan(0);
    expect(due[0].front.length).toBeGreaterThan(5);
    expect(due[0].back.length).toBeGreaterThan(5);

    const next = await reviewCard({ user, cardId: due[0].id, rating: "good" });
    expect(new Date(next.due).getTime()).toBeGreaterThan(Date.now());
    const after = await dueCards({ user, token: ingest.token });
    expect(after.find((c) => c.id === due[0].id)).toBeUndefined();

    const again = await reviewCard({ user, cardId: due[1].id, rating: "again" });
    expect(new Date(again.due).getTime() - Date.now()).toBeLessThan(15 * 60_000);
  });

  it("keeps cards private to their owner", async () => {
    const owner = await signIn("owner-cards@fund.example");
    const other = await signIn("other-cards@fund.example");
    const ingest = await creatorIngest({ user: owner, fileName: "o.md", buffer: memo });
    await generateFlashcards({ token: ingest.token, user: owner });
    const [card] = await dueCards({ user: owner, token: ingest.token });
    await expect(generateFlashcards({ token: ingest.token, user: other })).rejects.toMatchObject({ status: 403 });
    await expect(reviewCard({ user: other, cardId: card.id, rating: "good" })).rejects.toMatchObject({ status: 404 });
    expect(await dueCards({ user: other })).toHaveLength(0);
  });

  it("lists projects with card counts", async () => {
    const user = await signIn("projects@fund.example");
    const ingest = await creatorIngest({ user, fileName: "Board-Deck-Q3.md", buffer: memo });
    await generateFlashcards({ token: ingest.token, user });
    const projects = await listProjects(user);
    const p = projects.find((x) => x.token === ingest.token)!;
    expect(p.title).toBe("Board-Deck-Q3");
    expect(p.cards).toBeGreaterThan(0);
    expect(p.due).toBe(p.cards);
    expect(p.documentAvailable).toBe(true);
  });

  it("purges card text with the deliverable's retention window", async () => {
    const user = await signIn("purge-cards@fund.example");
    const ingest = await creatorIngest({ user, fileName: "p.md", buffer: memo });
    await generateFlashcards({ token: ingest.token, user });
    const db = await getDb();
    await db.run(`UPDATE flashcards SET purge_after = ? WHERE deliverable_id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      ingest.deliverableId,
    ]);
    await purgeExpired();
    expect(await dueCards({ user, token: ingest.token })).toHaveLength(0);
    const left = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM flashcards WHERE deliverable_id = ?`, [
      ingest.deliverableId,
    ]);
    expect(Number(left?.n)).toBe(0);
  });
});
