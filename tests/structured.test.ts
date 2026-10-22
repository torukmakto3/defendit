import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { completeJson, DEFEND_ROUTE_BUDGET_MS, graderCallBudgetMs, graderTimeoutMs } from "../src/lib/llm";
import type { LlmProvider, LlmRequest, LlmResponse } from "../src/lib/llm";

const schema = z.object({ ok: z.literal(true), n: z.number() });
const usage: LlmResponse["usage"] = {
  promptTokens: 1,
  completionTokens: 1,
  costUsd: 0,
  costSource: "estimated",
};

function provider(complete: LlmProvider["complete"]): LlmProvider {
  return { id: "t", provider: "test", retention: "mock", complete };
}

afterEach(() => {
  delete process.env.LLM_TIMEOUT_MS;
});

describe("structured model output", () => {
  it("repairs a non-JSON first response", async () => {
    let calls = 0;
    const data = await completeJson(
      provider(async () => {
        calls += 1;
        const content = calls === 1 ? "sure thing" : JSON.stringify({ ok: true, n: 2 });
        return { content, modelId: "t", provider: "test", usage };
      }),
      { purpose: "test", messages: [{ role: "user", content: "go" }] },
      schema,
    );
    expect(data.data).toEqual({ ok: true, n: 2 });
    expect(calls).toBe(2);
  });

  it("repairs a response that parses but fails the schema", async () => {
    let calls = 0;
    const data = await completeJson(
      provider(async () => {
        calls += 1;
        const content = calls === 1 ? JSON.stringify({ ok: false }) : JSON.stringify({ ok: true, n: 1 });
        return { content, modelId: "t", provider: "test", usage };
      }),
      { purpose: "test", temperature: 0.4, messages: [{ role: "user", content: "go" }] },
      schema,
    );
    expect(data.data.n).toBe(1);
    expect(calls).toBe(2);
  });

  it("rejects when the repair is still invalid", async () => {
    await expect(
      completeJson(
        provider(async () => ({ content: "nope", modelId: "t", provider: "test", usage })),
        { purpose: "test", messages: [{ role: "user", content: "go" }] },
        schema,
      ),
    ).rejects.toThrow(/non-JSON after repair/);
  });

  it("keeps the repair turn inside the 120s route budget", () => {
    process.env.LLM_TIMEOUT_MS = "90000";
    const first = graderCallBudgetMs(0);
    const repair = graderCallBudgetMs(first);
    expect(first + repair).toBeLessThan(120_000);
    delete process.env.LLM_TIMEOUT_MS;
    expect(graderCallBudgetMs(0) + graderCallBudgetMs(graderCallBudgetMs(0))).toBeLessThan(120_000);
  });

  it("gives a grader 55s and still finishes inside the defend route", () => {
    delete process.env.GRADER_TIMEOUT_MS;
    delete process.env.LLM_TIMEOUT_MS;
    const route = readFileSync(join(__dirname, "../src/app/api/sessions/defend/complete/route.ts"), "utf8");
    const maxDuration = Number(route.match(/export const maxDuration = (\d+)/)?.[1]);
    expect(maxDuration * 1000).toBe(DEFEND_ROUTE_BUDGET_MS);
    // Fluid's Hobby ceiling is 300s. The route stays at or under that, so every plan can run it.
    expect(maxDuration).toBeLessThanOrEqual(300);
    expect(graderTimeoutMs()).toBe(55_000);
    expect(graderTimeoutMs()).toBeLessThan(maxDuration * 1000);
    const first = graderCallBudgetMs(0, "grade");
    const repair = graderCallBudgetMs(first, "grade");
    expect(first).toBe(55_000);
    expect(first + repair).toBeLessThan(DEFEND_ROUTE_BUDGET_MS);
  });

  it("times out a provider that ignores the abort signal", async () => {
    process.env.LLM_TIMEOUT_MS = "40";
    const hanging: LlmProvider["complete"] = (req: LlmRequest) =>
      new Promise<LlmResponse>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("should have timed out first")), 500);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    await expect(
      completeJson(provider(hanging), { purpose: "test", messages: [{ role: "user", content: "go" }] }),
    ).rejects.toThrow(/timed out/);
  });
});
