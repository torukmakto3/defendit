/**
 * End-to-end smoke in mock mode (no HTTP server required).
 * Covers: request → upload → learn → defend → grade → signed receipt → hash check.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { sha256Hex, verifySignature } from "../src/lib/crypto";
import {
  completeDefendSession,
  createDefenseRequest,
  ingestDeliverable,
  learnCoachTurn,
  startSession,
} from "../src/lib/services";

process.env.MOCK_LLM = "1";
process.env.DATABASE_PATH = join(process.cwd(), "data", "smoke.db");

async function main() {
  const { token, requestId } = createDefenseRequest({
    receiverName: "Alex Partner",
    receiverEmail: "alex@fund.example",
    difficulty: "hard",
    title: "Smoke — Project North",
  });
  console.log("request", requestId, token);

  const fixture = join(process.cwd(), "fixtures", "sample-memo.md");
  const buffer = readFileSync(fixture);
  const expectedHash = sha256Hex(buffer);

  const uploaded = await ingestDeliverable({
    token,
    fileName: "sample-memo.md",
    buffer,
    creatorName: "Ana Analyst",
    creatorEmail: "ana@fund.example",
  });
  console.log("upload", uploaded.sha256.slice(0, 12), "claims", uploaded.claims.length);
  if (uploaded.sha256 !== expectedHash) {
    throw new Error("Upload hash mismatch");
  }

  const learn = startSession({
    token,
    mode: "learn",
    creatorName: "Ana Analyst",
    creatorEmail: "ana@fund.example",
  });
  const coach = await learnCoachTurn({ sessionId: learn.sessionId });
  await learnCoachTurn({
    sessionId: learn.sessionId,
    answer:
      "The core claim is a $12M Series B at $90M post because North can become the default workflow layer; unit economics hinge on churn staying near 1.2%.",
  });
  console.log("learn", coach.coachMessage.slice(0, 60) + "…");

  const defend = startSession({
    token,
    mode: "defend",
    creatorName: "Ana Analyst",
    creatorEmail: "ana@fund.example",
  });

  const turns = defend.plan.probes.map((probe, i) => {
    const started = new Date(Date.now() - (8_000 + i * 1_500)).toISOString();
    const ended = new Date().toISOString();
    const answer =
      probe.type === "planted_error"
        ? "That excerpt looks wrong — a number or claim was altered versus the memo. The original figures should match the unit economics section."
        : `Because the memo shows ${probe.expectedFocus}. If assumptions move 30% against us, the recommendation weakens first via LTV and IRR. Sources are the market and unit economics sections.`;
    return {
      id: `turn_${i + 1}`,
      probeId: probe.id,
      question: probe.question,
      answer,
      startedAt: started,
      endedAt: ended,
      latencyMs: 8000 + i * 1500,
      followUpIndex: 0,
    };
  });

  const result = await completeDefendSession({
    sessionId: defend.sessionId,
    turns,
    pasteEvents: 0,
    focusBlurEvents: 1,
  });

  const ok = verifySignature(
    result.receipt.payload,
    result.receipt.signature,
    result.receipt.publicKey,
  );
  if (!ok) throw new Error("Receipt signature invalid");
  if (result.receipt.payload.deliverable.sha256 !== expectedHash) {
    throw new Error("Receipt hash mismatch");
  }
  const published = JSON.stringify(result.receipt.payload);
  if (published.includes("ana@fund.example") || published.includes("LTV and IRR")) {
    throw new Error("Public receipt leaked email or an answer");
  }

  const tampered = sha256Hex(Buffer.concat([buffer, Buffer.from("\n")]));
  if (tampered === expectedHash) throw new Error("Tamper hash should differ");

  console.log("receipt", result.receipt.payload.id, "score", result.score);
  console.log("stamp", result.stampPath);
  console.log("tamper check: doesn't match ✓");
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
