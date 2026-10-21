/**
 * Spoken form of examiner text.
 *
 * Speech engines read `audit_checker.py` as "audit underscore checker dot py",
 * `registry.json` as "registry dot json", and a field dump as
 * "has adaptive circuit breaker false". This module rewrites only the string
 * that is sent to a speech engine.
 *
 * The written transcript and the on-screen question stay exact. Callers keep
 * the original text for the UI and pass the returned text to TTS. Learn
 * flashcards (#30) reuse `speakableCardText` the same way: written card text
 * stays exact, and only the spoken side goes through here.
 *
 * The voice agent vendors this file at `agent/src/speech/speakable.ts`.
 * `tests/speakable.test.ts` fails if the two copies diverge.
 *
 * Rules cover filenames, identifiers, and field dumps. An optional rewrite
 * (a cheap or Liquid model) may paraphrase excerpts. It is capped by a
 * timeout, cached, and dropped when the result still looks like code.
 */

/** Model attempt budget. The rules fallback must still finish under 500 ms. */
export const SPEAKABLE_BUDGET_MS = 400;

const CACHE_LIMIT = 200;

const EXTENSION_ROLE: Record<string, string> = {
  py: "script",
  pyi: "script",
  js: "script",
  jsx: "script",
  mjs: "script",
  cjs: "script",
  ts: "script",
  tsx: "script",
  sh: "script",
  bash: "script",
  rb: "script",
  go: "script",
  rs: "script",
  java: "script",
  kt: "script",
  php: "script",
  json: "file",
  jsonl: "file",
  yaml: "file",
  yml: "file",
  toml: "file",
  xml: "file",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xlsx: "spreadsheet",
  xls: "spreadsheet",
  md: "document",
  txt: "document",
  pdf: "document",
  docx: "document",
  doc: "document",
  html: "page",
  css: "stylesheet",
  sql: "query",
};

const EXTENSION_ALT = Object.keys(EXTENSION_ROLE)
  .sort((a, b) => b.length - a.length)
  .join("|");

export type SpeakableSource = "rules" | "model" | "cache";

export interface SpeakableResult {
  /** Text safe to send to a speech engine. */
  text: string;
  source: SpeakableSource;
  /** Milliseconds spent on this call, including a model attempt that timed out. */
  latencyMs: number;
}

/** Optional paraphrase. Throw or abort to fall back to the rules text. */
export type SpeakableRewrite = (text: string, signal: AbortSignal) => Promise<string>;

export interface SpeakableOptions {
  rewrite?: SpeakableRewrite;
  /** Defaults to {@link SPEAKABLE_BUDGET_MS}. */
  timeoutMs?: number;
  cache?: Map<string, string>;
  now?: () => number;
}

const sharedCache = new Map<string, string>();

export function createSpeakableCache(): Map<string, string> {
  return new Map();
}

/** Drop the process cache. Tests and a fresh interview process use this. */
export function clearSpeakableCache(): void {
  sharedCache.clear();
}

/**
 * Spoken form of one flashcard side. The stored card text is unchanged;
 * pass only the string that will be read aloud.
 */
export async function speakableCardText(text: string, options?: SpeakableOptions): Promise<string> {
  const result = await toSpeakable(text, options);
  return result.text;
}

/**
 * Rewrite `text` for TTS. Rules always run. When `rewrite` is set and the
 * rules pass changed the text, the model may replace that result until the
 * timeout, and a miss or a code-like answer keeps the rules text.
 */
export async function toSpeakable(text: string, options?: SpeakableOptions): Promise<SpeakableResult> {
  const clock = options?.now ?? nowMs;
  const started = clock();
  const timeoutMs = options?.timeoutMs ?? SPEAKABLE_BUDGET_MS;
  const cache = options?.cache ?? sharedCache;
  const key = `${options?.rewrite ? "m" : "r"}\n${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return { text: hit, source: "cache", latencyMs: Math.max(0, clock() - started) };
  }

  const rules = rulesSpeakable(text);
  let spoken = rules;
  let source: Exclude<SpeakableSource, "cache"> = "rules";
  if (options?.rewrite && rules !== text) {
    try {
      const modelText = await runRewrite(options.rewrite, text, timeoutMs);
      const accepted = acceptModel(rules, modelText);
      if (accepted) {
        spoken = accepted;
        source = "model";
      }
    } catch {
      spoken = rules;
      source = "rules";
    }
  }
  remember(cache, key, spoken);
  return { text: spoken, source, latencyMs: Math.max(0, clock() - started) };
}

/** True when the string still contains tokens a speech engine would spell out. */
export function isNaturallySpeakable(text: string): boolean {
  if (/_/.test(text)) return false;
  if (new RegExp(String.raw`\.(?:${EXTENSION_ALT})\b`, "i").test(text)) return false;
  if (/\b[\w.]+\s*=\s*\S/.test(text)) return false;
  if (/[{}[\]`]/.test(text)) return false;
  if (/\b(?:underscore|dot py|dot json)\b/i.test(text)) return false;
  return true;
}

