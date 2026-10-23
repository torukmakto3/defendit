/**
 * Document language, detected once from the file text and stored as a BCP-47
 * primary subtag (`es`, `pt`, `en`). Uncertain or very short text is `en`.
 * A missing stored value is also `en`, so sessions created before this column
 * keep the English path.
 */

const MIN_LETTERS = 40;

const WORD_LISTS: Record<string, string[]> = {
  es: [
    "el", "los", "las", "del", "al", "una", "con", "hay", "muy", "segun", "hasta",
    "debe", "deben", "tambien", "pero", "porque", "este", "esta", "estos", "estas",
    "sobre", "entre", "desde", "donde", "cuando", "como", "para", "que", "por",
    "sus", "son", "mas", "cual", "cuales", "documento",
  ],
  pt: [
    "nao", "sao", "voce", "voces", "com", "dos", "das", "pela", "pelo", "isso",
    "isto", "muito", "ate", "assim", "seu", "sua", "seus", "suas", "deve", "devem",
    "uma", "para", "que", "por", "em", "do", "da", "os", "as", "num", "numa",
    "porque", "este", "esta", "documento",
  ],
  en: [
    "the", "and", "of", "to", "in", "is", "that", "for", "with", "on", "this",
    "are", "from", "or", "an", "by", "be", "was", "were", "which", "their",
    "would", "should", "have", "has", "not", "but", "can", "will", "we", "it",
  ],
  fr: [
    "le", "les", "des", "une", "est", "dans", "pour", "avec", "sur", "pas",
    "sont", "cette", "ces", "aux", "qui", "nous", "vous", "elle", "dans", "une",
    "que", "par", "plus", "comme", "etre",
  ],
  de: [
    "der", "die", "das", "und", "ein", "eine", "ist", "nicht", "mit", "auf",
    "fur", "den", "dem", "von", "sich", "auch", "dass", "oder", "ein", "im",
  ],
};

const NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  ja: "Japanese",
};

/** Languages whose examiner lines, card fallbacks, and planted-error wording exist. */
export const AUTHORED_LANGUAGES = ["en", "es", "pt"] as const;
export type AuthoredLanguage = (typeof AUTHORED_LANGUAGES)[number];

export function resolveDocumentLanguage(stored: string | null | undefined): string {
  const code = normalizeLanguageTag(stored);
  return code || "en";
}

export function normalizeLanguageTag(stored: string | null | undefined): string {
  if (!stored) return "";
  const primary = stored.trim().toLowerCase().replace(/_/g, "-").split("-")[0] ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : "";
}

export function languageName(code: string | null | undefined): string {
  const resolved = resolveDocumentLanguage(code);
  return NAMES[resolved] ?? resolved;
}

export function isAuthoredLanguage(code: string | null | undefined): code is AuthoredLanguage {
  return (AUTHORED_LANGUAGES as readonly string[]).includes(resolveDocumentLanguage(code));
}

/**
 * Instruction appended to a generative prompt. UI chrome stays English;
 * this only covers text the model writes about the document.
 */
export function languageInstruction(code: string | null | undefined): string {
  const resolved = resolveDocumentLanguage(code);
  const name = languageName(resolved);
  const fairness =
    resolved === "en"
      ? "An answer in English must not be penalized for its wording, and an answer in another language is not a non-answer merely because of the language."
      : `An answer in ${name} or in English is equally acceptable and must not be penalized for the language it uses.`;
  return `Document language: ${resolved} (${name}). Write in ${name}. ${fairness}`;
}

/**
 * Cheap function-word detector. No model call. Accents are folded for the
 * word lists; ñ, ¿, ¡ and ã, õ, ç stay on the original text as script marks.
 * `ción` versus `ção` separates Spanish from Portuguese after folding.
 */
export function detectDocumentLanguage(text: string): string {
  const sample = text.replace(/\s+/g, " ").trim();
  const letters = sample.match(/\p{L}/gu);
  if (!letters || letters.length < MIN_LETTERS) return "en";

  const folded = fold(sample);
  const scores: Record<string, number> = {
    es: countWords(folded, WORD_LISTS.es) + countMarks(sample, /[ñ¿¡]/g) * 3 + countSuffix(folded, "cion") * 2,
    pt: countWords(folded, WORD_LISTS.pt) + countMarks(sample, /[ãõç]/g) * 3 + countSuffix(folded, "cao") * 2,
    en: countWords(folded, WORD_LISTS.en),
    fr: countWords(folded, WORD_LISTS.fr),
    de: countWords(folded, WORD_LISTS.de),
  };

  // também / también fold to the same token. Give it to whichever of es/pt already leads.
  const shared = countWords(folded, ["tambem"]);
  if (shared > 0 && scores.pt >= scores.es) scores.pt += shared;
  else scores.es += shared;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topCode, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  if (topCode === "en") return "en";
  if (topScore < 4) return "en";
  if (topScore < secondScore + 2) return "en";
  return topCode;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
}

function countWords(folded: string, words: string[]): number {
  let n = 0;
  for (const word of words) {
    const matches = folded.match(new RegExp(`(?:^|[^a-z])${word}(?=[^a-z]|$)`, "g"));
    n += matches?.length ?? 0;
  }
  return n;
}

function countMarks(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function countSuffix(folded: string, suffix: string): number {
  return folded.match(new RegExp(`${suffix}(?=[^a-z]|$)`, "g"))?.length ?? 0;
}
