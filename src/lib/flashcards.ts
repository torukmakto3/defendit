import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { z } from "zod";
import type { User } from "./auth";
import { FLASHCARD_WRITING_RULES, prepareCardFaces, settleCardText } from "./card-text";
import { claimsFromText } from "./claims";
import { sha256Hex } from "./crypto";
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
import { extractText, guessMimeType } from "./parse";
import { MAX_UPLOAD_BYTES } from "./services";
import { studyFileMissingMessage } from "./study-file";
import type { Claim } from "./types";
import { decryptField, decryptJson, encryptField } from "./vault";

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

/**
 * Vault contexts for a deliverable. These must match `ctx` in services.ts:
 * a ciphertext copied under a different context does not decrypt.
 */
const deliverableCtx = {
  fileName: (id: string) => `deliverables.file_name:${id}`,
  text: (id: string) => `deliverables.text:${id}`,
  claims: (id: string) => `deliverables.claims:${id}`,
};

interface StudySource {
  requestId: string;
  status: string;
  deliverableId: string;
  sha256: string;
  purgeAfter: string;
  text: string | null;
  claims: Claim[] | null;
  fileName: string | null;
}

function stillWithin(iso: string | null | undefined, nowIso: string): boolean {
  return !iso || iso >= nowIso;
}

