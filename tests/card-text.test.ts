import { describe, expect, it } from "vitest";
import { cardTextIssues, plainCardProse, prepareCardFaces, settleCardText } from "../src/lib/card-text";

const file = { fileName: "north_star.md" };

describe("flashcard text", () => {
  it("turns identifiers into plain words and drops file dumps", () => {
    const cleaned = plainCardProse(
      "See north_star.md for monthly_churn where status=high and monthlyChurn moved.",
      file,
    );
    expect(cardTextIssues(cleaned, file)).toEqual([]);
    expect(cleaned).not.toMatch(/monthly_churn|monthlyChurn|north_star|\.md|status=high/);
    expect(cleaned.toLowerCase()).toContain("monthly churn");
  });

  it("leaves ordinary prose alone", () => {
    const prose = "Payback is 11 months at a $90M valuation in the U.S. market.";
    expect(plainCardProse(prose)).toBe(prose);
    expect(cardTextIssues(prose)).toEqual([]);
  });

  it("flags each kind of raw card text", () => {
    expect(cardTextIssues("the churn_rate doubled")).toContain("snake_case");
    expect(cardTextIssues("the monthlyChurn doubled")).toContain("camel_case");
    expect(cardTextIssues("read north_star.md")).toEqual(expect.arrayContaining(["filename", "extension"]));
    expect(cardTextIssues("status=high")).toContain("key_value");
    expect(cardTextIssues("Board-Deck-Q3 is the deck", { fileName: "Board-Deck-Q3.md" })).toContain("filename");
  });

  it("asks a short question and does not glue a heading onto the answer", () => {
    const faces = prepareCardFaces({
      section: "Thesis",
      text: "Recommendation We recommend a $12M Series B investment in Project North at a $90M post-money valuation. The thesis is that North can become the default workflow layer.",
      source:
        "Recommendation We recommend a $12M Series B investment in Project North at a $90M post-money valuation.",
    });
    const settled = settleCardText(faces);
    expect(settled.front).toBe("What does the file recommend?");
    expect(settled.back.startsWith("We recommend a $12M Series B")).toBe(true);
    expect(settled.back).not.toMatch(/^Recommendation/);
    expect(cardTextIssues(settled.front)).toEqual([]);
    expect(cardTextIssues(settled.back)).toEqual([]);
    expect(settled.source).toMatch(/^We recommend a \$12M Series B/);
  });

  it("keeps exact file text on the source line only", () => {
    const settled = settleCardText(
      {
        section: "unit_economics",
        front: "What is monthly_churn in north_star.md?",
        back: "status=high according to monthlyChurn in the export.",
        source: "monthly_churn in north_star.md is status=high",
      },
      file,
    );
    expect(cardTextIssues(settled.front, file)).toEqual([]);
    expect(cardTextIssues(settled.back, file)).toEqual([]);
    expect(settled.front.length).toBeGreaterThan(8);
    expect(settled.back.length).toBeGreaterThan(8);
    expect(settled.source).toMatch(/monthly_churn/);
    expect(settled.source).toMatch(/north_star\.md/);
    expect(settled.source).toMatch(/status=high/);
  });
});
