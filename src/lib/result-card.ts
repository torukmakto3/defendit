import type { Metadata } from "next";
import { publicTierTitle, tierForScore, type ResultTier } from "./challenge-tier";
import type { Difficulty, ReceiptPayload } from "./types";

/**
 * What the defender chose to publish.
 * `public` shows the score. `score_hidden` is public without the score.
 * `private` is a generic DefendIT card.
 */
export type ReceiptVisibility = "public" | "score_hidden" | "private";

export type CardVariant = "A" | "B" | "C" | "private" | "unknown" | "demo";

/** Bumped when the card artwork changes, so cached images miss. */
export const RESULT_CARD_VERSION = "v1";

/** Versioned image URLs are safe to cache. A visibility change uses a new id. */
export const RESULT_CARD_CACHE_CONTROL = "public, max-age=86400";

/** An old visibility id must not be stored again. */
export const RESULT_CARD_STALE_CACHE_CONTROL = "private, no-store";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export interface CardLine {
  text: string;
  tone: "body" | "meta" | "verify";
}

export interface ResultCard {
  variant: CardVariant;
  visibility: ReceiptVisibility | "unknown" | "demo";
  tier: ResultTier | null;
  /** Path segment. Includes the visibility so a change busts the image cache. */
  imageId: string;
  title: string;
  description: string;
  alt: string;
  kicker: string;
  headline: string;
  lines: CardLine[];
  actions: string[];
}

export interface ShareMetadata {
  title: string;
  description: string;
  alt: string;
  imageId: string;
  ogImagePath: string;
  twitterImagePath: string;
  twitterCard: "summary_large_image";
  width: number;
  height: number;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export function resultCardImageId(visibility: ReceiptVisibility | "unknown" | "demo"): string {
  return `${RESULT_CARD_VERSION}-${visibility}`;
}

export function cacheControlForImage(requestedId: string, card: { imageId: string }): string {
  return requestedId === card.imageId ? RESULT_CARD_CACHE_CONTROL : RESULT_CARD_STALE_CACHE_CONTROL;
}

/** First and last 4 hex characters. The full digest stays off the card. */
export function fileFingerprint(sha256: string): { start: string; end: string; label: string } | null {
  const hex = sha256.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 8) return null;
  const start = hex.slice(0, 4);
  const end = hex.slice(-4);
  return { start, end, label: `${start}…${end}` };
}

export function questionCountOf(bands: { strong: number; partial: number; weak: number }): number {
  const n = bands.strong + bands.partial + bands.weak;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(99, Math.round(n));
}

export function cardVariant(visibility: ReceiptVisibility, tier: ResultTier): CardVariant {
  switch (visibility) {
    case "private":
      return "private";
    case "score_hidden":
      // Kit variant B. The number stays off the card. The headline is still the
      // tier, the same rule resultCardCopy uses for a challenge result.
      return "B";
    case "public":
      return tier === "Still sharpening" ? "C" : "A";
    default: {
      const unknown: never = visibility;
      return unknown;
    }
  }
}

export interface CardInput {
  visibility: ReceiptVisibility;
  score: number;
  difficulty: Difficulty;
  questionCount: number;
  sha256: string;
  createdAt: string;
  receiptId: string;
  /** Shown only when it is not an email. */
  defenderName?: string | null;
  /** Public file label. Omitted when the defender did not share one. */
  fileLabel?: string | null;
  /** Shown only when the challenger opted in, and only on the full card. */
  challengerName?: string | null;
  /** Short topic labels for variant C. Never a raw answer. */
  strongest?: string | null;
  nextFocus?: string | null;
  attempt?: number;
  /** Host without a scheme, such as defendit.me. */
  host?: string;
}