/** Deterministic rewrite. Idempotent on its own output. */
export function rulesSpeakable(text: string): string {
  if (!text) return text;
  let out = text.replace(/\r\n/g, "\n");
  out = replaceFencedBlocks(out);
  out = replaceInlineCode(out);
  out = replaceJsonSpans(out);
  out = replaceKeyValues(out);
  out = replaceFilenames(out);
  out = replaceIdentifiers(out);
  out = replaceLooseFieldDumps(out);
  out = stripUnspeakableSymbols(out);
  return tidy(out);
}

function runRewrite(rewrite: SpeakableRewrite, text: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("speech rewrite timed out"));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([rewrite(text, controller.signal), abort]).finally(() => clearTimeout(timer));
}

function acceptModel(rules: string, modelText: string): string | null {
  const trimmed = modelText.trim();
  // A reply that still spells a filename or a field dump is not usable,
  // even if a second rules pass could scrub it. Keep the rules text.
  if (!trimmed || !isNaturallySpeakable(trimmed)) return null;
  const cleaned = tidy(rulesSpeakable(trimmed));
  if (!cleaned || !isNaturallySpeakable(cleaned)) return null;
  const floor = Math.min(12, rules.trim().length);
  if (cleaned.length < floor) return null;
  return cleaned;
}

function remember(cache: Map<string, string>, key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function nowMs(): number {
  return performance.now();
}

function extensionPattern(): RegExp {
  return new RegExp(
    String.raw`(^|[^\w])(?:[\w.-]+\/)*([A-Za-z][\w.-]*?)\.(${EXTENSION_ALT})\b`,
    "gi",
  );
}

function keyValuePattern(): RegExp {
  const key = String.raw`(?:"([A-Za-z_][\w.-]*)"|'([A-Za-z_][\w.-]*)'|([A-Za-z_][\w]*))`;
  const value = String.raw`(true|false|True|False|yes|no|on|off|null|none|None|nil|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
  return new RegExp(String.raw`${key}\s*(==|=|:)\s*${value}`, "g");
}

/** A prose colon (`holds: "the claim"`) is not a field dump. */
function isFieldKey(key: string, quoted: boolean, op: string): boolean {
  if (op.includes("=")) return true;
  if (quoted) return true;
  return key.includes("_") || /[a-z][A-Z]/.test(key);
}

function bracketValuePattern(): RegExp {
  return /\[["']([A-Za-z_][\w]*)["']\]\s*==?\s*(True|False|true|false|None|null|yes|no|-?\d+(?:\.\d+)?)/g;
}

function replaceFencedBlocks(text: string): string {
  return text.replace(/```(?:[a-z0-9]+)?[ \t]*\n?([\s\S]*?)```/gi, (_match, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return "a short excerpt from the document";
    const described = describeStructured(trimmed);
    if (described) return described;
    return paraphraseCode(trimmed);
  });
}

function replaceInlineCode(text: string): string {
  return text.replace(/`([^`\n]+)`/g, (_match, body: string) => describeToken(body.trim()));
}

function describeToken(body: string): string {
  if (!body) return "";
  const described = describeStructured(body);
  if (described) return described;
  const onlyFile = body.match(new RegExp(String.raw`^(?:[\w.-]+\/)*([A-Za-z][\w.-]*?)\.(${EXTENSION_ALT})$`, "i"));
  if (onlyFile) return filePhrase(onlyFile[1], onlyFile[2]);
  if (looksLikeCode(body)) return paraphraseCode(body);
  return tidy(replaceIdentifiers(replaceFilenames(replaceKeyValues(body))));
}

function replaceJsonSpans(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") {
      out += ch;
      continue;
    }
    const end = matchingBracket(text, i);
    if (end === -1) {
      out += ch;
      continue;
    }
    const described = describeStructured(text.slice(i, end + 1));
    if (!described) {
      out += ch;
      continue;
    }
    out += described;
    i = end;
  }
  return out;
}

