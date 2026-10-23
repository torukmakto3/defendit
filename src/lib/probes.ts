import { clipExcerpt } from "./excerpt";
import { newId } from "./ids";
import { resolveDocumentLanguage, type AuthoredLanguage } from "./language";
import { mulberry32, seedFromString } from "./rng";
import type { Claim, ClaimKind, Difficulty, InterviewPlan, Probe, ProbeType, QuestionDifficulty } from "./types";

type Prefer = ClaimKind | "high";

interface BlueprintSlot {
  type: ProbeType;
  difficulty: QuestionDifficulty;
  prefer: Prefer[];
}

/**
 * Fixed coverage per difficulty. The seed shuffles order and which claim fills
 * a slot. It does not change how many of each type or difficulty are asked.
 */
/**
 * Sample demo. Three questions, difficulty fixed by the caller (standard, so
 * the interview stays on the text channel). One slot plants an error on an
 * assumption. The seed still only shuffles order and which claim fills a slot.
 */
const DEMO_SLOTS: BlueprintSlot[] = [
  { type: "explain_back", difficulty: 1, prefer: ["claim", "high"] },
  { type: "planted_error", difficulty: 2, prefer: ["assumption", "number"] },
  { type: "weakest_link", difficulty: 2, prefer: ["assumption"] },
];

const BLUEPRINT: Record<Difficulty, BlueprintSlot[]> = {
  standard: [
    { type: "explain_back", difficulty: 1, prefer: ["claim", "high"] },
    { type: "explain_back", difficulty: 2, prefer: ["number", "high"] },
    { type: "weakest_link", difficulty: 2, prefer: ["assumption"] },
    { type: "confidence", difficulty: 1, prefer: ["claim"] },
    { type: "counterfactual", difficulty: 2, prefer: ["number"] },
  ],
  hard: [
    { type: "explain_back", difficulty: 2, prefer: ["high", "claim"] },
    { type: "counterfactual", difficulty: 3, prefer: ["number"] },
    { type: "planted_error", difficulty: 2, prefer: ["number"] },
    { type: "weakest_link", difficulty: 2, prefer: ["assumption"] },
    { type: "prediction", difficulty: 3, prefer: ["assumption", "high"] },
    { type: "confidence", difficulty: 1, prefer: ["claim"] },
  ],
  expert: [
    { type: "explain_back", difficulty: 2, prefer: ["high", "claim"] },
    { type: "counterfactual", difficulty: 3, prefer: ["number"] },
    { type: "counterfactual", difficulty: 3, prefer: ["assumption", "number"] },
    { type: "planted_error", difficulty: 3, prefer: ["number"] },
    { type: "weakest_link", difficulty: 2, prefer: ["assumption"] },
    { type: "prediction", difficulty: 3, prefer: ["high", "assumption"] },
    { type: "confidence", difficulty: 2, prefer: ["claim"] },
  ],
};

export function blueprintMix(difficulty: Difficulty): string[] {
  return BLUEPRINT[difficulty].map((s) => `${s.type}:${s.difficulty}`).sort();
}

export function claimKind(claim: Claim): ClaimKind {
  if (claim.kind === "claim" || claim.kind === "assumption" || claim.kind === "number") return claim.kind;
  if (/\d/.test(claim.text) || (claim.figures?.length ?? 0) > 0) return "number";
  if (/\b(assum|risk|depend|contingent|fragile|supone|riesgo|depende|pressup|risco)\b/i.test(claim.text)) return "assumption";
  return "claim";
}