export function buildResultCard(input: CardInput): ResultCard {
  const tier = tierForScore(input.score);
  const variant = cardVariant(input.visibility, tier);
  if (variant === "private") return privateCard();
  const score = clampScore(input.score);
  const name = publicLabel(input.defenderName, 80);
  const file = publicLabel(input.fileLabel, 80);
  const fingerprint = fileFingerprint(input.sha256);
  const date = formatCardDate(input.createdAt);
  const difficulty = difficultyLabel(input.difficulty);
  const questions = input.questionCount > 0 ? Math.min(99, Math.round(input.questionCount)) : 0;
  const host = (input.host || "defendit.me").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const verifyPath = `${host}/r/${input.receiptId}`;
  const who = name ?? "A defender";

  if (variant === "B") {
    const headline = publicTierTitle(tier);
    const defended = file ? `${who} defended "${file}"` : `${who} defended a file`;
    const lines: CardLine[] = [
      { text: defended, tone: "body" },
      { text: "Result: kept private by the defender", tone: "body" },
    ];
    if (fingerprint) lines.push({ text: `File SHA-256  ${fingerprint.label}`, tone: "meta" });
    if (date) lines.push({ text: date.short, tone: "meta" });
    lines.push({ text: `Signed receipt · verify: ${verifyPath}`, tone: "verify" });
    return {
      variant,
      visibility: "score_hidden",
      tier,
      imageId: resultCardImageId("score_hidden"),
      title: headline,
      description: describeHidden(file, fingerprint?.label ?? null, date?.short ?? null),
      alt: altHidden(who, file, date?.long ?? null, tier, fingerprint, verifyPath),
      kicker: "DEFEND IT",
      headline,
      lines,
      actions: ["Challenge someone", "Defend your own"],
    };
  }

  const headline = publicTierTitle(tier);
  if (variant === "C") {
    const round = input.attempt && input.attempt > 0 ? `Round ${Math.min(99, Math.round(input.attempt))}` : null;
    const scoreLine = [round, difficulty, `score shown by choice: ${score}/100`].filter(Boolean).join(" · ");
    const focus = focusLine(input.strongest, input.nextFocus);
    const lines: CardLine[] = [{ text: defendedLine(who, file), tone: "body" }, { text: scoreLine, tone: "body" }];
    if (focus) lines.push({ text: focus, tone: "body" });
    const stamp = [fingerprint ? `File SHA-256  ${fingerprint.label}` : null, date?.short ?? null]
      .filter(Boolean)
      .join(" · ");
    if (stamp) lines.push({ text: stamp, tone: "meta" });
    lines.push({ text: `Verify: ${verifyPath}`, tone: "verify" });
    return {
      variant,
      visibility: "public",
      tier,
      imageId: resultCardImageId("public"),
      title: headline,
      description: describeSharpening(score, difficulty, fingerprint?.label ?? null, date?.short ?? null),
      alt: altSharpening({
        who,
        file,
        date: date?.long ?? null,
        difficulty,
        score,
        round: round ? Math.min(99, Math.round(input.attempt ?? 1)) : 1,
        strongest: publicLabel(input.strongest, 40),
        nextFocus: publicLabel(input.nextFocus, 40),
        fingerprint,
        verifyPath,
      }),
      kicker: "DEFEND IT",
      headline,
      lines,
      actions: ["Defend your own", "Rematch"],
    };
  }

  const challenger = publicLabel(input.challengerName, 80);
  const detail = [`Score ${score}/100`, difficulty, questions ? `${questions} ${questions === 1 ? "question" : "questions"}` : null]
    .filter(Boolean)
    .join(" · ");
  const dated = [date?.short ?? null, challenger ? `Challenged by ${challenger}` : null].filter(Boolean).join(" · ");
  const lines: CardLine[] = [
    { text: defendedLine(who, file), tone: "body" },
    { text: detail, tone: "body" },
  ];
  if (fingerprint) lines.push({ text: `File SHA-256  ${fingerprint.label}`, tone: "meta" });
  if (dated) lines.push({ text: dated, tone: "meta" });
  lines.push({ text: `Signed (Ed25519) · verify: ${verifyPath}`, tone: "verify" });
  return {
    variant: "A",
    visibility: "public",
    tier,
    imageId: resultCardImageId("public"),
    title: headline,
    description: describeFull(score, difficulty, questions, fingerprint?.label ?? null, date?.short ?? null),
    alt: altFull({
      who,
      file,
      date: date?.long ?? null,
      tier,
      score,
      difficulty,
      questions,
      fingerprint,
      verifyPath,
    }),
    kicker: "DEFEND IT",
    headline,
    lines,
    actions: ["Challenge someone", "Defend your own"],
  };
}

