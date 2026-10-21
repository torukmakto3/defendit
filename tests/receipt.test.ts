import { describe, expect, it } from "vitest";
import { gradedWithLine } from "../src/components/receipt/metrics";
import { signPayload } from "../src/lib/crypto";
import { buildSignedReceipt, verifyReceipt } from "../src/lib/receipt";
import type { IntegritySignals, ModelGrade, ReceiptPayload } from "../src/lib/types";

process.env.DEFEND_IT_SIGNING_SEED = "44".repeat(32);

const integrity: IntegritySignals = {
  status: "Clear",
  observations: [],
  avgLatencyMs: 0,
  latencyVariance: 0,
  pasteEvents: 0,
  focusBlurEvents: 0,
};

const grades: ModelGrade[] = [
  {
    modelId: "gpt-oss-120b",
    provider: "mock",
    temperature: 0,
    seed: 0,
    claimGrades: [],
    overallScore: 88,
  },
  {
    modelId: "deepseek-v3.2",
    provider: "mock",
    temperature: 0,
    seed: 7,
    claimGrades: [],
    overallScore: 71,
  },
];

function mint(overrides?: Partial<ModelGrade>[]): ReturnType<typeof buildSignedReceipt> {
  const used = overrides
    ? grades.map((grade, i) => ({ ...grade, ...overrides[i] }))
    : grades;
  return buildSignedReceipt({
    difficulty: "standard",
    sha256: "ab".repeat(32),
    byteLength: 42,
    grades: used,
    integrity,
  });
}

describe("signed receipt graders", () => {
  it("includes model, temperature, and seed per grader and verifies", () => {
    const receipt = mint();
    expect(receipt.payload.modelVersions).toEqual([
      "mock:gpt-oss-120b",
      "mock:deepseek-v3.2",
    ]);
    expect(receipt.payload.graders).toEqual([
      { model: "mock:gpt-oss-120b", temperature: 0, seed: 0 },
      { model: "mock:deepseek-v3.2", temperature: 0, seed: 7 },
    ]);
    expect(verifyReceipt(receipt)).toBe(true);
    expect(gradedWithLine(receipt.payload)).toBe(
      `Graded with mock:gpt-oss-120b (temperature 0, seed 0), mock:deepseek-v3.2 (temperature 0, seed 7) · ${receipt.payload.rubricVersion}`,
    );
  });

  it("verifies an old receipt that lists model ids and no graders", () => {
    const legacy: ReceiptPayload = {
      id: "rcpt_legacyreceipt00001",
      version: "defend-it-receipt-v2",
      createdAt: "2026-10-01T00:00:00.000Z",
      difficulty: "standard",
      score: 80,
      outcome: "Defended",
      bands: { strong: 1, partial: 0, weak: 0 },
      deliverable: { sha256: "cd".repeat(32), byteLength: 12 },
      rubricVersion: "defend-it-rubric-v0.4",
      modelVersions: ["mock:gpt-oss-120b"],
      integrity: { status: "Clear" },
      attempt: 1,
      assuranceLevel: "L1",
    };
    const { signature, publicKey } = signPayload(legacy);
    expect(verifyReceipt({ payload: legacy, signature, publicKey, verifyUrl: "http://localhost/verify/x" })).toBe(true);
    expect(gradedWithLine(legacy)).toBe("Graded with mock:gpt-oss-120b · defend-it-rubric-v0.4");

    const withoutSettings = mint([
      { temperature: undefined, seed: undefined },
      { temperature: undefined, seed: undefined },
    ]);
    expect(withoutSettings.payload.graders).toBeUndefined();
    expect(withoutSettings.payload.modelVersions).toEqual([
      "mock:gpt-oss-120b",
      "mock:deepseek-v3.2",
    ]);
    expect(verifyReceipt(withoutSettings)).toBe(true);
    expect(gradedWithLine(withoutSettings.payload)).toBe(
      `Graded with mock:gpt-oss-120b, mock:deepseek-v3.2 · ${withoutSettings.payload.rubricVersion}`,
    );
  });

  it("fails verification when temperature or seed is changed", () => {
    const receipt = mint();
    expect(verifyReceipt(receipt)).toBe(true);

    const warmer = structuredClone(receipt);
    warmer.payload.graders![0].temperature = 1;
    expect(verifyReceipt(warmer)).toBe(false);

    const reseeded = structuredClone(receipt);
    reseeded.payload.graders![1].seed = 99;
    expect(verifyReceipt(reseeded)).toBe(false);
  });
});
