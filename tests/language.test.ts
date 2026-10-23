import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectStt } from "../agent/src/stt";
import { selectTts } from "../agent/src/tts";
import { prepareCardFaces } from "../src/lib/card-text";
import { decodePlainText } from "../src/lib/parse";
import { examinerScript } from "../src/lib/examiner-script";
import { clipExcerpt, hasLoneSurrogate } from "../src/lib/excerpt";
import { detectDocumentLanguage, resolveDocumentLanguage } from "../src/lib/language";
import { buildInterviewPlan, plantError } from "../src/lib/probes";
import { checkQuestion } from "../src/lib/question-check";
import { rubricPrompt } from "../src/lib/rubric";
import type { Claim } from "../src/lib/types";

const spanish = readFileSync(new URL("../fixtures/language/casco-es.md", import.meta.url), "utf8");
const portuguese = readFileSync(new URL("../fixtures/language/casco-pt.md", import.meta.url), "utf8");
const english = readFileSync(new URL("../fixtures/sample-memo.md", import.meta.url), "utf8");

const casco: Claim = {
  id: "c1",
  text: "Todo barco debe poseer seis propiedades: flotabilidad, estabilidad, estanqueidad, robustez, velocidad y gobierno.",
  section: "Casco",
  sourceSpan:
    "Todo barco debe poseer seis propiedades: flotabilidad, estabilidad, estanqueidad, robustez, velocidad y gobierno.",
  stakes: "high",
};

describe("document language detection", () => {
  it("reads Spanish and Portuguese fixtures and leaves English and short text as en", () => {
    expect(detectDocumentLanguage(spanish)).toBe("es");
    expect(detectDocumentLanguage(portuguese)).toBe("pt");
    expect(detectDocumentLanguage(english)).toBe("en");
    expect(detectDocumentLanguage("Hola")).toBe("en");
    expect(resolveDocumentLanguage(null)).toBe("en");
    expect(resolveDocumentLanguage("es-MX")).toBe("es");
    expect(resolveDocumentLanguage("nope")).toBe("en");
  });
});

