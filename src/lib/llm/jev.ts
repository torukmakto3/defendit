/**
 * Optional TypeSafe Jev (System One) sidecar for fast typed decisions.
 * Not used for dialogue — only for stakes / bands / routing-style scores.
 *
 * Env: JEV_API_KEY, optional JEV_BASE_URL (default https://api.typesafe.ai)
 * Model: JEV_MODEL (default jev-latest)
 *
 * Open-weight alternative (self-host): autotrust/JEV on Hugging Face —
 * point JEV_BASE_URL at a compatible /v1/systemone-style endpoint when available.
 */

export interface JevScoreQuestion {
  id: string;
  type: "score";
  prompt: string;
  /** Inclusive 0–5 by default for rubric-like scores */
  min?: number;
  max?: number;
}

export interface JevChoiceQuestion {
  id: string;
  type: "choice";
  prompt: string;
  options: string[];
}

export type JevQuestion = JevScoreQuestion | JevChoiceQuestion;

export interface JevAnswer {
  id: string;
  value: string | number;
  probability?: number;
}

export function jevConfigured(): boolean {
  return Boolean(process.env.JEV_API_KEY);
}

export async function jevDecide(opts: {
  state: string | Record<string, unknown>;
  questions: JevQuestion[];
  instructions?: string;
}): Promise<JevAnswer[]> {
  if (!process.env.JEV_API_KEY) {
    throw new Error("JEV_API_KEY not set");
  }

  const base = (process.env.JEV_BASE_URL || "https://api.typesafe.ai").replace(
    /\/$/,
    "",
  );
  const model = process.env.JEV_MODEL || "jev-latest";

  const res = await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.JEV_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      state: opts.state,
      instructions: opts.instructions,
      questions: opts.questions.map((q) => {
        if (q.type === "score") {
          return {
            id: q.id,
            type: "score",
            prompt: q.prompt,
            min: q.min ?? 0,
            max: q.max ?? 5,
          };
        }
        return {
          id: q.id,
          type: "choice",
          prompt: q.prompt,
          options: q.options,
        };
      }),
    }),
  });

  if (!res.ok) {
    throw new Error(`Jev error ${res.status}`);
  }

  const data = (await res.json()) as {
    answers?: { id: string; value?: string | number; probability?: number }[];
  };

  return (data.answers || []).map((a) => ({
    id: a.id,
    value: a.value ?? "",
    probability: a.probability,
  }));
}

/** Heuristic fallback when Jev is unset — keeps beta offline. */
export function mockStakesDecision(claimText: string): "high" | "medium" | "low" {
  if (/\b(recommend|invest|irr|ltv|valuation|exit)\b/i.test(claimText)) {
    return "high";
  }
  if (/\b(risk|assum|churn|margin|cac)\b/i.test(claimText)) {
    return "medium";
  }
  return "low";
}
