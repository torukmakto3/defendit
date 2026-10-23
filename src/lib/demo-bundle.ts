import { claimsFromText } from "./claims";
import type { DemoSampleId } from "./demo-policy";
import { buildInterviewPlan } from "./probes";
import { questionPrefetchFingerprint, type QuestionPrefetch } from "./question-prefetch";
import type { Claim } from "./types";

/**
 * The two sample files, inlined so a serverless function does not have to
 * read `fixtures/demo` at request time. Tests assert these strings match
 * the files on disk.
 */
export const DEMO_SAMPLE_TEXT: Record<DemoSampleId, string> = {
  "harbor-readme": `# Harbor

Harbor is a local index for a team's notes. It runs on one machine and answers search from that machine's disk.

Harbor keeps each note as a plain Markdown file. Search reads those files and builds an in-memory index when the process starts.

The index assumes each workspace stays under 2,000 notes. That assumption is what lets the whole index fit in one process without a separate search service.

A note is visible to everyone on the workspace. Harbor does not apply per-person permissions in this version.

Restarting Harbor rebuilds the index from disk. Notes added while it is stopped show up on the next start.
`,
  "lane-memo": `# Lane

Lane is a review queue for short design packets. A reviewer opens one packet, leaves a decision, and the queue moves to the next.

The design assumes a reviewer finishes a packet in 12 minutes. One queue worker then covers a team of 40 people submitting one packet a day.

Packets are Markdown. Lane stores the decision next to the file hash so a later edit is visible.

Lane does not assign a packet twice. If a reviewer stops halfway, the packet returns to the queue after 12 minutes.

The 12-minute assumption is the load-bearing one. A slower review means the single worker falls behind.
`,
};

const DEMO_SEED: Record<DemoSampleId, string> = {
  "harbor-readme": "demo-sample-harbor-readme",
  "lane-memo": "demo-sample-lane-memo",
};

interface DemoBundle {
  text: string;
  claims: Claim[];
  prefetch: QuestionPrefetch;
}

function bundled(id: DemoSampleId): DemoBundle {
  const text = DEMO_SAMPLE_TEXT[id];
  const claims = claimsFromText(text);
  const plan = buildInterviewPlan({
    claims,
    difficulty: "standard",
    seed: DEMO_SEED[id],
    shape: "demo",
  });
  return {
    text,
    claims,
    prefetch: {
      seed: DEMO_SEED[id],
      difficulty: "standard",
      fingerprint: questionPrefetchFingerprint(claims, undefined, "demo", "en"),
      plan,
      restPhrased: true,
      firstQuestionMs: 0,
    },
  };
}

/** Built once. A demo copies this instead of calling a model before the charge. */
const BUNDLES: Record<DemoSampleId, DemoBundle> = {
  "harbor-readme": bundled("harbor-readme"),
  "lane-memo": bundled("lane-memo"),
};

/** Per-request copy. Probe ids stay stable for the life of the process. */
export function demoSampleBundle(id: DemoSampleId): DemoBundle {
  const source = BUNDLES[id];
  return {
    text: source.text,
    claims: structuredClone(source.claims),
    prefetch: structuredClone(source.prefetch),
  };
}
