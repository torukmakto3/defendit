import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { calibrationAnswer } from "../fixtures/calibration/answers";
import { detectNonAnswer } from "../src/lib/non-answer";
import type { ProbeType } from "../src/lib/types";

const dir = join(__dirname, "..", "fixtures", "calibration");

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 40 && !paragraph.startsWith("#"));
}

function judge(answer: string, claimText: string, probeType: ProbeType = "explain_back") {
  return detectNonAnswer({
    answer,
    question: "Walk me through why this holds.",
    claimText,
    sourceSpan: claimText.slice(0, 40),
    figures: [],
    probeType,
  });
}

describe("calibration answers", () => {
  const files = readdirSync(dir).filter((file) => file.endsWith(".md"));

  it("explains each fixture paragraph instead of quoting a template", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const paragraph of paragraphs(text)) {
        const answer = calibrationAnswer({
          fixture: file,
          kind: "good",
          claimText: paragraph,
          probeType: "explain_back",
        });
        expect(answer).not.toContain("Because the document says");
        expect(answer.toLowerCase()).toContain("because");
        expect(answer).toMatch(/\d/);
        expect(judge(answer, paragraph)).toBeNull();
        const figure = paragraph.match(/\$?\d[\d,]*(?:\.\d+)?%?/);
        if (figure) expect(answer).toContain(figure[0]);
        const counter = calibrationAnswer({
          fixture: file,
          kind: "good",
          claimText: paragraph,
          probeType: "counterfactual",
        });
        expect(counter.toLowerCase()).toContain("if ");
        expect(counter).toContain(answer);
        const planted = calibrationAnswer({
          fixture: file,
          kind: "good",
          claimText: paragraph,
          probeType: "planted_error",
          plantedContent: "a changed figure",
        });
        expect(planted.toLowerCase()).toMatch(/altered/);
        expect(planted.toLowerCase()).toMatch(/wrong/);
        expect(judge(planted, paragraph, "planted_error")).toBeNull();
      }
    }
  });

  it("keeps the vague set on topic and out of the refusal regex", () => {
    for (const file of files) {
      const vague = calibrationAnswer({
        fixture: file,
        kind: "vague",
        claimText: "any claim",
        probeType: "explain_back",
      });
      expect(vague).not.toMatch(/\d/);
      expect(judge(vague, "any claim")).toBeNull();
      expect(vague.toLowerCase()).toMatch(/harbor logistics|night bus|webhook/);
      expect(judge(calibrationAnswer({ fixture: file, kind: "bad", claimText: "", probeType: "explain_back" }), "")?.kind).toBe(
        "refusal",
      );
      expect(judge(calibrationAnswer({ fixture: file, kind: "idk", claimText: "", probeType: "explain_back" }), "")?.kind).toBe(
        "refusal",
      );
    }
  });
});
