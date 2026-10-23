import type { Claim, ProbeType } from "./types";

export interface QuestionCheck {
  grounded: boolean;
  unambiguous: boolean;
  answerable: boolean;
  ok: boolean;
  reasons: string[];
}

const OUTSIDE = /\b(google|wikipedia|search online|search the web|look (?:this|it) up|current news|personal life)\b/i;
const ASKS =
  /\?|^(walk|explain|suppose|if\b|name|predict|check|defend|take|talk|help|convince|unpack|say|read|how|what|why|where|when|which|who|is|does|do|would|could|should|from)\b/i;

/**
 * A question is fair to score at zero for a non-answer only when it cites the
 * claim it tests and can be answered from the document alone.
 */
export function checkQuestion(input: {
  question: string;
  claim: Claim;
  probeType: ProbeType;
  plantedContent?: string;
}): QuestionCheck {
  const question = input.question.replace(/\s+/g, " ").trim();
  const reasons: string[] = [];
  const grounded = isGrounded(question, input.claim, input.probeType, input.plantedContent);
  const body = questionBody(question, input.probeType, input.plantedContent);
  const marks = question.match(/\?/g)?.length ?? 0;
  const unambiguous = body.length >= 12 && body.length <= 420 && marks <= 2;
  const answerable = !OUTSIDE.test(question) && ASKS.test(question);
  if (!grounded) reasons.push("not grounded in the claim, its source span, or a figure");
  if (body.length < 12 || body.length > 420) reasons.push("length outside 12–420");
  if (marks > 2) reasons.push("more than two questions");
  if (OUTSIDE.test(question)) reasons.push("asks for something outside the document");
  if (!ASKS.test(question)) reasons.push("not a question or a direct instruction");
  return { grounded, unambiguous, answerable, ok: grounded && unambiguous && answerable, reasons };
}

function questionBody(question: string, probeType: ProbeType, plantedContent?: string): string {
  if (probeType !== "planted_error" || !plantedContent) return question;
  const excerpt = plantedContent.replace(/\s+/g, " ").trim();
  if (excerpt.length < 12) return question;
  return question.replace(excerpt, " ").replace(/\s+/g, " ").trim();
}

function isGrounded(question: string, claim: Claim, probeType: ProbeType, plantedContent?: string): boolean {
  const hay = question.toLowerCase();
  if (probeType === "planted_error") {
    const excerpt = (plantedContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    // The full altered span has to be in the question. A 24-character prefix
    // let a mid-sentence cut pass, and the grader then saw only that cut.
    return excerpt.length >= 12 && hay.includes(excerpt);
  }
  const span = claim.sourceSpan.replace(/\s+/g, " ").trim();
  if (span.length >= 4 && hay.includes(span.toLowerCase())) return true;
  for (const figure of claim.figures ?? []) {
    const cleaned = figure.trim();
    if (cleaned.length >= 2 && hay.includes(cleaned.toLowerCase())) return true;
  }
  const numbers = claim.text.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  if (numbers.some((figure) => figure.length >= 2 && hay.includes(figure.toLowerCase()))) return true;
  const slice = claim.text.replace(/\s+/g, " ").trim().slice(0, 24).toLowerCase();
  return slice.length >= 12 && hay.includes(slice);
}
