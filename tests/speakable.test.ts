import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { speechLlmRewrite } from "../src/lib/speech/llm-rewrite";
import {
  clearSpeakableCache,
  createSpeakableCache,
  isNaturallySpeakable,
  rulesSpeakable,
  speakableCardText,
  toSpeakable,
} from "../src/lib/speech/speakable";

const FIELD = "whether it has an adaptive circuit breaker; it's set to off";

const NATURAL =
  'Walk me through why this holds: "$12M Series B". What in the document supports "We recommend a $12M Series B at a $90M post-money valuation."?';

function expectClean(spoken: string) {
  expect(spoken).not.toMatch(/_/);
  expect(spoken).not.toMatch(/\.py\b/i);
  expect(spoken).not.toMatch(/\.json\b/i);
  expect(spoken).not.toMatch(/\b[\w.]+\s*=\s*\S/);
  expect(spoken).not.toMatch(/\b(?:underscore|dot py|dot json)\b/i);
  expect(isNaturallySpeakable(spoken)).toBe(true);
}

describe("rulesSpeakable", () => {
  it("describes a Python file by role", () => {
    const spoken = rulesSpeakable("audit_checker.py");
    expect(spoken).toBe("the audit checker script");
    expectClean(spoken);
  });

  it("describes a JSON file by role", () => {
    const spoken = rulesSpeakable("registry.json");
    expect(spoken).toBe("the registry file");
    expectClean(spoken);
  });

  it("describes a snake_case boolean field in words", () => {
    expect(rulesSpeakable("has_adaptive_circuit_breaker: false")).toBe(FIELD);
    expect(rulesSpeakable("has_adaptive_circuit_breaker=false")).toBe(FIELD);
    expect(rulesSpeakable('{"has_adaptive_circuit_breaker": false}')).toBe(FIELD);
    expectClean(FIELD);
  });

  it("describes a camelCase boolean field in words", () => {
    expect(rulesSpeakable("hasAdaptiveCircuitBreaker: false")).toBe(FIELD);
    expect(rulesSpeakable("hasAdaptiveCircuitBreaker = false")).toBe(FIELD);
    expectClean(rulesSpeakable("hasAdaptiveCircuitBreaker = false"));
  });

  it("describes a field dump that is already split into words", () => {
    expect(rulesSpeakable("has adaptive circuit breaker false")).toBe(FIELD);
  });

  it("says a true flag is on", () => {
    expect(rulesSpeakable("is_enabled: true")).toBe("whether it is enabled; it's set to on");
    expect(rulesSpeakable("has_adaptive_circuit_breaker: true")).toBe(
      "whether it has an adaptive circuit breaker; it's set to on",
    );
  });

  it("splits snake_case and camelCase identifiers that are not files", () => {
    expect(rulesSpeakable("The retry_wrapper caps maxRetries at 30 seconds.")).toBe(
      "The retry wrapper caps max retries at 30 seconds.",
    );
  });

  it("speaks a path by the file's role, not the directories", () => {
    expect(rulesSpeakable("See src/checks/audit_checker.py before startup.")).toBe(
      "See the audit checker script before startup.",
    );
  });

  it("paraphrases a code excerpt instead of reading it", () => {
    const excerpt = [
      "```py",
      "def run():",
      "    cfg = open('registry.json')",
      "    assert cfg['has_adaptive_circuit_breaker'] == False",
      "    load('audit_checker.py')",
      "```",
    ].join("\n");
    const spoken = rulesSpeakable(`I'm looking at this excerpt.\n\n${excerpt}\n\nIs it accurate?`);
    expect(spoken).toMatch(/short excerpt/i);
    expect(spoken).toMatch(/audit checker script/);
    expect(spoken).toMatch(/registry file/);
    expect(spoken).toMatch(/adaptive circuit breaker/);
    expect(spoken).toMatch(/off/);
    expect(spoken).toMatch(/Is it accurate\?/);
    expectClean(spoken);
  });

  it("paraphrases inline code and a JSON dump", () => {
    const spoken = rulesSpeakable(
      "Compare `audit_checker.py` with `{\"max_retries\": 3, \"has_adaptive_circuit_breaker\": false}`.",
    );
    expect(spoken).toContain("the audit checker script");
    expect(spoken).toContain("the max retries is 3");
    expect(spoken).toContain(FIELD);
    expectClean(spoken);
  });

  it("leaves a natural examiner question unchanged", () => {
    expect(rulesSpeakable(NATURAL)).toBe(NATURAL);
  });

  it("does not treat a prose colon as a field dump", () => {
    const question = 'From 0 to 100, how confident are you that "1.2%" is right? What would move that number?';
    expect(rulesSpeakable(question)).toBe(question);
  });

  it("rewrites only the artifacts inside a spoken interviewer line", () => {
    const line = "Thanks. Question 2. Open audit_checker.py and explain has_adaptive_circuit_breaker: false.";
    expect(rulesSpeakable(line)).toBe(
      "Thanks. Question 2. Open the audit checker script and explain whether it has an adaptive circuit breaker; it's set to off.",
    );
  });

  it("keeps the original string intact", () => {
    const original = "Open audit_checker.py and registry.json.";
    const copy = original;
    const spoken = rulesSpeakable(original);
    expect(original).toBe(copy);
    expect(spoken).toBe("Open the audit checker script and the registry file.");
    expect(spoken).not.toBe(original);
  });

  it("is idempotent and never spells punctuation from the examples", () => {
    const samples = [
      "audit_checker.py",
      "registry.json",
      "has_adaptive_circuit_breaker: false",
      "hasAdaptiveCircuitBreaker = false",
      "has adaptive circuit breaker false",
      "The retry_wrapper reads registry.json.",
      NATURAL,
    ];
    for (const sample of samples) {
      const once = rulesSpeakable(sample);
      expect(rulesSpeakable(once)).toBe(once);
      expectClean(once);
    }
  });
});

