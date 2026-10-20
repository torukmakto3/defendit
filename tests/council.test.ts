import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/errors";
import {
  DEFAULT_LIQUID_COUNCIL_MODELS,
  describeGradingCouncil,
  getGradingCouncil,
  gradingSeed,
  isAutoRoutedModel,
} from "../src/lib/llm";
import { createLiquidProvider } from "../src/lib/llm/openai-compat";
import { register } from "../src/instrumentation";

const LLM_ENV = [
  "MOCK_LLM",
  "LLM_PROVIDER",
  "LIQUID_API_KEY",
  "LIQUID_MODEL",
  "LIQUID_COUNCIL_MODELS",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_MODEL_B",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_MODEL_B",
  "OPENAI_COMPAT_BASE_URL",
  "LLM_ALLOW_UNVERIFIED_RETENTION",
  "VERCEL",
  "GRADING_SEED",
  "NEXT_PHASE",
  "NEXT_RUNTIME",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(LLM_ENV.map((key) => [key, process.env[key]]));
  for (const key of LLM_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of LLM_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("auto-routed model names", () => {
  it("matches routers and leaves pinned model ids alone", () => {
    expect(isAutoRoutedModel("liquid.auto")).toBe(true);
    expect(isAutoRoutedModel("liquid.auto:balanced")).toBe(true);
    expect(isAutoRoutedModel("auto")).toBe(true);
    expect(isAutoRoutedModel("gpt-oss-120b")).toBe(false);
    expect(isAutoRoutedModel("deepseek-v3.2")).toBe(false);
  });
});

describe("deployed grading council", () => {
  beforeEach(() => {
    process.env.VERCEL = "1";
    process.env.LIQUID_API_KEY = "liq_test";
    process.env.LIQUID_MODEL = "liquid.auto";
  });

  it("refuses liquid.auto and a one-model council", () => {
    expect(() => getGradingCouncil()).toThrow(HttpError);
    expect(() => getGradingCouncil()).toThrow(/Grading is refused/);
    expect(() => getGradingCouncil()).toThrow(/LIQUID_COUNCIL_MODELS/);
    process.env.LIQUID_COUNCIL_MODELS = "gpt-oss-120b";
    expect(() => getGradingCouncil()).toThrow(/at least 2/);
    process.env.LIQUID_COUNCIL_MODELS = "gpt-oss-120b,liquid.auto";
    expect(() => getGradingCouncil()).toThrow(/router/);
  });

  it("grades when the council is two or more pinned models", () => {
    process.env.LIQUID_COUNCIL_MODELS = DEFAULT_LIQUID_COUNCIL_MODELS.join(",");
    const council = getGradingCouncil();
    expect(council.map((member) => member.id)).toEqual([...DEFAULT_LIQUID_COUNCIL_MODELS]);
    expect(council.every((member) => member.provider === "liquid")).toBe(true);
    expect(describeGradingCouncil()).toBe(
      DEFAULT_LIQUID_COUNCIL_MODELS.map((id) => `liquid:${id}`).join(", "),
    );
  });

  it("still grades in mock mode", async () => {
    process.env.MOCK_LLM = "1";
    const council = getGradingCouncil();
    expect(council).toHaveLength(3);
    expect(council.every((member) => member.provider === "mock")).toBe(true);
    process.env.NEXT_RUNTIME = "nodejs";
    await expect(register()).resolves.toBeUndefined();
  });

  it("fails the startup check when the deployed council cannot grade", async () => {
    expect(describeGradingCouncil()).toMatch(/Grading is refused/);
    process.env.NEXT_RUNTIME = "nodejs";
    await expect(register()).rejects.toThrow(/Grading is refused/);
    process.env.NEXT_PHASE = "phase-production-build";
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("local grading council", () => {
  it("still grades with liquid.auto when it is not a deployment", async () => {
    process.env.LIQUID_API_KEY = "liq_test";
    process.env.LIQUID_MODEL = "liquid.auto";
    const council = getGradingCouncil();
    expect(council.map((member) => member.id)).toEqual(["liquid.auto"]);
    process.env.NEXT_RUNTIME = "nodejs";
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("grading seed", () => {
  it("sends the seed on a Liquid grading call and stores the override", async () => {
    process.env.GRADING_SEED = "7";
    expect(gradingSeed()).toBe(7);
    const calls: { body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: String(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
      }),
    );
    await createLiquidProvider("liq_test", "gpt-oss-120b").complete({
      messages: [{ role: "user", content: "grade" }],
      temperature: 0,
      seed: gradingSeed(),
    });
    const body = JSON.parse(calls[0].body);
    expect(body.model).toBe("gpt-oss-120b");
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(7);
  });

  it("rejects a non-integer GRADING_SEED", () => {
    process.env.GRADING_SEED = "nope";
    expect(() => gradingSeed()).toThrow(/integer/);
  });
});
