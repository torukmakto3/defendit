import { describe, expect, it } from "vitest";
import { selectStt } from "./src/stt";

describe("interviewer STT language", () => {
  it("keeps Nova-3 English when the document language is missing", () => {
    expect(selectStt({})).toEqual({ kind: "deepgram-inference", descriptor: "deepgram/nova-3", language: "en-US" });
    expect(selectStt({ DEEPGRAM_API_KEY: "dg-test" }, "en")).toEqual({
      kind: "deepgram-plugin",
      model: "nova-3",
      language: "en-US",
      smartFormat: true,
      punctuate: true,
      mipOptOut: true,
    });
  });

  it("uses Nova-3 multi for Spanish and Portuguese so an English answer is also transcribed", () => {
    expect(selectStt({}, "es")).toEqual({
      kind: "deepgram-inference",
      descriptor: "deepgram/nova-3:multi",
      language: "multi",
    });
    expect(selectStt({ DEEPGRAM_API_KEY: "dg-test" }, "pt-BR")).toEqual({
      kind: "deepgram-plugin",
      model: "nova-3",
      language: "multi",
      smartFormat: true,
      punctuate: true,
      mipOptOut: true,
    });
  });

  it("sends a language outside the Nova-3 multi set as itself", () => {
    expect(selectStt({}, "sv")).toEqual({
      kind: "deepgram-inference",
      descriptor: "deepgram/nova-3:sv",
      language: "sv",
    });
  });
});
