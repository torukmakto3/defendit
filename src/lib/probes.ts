import { mulberry32, seedFromString } from "./rng";
import type { Claim, ClaimKind, Difficulty, InterviewPlan, Probe, ProbeType, QuestionDifficulty } from "./types";
import { newId } from "./ids";

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
  if (/\b(assum|risk|depend|contingent|fragile)\b/i.test(claim.text)) return "assumption";
  return "claim";
}

export function buildInterviewPlan(opts: {
  claims: Claim[];
  difficulty: Difficulty;
  seed: string;
  pinnedClaimIds?: string[];
}): InterviewPlan {
  const rand = mulberry32(seedFromString(opts.seed));
  const slots = shuffle([...BLUEPRINT[opts.difficulty]], rand);
  const pinned = new Set(opts.pinnedClaimIds ?? []);
  const used = new Set<string>();
  const probes = slots.map((slot) => {
    const claim = pickClaim(opts.claims, slot, used, pinned, rand);
    return buildProbe(claim, slot.type, slot.difficulty, rand);
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

function fill(template: string, claim: Claim, max: number): string {
  const quote = truncate((claim.sourceSpan || claim.text).trim() || claim.text, 80);
  return template
    .split("{c}")
    .join(truncate(claim.text, max))
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

function buildProbe(claim: Claim, type: ProbeType, difficulty: QuestionDifficulty, rand: () => number): Probe {
  const id = newId("probe");
  if (type === "planted_error") {
    const altered = plantError(claim.text, rand);
    return {
      id,
      claimId: claim.id,
      type,
      difficulty,
      question: plantedQuestion(pick(PLANTED_LEADS, rand), altered),
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
    question: fill(pick(TEMPLATES[type], rand), claim, type === "confidence" ? 100 : 140),
    sourceSpan: claim.sourceSpan,
    expectedFocus: expectedFocus[type],
  };
}

/** One extra question when graders disagree. Wording is fixed so it costs no model call. */
export function makeFollowUpProbe(claim: Claim, source: Probe): Probe {
  return {
    id: newId("probe"),
    claimId: claim.id,
    type: "explain_back",
    difficulty: source.difficulty ?? 2,
    followUpOf: source.id,
    question: `One more check, because that answer was read differently by different graders. What in the document supports "${truncate(claim.sourceSpan || claim.text, 80)}" in "${truncate(claim.text, 120)}", and which assumption would change your answer?`,
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

/**
 * Alter one fact so a careful author would notice: numbers first, then a
 * meaning-flipping word swap. Only as a last resort, an added claim.
 */
export function plantError(text: string, rand: () => number): string {
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
  const candidates = SWAPS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]).filter(([from]) => new RegExp(`\\b${from}\\b`, "i").test(text));
  if (candidates.length) {
    const [from, to] = candidates[Math.floor(rand() * candidates.length)];
    return text.replace(new RegExp(`\\b${from}\\b`, "i"), (w) => (w[0] === w[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
  }
  return `${text.replace(/\.$/, "")}, as confirmed by an external audit.`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Learn mode: private probe sequence, never shared. */
export function buildLearnPlan(claims: Claim[], seed: string): InterviewPlan {
  return buildInterviewPlan({
    claims,
    difficulty: "hard",
    seed: `learn:${seed}`,
  });
}
