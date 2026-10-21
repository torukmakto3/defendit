import { prepareCardFaces } from "../card-text";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types";
import { usageFromProviderBody } from "./usage";

/**
 * Offline mock provider: deterministic, no network.
 * Produces structured JSON when json=true based on purpose heuristics.
 */
export function createMockProvider(modelId = "mock-defend-v1"): LlmProvider {
  return {
    id: modelId,
    provider: "mock",
    retention: "mock",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const user = req.messages.filter((m) => m.role === "user").pop()?.content ?? "";
      const purpose = req.purpose ?? "generic";
      if (purpose === "grade") await waitForGrade(req, modelId);

      let content: string;
      if (req.json) {
        content = JSON.stringify(mockJson(purpose, user, modelId));
      } else {
        content = mockText(purpose, user);
      }

      return {
        content,
        modelId,
        provider: "mock",
        usage: usageFromProviderBody(null, {
          promptText: req.messages.map((message) => message.content).join("\n"),
          completionText: content,
        }),
      };
    },
  };
}

/**
 * Test knobs for the grading council. Unset in normal mock mode.
 * `MOCK_GRADER_DELAY_MS` pauses every grade. `MOCK_GRADER_HANG_MODEL` pauses
 * one model until the per-grader abort fires.
 */
async function waitForGrade(req: LlmRequest, modelId: string): Promise<void> {
  const hang = process.env.MOCK_GRADER_HANG_MODEL === modelId;
  const delay = hang ? 5_000 : Number(process.env.MOCK_GRADER_DELAY_MS || "0");
  if (!Number.isFinite(delay) || delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      req.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    if (req.signal?.aborted) {
      onAbort();
      return;
    }
    req.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mockJson(purpose: string, user: string, modelId: string): unknown {
  switch (purpose) {
    case "extract_claims":
      return mockClaims(user);
    case "learn_turn":
      return mockLearnTurn(user);
    case "defend_followup":
      return {
        followUp: followUpFromAnswer(user),
        done: false,
      };
    case "grade":
      return mockGrade(user, modelId);
    case "write_questions":
      return mockQuestions(user);
    case "write_flashcards":
      return mockFlashcards(user);
    default:
      return { ok: true, echo: user.slice(0, 200) };
  }
}

function mockFlashcards(user: string): unknown {
  const match = user.match(/<claims>\n([\s\S]*?)\n<\/claims>/);
  const claims = match
    ? (JSON.parse(match[1]) as { id: string; text: string; section: string; source?: string }[])
    : [];
  return {
    cards: claims.map((c) => {
      const faces = prepareCardFaces({ section: c.section, text: c.text, source: c.source || c.text });
      return { claimId: c.id, front: faces.front, back: faces.back, source: faces.source };
    }),
  };
}

/** Offline stand-in for the question writer: claim-specific, varied openings. */
function mockQuestions(user: string): unknown {
  const match = user.match(/<probes>\n([\s\S]*?)\n<\/probes>/);
  const items = match ? (JSON.parse(match[1]) as { probeId: string; type: string; claim: string }[]) : [];
  const openers = ["Talk me through", "Help me understand", "Defend", "Convince me of", "Unpack"];
  return {
    questions: items.map((it, i) => {
      const claim = it.claim.replace(/\s+/g, " ").slice(0, 120);
      if (it.type === "planted_error") return { probeId: it.probeId, question: "Read this line from your document carefully. Is it right?" };
      if (it.type === "counterfactual") return { probeId: it.probeId, question: `Say the key number in "${claim}" came in 30% worse. What gives way first?` };
      if (it.type === "confidence") return { probeId: it.probeId, question: `How confident are you, 0 to 100, that "${claim}" holds up?` };
      return { probeId: it.probeId, question: `${openers[i % openers.length]} "${claim}". What backs it up?` };
    }),
  };
}

function mockClaims(user: string): { claims: unknown[] } {
  const body = user.replace(/^[\s\S]*---DOCUMENT---\n?/, "");
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40);

  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);

  const raw = (paragraphs.length >= 3 ? paragraphs : sentences).slice(0, 12);
  const claims = raw.map((text, i) => {
    const figures = text.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
    const assumption = /\b(assum|risk|depend|contingent|fragile|if)\b/i.test(text);
    return {
      id: `claim_${i + 1}`,
      text: text.slice(0, 280),
      section: sectionName(i),
      sourceSpan: text.slice(0, 80),
      stakes: i % 3 === 0 ? "high" : i % 3 === 1 ? "medium" : "low",
      kind: figures.length ? "number" : assumption ? "assumption" : "claim",
      figures: figures.slice(0, 6),
    };
  });

  if (claims.length < 3) {
    return {
      claims: [
        {
          id: "claim_1",
          text: "The deliverable recommends proceeding based on projected returns.",
          section: "Recommendation",
          sourceSpan: "projected returns",
          stakes: "high",
        },
        {
          id: "claim_2",
          text: "Unit economics depend on retention and contribution margin assumptions.",
          section: "Unit economics",
          sourceSpan: "contribution margin",
          stakes: "high",
        },
        {
          id: "claim_3",
          text: "Key risks include competitive response and execution delays.",
          section: "Risks",
          sourceSpan: "competitive response",
          stakes: "medium",
        },
        {
          id: "claim_4",
          text: "Market sizing uses a top-down TAM estimate of $2.4B.",
          section: "Market",
          sourceSpan: "$2.4B",
          stakes: "medium",
        },
      ],
    };
  }
  return { claims };
}

