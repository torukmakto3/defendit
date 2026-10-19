import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { completeJson } from "../src/lib/llm";
import type { LlmProvider, LlmRequest, LlmResponse } from "../src/lib/llm";

const schema = z.object({ ok: z.literal(true), n: z.number() });

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
        return { content, modelId: "t", provider: "test" };
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
        return { content, modelId: "t", provider: "test" };
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
        provider(async () => ({ content: "nope", modelId: "t", provider: "test" })),
        { purpose: "test", messages: [{ role: "user", content: "go" }] },
        schema,
      ),
    ).rejects.toThrow(/non-JSON after repair/);
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