export function buildInterviewPlan(opts: {
  claims: Claim[];
  difficulty: Difficulty;
  seed: string;
  pinnedClaimIds?: string[];
  /** `demo` uses the short sample blueprint. Omit it for a full interview. */
  shape?: "demo";
  /** Document language. Missing or unknown stays English, including old sessions. */
  language?: string | null;
}): InterviewPlan {
  const language = authoredLanguage(opts.language);
  const rand = mulberry32(seedFromString(opts.seed));
  const slots = shuffle([...(opts.shape === "demo" ? DEMO_SLOTS : BLUEPRINT[opts.difficulty])], rand);
  const pinned = new Set(opts.pinnedClaimIds ?? []);
  const used = new Set<string>();
  const probes = slots.map((slot) => {
    const claim = pickClaim(opts.claims, slot, used, pinned, rand);
    return buildProbe(claim, slot.type, slot.difficulty, rand, language);
  });
  return {
    seed: opts.seed,
    difficulty: opts.difficulty,
    probes,
    plantedErrorClaimId: probes.find((p) => p.type === "planted_error")?.claimId,
  };
}

function preference(claim: Claim, slot: BlueprintSlot, pinned: Set<string>): number {
  const kind = claimKind(claim);
  let score = 0;
  if (slot.prefer.includes(kind)) score += 2;
  if (slot.prefer[0] === kind) score += 1;
  if (slot.prefer.includes("high") && claim.stakes === "high") score += 2;
  if (pinned.has(claim.id)) score += 3;
  return score;
}

