export type NonAnswerKind = "blank" | "refusal" | "restatement";

export interface NonAnswer {
  kind: NonAnswerKind;
  reason: string;
}

/**
 * Clear non-answers only. Blank, an "I don't know" / refusal, or a restatement
 * of the question score 0 before the graders run. Anything with substance,
 * including another language or different words for the same fact, is left to
 * the graders.
 */
export function detectNonAnswer(input: {
  answer: string;
  question: string;
  claimText: string;
  sourceSpan: string;
  figures: string[];
  probeType: string;
}): NonAnswer | null {
  const answer = input.answer.replace(/\s+/g, " ").trim();
  if (isBlank(answer)) return { kind: "blank", reason: "blank" };
  if (isClearRefusal(answer)) return { kind: "refusal", reason: "refusal" };
  if (isRestatement(answer, input.question)) {
    return { kind: "restatement", reason: "restates the question" };
  }
  return null;
}

const STOP = new Set([
  "which", "there", "their", "about", "would", "could", "should", "other", "these", "those",
  "being", "after", "before", "where", "while", "because", "through", "still", "every", "another",
  "from", "that", "this", "with", "your", "have", "what", "when", "them", "they", "been", "into",
  "than", "then", "also", "just", "only", "some", "such", "very", "does", "doing",
]);

/** A clause that is the whole refusal, with no claim left in it. */
const REFUSAL_CLAUSE = [
  /^i\s+do\s*n['’]?t\s+know$/,
  /^i\s+do\s+not\s+know$/,
  /^idk$/,
  /^dunno$/,
  /^no\s+idea$/,
  /^no\s+clue$/,
  /^(?:i(?:'m| am)\s+)?not\s+sure$/,
  /^i(?:'m| am)\s+unsure$/,
  /^i\s+can(?:not|'t)\s+(?:say|answer|tell)(?:\s+you)?$/,
  /^beats\s+me$/,
  /^i\s+guess(?:\s+it(?:'s| is)\s+fine)?$/,
  /^it(?:'s| is)\s+fine$/,
  /^sounds\s+good$/,
  /^whatever$/,
];

function isBlank(answer: string): boolean {
  if (!answer) return true;
  return /^(n\/?a|none|nil|blank|\.{2,}|-+)$/i.test(answer);
}

function isClearRefusal(answer: string): boolean {
  const parts = answer
    .replace(/[.!?]+$/g, "")
    .split(/\s*(?:,|;|—|–|\band\b)\s*/i)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => REFUSAL_CLAUSE.some((pattern) => pattern.test(part)));
}

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{4,}|\d+(?:\.\d+)?/g) ?? []).filter((token) => !STOP.has(token));
}

/** An echo of the question. A short reply, or one with its own words, is not. */
function isRestatement(answer: string, question: string): boolean {
  const answerTokens = contentTokens(answer);
  if (answerTokens.length < 6) return false;
  const questionTokens = new Set(contentTokens(question));
  const novel = answerTokens.filter((token) => !questionTokens.has(token));
  const overlap = answerTokens.length - novel.length;
  return overlap / answerTokens.length >= 0.8 && novel.length < 3;
}