/** A sample demo is not a credential. The card has no score and no file name. */
export function demoSampleCard(): ResultCard {
  return {
    variant: "demo",
    visibility: "demo",
    tier: null,
    imageId: resultCardImageId("demo"),
    title: "Sample demo · Not a credential",
    description: "Sample demo. Not a credential.",
    alt: "DefendIT receipt card. Sample demo. Not a credential. No score is shown.",
    kicker: "DEFEND IT",
    headline: "Sample demo · Not a credential",
    lines: [
      { text: "Sample demo.", tone: "body" },
      { text: "Not a credential.", tone: "body" },
      { text: "No score on this card.", tone: "meta" },
    ],
    actions: [],
  };
}

export function isDemoSample(payload: ReceiptPayload): boolean {
  return payload.demo?.sample === true;
}

export function cardFromReceipt(opts: {
  payload: ReceiptPayload;
  visibility?: ReceiptVisibility;
  fileLabel?: string | null;
  challengerName?: string | null;
  strongest?: string | null;
  nextFocus?: string | null;
  host?: string;
  questionCount?: number;
}): ResultCard {
  if (isDemoSample(opts.payload)) return demoSampleCard();
  const name = opts.payload.creator?.displayName ?? null;
  return buildResultCard({
    visibility: opts.visibility ?? "public",
    score: opts.payload.score,
    difficulty: opts.payload.difficulty,
    questionCount: opts.questionCount ?? questionCountOf(opts.payload.bands),
    sha256: opts.payload.deliverable.sha256,
    createdAt: opts.payload.createdAt,
    receiptId: opts.payload.id,
    defenderName: name,
    fileLabel: opts.fileLabel,
    challengerName: opts.challengerName,
    strongest: opts.strongest,
    nextFocus: opts.nextFocus,
    attempt: opts.payload.attempt,
    host: opts.host,
  });
}

/** Missing receipt. Same generic frame, without claiming the defender chose private. */
export function unknownResultCard(): ResultCard {
  return {
    variant: "unknown",
    visibility: "unknown",
    tier: null,
    imageId: resultCardImageId("unknown"),
    title: "DefendIT",
    description: "A DefendIT understanding receipt.",
    alt: "DefendIT receipt card. A signed understanding receipt.",
    kicker: "DEFEND IT",
    headline: "DefendIT",
    lines: [
      { text: "A signed understanding receipt.", tone: "body" },
      { text: "Score and file name stay off this card.", tone: "meta" },
    ],
    actions: [],
  };
}

/** Text fields from `resultCardCopy`, plus the lines the shared OG renderer draws. */
export interface ResultCardCopy {
  kicker: string;
  title: string;
  subtitle: string;
  foot: string;
  score: string | null;
  description: string;
  alt: string;
  imageId: string;
  headline: string;
  lines: CardLine[];
  actions: string[];
  tier: ResultTier | null;
  visibility: ReceiptVisibility | "unknown" | "demo";
}

/**
 * Keep the visibility decision in the overlay. A score-hidden challenge result
 * passes `score: null` here even when the receipt payload still has a number.
 */
export function withCardCopy(
  card: ResultCard,
  overlay: {
    kicker: string;
    title: string;
    subtitle: string;
    foot: string;
    score: string | null;
  },
): ResultCardCopy {
  return {
    ...overlay,
    headline: overlay.title,
    description: card.description,
    alt: card.alt,
    imageId: card.imageId,
    lines: card.lines,
    actions: card.actions,
    tier: card.tier,
    visibility: card.visibility,
  };
}