function pickClaim(
  claims: Claim[],
  slot: BlueprintSlot,
  used: Set<string>,
  pinned: Set<string>,
  rand: () => number,
): Claim {
  const pool = claims.length ? claims : [];
  if (pool.length === 0) {
    return { id: "claim_missing", text: "The deliverable's main claim.", section: "General", sourceSpan: "", stakes: "medium" };
  }
  const unused = pool.filter((c) => !used.has(c.id));
  const candidates = unused.length ? unused : pool;
  const best = Math.max(...candidates.map((c) => preference(c, slot, pinned)));
  const top = candidates.filter((c) => preference(c, slot, pinned) === best);
  const pick = top[Math.floor(rand() * top.length)];
  used.add(pick.id);
  return pick;
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Fallback wording when the model can't phrase questions. Several variants per
 * probe type, picked by the seeded RNG, so even offline interviews vary.
 * {c} = claim text, {s} = section, {q} = the cited source span.
 */
const TEMPLATES: Record<Exclude<ProbeType, "planted_error">, string[]> = {
  explain_back: [
    'Walk me through why this holds: "{q}". What in the document supports "{c}"?',
    'Explain "{q}" as if to a skeptical partner. Where does "{c}" come from?',
    'Your deliverable says "{q}". How did you get to "{c}"?',
    'Take "{q}". What is the reasoning behind "{c}", step by step?',
  ],
  counterfactual: [
    'Suppose the main assumption behind "{q}" moved 30% against you. What breaks first in "{c}"?',
    'If the inputs behind "{q}" turned out half as favourable, would "{c}" survive? Why?',
    'What would have to change for "{c}" — specifically "{q}" — to stop being true?',
  ],
  weakest_link: [
    'In "{c}", the passage "{q}" carries a fragile assumption. Which one, and why is it still acceptable?',
    'If you had to bet against "{q}" inside "{c}", which part would it be?',
    'Where is "{c}" most exposed if a reviewer pushes on "{q}"?',
  ],
  prediction: [
    'If someone challenged "{q}" from "{c}" in a review meeting, what would they ask first?',
    'Predict the toughest objection to "{q}" in "{c}". How would you answer it?',
    'What number around "{q}" would you check first if "{c}" came in below plan?',
  ],
  confidence: [
    'From 0 to 100, how confident are you that "{q}" in "{c}" is right? What would move that number?',
    'How sure are you about "{c}", citing "{q}", from 0 to 100? Name one thing that would lower it.',
  ],
};

const PLANTED_LEADS = [
  "I'm looking at this excerpt from your deliverable. Is it accurate as written, or is something off?",
  "Here is a line from your document. Does it match what you wrote?",
  "Check this excerpt for me. Anything wrong with it?",
];

const ES_TEMPLATES: Record<Exclude<ProbeType, "planted_error">, string[]> = {
  explain_back: [
    'Explícame por qué se sostiene esto: "{q}". ¿Qué parte del documento apoya "{c}"?',
    'Explica "{q}" como si se lo contaras a un colega escéptico. ¿De dónde sale "{c}"?',
    'Tu documento dice "{q}". ¿Cómo llegaste a "{c}"?',
    'Toma "{q}". ¿Cuál es el razonamiento detrás de "{c}", paso a paso?',
  ],
  counterfactual: [
    'Supón que el supuesto principal detrás de "{q}" se mueve un 30% en tu contra. ¿Qué se rompe primero en "{c}"?',
    'Si los datos detrás de "{q}" fueran la mitad de favorables, ¿sobreviviría "{c}"? ¿Por qué?',
    '¿Qué tendría que cambiar para que "{c}" — en concreto "{q}" — dejara de ser cierto?',
  ],
  weakest_link: [
    'En "{c}", el pasaje "{q}" apoya un supuesto frágil. ¿Cuál es, y por qué sigue siendo aceptable?',
    'Si tuvieras que apostar contra "{q}" dentro de "{c}", ¿qué parte sería?',
    '¿Dónde queda "{c}" más expuesto si un revisor insiste en "{q}"?',
  ],
  prediction: [
    'Si alguien cuestionara "{q}" de "{c}" en una revisión, ¿qué preguntaría primero?',
    'Anticipa la objeción más dura a "{q}" en "{c}". ¿Cómo la responderías?',
    '¿Qué cifra alrededor de "{q}" comprobarías primero si "{c}" quedara por debajo del plan?',
  ],
  confidence: [
    'Del 0 al 100, ¿qué tan seguro estás de que "{q}" en "{c}" es correcto? ¿Qué movería ese número?',
    '¿Qué tan seguro estás de "{c}", citando "{q}", del 0 al 100? Nombra algo que lo bajaría.',
  ],
};

const PT_TEMPLATES: Record<Exclude<ProbeType, "planted_error">, string[]> = {
  explain_back: [
    'Explique porque isto se sustenta: "{q}". O que no documento apoia "{c}"?',
    'Explique "{q}" como se falasse com um colega cético. De onde vem "{c}"?',
    'O seu documento diz "{q}". Como chegou a "{c}"?',
    'Tome "{q}". Qual é o raciocínio por trás de "{c}", passo a passo?',
  ],
  counterfactual: [
    'Suponha que o pressuposto principal por trás de "{q}" se mova 30% contra si. O que quebra primeiro em "{c}"?',
    'Se os dados por trás de "{q}" fossem metade tão favoráveis, "{c}" sobreviveria? Porquê?',
    'O que teria de mudar para "{c}" — em concreto "{q}" — deixar de ser verdade?',
  ],
  weakest_link: [
    'Em "{c}", a passagem "{q}" apoia um pressuposto frágil. Qual é, e porque continua aceitável?',
    'Se tivesse de apostar contra "{q}" dentro de "{c}", que parte seria?',
    'Onde fica "{c}" mais exposto se um revisor insistir em "{q}"?',
  ],
  prediction: [
    'Se alguém questionasse "{q}" de "{c}" numa revisão, o que perguntaria primeiro?',
    'Antecipe a objeção mais dura a "{q}" em "{c}". Como responderia?',
    'Que número à volta de "{q}" verificaria primeiro se "{c}" ficasse abaixo do plano?',
  ],
  confidence: [
    'De 0 a 100, quão confiante está de que "{q}" em "{c}" está certo? O que moveria esse número?',
    'Quão seguro está de "{c}", citando "{q}", de 0 a 100? Diga uma coisa que o baixaria.',
  ],
};

const ES_LEADS = [
  "Estoy mirando este fragmento de tu documento. ¿Está bien como está escrito, o hay algo que no cuadra?",
  "Aquí hay una línea de tu documento. ¿Coincide con lo que escribiste?",
  "Revisa este fragmento. ¿Hay algo que esté mal?",
];

const PT_LEADS = [
  "Estou a ver este excerto do seu documento. Está correto como está escrito, ou há algo fora do lugar?",
  "Aqui está uma linha do seu documento. Corresponde ao que escreveu?",
  "Verifique este excerto. Há alguma coisa errada?",
];

const TEMPLATES_BY_LANGUAGE: Record<AuthoredLanguage, Record<Exclude<ProbeType, "planted_error">, string[]>> = {
  en: TEMPLATES,
  es: ES_TEMPLATES,
  pt: PT_TEMPLATES,
};

const LEADS_BY_LANGUAGE: Record<AuthoredLanguage, string[]> = {
  en: PLANTED_LEADS,
  es: ES_LEADS,
  pt: PT_LEADS,
};

function authoredLanguage(code: string | null | undefined): AuthoredLanguage {
  const resolved = resolveDocumentLanguage(code);
  if (resolved === "es" || resolved === "pt") return resolved;
  return "en";
}

function fill(template: string, claim: Claim, max: number): string {
  const quote = clipExcerpt((claim.sourceSpan || claim.text).trim() || claim.text, 80);
  return template
    .split("{c}")
    .join(clipExcerpt(claim.text, max))
    .split("{s}")
    .join(claim.section)
    .split("{q}")
    .join(quote);
}

function pick<T>(items: T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}

export function plantedQuestion(lead: string, altered: string): string {
  return `${lead}\n\n"${altered}"`;
}

function buildProbe(
  claim: Claim,
  type: ProbeType,
  difficulty: QuestionDifficulty,
  rand: () => number,
  language: AuthoredLanguage,
): Probe {
  const id = newId("probe");
  if (type === "planted_error") {
    const altered = plantError(claim.text, rand, language);
    return {
      id,
      claimId: claim.id,
      type,
      difficulty,
      question: plantedQuestion(pick(LEADS_BY_LANGUAGE[language], rand), altered),
      plantedContent: altered,
      sourceSpan: claim.sourceSpan,
      expectedFocus: "detect alteration",
    };
  }
  const expectedFocus: Record<Exclude<ProbeType, "planted_error">, string> = {
    explain_back: claim.sourceSpan,
    counterfactual: "sensitivity / assumptions",
    weakest_link: claim.section,
    prediction: claim.section,
    confidence: "calibration",
  };
  return {
    id,
    claimId: claim.id,
    type,
    difficulty,
    question: fill(pick(TEMPLATES_BY_LANGUAGE[language][type], rand), claim, type === "confidence" ? 100 : 140),
    sourceSpan: claim.sourceSpan,
    expectedFocus: expectedFocus[type],
  };
}

const FOLLOW_UP: Record<AuthoredLanguage, (quote: string, claim: string) => string> = {
  en: (quote, claim) =>
    `One more check, because that answer was read differently by different graders. What in the document supports "${quote}" in "${claim}", and which assumption would change your answer?`,
  es: (quote, claim) =>
    `Una comprobación más, porque esa respuesta se leyó de formas distintas. ¿Qué parte del documento sostiene "${quote}" en "${claim}", y qué supuesto cambiaría tu respuesta?`,
  pt: (quote, claim) =>
    `Mais uma verificação, porque essa resposta foi lida de formas diferentes. O que no documento sustenta "${quote}" em "${claim}", e que pressuposto mudaria a sua resposta?`,
};

/** One extra question when graders disagree. Wording is fixed so it costs no model call. */
export function makeFollowUpProbe(claim: Claim, source: Probe, language?: string | null): Probe {
  const code = authoredLanguage(language);
  const quote = clipExcerpt(claim.sourceSpan || claim.text, 80);
  const text = clipExcerpt(claim.text, 120);
  return {
    id: newId("probe"),
    claimId: claim.id,
    type: "explain_back",
    difficulty: source.difficulty ?? 2,
    followUpOf: source.id,
    question: FOLLOW_UP[code](quote, text),
    sourceSpan: claim.sourceSpan,
    expectedFocus: claim.sourceSpan,
  };
}

/** Word swaps that flip meaning but read naturally (both directions). */
const SWAPS: [string, string][] = [
  ["increase", "decrease"], ["increases", "decreases"], ["increased", "decreased"],
  ["higher", "lower"], ["above", "below"], ["more", "less"], ["rose", "fell"],
  ["before", "after"], ["daily", "weekly"], ["monthly", "quarterly"],
  ["always", "never"], ["safe", "unsafe"], ["nullable", "non-nullable"],
  ["expand", "contract"], ["faster", "slower"], ["cheaper", "more expensive"],
  ["first", "last"], ["minimum", "maximum"], ["includes", "excludes"],
];

const EXTRA_SWAPS: Record<AuthoredLanguage, [string, string][]> = {
  en: [],
  es: [
    ["aumenta", "disminuye"],
    ["mayor", "menor"],
    ["antes", "después"],
    ["siempre", "nunca"],
    ["incluye", "excluye"],
    ["seguro", "inseguro"],
    ["cuatro", "seis"],
    ["seis", "ocho"],
  ],
  pt: [
    ["aumenta", "diminui"],
    ["maior", "menor"],
    ["antes", "depois"],
    ["sempre", "nunca"],
    ["inclui", "exclui"],
    ["seguro", "inseguro"],
    ["quatro", "seis"],
    ["seis", "oito"],
  ],
};

const AUDIT_SUFFIX: Record<AuthoredLanguage, string> = {
  en: ", as confirmed by an external audit.",
  es: ", según una auditoría externa.",
  pt: ", conforme uma auditoria externa.",
};

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * Alter one fact so a careful author would notice: numbers first, then a
 * meaning-flipping word swap. Only as a last resort, an added claim in the
 * document language. The returned string is the full altered span. Callers
 * that speak or display it must not cut it with a byte slice.
 */
export function plantError(text: string, rand: () => number, language?: string | null): string {
  const code = authoredLanguage(language);
  const numbers = [...text.matchAll(/\$?\d[\d,]*(\.\d+)?(\s?(?:%|x|ms|M|B|k)(?![A-Za-z]))?/g)];
  if (numbers.length) {
    const m = numbers[Math.floor(rand() * numbers.length)];
    const original = m[0];
    const n = parseFloat(original.replace(/[$,]/g, ""));
    if (!Number.isNaN(n) && n !== 0) {
      const factor = rand() > 0.5 ? 1.5 : 0.6;
      const raw = n * factor;
      const changed = Number.isInteger(n) ? String(Math.max(1, Math.round(raw))) : raw.toFixed(1);
      const suffix = m[2] ?? "";
      const prefix = original.startsWith("$") ? "$" : "";
      return text.replace(original, `${prefix}${changed}${suffix}`);
    }
  }
  const swaps = [...SWAPS, ...EXTRA_SWAPS[code]];
  const candidates = swaps.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]).filter(([from]) => wordPattern(from).test(text));
  if (candidates.length) {
    const [from, to] = candidates[Math.floor(rand() * candidates.length)];
    return text.replace(wordPattern(from), (w) => (w[0] === w[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
  }
  return `${text.replace(/[.!?…]+$/u, "")}${AUDIT_SUFFIX[code]}`;
}

/** Learn mode: private probe sequence, never shared. */
export function buildLearnPlan(claims: Claim[], seed: string, language?: string | null): InterviewPlan {
  return buildInterviewPlan({
    claims,
    difficulty: "hard",
    seed: `learn:${seed}`,
    language,
  });
}