function sectionName(i: number): string {
  const names = [
    "Thesis",
    "Market",
    "Unit economics",
    "Assumptions",
    "Risks",
    "Recommendation",
    "Evidence",
    "Timeline",
  ];
  return names[i % names.length];
}

function mockLearnTurn(user: string): unknown {
  const lower = user.toLowerCase();
  const answered =
    lower.includes("creator answer:") || lower.includes("answer:");
  if (!answered) {
    return {
      coachMessage:
        "Before we dig in: in your own words, what is the single most important claim this document is making?",
      gapHint: null,
      done: false,
    };
  }

  const answerMatch = user.match(/Creator answer:\s*([\s\S]*?)(?:\n\n|$)/i);
  const answer = (answerMatch?.[1] || "").trim();
  const thin = answer.split(/\s+/).length < 25;

  return {
    coachMessage: thin
      ? "That covers the headline. Push one level deeper: which assumption would break the conclusion if it were wrong, and why?"
      : "Good. Now a what-if: if the key number you just mentioned moved 30% against you, what changes in the recommendation?",
    gapHint: thin
      ? {
          section: "Assumptions",
          strength: "weak",
          note: "Explanation stayed surface-level; name the load-bearing assumption next.",
        }
      : {
          section: "Transfer",
          strength: "partial",
          note: "Reasoning present; still probe counterfactual sensitivity.",
        },
    done: /session turn:\s*[5-9]/i.test(user),
  };
}

function followUpFromAnswer(user: string): string {
  if (/don't know|not sure|unsure/i.test(user)) {
    return "That's fine to flag uncertainty. What would you need to look up to answer confidently?";
  }
  if (user.split(/\s+/).length < 20) {
    return "Can you walk me through the concrete numbers or sources that support that?";
  }
  return "What would have to be true for the opposite conclusion to hold?";
}

interface MockBlock {
  probeId: string;
  claimId: string;
  section: string;
  answer: string;
}

function parseGradeBlocks(user: string): MockBlock[] {
  const chunks = user.split(/\n\n(?=Probe id:)/);
  const blocks = chunks
    .map((chunk) => {
      const probeId = chunk.match(/Probe id:\s*(\S+)/)?.[1];
      const claimId = chunk.match(/Claim id:\s*(\S+)/)?.[1];
      const section = chunk.match(/Section:\s*([^\n]+)/)?.[1]?.trim();
      const answer = chunk.match(/Answer:\s*([\s\S]*?)(?:\nLatency ms:|$)/)?.[1]?.trim();
      if (!probeId || !claimId || answer === undefined) return null;
      return { probeId, claimId, section: section || "General", answer };
    })
    .filter((b): b is MockBlock => !!b);
  return blocks.length
    ? blocks
    : [{ probeId: "probe_1", claimId: "claim_1", section: "Overall", answer: user.slice(0, 180) }];
}

