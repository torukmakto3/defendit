import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { z } from "zod";
import type { User } from "./auth";
import { FLASHCARD_WRITING_RULES, prepareCardFaces, settleCardText } from "./card-text";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { newId } from "./ids";
import {
  completeJson,
  getPrimaryLlm,
  guardRetention,
  isMockLlm,
  withLlmScope,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./llm";
import { createGroqProvider, createLiquidProvider, createOpenRouterProvider } from "./llm/openai-compat";
import { recordLlmCall } from "./llm/usage";
import { loadOwnDeliverable } from "./services";
import type { Claim } from "./types";
import { decryptField, encryptField } from "./vault";

export { listProjects } from "./services";

/**
 * Spaced-repetition cards for one deliverable, scheduled with FSRS.
 * Card text is encrypted and deleted with the deliverable's retention window.
 * A project keeps one deck until the creator asks to regenerate it.
 *
 * Generation prefers a small Liquid model (`FLASHCARD_MODEL`, default
 * `llama-3.1-8b-instruct`) so a deck stays cheap. Mock mode stays offline.
 */
const scheduler = fsrs({ enable_fuzz: true });
const ctx = {
  front: (id: string) => `flashcards.front:${id}`,
  back: (id: string) => `flashcards.back:${id}`,
  source: (id: string) => `flashcards.source:${id}`,
};

/** Small open model. Pinned, so card wording does not follow `liquid.auto`. */
export const DEFAULT_FLASHCARD_MODEL = "llama-3.1-8b-instruct";

export const RATINGS = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy } as const;
export type RatingName = keyof typeof RATINGS;

const MAX_CARDS = 12;

const cardResponseSchema = z.object({
  cards: z
    .array(
      z.object({
        claimId: z.string().optional(),
        front: z.string().optional(),
        back: z.string().optional(),
        source: z.string().optional(),
      }),
    )
    .optional(),
});

export interface StudyCard {
  id: string;
  token: string;
  front: string;
  back: string;
  source: string | null;
  due: string;
}

interface DraftCard {
  claimId: string;
  front: string;
  back: string;
  source: string | null;
}

export function flashcardModelId(): string {
  const configured = process.env.FLASHCARD_MODEL?.trim();
  return configured || DEFAULT_FLASHCARD_MODEL;
}

function track(provider: LlmProvider): LlmProvider {
  return {
    ...provider,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const res = await provider.complete(req);
      await recordLlmCall({
        purpose: req.purpose,
        provider: res.provider,
        modelId: res.modelId,
        usage: res.usage,
      });
      return res;
    },
  };
}

/** Model that writes cards. Liquid when a key is set, otherwise another cheap host, then the primary. */
export function flashcardLlm(): LlmProvider {
  if (isMockLlm()) return getPrimaryLlm();
  const model = flashcardModelId();
  const env = process.env;
  if (env.LIQUID_API_KEY) return track(guardRetention(createLiquidProvider(env.LIQUID_API_KEY, model)));
  if (env.GROQ_API_KEY) return track(guardRetention(createGroqProvider(env.GROQ_API_KEY, model)));
  if (env.OPENROUTER_API_KEY) {
    return track(guardRetention(createOpenRouterProvider(env.OPENROUTER_API_KEY, model)));
  }
  return getPrimaryLlm();
}

function cardToJson(card: Card): string {
  return JSON.stringify(card);
}

function cardFromJson(json: string): Card {
  const c = JSON.parse(json) as Card & { due: string; last_review?: string };
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Drop cards that ask the same thing, answer the same thing, or quote the same line. */
export function dedupeFlashcards<T extends { front: string; back: string; source: string | null }>(cards: T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const card of cards) {
    const keys = [`f:${normalizeKey(card.front)}`, `b:${normalizeKey(card.back)}`];
    const sourceKey = normalizeKey(card.source ?? "");
    if (sourceKey.length >= 24) keys.push(`s:${sourceKey}`);
    if (keys.some((key) => key.length >= 10 && seen.has(key))) continue;
    for (const key of keys) {
      if (key.length >= 10) seen.add(key);
    }
    kept.push(card);
  }
  return kept;
}

function draftFromClaim(claim: Claim, fileName: string | null): DraftCard {
  const faces = prepareCardFaces({
    section: claim.section,
    text: claim.text,
    source: claim.sourceSpan || claim.text,
  });
  return { claimId: claim.id, ...settleCardText(faces, { fileName }) };
}

