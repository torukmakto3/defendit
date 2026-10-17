import type { Difficulty } from "./types";

export const RUBRIC_VERSION = "defend-it-rubric-v0.1";

export const DIMENSIONS = [
  "accuracy",
  "reasoning",
  "transfer",
  "errorDetection",
  "ownership",
] as const;

export function rubricPrompt(difficulty: Difficulty): string {
  return `You are grading an oral defense of a deliverable.

Rubric version: ${RUBRIC_VERSION}
Difficulty: ${difficulty}

Score each claim on 0–4 for:
- accuracy: facts and claims match the document
- reasoning: explains why, not just what
- transfer: handles counterfactuals / what-ifs
- errorDetection: catches planted errors when present
- ownership: names sources, alternatives, what they'd change

Bands: Strong (avg≥3), Partial (avg≥2), Weak (avg<2).
Return JSON: { claimGrades:[{claimId,section,scores:{accuracy,reasoning,transfer,errorDetection,ownership},band,evidence,reason}], overallScore:0-100 }

Difficulty expectations:
- standard: key claims and why they hold
- hard: what-ifs, stretched assumptions, planted error
- expert: adversarial edge cases and counterarguments`;
}