export function shareMetadata(
  card: Pick<ResultCard, "title" | "description" | "alt" | "imageId">,
  receiptId: string,
): ShareMetadata {
  const id = encodeURIComponent(receiptId);
  return {
    title: card.title,
    description: card.description,
    alt: card.alt,
    imageId: card.imageId,
    ogImagePath: `/r/${id}/opengraph-image/${card.imageId}`,
    twitterImagePath: `/r/${id}/twitter-image/${card.imageId}`,
    twitterCard: "summary_large_image",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  };
}

export function toNextMetadata(share: ShareMetadata, pagePath: string): Metadata {
  const image = {
    url: share.ogImagePath,
    width: share.width,
    height: share.height,
    alt: share.alt,
    type: "image/png",
  };
  return {
    title: share.title === "DefendIT" ? "DefendIT" : `${share.title} · DefendIT`,
    description: share.description,
    openGraph: {
      title: share.title,
      description: share.description,
      url: pagePath,
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: share.title,
      description: share.description,
      images: [
        {
          url: share.twitterImagePath,
          alt: share.alt,
          width: share.width,
          height: share.height,
        },
      ],
    },
  };
}

/**
 * The tags a receipt link should emit. Tests assert these for each variant.
 * The route serves the same title, description, alt, and image paths through
 * the Next metadata API.
 */
export function renderShareMetaTags(share: ShareMetadata): string[] {
  return [
    metaTag("property", "og:title", share.title),
    metaTag("property", "og:description", share.description),
    metaTag("property", "og:image", share.ogImagePath),
    metaTag("property", "og:image:alt", share.alt),
    metaTag("property", "og:image:width", String(share.width)),
    metaTag("property", "og:image:height", String(share.height)),
    metaTag("name", "twitter:card", share.twitterCard),
    metaTag("name", "twitter:title", share.title),
    metaTag("name", "twitter:description", share.description),
    metaTag("name", "twitter:image", share.twitterImagePath),
    metaTag("name", "twitter:image:alt", share.alt),
  ];
}

function privateCard(): ResultCard {
  return {
    variant: "private",
    visibility: "private",
    tier: null,
    imageId: resultCardImageId("private"),
    title: "DefendIT",
    description: "A DefendIT understanding receipt. The defender kept the result private.",
    alt: "DefendIT receipt card. The defender kept this result private. The card shows no score and no file name.",
    kicker: "DEFEND IT",
    headline: "DefendIT",
    lines: [
      { text: "A signed understanding receipt.", tone: "body" },
      { text: "The defender kept this result private.", tone: "body" },
      { text: "No score and no file name on this card.", tone: "meta" },
    ],
    actions: [],
  };
}

function metaTag(attr: "property" | "name", key: string, value: string): string {
  return `<meta ${attr}="${key}" content="${escapeAttr(value)}" />`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** A public label. Emails and control characters never reach the card. */
export function publicLabel(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || EMAIL.test(cleaned)) return null;
  return cleaned.slice(0, max);
}

function difficultyLabel(difficulty: Difficulty): string {
  switch (difficulty) {
    case "standard":
      return "Standard";
    case "hard":
      return "Hard";
    case "expert":
      return "Expert";
    default: {
      const unknown: never = difficulty;
      return unknown;
    }
  }
}

export function formatCardDate(iso: string): { short: string; long: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const short = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const long = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return { short, long };
}

function defendedLine(who: string, file: string | null): string {
  return file ? `${who} defended "${file}"` : `${who} defended a file`;
}