async function writeCards(claims: Claim[], excerpt: string | null, fileName: string | null): Promise<DraftCard[]> {
  const selected = claims.slice(0, MAX_CARDS);
  const fallback = new Map(selected.map((claim) => [claim.id, draftFromClaim(claim, fileName)]));
  try {
    const { data } = await completeJson(
      flashcardLlm(),
      {
        purpose: "write_flashcards",
        temperature: 0.3,
        messages: [
          { role: "system", content: FLASHCARD_WRITING_RULES },
          {
            role: "user",
            content: [
              excerpt ? `<file>\n${excerpt.slice(0, 4000)}\n</file>` : "<file>The extracted text is no longer available. Use the claims only.</file>",
              `<claims>\n${JSON.stringify(
                selected.map((claim) => ({
                  id: claim.id,
                  section: claim.section,
                  text: claim.text,
                  source: claim.sourceSpan,
                })),
              )}\n</claims>`,
            ].join("\n"),
          },
        ],
      },
      cardResponseSchema,
    );
    for (const raw of data.cards ?? []) {
      if (!raw.claimId || !fallback.has(raw.claimId) || !raw.front || !raw.back) continue;
      const claim = selected.find((item) => item.id === raw.claimId);
      const settled = settleCardText(
        {
          section: claim?.section,
          front: raw.front,
          back: raw.back,
          source: raw.source || claim?.sourceSpan || claim?.text,
        },
        { fileName },
      );
      fallback.set(raw.claimId, { claimId: raw.claimId, ...settled });
    }
  } catch (e) {
    console.warn("[flashcards] using plain cards from the file:", e instanceof Error ? e.message : e);
  }
  return dedupeFlashcards([...fallback.values()]);
}

export async function generateFlashcards(opts: { token: string; user: User; regenerate?: boolean }) {
  const { request, deliverable, claims, text, fileName } = await loadOwnDeliverable(opts.token, opts.user);
  const db = await getDb();
  if (!opts.regenerate) {
    const existing = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM flashcards WHERE deliverable_id = ?`, [
      deliverable.id,
    ]);
    if (Number(existing?.n) > 0) return { created: 0, total: Number(existing?.n), cached: true };
  }

  const cards = await withLlmScope({ requestId: request.id }, () => writeCards(claims, text, fileName));
  const now = new Date();
  return db.transaction(async (tx) => {
    const existing = await tx.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM flashcards WHERE deliverable_id = ? AND user_id = ?`,
      [deliverable.id, opts.user.id],
    );
    const already = Number(existing?.n) || 0;
    if (!opts.regenerate && already > 0) return { created: 0, total: already, cached: true };
    if (opts.regenerate && already > 0) {
      await tx.run(`DELETE FROM flashcards WHERE deliverable_id = ? AND user_id = ?`, [
        deliverable.id,
        opts.user.id,
      ]);
    }
    for (const card of cards) {
      const id = newId("card");
      const fresh = createEmptyCard(now);
      await tx.run(
        `INSERT INTO flashcards
          (id, user_id, request_id, deliverable_id, claim_id, front_enc, back_enc, source_enc, card_json, due, created_at, purge_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          opts.user.id,
          request.id,
          deliverable.id,
          card.claimId,
          encryptField(card.front, ctx.front(id)),
          encryptField(card.back, ctx.back(id)),
          card.source ? encryptField(card.source, ctx.source(id)) : null,
          cardToJson(fresh),
          fresh.due.toISOString(),
          now.toISOString(),
          deliverable.purge_after,
        ],
      );
    }
    return { created: cards.length, total: cards.length, cached: false };
  });
}

export async function dueCards(opts: { user: User; token?: string; limit?: number }): Promise<StudyCard[]> {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const rows = await db.all<{
    id: string;
    front_enc: string;
    back_enc: string;
    source_enc: string | null;
    due: string;
    token: string;
  }>(
    `SELECT f.id, f.front_enc, f.back_enc, f.source_enc, f.due, r.token
     FROM flashcards f JOIN defense_requests r ON r.id = f.request_id
     WHERE f.user_id = ? AND f.due <= ? AND f.purge_after > ? ${opts.token ? "AND r.token = ?" : ""}
     ORDER BY f.due ASC
     LIMIT ?`,
    [opts.user.id, nowIso, nowIso, ...(opts.token ? [opts.token] : []), Math.min(opts.limit ?? 30, 100)],
  );
  return rows.map((row) => ({
    id: row.id,
    token: row.token,
    front: decryptField(row.front_enc, ctx.front(row.id)) ?? "",
    back: decryptField(row.back_enc, ctx.back(row.id)) ?? "",
    source: row.source_enc ? decryptField(row.source_enc, ctx.source(row.id)) : null,
    due: row.due,
  }));
}

export async function reviewCard(opts: { user: User; cardId: string; rating: RatingName }) {
  const grade = RATINGS[opts.rating] as Grade | undefined;
  if (!grade) throw new HttpError(400, "Unknown rating");
  const db = await getDb();
  const row = await db.get<{ card_json: string }>(
    `SELECT card_json FROM flashcards WHERE id = ? AND user_id = ?`,
    [opts.cardId, opts.user.id],
  );
  if (!row) throw new HttpError(404, "Card not found");
  const { card } = scheduler.next(cardFromJson(row.card_json), new Date(), grade);
  await db.run(`UPDATE flashcards SET card_json = ?, due = ? WHERE id = ? AND user_id = ?`, [
    cardToJson(card),
    card.due.toISOString(),
    opts.cardId,
    opts.user.id,
  ]);
  return { due: card.due.toISOString(), state: card.state, reps: card.reps };
}