/** Cards whose retention window has not closed. Expired rows are ignored, not served. */
async function liveDeckCount(deliverableId: string, userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM flashcards WHERE deliverable_id = ? AND user_id = ? AND purge_after >= ?`,
    [deliverableId, userId, new Date().toISOString()],
  );
  return Number(row?.n) || 0;
}

/**
 * Keep the deliverable's retention when it is still open. A deck rebuilt after
 * that window closed gets a fresh card window. The raw document text is not
 * given that extension.
 */
function cardPurgeAfter(deliverablePurgeAfter: string): string {
  const now = new Date();
  if (deliverablePurgeAfter > now.toISOString()) return deliverablePurgeAfter;
  const days = Number(process.env.RETENTION_DAYS || "30");
  const span = Number.isFinite(days) && days > 0 ? days : 30;
  return new Date(now.getTime() + span * 24 * 3600_000).toISOString();
}

async function loadForStudy(token: string, user: User): Promise<StudySource> {
  const db = await getDb();
  const request = await db.get<{
    id: string;
    status: string;
    creator_user_id: string | null;
  }>(`SELECT id, status, creator_user_id FROM defense_requests WHERE token = ?`, [token]);
  if (!request) throw new HttpError(404, "Defense link not found");
  if (request.creator_user_id !== user.id) {
    throw new HttpError(403, "This defense belongs to another account");
  }
  const deliverable = await db.get<{
    id: string;
    sha256: string;
    purge_after: string;
    purged_at: string | null;
    text_enc: string | null;
    text_purge_after: string | null;
    claims_enc: string | null;
    file_name_enc: string | null;
  }>(`SELECT * FROM deliverables WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`, [request.id]);
  if (!deliverable) throw new HttpError(400, "Upload a deliverable first");

  const nowIso = new Date().toISOString();
  const retained = !deliverable.purged_at && deliverable.purge_after >= nowIso;
  const textLive =
    retained && !!deliverable.text_enc && stillWithin(deliverable.text_purge_after, nowIso);
  return {
    requestId: request.id,
    status: request.status,
    deliverableId: deliverable.id,
    sha256: deliverable.sha256,
    purgeAfter: deliverable.purge_after,
    text: textLive ? decryptField(deliverable.text_enc, deliverableCtx.text(deliverable.id)) : null,
    claims: retained ? decryptJson<Claim[]>(deliverable.claims_enc, deliverableCtx.claims(deliverable.id)) : null,
    fileName:
      retained && deliverable.file_name_enc
        ? decryptField(deliverable.file_name_enc, deliverableCtx.fileName(deliverable.id))
        : null,
  };
}

async function storeDeck(opts: {
  userId: string;
  requestId: string;
  deliverableId: string;
  purgeAfter: string;
  cards: DraftCard[];
  regenerate: boolean;
}): Promise<{ created: number; total: number; cached: boolean }> {
  const db = await getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    await tx.run(
      `DELETE FROM flashcards WHERE deliverable_id = ? AND user_id = ? AND purge_after < ?`,
      [opts.deliverableId, opts.userId, nowIso],
    );
    const existing = await tx.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM flashcards WHERE deliverable_id = ? AND user_id = ?`,
      [opts.deliverableId, opts.userId],
    );
    const already = Number(existing?.n) || 0;
    if (!opts.regenerate && already > 0) return { created: 0, total: already, cached: true };
    if (opts.regenerate && already > 0) {
      await tx.run(`DELETE FROM flashcards WHERE deliverable_id = ? AND user_id = ?`, [
        opts.deliverableId,
        opts.userId,
      ]);
    }
    for (const card of opts.cards) {
      const id = newId("card");
      const fresh = createEmptyCard(now);
      await tx.run(
        `INSERT INTO flashcards
          (id, user_id, request_id, deliverable_id, claim_id, front_enc, back_enc, source_enc, card_json, due, created_at, purge_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          opts.userId,
          opts.requestId,
          opts.deliverableId,
          card.claimId,
          encryptField(card.front, ctx.front(id)),
          encryptField(card.back, ctx.back(id)),
          card.source ? encryptField(card.source, ctx.source(id)) : null,
          cardToJson(fresh),
          fresh.due.toISOString(),
          now.toISOString(),
          opts.purgeAfter,
        ],
      );
    }
    return { created: opts.cards.length, total: opts.cards.length, cached: false };
  });
}

export async function generateFlashcards(opts: { token: string; user: User; regenerate?: boolean }) {
  const source = await loadForStudy(opts.token, opts.user);
  if (!opts.regenerate) {
    const existing = await liveDeckCount(source.deliverableId, opts.user.id);
    if (existing > 0) return { created: 0, total: existing, cached: true };
  }
  // A missing file is not rebuilt from leftover claims. Those are a lossy map,
  // and the text they came from was deleted on purpose.
  if (!source.text || !source.claims?.length) {
    throw new HttpError(410, studyFileMissingMessage(source.status));
  }
  const cards = await withLlmScope({ requestId: source.requestId }, () =>
    writeCards(source.claims ?? [], source.text, source.fileName),
  );
  return storeDeck({
    userId: opts.user.id,
    requestId: source.requestId,
    deliverableId: source.deliverableId,
    purgeAfter: cardPurgeAfter(source.purgeAfter),
    cards,
    regenerate: !!opts.regenerate,
  });
}

/**
 * Write the creator's deck while the extracted text is still in the row,
 * including when its text timer has already passed and purge is about to
 * null the column. No-op once a live deck exists, or once full retention
 * has closed (those cards would be deleted in the same purge).
 */
export async function cacheStudyDeckBeforeTextDeletion(deliverableId: string): Promise<number> {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const row = await db.get<{
    id: string;
    request_id: string;
    owner_user_id: string;
    text_enc: string | null;
    claims_enc: string | null;
    file_name_enc: string | null;
    purge_after: string;
    purged_at: string | null;
  }>(
    `SELECT id, request_id, owner_user_id, text_enc, claims_enc, file_name_enc, purge_after, purged_at
     FROM deliverables WHERE id = ?`,
    [deliverableId],
  );
  if (!row || row.purged_at || row.purge_after < nowIso || !row.text_enc || !row.claims_enc) return 0;
  if ((await liveDeckCount(row.id, row.owner_user_id)) > 0) return 0;
  const text = decryptField(row.text_enc, deliverableCtx.text(row.id));
  const claims = decryptJson<Claim[]>(row.claims_enc, deliverableCtx.claims(row.id));
  if (!text || !claims?.length) return 0;
  const fileName = row.file_name_enc ? decryptField(row.file_name_enc, deliverableCtx.fileName(row.id)) : null;
  const cards = await withLlmScope({ requestId: row.request_id }, () => writeCards(claims, text, fileName));
  const stored = await storeDeck({
    userId: row.owner_user_id,
    requestId: row.request_id,
    deliverableId: row.id,
    purgeAfter: row.purge_after,
    cards,
    regenerate: false,
  });
  return stored.created;
}

/**
 * Rebuild a deck from a file the creator uploads again. The bytes must match
 * the defended SHA-256. The extracted text is not stored.
 */
export async function restoreStudyDeck(opts: {
  token: string;
  user: User;
  fileName: string;
  buffer: Buffer;
  mimeType?: string;
}) {
  const source = await loadForStudy(opts.token, opts.user);
  const existing = await liveDeckCount(source.deliverableId, opts.user.id);
  if (existing > 0) return { created: 0, total: existing, cached: true };
  if (source.status !== "defended") {
    throw new HttpError(409, "Upload the file again from the workspace.");
  }
  if (source.text) {
    throw new HttpError(409, "The file is still available. Open Learn to study it.");
  }
  if (opts.buffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `File is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  if (sha256Hex(opts.buffer) !== source.sha256) {
    throw new HttpError(409, "That file does not match the one you defended.");
  }
  const mime = opts.mimeType || guessMimeType(opts.fileName);
  let extracted: string;
  try {
    extracted = (await extractText(opts.buffer, mime, opts.fileName)).slice(0, 400_000);
  } catch {
    throw new HttpError(400, "Could not read that file. Try PDF, DOCX, XLSX, CSV, TXT or MD.");
  }
  if (extracted.length < 20) {
    throw new HttpError(400, "Could not extract enough text from the upload.");
  }
  const claims = claimsFromText(extracted);
  const cards = await withLlmScope({ requestId: source.requestId }, () =>
    writeCards(claims, extracted, opts.fileName),
  );
  return storeDeck({
    userId: opts.user.id,
    requestId: source.requestId,
    deliverableId: source.deliverableId,
    purgeAfter: cardPurgeAfter(source.purgeAfter),
    cards,
    regenerate: false,
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
