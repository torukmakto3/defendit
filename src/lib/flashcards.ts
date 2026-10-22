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
  trackedComplete,
  withLlmScope,
  type LlmProvider,
  type LlmRequest,
} from "./llm";
import { createGroqProvider, createLiquidProvider, createOpenRouterProvider } from "./llm/openai-compat";
import { estimateTokens } from "./llm/usage";
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
/**
 * Card 1 is its own short call so it can return first. The rest of the deck
 * is one call, run at the same time, and that call still sees the file excerpt.
 * Splitting the rest further would repeat the system prompt and the excerpt.
 */
const CARD_BATCH = MAX_CARDS;

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
    complete: (req: LlmRequest) => trackedComplete(provider, req),
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

interface OrderedDraft extends DraftCard {
  order: number;
}

export interface DeckBuildResult {
  created: number;
  total: number;
  cached: boolean;
  firstCardMs: number;
  deckMs: number;
}

function claimsBlock(claims: Claim[]): string {
  return `<claims>\n${JSON.stringify(
    claims.map((claim) => ({
      id: claim.id,
      section: claim.section,
      text: claim.text,
      source: claim.sourceSpan,
    })),
  )}\n</claims>`;
}

/** The single call Learn used to make: system rules, up to 4,000 characters of the file, then every claim. */
function legacyFlashcardUserPrompt(claims: Claim[], fileText: string | null): string {
  const excerpt = fileText ? fileText.slice(0, 4000) : null;
  return [
    excerpt
      ? `<file>\n${excerpt}\n</file>`
      : "<file>The extracted text is no longer available. Use the claims only.</file>",
    claimsBlock(claims),
  ].join("\n");
}

/**
 * Card 1 omits the file excerpt so the call stays small. Later batches include
 * the same excerpt the single call used to send.
 */
function batchUserPrompt(claims: Claim[], fileText: string | null): string {
  const excerpt = fileText ? fileText.slice(0, 4000) : null;
  return [
    excerpt
      ? `<file>\n${excerpt}\n</file>`
      : "<file>Each claim's text and source are the file. Write one card per claim.</file>",
    claimsBlock(claims),
  ].join("\n");
}

function batchClaims(claims: Claim[]): Claim[][] {
  const selected = claims.slice(0, MAX_CARDS);
  if (selected.length === 0) return [];
  const batches: Claim[][] = [[selected[0]]];
  for (let i = 1; i < selected.length; i += CARD_BATCH) batches.push(selected.slice(i, i + CARD_BATCH));
  return batches;
}

function completionJson(claims: Claim[], fileName: string | null): string {
  return JSON.stringify({
    cards: claims.map((claim) => {
      const card = draftFromClaim(claim, fileName);
      return { claimId: card.claimId, front: card.front, back: card.back, source: card.source };
    }),
  });
}

/**
 * Prompt-token estimate for one deck, using the same 4-characters-per-token
 * rule as a provider that omits usage. Completion size is the offline card
 * JSON, which is what mock mode actually returns.
 */
export function estimateFlashcardTokens(claims: Claim[], fileText: string | null, fileName: string | null = null) {
  const selected = claims.slice(0, MAX_CARDS);
  const beforePrompt =
    estimateTokens(FLASHCARD_WRITING_RULES) + estimateTokens(legacyFlashcardUserPrompt(selected, fileText));
  const batches = batchClaims(selected);
  let afterPrompt = 0;
  let afterCompletion = 0;
  batches.forEach((batch, index) => {
    const excerpt = index === 0 ? null : fileText;
    afterPrompt += estimateTokens(FLASHCARD_WRITING_RULES) + estimateTokens(batchUserPrompt(batch, excerpt));
    afterCompletion += estimateTokens(completionJson(batch, fileName));
  });
  const beforeCompletion = estimateTokens(completionJson(selected, fileName));
  return {
    cards: selected.length,
    callsBefore: selected.length === 0 ? 0 : 1,
    callsAfter: batches.length,
    beforePromptTokens: beforePrompt,
    afterPromptTokens: afterPrompt,
    beforeCompletionTokens: beforeCompletion,
    afterCompletionTokens: afterCompletion,
    beforeTokens: beforePrompt + beforeCompletion,
    afterTokens: afterPrompt + afterCompletion,
  };
}

