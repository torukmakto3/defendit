import { describe, expect, it } from "vitest";
import { rubricPrompt } from "../src/lib/rubric";

describe("rubric prompt", () => {
  it("scores accuracy on content and requires the number to match the reason", () => {
    const prompt = rubricPrompt("standard");
    expect(prompt).toContain(
      "Accuracy is judged on whether the answer's content is correct, not on whether it repeats the source wording.",
    );
    expect(prompt).toContain("The numeric score must match the stated reason.");
    expect(prompt).toContain("defend-it-rubric-v0.5");
  });
});