function mockGrade(user: string, modelId: string): unknown {
  const blocks = parseGradeBlocks(user);
  if (user.includes("FORCE_DISAGREE")) {
    const level = modelId.includes("strict") ? 0 : modelId.includes("lenient") ? 4 : 2;
    return {
      claimGrades: blocks.map((b) => ({
        probeId: b.probeId,
        claimId: b.claimId,
        section: b.section,
        scores: { accuracy: level, reasoning: level, transfer: level, errorDetection: level, ownership: level },
        band: level >= 3 ? "Strong" : level >= 2 ? "Partial" : "Weak",
        evidence: b.answer.slice(0, 180) || "no answer given",
        reason: "Spread forced for the disagreement check.",
      })),
      overallScore: level * 25,
    };
  }

  const bias = modelId.includes("strict") ? -0.4 : modelId.includes("lenient") ? 0.5 : 0;

  const claimGrades = blocks.map((b) => {
      const answer = b.answer;
      const words = answer.split(/\s+/).filter(Boolean).length;
      const hasBecause = /because|therefore|so that|which means/i.test(answer);
      const hasNumber = /\d/.test(answer);
      const unsure = /don't know|not sure|guess/i.test(answer);
      const caughtError = /wrong|incorrect|error|typo|should be|doesn't match|altered/i.test(answer);

      let accuracy = clamp(1.5 + words / 40 + (hasNumber ? 0.5 : 0) + bias);
      let reasoning = clamp(1.2 + (hasBecause ? 1.2 : 0.3) + words / 50 + bias);
      const transfer = clamp(1 + (/if |would |counter/i.test(answer) ? 1.5 : 0.4) + bias);
      const errorDetection = clamp(caughtError ? 3.5 : 1.5 + bias);
      let ownership = clamp(unsure ? 1 : 1.5 + (hasBecause ? 1 : 0) + bias);

      if (unsure) {
        accuracy = Math.min(accuracy, 1);
        reasoning = Math.min(reasoning, 1);
        ownership = Math.min(ownership, 1);
      }

      const avg = (accuracy + reasoning + transfer + errorDetection + ownership) / 5;
      const band = avg >= 3 ? "Strong" : avg >= 2 ? "Partial" : "Weak";

      return {
        probeId: b.probeId,
        claimId: b.claimId,
        section: b.section,
        scores: {
          accuracy: round1(accuracy),
          reasoning: round1(reasoning),
          transfer: round1(transfer),
          errorDetection: round1(errorDetection),
          ownership: round1(ownership),
        },
        band,
        evidence: answer.slice(0, 180) || "(no answer)",
        reason:
          band === "Strong"
            ? "Clear ownership of the claim with supporting reasoning."
            : band === "Partial"
              ? "Partial grasp; some gaps in transfer or specificity."
              : "Thin or uncertain answer relative to the claim.",
      };
    },
  );

  const overall =
    claimGrades.reduce((s, g) => {
      const v = Object.values(g.scores as Record<string, number>);
      return s + v.reduce((a, b) => a + b, 0) / v.length;
    }, 0) / Math.max(claimGrades.length, 1);

  return {
    claimGrades,
    overallScore: Math.round(clamp(overall) * 25), // 0-100
  };
}

function mockText(purpose: string, user: string): string {
  if (purpose === "learn_turn") {
    return "Let's start with the core thesis. Explain it back to me in two sentences.";
  }
  return `Acknowledged (${purpose}): ${user.slice(0, 120)}`;
}

function clamp(n: number, min = 0, max = 4): number {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
