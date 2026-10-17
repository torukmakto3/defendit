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

  const probes: Probe[] = unique.map((claim, i) => {
    let type = types[i % types.length];
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

function buildProbe(claim: Claim, type: ProbeType, rand: () => number): Probe {
  const id = newId("probe");
  switch (type) {
    case "explain_back":
      return {
        id,
        claimId: claim.id,
        type,
        question: `Walk me through why this holds: "${truncate(claim.text, 160)}". What evidence in the document supports it?`,
        expectedFocus: claim.sourceSpan,
      };
    case "counterfactual":
      return {
        id,
        claimId: claim.id,
        type,
        question: `What if a key assumption behind "${truncate(claim.text, 120)}" moved 30% against you? What breaks first, and does the recommendation change?`,
        expectedFocus: "sensitivity / assumptions",
      };
    case "weakest_link":
      return {
        id,
        claimId: claim.id,
        type,
        question: `Looking at the "${claim.section}" section: what is the most fragile assumption, and why is it still acceptable?`,
        expectedFocus: claim.section,
      };
    case "planted_error": {
      const altered = plantError(claim.text, rand);
      return {
        id,
        claimId: claim.id,
        type,
        question: `I'm looking at this excerpt from your deliverable. Is it accurate as written, or is something off?\n\n"${altered}"`,
        plantedContent: altered,
        expectedFocus: "detect alteration",
      };
    }
    case "prediction":
      return {
        id,
        claimId: claim.id,
        type,
        question: `Before we look it up: if someone challenged the "${claim.section}" conclusion in a review meeting, what is the first follow-up question you would expect?`,
        expectedFocus: claim.section,
      };
    case "confidence":
      return {
        id,
        claimId: claim.id,
        type,
        question: `On a scale of 0–100, how confident are you that "${truncate(claim.text, 100)}" is correct? Briefly say what would raise or lower that confidence.`,
        expectedFocus: "calibration",
      };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function plantError(text: string, rand: () => number): string {
  const numberMatch = text.match(/\d+(\.\d+)?%?/);
  if (numberMatch) {
    const original = numberMatch[0];
    const n = parseFloat(original);
    if (!Number.isNaN(n)) {
      const bumped = original.includes("%")
        ? `${Math.round(n * (rand() > 0.5 ? 1.35 : 0.65))}%`
        : String(Math.round(n * (rand() > 0.5 ? 1.4 : 0.6) * 10) / 10);
      return text.replace(original, bumped);
    }
  }
  if (/increase|grow|higher|up/i.test(text)) {
    return text.replace(/increase|grow|higher|up/i, "decrease");
  }
  if (/decrease|lower|down|fall/i.test(text)) {
    return text.replace(/decrease|lower|down|fall/i, "increase");
  }
  return `${text} [Note: figures were independently verified by third-party audit.]`;
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
