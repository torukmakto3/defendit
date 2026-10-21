import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEARN_MODE,
  LEARN_MODES,
  learnModeStatus,
  weakSpotSections,
} from "../src/lib/learn-modes";

describe("learn modes", () => {
  it("opens on flashcards and leaves the other modes for later", () => {
    expect(DEFAULT_LEARN_MODE).toBe("flashcards");
    expect(learnModeStatus("flashcards")).toBe("ready");
    expect(LEARN_MODES.filter((mode) => mode.status === "next").map((mode) => mode.id)).toEqual([
      "quiz",
      "explain_back",
      "weak_spots",
    ]);
  });

  it("orders weak-spot review from interview gaps, weakest first", () => {
    const spots = weakSpotSections([
      { section: "Exit", strength: "strong", note: "solid" },
      { section: "Market", strength: "partial" },
      { section: "Risks", strength: "weak" },
      { section: "Timeline", strength: "weak" },
    ]);
    expect(spots.map((gap) => gap.section)).toEqual(["Risks", "Timeline", "Market"]);
    expect(spots.some((gap) => gap.strength === "strong")).toBe(false);
  });
});