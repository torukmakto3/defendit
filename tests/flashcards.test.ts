import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeMagicLink, requestMagicLink, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { cardTextIssues } from "../src/lib/card-text";
import {
  DEFAULT_FLASHCARD_MODEL,
  dedupeFlashcards,
  dueCards,
  flashcardLlm,
  generateFlashcards,
  listProjects,
  reviewCard,
} from "../src/lib/flashcards";
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

  it("keeps generated faces clean and quotes the file on the source line", async () => {
    const dirty = Buffer.from(
      [
        "monthly_churn in north_star.md is status=high and should stay in the source quote only, not on the card face itself.",
        "",
        "Payback on the new customers is eleven months, and the contribution margin is sixty two percent after support costs are paid.",
        "",
        "The field monthlyChurn and the dump file_name=north_star.md do not belong on the face of a card at all.",
      ].join("\n"),
    );
    const user = await signIn("clean-cards@fund.example");
    const ingest = await creatorIngest({ user, fileName: "north_star.md", buffer: dirty });
    const made = await generateFlashcards({ token: ingest.token, user });
    expect(made.created).toBeGreaterThan(0);
    const cards = await dueCards({ user, token: ingest.token });
    expect(cards.length).toBe(made.created);
    for (const card of cards) {
      expect(cardTextIssues(card.front, { fileName: "north_star.md" })).toEqual([]);
      expect(cardTextIssues(card.back, { fileName: "north_star.md" })).toEqual([]);
    }
    expect(
      cards.some((card) => card.source && /monthly_churn|north_star\.md|status=high|monthlyChurn/.test(card.source)),
    ).toBe(true);
  });

  it("dedupes repeated points and regenerates only when asked", async () => {
    expect(
      dedupeFlashcards([
        { front: "What is payback?", back: "Payback is eleven months.", source: "Payback is eleven months at the current pace." },
        { front: "Say the payback again?", back: "Payback is eleven months.", source: "Payback is eleven months at the current pace." },
      ]),
    ).toHaveLength(1);

    const repeated = Buffer.from(
      [
        "Payback period on customer acquisition is eleven months at the current sales efficiency, and that is the figure to remember.",
        "",
        "Payback period on customer acquisition is eleven months at the current sales efficiency, and that is the figure to remember.",
        "",
        "Contribution margin is sixty two percent after payment processing and support, which is a separate point from payback.",
      ].join("\n"),
    );
    const user = await signIn("dedupe-cards@fund.example");
    const ingest = await creatorIngest({ user, fileName: "repeat.md", buffer: repeated });
    const first = await generateFlashcards({ token: ingest.token, user });
    expect(first.cached).toBe(false);
    expect(first.created).toBeLessThan(3);
    const cached = await generateFlashcards({ token: ingest.token, user });
    expect(cached.created).toBe(0);
    expect(cached.cached).toBe(true);
    expect(cached.total).toBe(first.total);

    const before = await dueCards({ user, token: ingest.token });
    const fresh = await generateFlashcards({ token: ingest.token, user, regenerate: true });
    expect(fresh.created).toBeGreaterThan(0);
    expect(fresh.cached).toBe(false);
    const after = await dueCards({ user, token: ingest.token });
    expect(after).toHaveLength(fresh.total);
    expect(after.some((card) => before.some((old) => old.id === card.id))).toBe(false);
  });

  it("uses a pinned cheap Liquid model when Liquid is configured", () => {
    const saved = {
      MOCK_LLM: process.env.MOCK_LLM,
      LIQUID_API_KEY: process.env.LIQUID_API_KEY,
      FLASHCARD_MODEL: process.env.FLASHCARD_MODEL,
    };
    try {
      process.env.MOCK_LLM = "0";
      process.env.LIQUID_API_KEY = "test-key";
      delete process.env.FLASHCARD_MODEL;
      const pinned = flashcardLlm();
      expect(pinned.provider).toBe("liquid");
      expect(pinned.id).toBe(DEFAULT_FLASHCARD_MODEL);
      expect(pinned.id).not.toMatch(/auto/i);

      process.env.FLASHCARD_MODEL = "llama-3.2-3b-instruct";
      expect(flashcardLlm().id).toBe("llama-3.2-3b-instruct");

      process.env.MOCK_LLM = "1";
      expect(flashcardLlm().provider).toBe("mock");
    } finally {
      process.env.MOCK_LLM = saved.MOCK_LLM;
      if (saved.LIQUID_API_KEY === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = saved.LIQUID_API_KEY;
      if (saved.FLASHCARD_MODEL === undefined) delete process.env.FLASHCARD_MODEL;
      else process.env.FLASHCARD_MODEL = saved.FLASHCARD_MODEL;
    }
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
