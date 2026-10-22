import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "../src/app/privacy/page";
import { PRIVACY_UPDATED } from "../src/lib/privacy";
import { SiteFooter } from "../src/components/site-footer";

describe("privacy page", () => {
  const html = renderToStaticMarkup(createElement(PrivacyPage));

  it("states when the page was last updated", () => {
    expect(PRIVACY_UPDATED).toBe("22 October 2026");
    expect(html).toContain("Last updated");
    expect(html).toContain("22 October 2026");
    expect(html).toContain("2026-10-22");
  });

  it("describes storage, retention, the receipt, and deletion from the code", () => {
    expect(html).toContain("Vercel");
    expect(html).toContain("Postgres");
    expect(html).toContain("Neon");
    expect(html).toContain("does not record which of those");
    expect(html).toContain("sign-in email");
    expect(html).toContain("not written to disk");
    expect(html).toContain("SHA-256");
    expect(html).toContain("AES-256-GCM");
    expect(html).toContain("deleted when the defense is finished");
    expect(html).toContain("72 hours");
    expect(html).toContain("answers are not deleted at that moment");
    expect(html).toContain("30 days");
    expect(html).toContain("Challenge links");
    expect(html).toContain("CHALLENGES_ENABLED");
    expect(html).toContain("Defended · Strong");
    expect(html).toContain("Still sharpening");
    expect(html).toContain("public without the score");
    expect(html).toContain("keyed hash");
    expect(html).toContain("leaves these rows in place");
    expect(html).toContain("Ed25519");
    expect(html).toContain("does not contain the file");
    expect(html).toContain("Resend");
    expect(html).toContain("There is no delete button");
  });

  it("names the zero-retention rule and refuses an AI-detection or AI Act claim", () => {
    expect(html).toContain("Liquid");
    expect(html).toContain("zero_retention");
    expect(html).toContain("OpenRouter");
    expect(html).toContain("LLM_ALLOW_UNVERIFIED_RETENTION=1");
    expect(html).toContain("not an AI detector");
    expect(html).toContain("EU AI Act");
  });

  it("allows first-party funnel counts without a tracking cookie", () => {
    expect(html).toContain("No third-party trackers or advertising cookies");
    expect(html).toContain("our own database");
    expect(html).toContain("no tracking cookie");
  });
});

describe("site footer", () => {
  it("links every page to the privacy page", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("Privacy");
  });
});
