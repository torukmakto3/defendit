import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "../src/app/privacy/page";
import { OPERATOR_NAME } from "../src/lib/operator";
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
    expect(html).toContain("paste count");
    expect(html).toContain("focus-loss count");
    expect(html).not.toContain("keeps only the status word");
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
    expect(html).toContain("di_demo");
    expect(html).toContain("kept for 24 hours");
    expect(html).toContain("keyed hash");
  });

  it("describes analytics rows and the keyed beacon limit", () => {
    expect(html).toContain("Analytics");
    expect(html).toContain("landing_view");
    expect(html).toContain("sign_in_started");
    expect(html).toContain("sign_in_completed");
    expect(html).toContain("defense_started");
    expect(html).toContain("defense_completed");
    expect(html).toContain("learn_opened");
    expect(html).toContain("receipt_shared");
    expect(html).toContain("challenge_created");
    expect(html).toContain("challenge_opened");
    expect(html).toContain("challenge_accepted");
    expect(html).toContain("challenge_declined");
    expect(html).toContain("challenge_completed");
    expect(html).toContain("challenge_shared_back");
    expect(html).toContain("rounded to the minute");
    expect(html).toContain("referrer domain");
    expect(html).toContain("utm_source");
    expect(html).toContain("utm_campaign");
    expect(html).toContain("does not store a cookie");
    expect(html).toContain("Do Not Track");
    expect(html).toContain("Global Privacy Control");
    expect(html).toContain("90 days");
    expect(html).toContain("keyed hash of the IP address");
  });

  it("states the GDPR bases, the real file clocks, and the rights", () => {
    expect(html).toContain("Your account is kept until you delete it or ask us to");
    expect(html).toContain("produced automatically");
    expect(html).toContain("human review");
    expect(html).toContain("Article 13(2)(f)");
    expect(html).toContain("Article 22");
    expect(html).toContain("restrict processing");
    expect(html).toContain("within one month");
    expect(html).toContain("Article 6(1)(b)");
    expect(html).toContain("Article 6(1)(f)");
    expect(html).toContain("anonymous view is not counted");
    expect(html).toContain("IP limit is skipped");
    expect(html).toContain("legitimate interest");
    expect(html).toContain("raw uploaded file is not kept");
    expect(html).toContain("DOCUMENT_TTL_HOURS");
    expect(html).toContain("RETENTION_DAYS");
    expect(html).toContain("access");
    expect(html).toContain("portability");
    expect(html).toContain("object");
    expect(html).toContain("Comissão Nacional de Proteção de Dados");
    expect(html).toContain("https://www.cnpd.pt/");
    expect(html).toContain("geral@cnpd.pt");
    expect(html).toContain(OPERATOR_NAME);
    expect(html).not.toContain("Luis");
    expect(html).toContain("mailto:tramuntanabtc@gmail.com");
    expect(html).toContain("There is no delete button");
    expect(html).not.toContain("TODO(legal review)");
    expect(html).not.toContain("Draft, last updated");
  });

  it("names the model and voice hosts the code actually calls", () => {
    expect(html).toContain("router.inference.ai.exchange");
    expect(html).toContain("openrouter.ai");
    expect(html).toContain("api.groq.com");
    expect(html).toContain("api.openai.com");
    expect(html).toContain("api.anthropic.com");
    expect(html).toContain("LiveKit");
    expect(html).toContain("*.livekit.cloud");
    expect(html).toContain("Deepgram");
    expect(html).toContain("nova-3");
    expect(html).toContain("xai/tts-1");
    expect(html).toContain("api.resend.com");
    expect(html).toContain("accounts.google.com");
    expect(html).toContain("api.typesafe.ai");
    expect(html).toContain("does not receive interview content");
    expect(html).toContain("standard contractual clauses");
    expect(html).toContain("does not record the country");
    expect(html).toContain("Stripe");
    expect(html).toContain("card fingerprint");
    expect(html).toContain("do not store the card number");
  });

  it("keeps the draft marker and the legal-review note in the source only", () => {
    const source = readFileSync("src/app/privacy/page.tsx", "utf8");
    expect(source.startsWith("// Draft, last updated 2026-10-22\n")).toBe(true);
    expect(source).toContain("// TODO(legal review): placeholder contact");
  });
});

describe("site footer", () => {
  it("links every page to the privacy page", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("Privacy");
  });
});
