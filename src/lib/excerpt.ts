/**
 * Display clips for quoted document text.
 *
 * Cuts on grapheme boundaries, then on a sentence or a word, and marks a
 * shortened quote with an ellipsis. Callers that grade keep the full span
 * and pass only the shortened string to the screen or the spoken question.
 */

const ELLIPSIS = "…";

export function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  }
  return Array.from(text);
}

export function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** First sentence, or the whole string when it has no sentence end. */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/^[\s\S]*?[.!?…](?=\s|$)/);
  return (match ? match[0] : clean).trim();
}

/**
 * Shorten `text` to at most `maxChars` graphemes. A sentence end in the kept
 * region wins when it keeps a useful share of the budget; otherwise the cut
 * is the last whole word. The full string is returned unchanged when it fits.
 */
export function clipExcerpt(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (maxChars < 2) return ELLIPSIS;
  const chars = graphemes(clean);
  if (chars.length <= maxChars) return clean;
  const budget = maxChars - 1;
  const sliced = chars.slice(0, budget).join("");
  const sentenceAt = lastSentenceEnd(sliced);
  let cut = sliced;
  if (sentenceAt >= Math.floor(budget * 0.45)) {
    cut = sliced.slice(0, sentenceAt).trimEnd();
  } else {
    const word = sliced.replace(/\s+\S*$/u, "").trimEnd();
    cut = word || sliced.trimEnd();
  }
  cut = cut.replace(/[,:;]+$/u, "").trimEnd();
  return `${cut}${ELLIPSIS}`;
}

/**
 * Cap stored or prompted text without collapsing paragraphs. The cut is on a
 * grapheme, then backed up to whitespace so a word (and an accent) stays whole.
 */
export function cutText(text: string, maxChars: number): string {
  const chars = graphemes(text);
  if (chars.length <= maxChars) return text;
  let cut = chars.slice(0, maxChars).join("");
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (boundary >= Math.floor(maxChars * 0.8)) cut = cut.slice(0, boundary);
  return cut.trimEnd();
}

function lastSentenceEnd(text: string): number {
  const marks = [...text.matchAll(/[.!?…](?=\s|$)/g)];
  if (marks.length === 0) return -1;
  const last = marks[marks.length - 1];
  return (last.index ?? 0) + last[0].length;
}