describe("examiner script", () => {
  it("speaks the introduction and the question label in the document language", () => {
    expect(examinerScript("es").intro(6)).toMatch(/^Hola, soy tu examinador/);
    expect(examinerScript("es").intro(6)).not.toMatch(/I'm your examiner/);
    expect(examinerScript("es").questionLabel(2)).toBe("Pregunta 2.");
    expect(examinerScript("es").acks.join(" ")).not.toMatch(/Got it/);
    expect(examinerScript("pt").intro(6)).toMatch(/^Olá, sou o seu examinador/);
    expect(examinerScript("pt").questionLabel(2)).toBe("Pergunta 2.");
    expect(examinerScript(null).intro(6)).toMatch(/^Hi, I'm your examiner/);
    expect(examinerScript("en-US").questionLabel(2)).toBe("Question 2.");
  });

  it("matches the copy the voice worker speaks", () => {
    const web = readFileSync(new URL("../src/lib/examiner-script.ts", import.meta.url), "utf8");
    const agent = readFileSync(new URL("../agent/src/examiner-script.ts", import.meta.url), "utf8");
    expect(agent).toBe(web);
  });
});

describe("speech config for es and pt", () => {
  it("keeps English Nova-3 and Thalia, and switches Spanish and Portuguese", () => {
    const englishStt = selectStt({}, "en");
    const spanishStt = selectStt({ DEEPGRAM_API_KEY: "dg" }, "es");
    const portugueseStt = selectStt({}, "pt");
    expect(englishStt.kind === "deepgram-inference" && englishStt.descriptor).toBe("deepgram/nova-3");
    expect(spanishStt.language).toBe("multi");
    expect(portugueseStt.kind === "deepgram-inference" && portugueseStt.descriptor).toBe("deepgram/nova-3:multi");
    expect(selectTts({ DEEPGRAM_API_KEY: "dg" }, "es")).toMatchObject({
      model: "aura-2-estrella-es",
      language: "es",
    });
    expect(selectTts({}, "pt")).toMatchObject({
      language: "pt-BR",
      note: "aura-2-has-no-portuguese",
    });
    expect(selectTts({ DEEPGRAM_API_KEY: "dg" })).toMatchObject({ model: "aura-2-thalia-en", language: "en" });
  });
});

describe("excerpt clips", () => {
  it("cuts on a grapheme and a word, including accents and emoji", () => {
    const accented = "preparacio\u0301n del examen de estabilidad y gobierno del buque en alta mar";
    const clip = clipExcerpt(accented, 18);
    expect(clip.endsWith("…")).toBe(true);
    expect(hasLoneSurrogate(clip)).toBe(false);
    expect(clip).not.toMatch(/\u0301…/);
    expect(clip.normalize("NFC")).toMatch(/^preparación/);

    const emoji = "Estabilidad 🚢 del buque después de una escora muy grande en el puerto.";
    const spoken = clipExcerpt(emoji, 22);
    expect(hasLoneSurrogate(spoken)).toBe(false);
    expect(spoken.endsWith("…")).toBe(true);
    expect(spoken.includes("🚢") || spoken.startsWith("Estabilidad")).toBe(true);
    expect(spoken).not.toMatch(/\uD83D$/);
  });
});

describe("Spanish questions and grading copy", () => {
  it("keeps the full planted span in the question and on the probe", () => {
    const plan = buildInterviewPlan({
      claims: [casco, { ...casco, id: "c2" }, { ...casco, id: "c3" }],
      difficulty: "hard",
      seed: "casco",
      language: "es",
    });
    const planted = plan.probes.find((probe) => probe.type === "planted_error");
    expect(planted?.plantedContent).toBeTruthy();
    expect(planted?.question).toContain(planted?.plantedContent);
    expect(planted?.question).not.toMatch(/as confirmed by an external audit/);
    expect(planted?.question).not.toMatch(/Walk me through|Got it/);
    expect(planted?.sourceSpan).toBe(casco.sourceSpan);
    expect(plan.probes.every((probe) => !probe.question.startsWith("Walk me through"))).toBe(true);
  });

  it("rejects a planted question that only quotes a prefix", () => {
    const altered = plantError(casco.text, () => 0.1, "es");
    const prefix = `${altered.slice(0, 40)}…`;
    expect(
      checkQuestion({
        question: `Revisa este fragmento. "${prefix}"`,
        claim: casco,
        probeType: "planted_error",
        plantedContent: altered,
      }).grounded,
    ).toBe(false);
    expect(
      checkQuestion({
        question: `Revisa este fragmento. ¿Hay algo que esté mal?\n\n"${altered}"`,
        claim: casco,
        probeType: "planted_error",
        plantedContent: altered,
      }).ok,
    ).toBe(true);
  });

  it("tells the grader the document language and not to penalize English", () => {
    const prompt = rubricPrompt("hard", "es");
    expect(prompt).toContain("Document language: es (Spanish)");
    expect(prompt).toContain("must not be penalized for the language it uses");
    expect(prompt).toContain("full planted excerpt");
    expect(rubricPrompt("hard", "pt")).toContain("Document language: pt (Portuguese)");
    expect(rubricPrompt("standard")).toContain("Document language: en (English)");
    expect(prompt).toContain("defend-it-rubric-v0.5");
  });

  it("writes a Spanish card front and keeps the accent", () => {
    const faces = prepareCardFaces({
      section: "Estabilidad",
      text: "La estabilidad es la capacidad del buque para volver a su posición de adrizado después de una escora.",
      language: "es",
    });
    expect(faces.front).toMatch(/^¿Qué dice el documento sobre estabilidad\?/);
    expect(faces.front).not.toMatch(/What does the file/);
    expect(faces.back).toContain("posición");
    expect(faces.source).toContain("posición");
  });
});

describe("plain text encoding", () => {
  it("reads a Windows-1252 ñ instead of a replacement character", () => {
    const bytes = Buffer.concat([
      Buffer.from("La estanqueidad del bu"),
      Buffer.from([0xf1]),
      Buffer.from("o mantiene el agua fuera del casco."),
    ]);
    const text = decodePlainText(bytes);
    expect(text).toContain("buño");
    expect(text).not.toContain("\uFFFD");
    expect(decodePlainText(Buffer.from("cañón", "utf8"))).toBe("cañón");
  });
});
