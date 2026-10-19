import { mulberry32, pickN, seedFromString } from "./rng";
import type { Claim, Difficulty, InterviewPlan, Probe, ProbeType } from "./types";
import { newId } from "./ids";

const PROBE_WEIGHTS: Record<Difficulty, ProbeType[]> = {
  standard: ["explain_back", "explain_back", "weakest_link", "confidence"],
  hard: [
    "explain_back",
    "counterfactual",
    "planted_error",
    "weakest_link",
    "prediction",
  ],
  expert: [
    "explain_back",
    "counterfactual",
    "counterfactual",
    "planted_error",
    "weakest_link",
    "prediction",
  ],
};

const TARGET_COUNTS: Record<Difficulty, number> = {
  standard: 5,
  hard: 6,
  expert: 7,
};

export function buildInterviewPlan(opts: {
  claims: Claim[];
  difficulty: Difficulty;
  seed: string;
  pinnedClaimIds?: string[];
}): InterviewPlan {
  const rand = mulberry32(seedFromString(opts.seed));
  const types = PROBE_WEIGHTS[opts.difficulty];
  const count = TARGET_COUNTS[opts.difficulty];

  const high = opts.claims.filter((c) => c.stakes === "high");
  const rest = opts.claims.filter((c) => c.stakes !== "high");
  const pinned = opts.claims.filter((c) =>
    opts.pinnedClaimIds?.includes(c.id),
  );

  const pool = [
    ...pinned,
    ...pickN(high, Math.max(3, Math.ceil(count * 0.6)), rand),
    ...pickN(rest, count, rand),
  ];
  const unique = dedupeClaims(pool).slice(0, count);

  let plantedErrorClaimId: string | undefined;
  if (opts.difficulty !== "standard" && unique.length > 0) {
    const idx = Math.floor(rand() * unique.length);
    plantedErrorClaimId = unique[idx].id;
  }

  // Seeded shuffle of the type mix, so interviews don't all open the same way.
  const order = shuffle([...types], rand);
  const probes: Probe[] = unique.map((claim, i) => {
    let type = order[i % order.length];
    if (plantedErrorClaimId && claim.id === plantedErrorClaimId) {
      type = "planted_error";
    } else if (type === "planted_error" && claim.id !== plantedErrorClaimId) {
      type = "counterfactual";
    }
    return buildProbe(claim, type, rand);
  });

  return {
    seed: opts.seed,
    difficulty: opts.difficulty,
    probes,
    plantedErrorClaimId,
  };
}

function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const c of claims) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
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
 * {c} = claim text, {s} = section.
 */
const TEMPLATES: Record<Exclude<ProbeType, "planted_error">, string[]> = {
  explain_back: [
    'Walk me through why this holds: "{c}". What in the document supports it?',
    'Explain "{c}" as if to a skeptical partner. Where does that come from?',
    'Your deliverable says "{c}". How did you get there?',
    'Take "{c}". What is the reasoning behind it, step by step?',
  ],
  counterfactual: [
    'Suppose the main assumption behind "{c}" moved 30% against you. What breaks first?',
    'If the inputs behind "{c}" turned out half as favourable, would your conclusion survive? Why?',
    'What would have to change for "{c}" to stop being true, and how likely is that?',
  ],
  weakest_link: [
    'In the "{s}" section, which assumption is the most fragile, and why is it still acceptable?',
    'If you had to bet against one part of "{s}", which would it be?',
    'Where is "{s}" most exposed if a reviewer pushes hard?',
  ],
  prediction: [
    'If someone challenged the "{s}" conclusion in a review meeting, what would they ask first?',
    'Predict the toughest objection to "{s}". How would you answer it?',
    'What number in "{s}" would you check first if results came in below plan?',
  ],
  confidence: [
    'From 0 to 100, how confident are you that "{c}" is right? What would move that number?',
    'How sure are you about "{c}", 0 to 100? Name one thing that would lower it.',
  ],
};

const PLANTED_LEADS = [
  "I'm looking at this excerpt from your deliverable. Is it accurate as written, or is something off?",
  "Here is a line from your document. Does it match what you wrote?",
  "Check this excerpt for me. Anything wrong with it?",
];

function fill(template: string, claim: Claim, max: number): string {
  return template.replace("{c}", truncate(claim.text, max)).replace("{s}", claim.section);
}

function pick<T>(items: T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}

export function plantedQuestion(lead: string, altered: string): string {
  return `${lead}\n\n"${altered}"`;
}

function buildProbe(claim: Claim, type: ProbeType, rand: () => number): Probe {
  const id = newId("probe");
  if (type === "planted_error") {
    const altered = plantError(claim.text, rand);
    return {
      id,
      claimId: claim.id,
      type,
      question: plantedQuestion(pick(PLANTED_LEADS, rand), altered),
      plantedContent: altered,
      expectedFocus: "detect alteration",
    };
  }
  const expectedFocus: Record<typeof type, string> = {
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
    question: fill(pick(TEMPLATES[type], rand), claim, type === "confidence" ? 100 : 160),
    expectedFocus: expectedFocus[type],
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
