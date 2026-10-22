import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCheapestLlm, getGradingCouncil, getPrimaryLlm } from "../src/lib/llm";

const LLM_ENV = [
  "MOCK_LLM",
  "LLM_PROVIDER",
  "LIQUID_API_KEY",
  "LIQUID_MODEL",
  "LIQUID_COUNCIL_MODELS",
  "LIQUID_CAP_USD",
  "LIQUID_CHECKED_ONLY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_BASE_URL",
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_CHEAP_MODEL",
  "LLM_ALLOW_UNVERIFIED_RETENTION",
  "LIQUID_BASE_URL",
  "VERCEL",
];

let saved: Record<string, string | undefined> = {};
let calls: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  saved = Object.fromEntries(LLM_ENV.map((k) => [k, process.env[k]]));
  for (const k of LLM_ENV) delete process.env[k];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          model: "served-model",
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  for (const k of LLM_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const req = { messages: [{ role: "user" as const, content: "secret memo" }] };

describe("Liquid Inference provider", () => {
  it("is the primary provider when LIQUID_API_KEY is set", () => {
    process.env.LIQUID_API_KEY = "liq_test";
    const llm = getPrimaryLlm();
    expect(llm.provider).toBe("liquid");
    expect(llm.retention).toBe("zero-enforced");
  });

  it("attaches zero-retention rules and a cost cap to every call", async () => {
    process.env.LIQUID_API_KEY = "liq_test";
    await getPrimaryLlm().complete(req);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://router.inference.ai.exchange/v1/chat/completions",
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-liquid-retention"]).toBe("none");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("liquid.auto");
    expect(body.exchange.retention_policy).toBe("none");
    expect(body.exchange.provider_requirements.require).toContain(
      "zero_retention",
    );
    expect(body.exchange.cap_usd).toBeGreaterThan(0);
  });

  it("does not use a mock model to pad a live grading council", () => {
    process.env.LIQUID_API_KEY = "liq_test";
    const council = getGradingCouncil();
    expect(council.length).toBeGreaterThan(0);
    expect(council.every((m) => m.provider === "liquid")).toBe(true);
  });
});

describe("OpenRouter provider", () => {
  it("requests zero-data-retention endpoints only", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    process.env.LLM_PROVIDER = "openrouter";
    const llm = getPrimaryLlm();
    expect(llm.retention).toBe("zero-enforced");
    await llm.complete(req);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.provider.zdr).toBe(true);
    expect(body.provider.data_collection).toBe("deny");
  });
});

describe("retention guard", () => {
  it("refuses providers whose retention cannot be enforced", async () => {
    process.env.GROQ_API_KEY = "gsk_test";
    const llm = getPrimaryLlm();
    expect(llm.retention).toBe("unverified");
    await expect(llm.complete(req)).rejects.toThrow(/retention/i);
    expect(calls).toHaveLength(0);
  });

  it("allows an unverified provider only with an explicit opt-in", async () => {
    process.env.GROQ_API_KEY = "gsk_test";
    process.env.LLM_ALLOW_UNVERIFIED_RETENTION = "1";
    await getPrimaryLlm().complete(req);
    expect(calls).toHaveLength(1);
  });

  it("treats a local Ollama endpoint as private", async () => {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
    const llm = getPrimaryLlm();
    expect(llm.retention).toBe("local");
    await llm.complete(req);
    expect(calls).toHaveLength(1);
  });

  it("never echoes prompt or model output in errors", async () => {
    process.env.LIQUID_API_KEY = "liq_test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "secret memo not json" } }] }),
          { status: 200 },
        ),
      ),
    );
    const { completeJson } = await import("../src/lib/llm");
    await expect(completeJson(getPrimaryLlm(), req)).rejects.toThrow(
      /non-JSON/,
    );
    await expect(completeJson(getPrimaryLlm(), req)).rejects.not.toThrow(
      /secret memo/,
    );
  });
});

describe("council and deployment safety", () => {
  it("leaves a leftover retaining-provider key out of the council", async () => {
    process.env.LIQUID_API_KEY = "liq_test";
    process.env.GROQ_API_KEY = "gsk_test";
    const council = getGradingCouncil();
    expect(council.map((m) => m.provider)).toEqual(["liquid"]);
  });

  it("refuses to fall back to mock models on a deployment", () => {
    process.env.VERCEL = "1";
    expect(() => getPrimaryLlm()).toThrow(/No LLM provider/);
    process.env.MOCK_LLM = "1";
    expect(getPrimaryLlm().provider).toBe("mock");
  });

  it("treats IPv6 loopback as local and remote model servers as unverified", () => {
    process.env.OLLAMA_BASE_URL = "http://[::1]:11434/v1";
    expect(getPrimaryLlm().retention).toBe("local");
    process.env.OLLAMA_BASE_URL = "https://ollama.example.com/v1";
    expect(getPrimaryLlm().retention).toBe("unverified");
  });

  it("drops the zero-retention label when the Liquid base URL is overridden", () => {
    process.env.LIQUID_API_KEY = "liq_test";
    process.env.LIQUID_BASE_URL = "https://proxy.example.com/v1";
    expect(getPrimaryLlm().retention).toBe("unverified");
  });

  it("uses the primary compat model as the cheap model unless a separate one is set", () => {
    process.env.OPENAI_COMPAT_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.OPENAI_COMPAT_MODEL = "primary-model-for-cap";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getCheapestLlm().id).toBe("primary-model-for-cap");
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "OPENAI_COMPAT_CHEAP_MODEL is unset; a capped defense uses the primary compat model (primary-model-for-cap).",
    );
    process.env.OPENAI_COMPAT_CHEAP_MODEL = "small-local";
    expect(getCheapestLlm().id).toBe("small-local");
    warn.mockRestore();
  });

  it("keeps provider error bodies out of thrown errors", async () => {
    process.env.LIQUID_API_KEY = "liq_test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "bad_request", message: "secret memo echoed" } }), {
          status: 400,
        }),
      ),
    );
    await expect(getPrimaryLlm().complete(req)).rejects.toThrow("liquid error 400: bad_request");
  });
});