/** Mock-only pause. One card waits `MOCK_FLASHCARD_DELAY_MS`; a batch waits that times its size. */
async function pauseForMockCards(count: number): Promise<void> {
  const raw = process.env.MOCK_FLASHCARD_DELAY_MS;
  if (!raw || !isMockLlm()) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms * Math.max(1, count)));
}

function keepCard(card: DraftCard, seen: Set<string>): boolean {
  const keys = [`f:${normalizeKey(card.front)}`, `b:${normalizeKey(card.back)}`];
  const sourceKey = normalizeKey(card.source ?? "");
  if (sourceKey.length >= 24) keys.push(`s:${sourceKey}`);
  if (keys.some((key) => key.length >= 10 && seen.has(key))) return false;
  for (const key of keys) {
    if (key.length >= 10) seen.add(key);
  }
  return true;
}

async function writeCardBatch(claims: Claim[], fileName: string | null, fileText: string | null): Promise<DraftCard[]> {
  const drafts = new Map(claims.map((claim) => [claim.id, draftFromClaim(claim, fileName)]));
  await pauseForMockCards(claims.length);
  try {
    const { data } = await completeJson(
      flashcardLlm(),
      {
        purpose: "write_flashcards",
        temperature: 0.3,
        messages: [
          { role: "system", content: FLASHCARD_WRITING_RULES },
          { role: "user", content: batchUserPrompt(claims, fileText) },
        ],
      },
      cardResponseSchema,
    );
    for (const raw of data.cards ?? []) {
      if (!raw.claimId || !drafts.has(raw.claimId) || !raw.front || !raw.back) continue;
      const claim = claims.find((item) => item.id === raw.claimId);
      const settled = settleCardText(
        {
          section: claim?.section,
          front: raw.front,
          back: raw.back,
          source: raw.source || claim?.sourceSpan || claim?.text,
        },
        { fileName },
      );
      drafts.set(raw.claimId, { claimId: raw.claimId, ...settled });
    }
  } catch (e) {
    console.warn("[flashcards] using plain cards from the file:", e instanceof Error ? e.message : e);
  }
  return claims.map((claim) => drafts.get(claim.id)!);
}

/**
 * Card 1 is drafted on its own. The other batches run at the same time.
 * Cards are handed back in claim order, so a duplicate loses to the earlier card
 * the way `dedupeFlashcards` does, and card 1 is not held for the slower batches.
 */