function describeStructured(slice: string): string | null {
  const trimmed = slice.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return describeData(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function describeData(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "an empty list";
    return value.map((item) => describeData(item)).join(", ");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "an empty record";
    return entries.map(([key, entry]) => describeEntry(key, entry)).join(", and ");
  }
  return speakScalar(value);
}

function describeEntry(key: string, value: unknown): string {
  if (typeof value === "boolean") return fieldPhrase(key, value ? "true" : "false");
  if (typeof value === "number") return fieldPhrase(key, String(value));
  if (value === null) return fieldPhrase(key, "null");
  if (typeof value === "string") return fieldPhrase(key, JSON.stringify(value));
  return `the ${splitIdentifier(key)} is ${describeData(value)}`;
}

function replaceKeyValues(text: string): string {
  const withBrackets = text.replace(bracketValuePattern(), (_match, key: string, value: string) =>
    fieldPhrase(key, value),
  );
  return withBrackets.replace(
    keyValuePattern(),
    (match, quoted: string, single: string, bare: string, op: string, value: string) => {
      const key = quoted || single || bare;
      if (!key || !isFieldKey(key, Boolean(quoted || single), op)) return match;
      return fieldPhrase(key, value);
    },
  );
}

function replaceFilenames(text: string): string {
  return text.replace(extensionPattern(), (_match, lead: string, base: string, ext: string) => {
    return `${lead}${filePhrase(base, ext)}`;
  });
}

function replaceIdentifiers(text: string): string {
  let out = text.replace(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g, (id) => splitIdentifier(id));
  out = out.replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, (id) => splitIdentifier(id));
  out = out.replace(/\b[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, (id) => splitIdentifier(id));
  return out;
}

function replaceLooseFieldDumps(text: string): string {
  return text.replace(
    /\b(has|is)\s+([A-Za-z]+(?:\s+[A-Za-z]+){1,5}?)\s+(true|false)\b/gi,
    (match, verb: string, middle: string, value: string) => {
      if (!looksLikeBareField(middle)) return match;
      return fieldPhrase(`${verb} ${middle}`, value);
    },
  );
}

function looksLikeBareField(middle: string): boolean {
  const words = middle.trim().split(/\s+/);
  if (words.length < 2) return false;
  const blocked = new Set(["the", "this", "that", "your", "a", "an", "it", "to", "of", "for", "in", "on"]);
  return words.every((word) => /^[A-Za-z][A-Za-z0-9]*$/.test(word) && !blocked.has(word.toLowerCase()));
}

function stripUnspeakableSymbols(text: string): string {
  return text
    .replace(new RegExp(String.raw`\.(?:${EXTENSION_ALT})\b`, "gi"), " ")
    .replace(/[_`~|\\<>{}[\]]/g, " ")
    .replace(/#/g, " ")
    .replace(/\s*=+\s*/g, " ");
}

function paraphraseCode(body: string): string {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const add = (phrase: string) => {
    const clean = tidy(phrase);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    mentions.push(clean);
  };
  body.replace(extensionPattern(), (_match, _lead: string, base: string, ext: string) => {
    add(filePhrase(base, ext));
    return " ";
  });
  body.replace(bracketValuePattern(), (_match, key: string, value: string) => {
    add(fieldPhrase(key, value));
    return " ";
  });
  body.replace(keyValuePattern(), (_match, quoted: string, single: string, bare: string, op: string, value: string) => {
    const key = quoted || single || bare;
    if (key && isFieldKey(key, Boolean(quoted || single), op)) add(fieldPhrase(key, value));
    return " ";
  });
  const identifiers = body.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g) ?? [];
  if (mentions.length === 0) {
    for (const id of identifiers) add(splitIdentifier(id));
  }
  if (mentions.length === 0) return "a short excerpt from the document";
  return `a short excerpt that mentions ${joinList(mentions)}`;
}

function looksLikeCode(body: string): boolean {
  return /[_=;{}[\]]|```|\b(?:def|class|function|return|import|const|let)\b/.test(body) ||
    new RegExp(String.raw`\.(?:${EXTENSION_ALT})\b`, "i").test(body);
}

function filePhrase(base: string, ext: string): string {
  const words = splitIdentifier(base.replace(/\./g, " "));
  const role = EXTENSION_ROLE[ext.toLowerCase()] ?? "file";
  return `the ${words} ${role}`;
}

function fieldPhrase(key: string, rawValue: string): string {
  const words = splitIdentifier(key);
  const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
  if (/^(true|false|yes|no|on|off)$/i.test(value)) {
    const state = /^(true|yes|on)$/i.test(value) ? "on" : "off";
    if (words === "has" || words.startsWith("has ")) {
      const rest = words === "has" ? "it" : words.slice(4);
      return `whether it has ${withArticle(rest)}; it's set to ${state}`;
    }
    if (words === "is" || words.startsWith("is ")) {
      const rest = words === "is" ? "it" : words.slice(3);
      return `whether it is ${rest}; it's set to ${state}`;
    }
    return `${words}; it's set to ${state}`;
  }
  if (/^(null|none|nil)$/i.test(value)) return `the ${words}, which is unset`;
  return `the ${words} is ${speakScalar(value)}`;
}

function withArticle(rest: string): string {
  const trimmed = rest.trim();
  if (/^(a|an|the)\b/i.test(trimmed)) return trimmed;
  const article = /^[aeiou]/i.test(trimmed) ? "an" : "a";
  return `${article} ${trimmed}`;
}

function speakScalar(value: unknown): string {
  if (typeof value === "string") {
    return tidy(replaceIdentifiers(replaceFilenames(value)));
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "unset";
  return "a nested value";
}

function splitIdentifier(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matchingBracket(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(", ")} and ${last}`;
}

function tidy(text: string): string {
  return text
    .replace(/\b(the|a|an)\s+the\b/gi, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;?!])/g, "$1")
    .replace(/([,.;?!])(?=[A-Za-z])/g, "$1 ")
    .trim();
}