describe("toSpeakable", () => {
  it("uses a fast clean model paraphrase and then the cache", async () => {
    const cache = createSpeakableCache();
    let calls = 0;
    const rewrite = async () => {
      calls += 1;
      return "Please look at the audit checker script.";
    };
    const first = await toSpeakable("Please look at audit_checker.py.", {
      rewrite,
      timeoutMs: 400,
      cache,
    });
    const second = await toSpeakable("Please look at audit_checker.py.", {
      rewrite,
      timeoutMs: 400,
      cache,
    });
    expect(first.source).toBe("model");
    expect(first.text).toBe("Please look at the audit checker script.");
    expect(second.source).toBe("cache");
    expect(second.text).toBe(first.text);
    expect(calls).toBe(1);
    expect(second.latencyMs).toBeLessThan(500);
    expectClean(first.text);
  });

  it("drops a model answer that still names the file literally", async () => {
    const result = await toSpeakable("audit_checker.py", {
      rewrite: async () => "see audit_checker.py",
      timeoutMs: 400,
      cache: createSpeakableCache(),
    });
    expect(result.source).toBe("rules");
    expect(result.text).toBe("the audit checker script");
    expectClean(result.text);
  });

  it("falls back to rules inside the budget when the model stalls", async () => {
    const result = await toSpeakable("registry.json", {
      rewrite: (_text, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("the registry file, in other words"), 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
      timeoutMs: 200,
      cache: createSpeakableCache(),
    });
    expect(result.source).toBe("rules");
    expect(result.text).toBe("the registry file");
    expect(result.latencyMs).toBeLessThan(500);
  });

  it("does not call the model when the line is already speakable", async () => {
    let calls = 0;
    const result = await toSpeakable(NATURAL, {
      rewrite: async () => {
        calls += 1;
        return "rewritten";
      },
      cache: createSpeakableCache(),
    });
    expect(calls).toBe(0);
    expect(result.source).toBe("rules");
    expect(result.text).toBe(NATURAL);
  });

  it("keeps rules latency well under 500 ms per question", async () => {
    const samples = [
      "audit_checker.py",
      "registry.json",
      "has_adaptive_circuit_breaker: false",
      "hasAdaptiveCircuitBreaker = false",
      "has adaptive circuit breaker false",
      "```py\ndef run():\n    cfg = open('registry.json')\n    assert cfg['has_adaptive_circuit_breaker'] == False\n```",
      `Question 3. ${NATURAL}`,
      "Open src/checks/audit_checker.py and config/registry.json before you explain has_adaptive_circuit_breaker: false.",
    ];
    const times: number[] = [];
    for (let round = 0; round < 40; round++) {
      for (const sample of samples) {
        const start = performance.now();
        rulesSpeakable(sample);
        times.push(performance.now() - start);
      }
    }
    const maxMs = Math.max(...times);
    const meanMs = times.reduce((sum, ms) => sum + ms, 0) / times.length;
    let asyncMax = 0;
    for (const sample of samples) {
      const start = performance.now();
      const result = await toSpeakable(sample, { cache: createSpeakableCache() });
      asyncMax = Math.max(asyncMax, performance.now() - start);
      expect(result.source).toBe("rules");
    }
    expect(
      maxMs,
      `rules max ${maxMs.toFixed(3)} ms, mean ${meanMs.toFixed(3)} ms, toSpeakable max ${asyncMax.toFixed(3)} ms`,
    ).toBeLessThan(500);
    expect(meanMs).toBeLessThan(500);
    expect(asyncMax).toBeLessThan(500);
  });

  it("exposes the same helper Learn flashcards can speak", async () => {
    clearSpeakableCache();
    const spoken = await speakableCardText("What does audit_checker.py store in registry.json?");
    expect(spoken).toBe("What does the audit checker script store in the registry file?");
    expectClean(spoken);
  });
});

describe("speechLlmRewrite", () => {
  it("stays off unless the flag is set, including in mock mode", () => {
    const previousFlag = process.env.SPEECH_REWRITE_LLM;
    const previousMock = process.env.MOCK_LLM;
    process.env.SPEECH_REWRITE_LLM = "1";
    process.env.MOCK_LLM = "1";
    expect(speechLlmRewrite()).toBeUndefined();
    if (previousFlag === undefined) delete process.env.SPEECH_REWRITE_LLM;
    else process.env.SPEECH_REWRITE_LLM = previousFlag;
    if (previousMock === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = previousMock;
  });
});

describe("agent copy", () => {
  it("ships the same speakable module the web app tests", () => {
    const web = readFileSync(new URL("../src/lib/speech/speakable.ts", import.meta.url), "utf8");
    const agent = readFileSync(new URL("../agent/src/speech/speakable.ts", import.meta.url), "utf8");
    expect(agent).toBe(web);
  });
});