async function writeCardsBatched(
  claims: Claim[],
  fileName: string | null,
  fileText: string | null,
  onReady: (cards: OrderedDraft[]) => Promise<void>,
): Promise<OrderedDraft[]> {
  const selected = claims.slice(0, MAX_CARDS).map((claim, order) => ({ claim, order }));
  if (selected.length === 0) return [];
  const groups: { claim: Claim; order: number }[][] = [[selected[0]]];
  for (let i = 1; i < selected.length; i += CARD_BATCH) groups.push(selected.slice(i, i + CARD_BATCH));

  const pending = new Map<number, DraftCard>();
  let cursor = 0;
  const kept: OrderedDraft[] = [];
  const seen = new Set<string>();
  let chain = Promise.resolve();

  function takeReady(): OrderedDraft[] {
    const ready: OrderedDraft[] = [];
    while (pending.has(cursor)) {
      const card = pending.get(cursor)!;
      pending.delete(cursor);
      const order = cursor;
      cursor += 1;
      if (!keepCard(card, seen)) continue;
      const ordered = { ...card, order };
      kept.push(ordered);
      ready.push(ordered);
    }
    return ready;
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  await Promise.all(
    groups.map(async (group, groupIndex) => {
      const drafts = await writeCardBatch(
        group.map((item) => item.claim),
        fileName,
        groupIndex === 0 ? null : fileText,
      );
      for (let i = 0; i < group.length; i++) pending.set(group[i].order, drafts[i]);
      await enqueue(async () => {
        const ready = takeReady();
        if (ready.length > 0) await onReady(ready);
      });
    }),
  );
  return kept;
}

/** stage_timings is added by #34. Until then, log the same JSON shape and do not create that table. */
function logStage(requestId: string, stage: string, detail: string, durationMs: number): void {
  console.info(
    JSON.stringify({
      msg: "stage_timing",
      requestId,
      sessionId: null,
      stage,
      detail,
      durationMs: Math.max(0, Math.round(durationMs)),
    }),
  );
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

type DeckPhase = "ready" | "partial" | "empty";

async function deckPhase(deliverableId: string, userId: string): Promise<DeckPhase> {
  const db = await getDb();
  const row = await db.get<{ study_deck_ready: number | null }>(
    `SELECT study_deck_ready FROM deliverables WHERE id = ?`,
    [deliverableId],
  );
  const count = await liveDeckCount(deliverableId, userId);
  const flag = row?.study_deck_ready;
  if (flag === 1 || ((flag === null || flag === undefined) && count > 0)) return "ready";
  if (flag === 0 && count > 0) return "partial";
  return "empty";
}

async function setDeckFlag(deliverableId: string, ready: 0 | 1): Promise<void> {
  const db = await getDb();
  await db.run(`UPDATE deliverables SET study_deck_ready = ? WHERE id = ?`, [ready, deliverableId]);
}

async function deleteDeck(deliverableId: string, userId: string): Promise<void> {
  const db = await getDb();
  await db.run(`DELETE FROM flashcards WHERE deliverable_id = ? AND user_id = ?`, [deliverableId, userId]);
}

async function listDue(userId: string, token?: string, limit = 30): Promise<StudyCard[]> {
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
     WHERE f.user_id = ? AND f.due <= ? AND f.purge_after > ? ${token ? "AND r.token = ?" : ""}
     ORDER BY f.due ASC, f.created_at ASC, f.id ASC
     LIMIT ?`,
    [userId, nowIso, nowIso, ...(token ? [token] : []), Math.min(limit, 100)],
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

async function insertDrafts(opts: {
  userId: string;
  requestId: string;
  deliverableId: string;
  purgeAfter: string;
  token: string;
  cards: OrderedDraft[];
}): Promise<StudyCard[]> {
  const db = await getDb();
  const now = new Date();
  const stored: StudyCard[] = [];
  for (const card of opts.cards) {
    const id = newId("card");
    const fresh = createEmptyCard(now);
    const createdAt = new Date(now.getTime() + card.order).toISOString();
    await db.run(
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
        createdAt,
        opts.purgeAfter,
      ],
    );
    stored.push({
      id,
      token: opts.token,
      front: card.front,
      back: card.back,
      source: card.source,
      due: fresh.due.toISOString(),
    });
  }
  return stored;
}

interface DeckJob {
  snapshotted: Promise<void>;
  done: Promise<DeckBuildResult>;
  resolveSnap: () => void;
  emit: (card: StudyCard) => void;
  finish: (result: DeckBuildResult) => void;
  fail: (error: unknown) => void;
  subscribe: (listener: (card: StudyCard) => void) => () => void;
}

const deckJobs = new Map<string, DeckJob>();

function createDeckJob(requestId: string): DeckJob {
  let snap!: () => void;
  let resolveDone!: (result: DeckBuildResult) => void;
  let rejectDone!: (error: unknown) => void;
  let snapped = false;
  let closed = false;
  const snapshotted = new Promise<void>((resolve) => {
    snap = resolve;
  });
  const done = new Promise<DeckBuildResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const buffer: StudyCard[] = [];
  const listeners = new Set<(card: StudyCard) => void>();
  const resolveSnap = () => {
    if (snapped) return;
    snapped = true;
    snap();
  };
  const job: DeckJob = {
    snapshotted,
    done,
    resolveSnap,
    emit(card) {
      buffer.push(card);
      for (const listener of [...listeners]) listener(card);
    },
    finish(result) {
      if (closed) return;
      closed = true;
      resolveSnap();
      resolveDone(result);
    },
    fail(error) {
      if (closed) return;
      closed = true;
      resolveSnap();
      rejectDone(error);
    },
    subscribe(listener) {
      for (const card of buffer) listener(card);
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  void done.catch((error) => {
    if (error instanceof HttpError && (error.status === 410 || error.status === 404 || error.status === 400)) return;
    console.warn(
      "[flashcards] deck was not finished:",
      requestId,
      error instanceof Error ? error.message : error,
    );
  });
  return job;
}

function claimDeckJob(deliverableId: string, requestId: string): { job: DeckJob; fresh: boolean } {
  const existing = deckJobs.get(deliverableId);
  if (existing) return { job: existing, fresh: false };
  const job = createDeckJob(requestId);
  deckJobs.set(deliverableId, job);
  void job.done.finally(() => {
    if (deckJobs.get(deliverableId) === job) deckJobs.delete(deliverableId);
  }).catch(() => undefined);
  return { job, fresh: true };
}

async function pipeDeck(job: DeckJob, onCard: (card: StudyCard) => void): Promise<DeckBuildResult> {
  const unsubscribe = job.subscribe(onCard);
  try {
    return await job.done;
  } finally {
    unsubscribe();
  }
}

async function runGeneration(
  source: StudySource,
  userId: string,
  regenerate: boolean,
  job: DeckJob,
  started: number,
): Promise<void> {
  try {
    job.resolveSnap();
    const token = await tokenForRequest(source.requestId);
    if (!source.text || !source.claims?.length) {
      const cards = await listDue(userId, token);
      if (cards.length > 0 && !regenerate) {
        await setDeckFlag(source.deliverableId, 1);
        const elapsed = Date.now() - started;
        logStage(source.requestId, "first_card", "cached", elapsed);
        logStage(source.requestId, "flashcard_deck", "cached", elapsed);
        for (const card of cards) job.emit(card);
        job.finish({
          created: 0,
          total: await liveDeckCount(source.deliverableId, userId),
          cached: true,
          firstCardMs: elapsed,
          deckMs: elapsed,
        });
        return;
      }
      throw new HttpError(410, studyFileMissingMessage(source.status));
    }

    await setDeckFlag(source.deliverableId, 0);
    const db = await getDb();
    await db.run(
      `DELETE FROM flashcards WHERE deliverable_id = ? AND user_id = ? AND purge_after < ?`,
      [source.deliverableId, userId, new Date().toISOString()],
    );
    if (regenerate || (await liveDeckCount(source.deliverableId, userId)) > 0) {
      await deleteDeck(source.deliverableId, userId);
    }

    const purgeAfter = cardPurgeAfter(source.purgeAfter);
    let loggedFirst = false;
    let firstCardMs = 0;
    const owner = await db.get<{ email: string }>(`SELECT email FROM users WHERE id = ?`, [userId]);
    const drafts = await withLlmScope({ requestId: source.requestId, user: owner }, () =>
      writeCardsBatched(source.claims ?? [], source.fileName, source.text, async (batch) => {
        const stored = await insertDrafts({
          userId,
          requestId: source.requestId,
          deliverableId: source.deliverableId,
          purgeAfter,
          token,
          cards: batch,
        });
        if (!loggedFirst && stored.length > 0) {
          loggedFirst = true;
          firstCardMs = Date.now() - started;
          logStage(source.requestId, "first_card", "generated", firstCardMs);
        }
        for (const card of stored) job.emit(card);
      }),
    );
    await setDeckFlag(source.deliverableId, 1);
    const deckMs = Date.now() - started;
    logStage(source.requestId, "flashcard_deck", "generated", deckMs);
    job.finish({
      created: drafts.length,
      total: drafts.length,
      cached: false,
      firstCardMs,
      deckMs,
    });
  } catch (error) {
    job.fail(error);
  }
}

async function tokenForRequest(requestId: string): Promise<string> {
  const db = await getDb();
  const row = await db.get<{ token: string }>(`SELECT token FROM defense_requests WHERE id = ?`, [requestId]);
  return row?.token ?? "";
}

interface CacheRow {
  id: string;
  request_id: string;
  owner_user_id: string;
  text_enc: string | null;
  claims_enc: string | null;
  file_name_enc: string | null;
  purge_after: string;
  purged_at: string | null;
  status: string;
  sha256: string;
}

async function loadDeliverable(deliverableId: string): Promise<{ source: StudySource; userId: string } | null> {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const row = await db.get<CacheRow>(
    `SELECT d.id, d.request_id, d.owner_user_id, d.text_enc, d.claims_enc, d.file_name_enc, d.purge_after, d.purged_at, d.sha256, r.status
     FROM deliverables d JOIN defense_requests r ON r.id = d.request_id WHERE d.id = ?`,
    [deliverableId],
  );
  if (!row) return null;
  const retained = !row.purged_at && row.purge_after >= nowIso;
  const text = retained && row.text_enc ? decryptField(row.text_enc, deliverableCtx.text(row.id)) : null;
  const claims = retained && row.claims_enc ? decryptJson<Claim[]>(row.claims_enc, deliverableCtx.claims(row.id)) : null;
  const fileName =
    retained && row.file_name_enc ? decryptField(row.file_name_enc, deliverableCtx.fileName(row.id)) : null;
  return {
    userId: row.owner_user_id,
    source: {
      requestId: row.request_id,
      status: row.status,
      deliverableId: row.id,
      sha256: row.sha256,
      purgeAfter: row.purge_after,
      text,
      claims,
      fileName,
    },
  };
}

async function runCacheJob(deliverableId: string, job: DeckJob): Promise<void> {
  const started = Date.now();
  try {
    const loaded = await loadDeliverable(deliverableId);
    job.resolveSnap();
    if (!loaded || loaded.source.purgeAfter < new Date().toISOString()) {
      job.finish({ created: 0, total: 0, cached: true, firstCardMs: 0, deckMs: 0 });
      return;
    }
    const phase = await deckPhase(loaded.source.deliverableId, loaded.userId);
    if (phase === "ready") {
      const token = await tokenForRequest(loaded.source.requestId);
      const cards = await listDue(loaded.userId, token);
      const elapsed = Date.now() - started;
      if (cards.length > 0) logStage(loaded.source.requestId, "first_card", "cached", elapsed);
      logStage(loaded.source.requestId, "flashcard_deck", "cached", elapsed);
      for (const card of cards) job.emit(card);
      job.finish({
        created: 0,
        total: await liveDeckCount(loaded.source.deliverableId, loaded.userId),
        cached: true,
        firstCardMs: elapsed,
        deckMs: elapsed,
      });
      return;
    }
    if (!loaded.source.text || !loaded.source.claims?.length) {
      const token = await tokenForRequest(loaded.source.requestId);
      const cards = await listDue(loaded.userId, token);
      if (cards.length > 0) {
        await setDeckFlag(loaded.source.deliverableId, 1);
        for (const card of cards) job.emit(card);
        job.finish({
          created: 0,
          total: cards.length,
          cached: true,
          firstCardMs: Date.now() - started,
          deckMs: Date.now() - started,
        });
        return;
      }
      job.fail(new HttpError(410, studyFileMissingMessage(loaded.source.status)));
      return;
    }
    await runGeneration(loaded.source, loaded.userId, false, job, started);
  } catch (error) {
    job.fail(error);
  }
}

/**
 * Copy the file text into memory and start the deck. The snapshot resolves
 * once that copy exists, before the model call. Callers that are about to
 * delete the text wait for the snapshot only.
 */
export function beginStudyDeckCache(deliverableId: string): { snapshotted: Promise<void>; done: Promise<number> } {
  const { job, fresh } = claimDeckJob(deliverableId, deliverableId);
  if (fresh) void runCacheJob(deliverableId, job);
  return {
    snapshotted: job.snapshotted,
    done: job.done.then(
      (result) => result.created,
      () => 0,
    ),
  };
}

/** Wait for decks started in this process. The receipt route uses this so a response can return first. */
export async function settlePendingStudyDecks(): Promise<void> {
  const pending = [...deckJobs.values()];
  await Promise.all(pending.map((job) => job.done.catch(() => undefined)));
}

export async function streamStudyDeck(opts: {
  token: string;
  user: User;
  regenerate?: boolean;
  onCard: (card: StudyCard) => void;
  source?: StudySource;
}): Promise<DeckBuildResult> {
  const started = Date.now();
  const source = opts.source ?? (await loadForStudy(opts.token, opts.user));
  if (!opts.regenerate) {
    const existing = deckJobs.get(source.deliverableId);
    if (existing) return pipeDeck(existing, opts.onCard);
    const phase = await deckPhase(source.deliverableId, opts.user.id);
    const raced = deckJobs.get(source.deliverableId);
    if (raced) return pipeDeck(raced, opts.onCard);
    if (phase === "ready") {
      const cards = await listDue(opts.user.id, opts.token);
      const elapsed = Date.now() - started;
      if (cards.length > 0) logStage(source.requestId, "first_card", "cached", elapsed);
      logStage(source.requestId, "flashcard_deck", "cached", elapsed);
      for (const card of cards) opts.onCard(card);
      return {
        created: 0,
        total: await liveDeckCount(source.deliverableId, opts.user.id),
        cached: true,
        firstCardMs: elapsed,
        deckMs: elapsed,
      };
    }
  }
  if (opts.regenerate) {
    const existing = deckJobs.get(source.deliverableId);
    if (existing) await existing.done.catch(() => undefined);
  }
  const again = deckJobs.get(source.deliverableId);
  if (again && !opts.regenerate) return pipeDeck(again, opts.onCard);
  if ((!source.text || !source.claims?.length) && (await deckPhase(source.deliverableId, opts.user.id)) !== "ready") {
    const cards = await listDue(opts.user.id, opts.token);
    if (cards.length > 0 && !opts.regenerate) {
      for (const card of cards) opts.onCard(card);
      return {
        created: 0,
        total: cards.length,
        cached: true,
        firstCardMs: Date.now() - started,
        deckMs: Date.now() - started,
      };
    }
    throw new HttpError(410, studyFileMissingMessage(source.status));
  }
  const { job, fresh } = claimDeckJob(source.deliverableId, source.requestId);
  if (!fresh) return pipeDeck(job, opts.onCard);
  void runGeneration(source, opts.user.id, !!opts.regenerate, job, started);
  return pipeDeck(job, opts.onCard);
}

export async function generateFlashcards(opts: {
  token: string;
  user: User;
  regenerate?: boolean;
}): Promise<DeckBuildResult> {
  return streamStudyDeck({ ...opts, onCard: () => undefined });
}

/**
 * Write the creator's deck while the extracted text is still in the row,
 * including when its text timer has already passed and purge is about to
 * null the column. No-op once a live deck exists, or once full retention
 * has closed (those cards would be deleted in the same purge).
 * This waits until the cards are stored. The receipt path uses
 * `beginStudyDeckCache` and does not wait.
 */
export async function cacheStudyDeckBeforeTextDeletion(deliverableId: string): Promise<number> {
  const job = beginStudyDeckCache(deliverableId);
  return job.done;
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
  // The bytes stay in memory for this call. Nothing writes them back to the row.
  return streamStudyDeck({
    token: opts.token,
    user: opts.user,
    onCard: () => undefined,
    source: { ...source, text: extracted, claims, fileName: opts.fileName },
  });
}

export async function dueCards(opts: { user: User; token?: string; limit?: number }): Promise<StudyCard[]> {
  return listDue(opts.user.id, opts.token, opts.limit ?? 30);
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