function focusLine(strongest: string | null | undefined, nextFocus: string | null | undefined): string | null {
  const strong = publicLabel(strongest, 40);
  const next = publicLabel(nextFocus, 40);
  if (strong && next) return `Strongest answer: ${strong} · Next: ${next}`;
  if (strong) return `Strongest answer: ${strong}`;
  if (next) return `Next: ${next}`;
  return null;
}

function describeFull(
  score: number,
  difficulty: string,
  questions: number,
  fingerprint: string | null,
  date: string | null,
): string {
  const parts = [
    `Score ${score}/100`,
    difficulty,
    questions ? `${questions} ${questions === 1 ? "question" : "questions"}` : null,
    fingerprint ? `SHA-256 ${fingerprint}` : null,
    date,
  ];
  return parts.filter(Boolean).join(" · ");
}

function describeHidden(file: string | null, fingerprint: string | null, date: string | null): string {
  return [
    file ? `Defended "${file}"` : "A file was defended",
    "Result kept private by the defender",
    fingerprint ? `SHA-256 ${fingerprint}` : null,
    date,
  ]
    .filter(Boolean)
    .join(" · ");
}

function describeSharpening(score: number, difficulty: string, fingerprint: string | null, date: string | null): string {
  return [`Still sharpening`, difficulty, `score shown by choice ${score}/100`, fingerprint ? `SHA-256 ${fingerprint}` : null, date]
    .filter(Boolean)
    .join(" · ");
}

function altFull(opts: {
  who: string;
  file: string | null;
  date: string | null;
  tier: ResultTier;
  score: number;
  difficulty: string;
  questions: number;
  fingerprint: { start: string; end: string } | null;
  verifyPath: string;
}): string {
  const file = opts.file ? `the file ${opts.file}` : "a file";
  const when = opts.date ? ` on ${opts.date}` : "";
  const across = opts.questions
    ? ` across ${opts.questions} ${opts.questions === 1 ? "question" : "questions"}`
    : "";
  const hash = opts.fingerprint
    ? ` File fingerprint SHA-256 starting ${opts.fingerprint.start} and ending ${opts.fingerprint.end}.`
    : "";
  return `DefendIT receipt card. ${opts.who} defended ${file}${when}, rated ${opts.tier}, ${opts.score} out of 100 on ${opts.difficulty} difficulty${across}.${hash} Digitally signed; verify at ${opts.verifyPath}.`;
}

function altHidden(
  who: string,
  file: string | null,
  date: string | null,
  tier: ResultTier,
  fingerprint: { start: string; end: string } | null,
  verifyPath: string,
): string {
  const target = file ? `the file ${file}` : "a file";
  const when = date ? ` on ${date}` : "";
  const hash = fingerprint
    ? ` File fingerprint SHA-256 starting ${fingerprint.start} and ending ${fingerprint.end}.`
    : "";
  return `DefendIT receipt card. ${who} defended ${target}${when}, rated ${publicTierTitle(tier)}. The number stays off this card.${hash} Signed receipt; verify at ${verifyPath}.`;
}

function altSharpening(opts: {
  who: string;
  file: string | null;
  date: string | null;
  difficulty: string;
  score: number;
  round: number;
  strongest: string | null;
  nextFocus: string | null;
  fingerprint: { start: string; end: string } | null;
  verifyPath: string;
}): string {
  const file = opts.file ? ` on ${opts.file}` : "";
  const when = opts.date ? ` on ${opts.date}` : "";
  const focus =
    opts.strongest && opts.nextFocus
      ? ` Strongest area: ${opts.strongest}; next to work on: ${opts.nextFocus}.`
      : "";
  const hash = opts.fingerprint
    ? ` File fingerprint SHA-256 starting ${opts.fingerprint.start} and ending ${opts.fingerprint.end}.`
    : "";
  return `DefendIT receipt card. ${opts.who} took round ${opts.round} of a defense challenge${file}${when}, ${opts.difficulty} difficulty, status Still sharpening, score ${opts.score} out of 100 shown by the defender's choice.${focus}${hash} Verify at ${opts.verifyPath}.`;
}
