import type { ProbeType } from "./types";

export type NonAnswerKind = "blank" | "refusal" | "evasive" | "off_topic" | "restatement";

export interface NonAnswer {
  kind: NonAnswerKind;
  reason: string;
}

/**
 * Level 0 is no substantive engagement with the claim. These checks are
 * deterministic so "I don't know" cannot pick up partial credit from a grader.
 * A wrong answer that still deals with the claim is not a non-answer.
 */
export function detectNonAnswer(input: {
  answer: string;
  question: string;
  claimText: string;
  sourceSpan: string;
  figures: string[];
  probeType: ProbeType;
}): NonAnswer | null {
  const answer = input.answer.replace(/\s+/g, " ").trim();
  if (isBlank(answer)) return { kind: "blank", reason: "blank" };

  const lone = loneWord(answer);
  if (lone === "refusal") return { kind: "refusal", reason: "refusal" };
  if (lone === "evasive") return { kind: "evasive", reason: "evasive" };

  if (isRestatement(answer, input.question)) {
    return { kind: "restatement", reason: "restates the question" };
  }

  if (engages(answer, input)) return null;

  const hedge = hedgeKind(answer);
  if (hedge) return { kind: hedge, reason: hedge };
  return { kind: "off_topic", reason: "no overlap with the claim" };
}

const STOP = new Set([
  "which", "there", "their", "about", "would", "could", "should", "other", "these", "those",
  "being", "after", "before", "where", "while", "because", "through", "still", "every", "another",
  "from", "that", "this", "with", "your", "have", "what", "when", "them", "they", "been", "into",
  "than", "then", "also", "just", "only", "some", "such", "very", "does", "doing",
]);

const LONE_REFUSAL = /^(idk|dunno)$/i;
const LONE_EVASIVE = /^(yes|no|ok|okay|sure|maybe|pass|skip|whatever|fine|nah|yep|nope)$/i;

const REFUSAL_PHRASES = [
  /\bi\s+do\s*n['’]?t\s+know\b/i,
  /\bi\s+do\s+not\s+know\b/i,
  /\bidk\b/i,
  /\bdunno\b/i,
  /\bno\s+idea\b/i,
  /\bno\s+clue\b/i,
  /\b(?:i(?:'m| am)\s+)?not\s+sure\b/i,
  /\bi(?:'m| am)\s+unsure\b/i,
  /\bbeats\s+me\b/i,
  /\bi\s+can(?:not|'t)\s+(?:say|answer|tell)\b/i,
];

const EVASIVE_PHRASES = [
  /\bi\s+guess(?:\s+it(?:'s| is)\s+fine)?\b/i,
  /\bit(?:'s| is)\s+fine\b/i,
  /\bsounds\s+good\b/i,
  /\bwhatever\b/i,
  /\bthat(?:'s| is)\s+a\s+good\s+question\b/i,
  /\bit\s+depends\b/i,
  /\bhard\s+to\s+say\b/i,
  /\bmaybe\b/i,
];

function isBlank(answer: string): boolean {
  if (!answer) return true;
  if (/^(n\/?a|none|nil|blank|\.{2,}|-+)$/i.test(answer)) return true;
  const words = answer.match(/[a-z0-9]+/gi) ?? [];
  const word = words[0];
  if (!word) return true;
  if (words.length >= 2) return false;
  return !LONE_REFUSAL.test(word) && !LONE_EVASIVE.test(word);
}

function loneWord(answer: string): "refusal" | "evasive" | null {
  const words = answer.match(/[a-z0-9']+/gi) ?? [];
  if (words.length !== 1) return null;
  if (LONE_REFUSAL.test(words[0])) return "refusal";
  if (LONE_EVASIVE.test(words[0])) return "evasive";
  return "evasive";
}

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{4,}|\d+(?:\.\d+)?/g) ?? []).filter((token) => !STOP.has(token));
}

/** An echo of the question, even when that echo contains the claim's words. */
function isRestatement(answer: string, question: string): boolean {
  const answerTokens = contentTokens(answer);
  if (answerTokens.length < 6) return false;
  const questionTokens = new Set(contentTokens(question));
  const novel = answerTokens.filter((token) => !questionTokens.has(token));
  const overlap = answerTokens.length - novel.length;
  return overlap / answerTokens.length >= 0.8 && novel.length < 3;
}

function engages(
  answer: string,
  input: { claimText: string; sourceSpan: string; figures: string[]; probeType: ProbeType },
): boolean {
  if (input.probeType === "planted_error" && catchesPlant(answer)) return true;
  const hay = answer.toLowerCase();
  const words = `${input.claimText} ${input.sourceSpan}`.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  if (words.some((word) => !STOP.has(word) && new RegExp(`\\b${word}\\b`).test(hay))) return true;
  return figuresOf(input.claimText, input.figures).some((figure) => hasFigure(hay, figure));
}

function catchesPlant(answer: string): boolean {
  return /\b(altered|incorrect|typo|wrong|doesn['’]?t match|does not match)\b/i.test(answer);
}

function figuresOf(claimText: string, figures: string[]): string[] {
  const fromText = claimText.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const figure of [...figures, ...fromText]) {
    const cleaned = figure.replace(/\s+/g, "").trim();
    if (cleaned.length < 2 || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
  }
  return out;
}

function hasFigure(answer: string, figure: string): boolean {
  const needle = figure.toLowerCase();
  let from = 0;
  while (from < answer.length) {
    const idx = answer.indexOf(needle, from);
    if (idx < 0) return false;
    const before = answer[idx - 1];
    const after = answer[idx + needle.length];
    const digitBefore = !!before && /\d/.test(before);
    const digitAfter = !!after && /\d/.test(after) && /\d/.test(needle[needle.length - 1] ?? "");
    if (!digitBefore && !digitAfter) return true;
    from = idx + needle.length;
  }
  return false;
}

/** Hedge language with nothing left that could be an answer. */
function hedgeKind(answer: string): "refusal" | "evasive" | null {
  const refusal = stripPhrases(answer, REFUSAL_PHRASES);
  const evasive = stripPhrases(refusal.text, EVASIVE_PHRASES);
  if (!refusal.hit && !evasive.hit) return null;
  const left = evasive.text.match(/[a-z0-9]+/gi) ?? [];
  if (left.length >= 2) return null;
  return refusal.hit ? "refusal" : "evasive";
}

function stripPhrases(text: string, patterns: RegExp[]): { hit: boolean; text: string } {
  let hit = false;
  let next = text;
  for (const pattern of patterns) {
    if (pattern.test(next)) hit = true;
    next = next.replace(pattern, " ");
  }
  return { hit, text: next };
}
