import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FaqPage, { metadata as faqMeta } from "../src/app/faq/page";
import HowItWorksPage, { metadata as howMeta } from "../src/app/how-it-works/page";
import TermsPage, { metadata as termsMeta } from "../src/app/terms/page";
import { CreditTermsNotice } from "../src/components/credit-terms";
import { SiteFooter } from "../src/components/site-footer";
import { betaBudgetEur, betaDefenseEur } from "../src/lib/beta";
import { TIER_DEFENDED_MIN, TIER_STRONG_MIN } from "../src/lib/challenge-tier";
import {
  CHALLENGE_DAILY_PER_CREATOR_DEFAULT,
  CHALLENGE_OPEN_PER_CREATOR_DEFAULT,
  CHALLENGE_OPEN_PER_DEFENDER_DEFAULT,
  CHALLENGE_UNCLAIMED_DAYS_DEFAULT,
} from "../src/lib/challenge-public";
import { dailyPerCreator, openPerCreator, openPerDefender } from "../src/lib/challenges";
import { GRADING_TEMPERATURE } from "../src/lib/llm";
import { LEGAL_UPDATED, OPERATOR_EMAIL, OPERATOR_NAME } from "../src/lib/operator";
import { BETA_GRANT, formatEur, getPlan, PACKS, PAYG_CENTS } from "../src/lib/plans";
import { documentTtlHours, retentionDays } from "../src/lib/retention";
import { bandFor } from "../src/lib/score";
import {
  CHALLENGE_STRONG_MIN_SCORE,
  DEFENDED_MIN_SCORE,
  PARTIAL_CLAIM_SCORE,
  PARTIAL_LEVEL,
  PARTIAL_MIN_SCORE,
  STRONG_CLAIM_SCORE,
  STRONG_LEVEL,
} from "../src/lib/score-bands";
import { bandOf } from "../src/components/receipt/metrics";
import { outcomeFor } from "../src/lib/receipt";

const root = join(__dirname, "..");

function page(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

describe("public pages", () => {
  const terms = page(createElement(TermsPage));
  const how = page(createElement(HowItWorksPage));
  const faq = page(createElement(FaqPage));
  const footer = page(createElement(SiteFooter));
  const credit = page(createElement(CreditTermsNotice));

  it("renders terms, how it works, and the FAQ without the draft mark", () => {
    for (const html of [terms, how, faq]) {
      expect(html).toContain(LEGAL_UPDATED);
      expect(html).toContain("Last updated");
      expect(html).not.toContain("Draft");
      expect(html).not.toContain("TODO(legal review)");
    }
    expect(terms).toContain("Terms of Service");
    expect(how).toContain("How it works");
    expect(faq).toContain("Questions");
  });

  it("keeps the draft comment in source and the contact off the page as a todo", () => {
    for (const file of ["src/app/terms/page.tsx", "src/app/how-it-works/page.tsx", "src/app/faq/page.tsx"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src.startsWith("// Draft, last updated 2026-10-22")).toBe(true);
    }
    const operator = readFileSync(join(root, "src/lib/operator.ts"), "utf8");
    expect(operator).toContain("// TODO(legal review): placeholder contact");
    expect(terms).toContain(OPERATOR_NAME);
    expect(terms).toContain(`mailto:${OPERATOR_EMAIL}`);
    expect(faq).toContain(`mailto:${OPERATOR_EMAIL}`);
  });

  it("prints prices and the beta grant from the plan module", () => {
    expect(terms).toContain(formatEur(PAYG_CENTS.defense));
    expect(terms).toContain(formatEur(PAYG_CENTS.challenge));
    expect(terms).toContain(formatEur(PACKS.pack3.priceCents));
    expect(terms).toContain(formatEur(PACKS.pack8.priceCents));
    expect(terms).toContain(formatEur(getPlan("subscription").priceCents.month ?? 0));
    expect(terms).toContain(formatEur(getPlan("subscription").priceCents.year ?? 0));
    expect(terms).toContain(formatEur(getPlan("team").priceCents.month ?? 0));
    expect(terms).toContain(formatEur(getPlan("enterprise").priceCents.month ?? 0));
    expect(terms).toContain(formatEur(getPlan("enterprise").overageCents ?? 0));
    expect(terms).toContain("dit_defense_payg");
    expect(terms).toContain("dit_enterprise_extra_unit");
    expect(terms).toContain(String(BETA_GRANT.challenge));
    expect(terms).toContain(String(BETA_GRANT.learnSlots));
    expect(terms).toContain(formatEur(Math.round(betaBudgetEur() * 100)));
    expect(terms).toContain(formatEur(Math.round(betaDefenseEur() * 100)));
    expect(faq).toContain(formatEur(PAYG_CENTS.defense));
    expect(terms).toContain("wallet");
    expect(faq).toContain("wallet");
  });

  it("uses the score lines from the grading code", () => {
    expect(outcomeFor(DEFENDED_MIN_SCORE)).toBe("Defended");
    expect(outcomeFor(DEFENDED_MIN_SCORE - 1)).toBe("Partially defended");
    expect(outcomeFor(PARTIAL_MIN_SCORE)).toBe("Partially defended");
    expect(outcomeFor(PARTIAL_MIN_SCORE - 1)).toBe("Not defended");
    expect(bandOf(STRONG_CLAIM_SCORE)).toBe("strong");
    expect(bandOf(STRONG_CLAIM_SCORE - 1)).toBe("partial");
    expect(bandOf(PARTIAL_CLAIM_SCORE)).toBe("partial");
    expect(bandOf(PARTIAL_CLAIM_SCORE - 1)).toBe("weak");
    expect(bandFor(STRONG_LEVEL)).toBe("Strong");
    expect(bandFor(PARTIAL_LEVEL)).toBe("Partial");
    expect(bandFor(PARTIAL_LEVEL - 0.01)).toBe("Weak");

    expect(how).toContain(String(DEFENDED_MIN_SCORE));
    expect(how).toContain(String(PARTIAL_MIN_SCORE));
    expect(how).toContain(String(STRONG_CLAIM_SCORE));
    expect(how).toContain(String(PARTIAL_CLAIM_SCORE));
    expect(CHALLENGE_STRONG_MIN_SCORE).toBe(TIER_STRONG_MIN);
    expect(DEFENDED_MIN_SCORE).toBe(TIER_DEFENDED_MIN);
    expect(how).toContain(String(CHALLENGE_STRONG_MIN_SCORE));
    expect(how).toContain("Still sharpening");
    expect(how).toContain("Defended · Strong");
    expect(how).toContain(`temperature ${GRADING_TEMPERATURE}`);
    expect(how).toContain("/r/[id]");
    expect(how).toContain("/verify/[id]");
    expect(how).toContain("SHA-256");
    expect(how).toContain("Ed25519");
    expect(how).toContain("not a certification");
  });

  it("states file clocks, challenge opt-out, and that a receipt is one interview", () => {
    expect(faq).toContain(String(documentTtlHours()));
    expect(faq).toContain(String(retentionDays()));
    expect(faq).toContain("DOCUMENT_TTL_HOURS");
    expect(faq).toContain("RETENTION_DAYS");
    expect(faq).toContain("not stored");
    expect(faq).toContain("There is no delete button");
    const saved = {
      open: process.env.CHALLENGE_OPEN_PER_CREATOR,
      daily: process.env.CHALLENGE_DAILY_PER_CREATOR,
      defender: process.env.CHALLENGE_OPEN_PER_DEFENDER,
    };
    delete process.env.CHALLENGE_OPEN_PER_CREATOR;
    delete process.env.CHALLENGE_DAILY_PER_CREATOR;
    delete process.env.CHALLENGE_OPEN_PER_DEFENDER;
    try {
      expect(openPerCreator()).toBe(CHALLENGE_OPEN_PER_CREATOR_DEFAULT);
      expect(dailyPerCreator()).toBe(CHALLENGE_DAILY_PER_CREATOR_DEFAULT);
      expect(openPerDefender()).toBe(CHALLENGE_OPEN_PER_DEFENDER_DEFAULT);
    } finally {
      if (saved.open == null) delete process.env.CHALLENGE_OPEN_PER_CREATOR;
      else process.env.CHALLENGE_OPEN_PER_CREATOR = saved.open;
      if (saved.daily == null) delete process.env.CHALLENGE_DAILY_PER_CREATOR;
      else process.env.CHALLENGE_DAILY_PER_CREATOR = saved.daily;
      if (saved.defender == null) delete process.env.CHALLENGE_OPEN_PER_DEFENDER;
      else process.env.CHALLENGE_OPEN_PER_DEFENDER = saved.defender;
    }
    expect(terms).toContain(String(CHALLENGE_UNCLAIMED_DAYS_DEFAULT));
    expect(terms).toContain("do-not-challenge");
    expect(terms).toContain("one interview about one file");
    expect(terms).toContain("not a certification");
    expect(faq).toContain("Opting out");
    expect(terms).toContain("Portuguese law");
  });

  it("sets a title and description on each page", () => {
    expect(termsMeta.title).toBe("Terms of Service · Defend It");
    expect(termsMeta.description).toMatch(/refund/i);
    expect(howMeta.title).toBe("How it works · Defend It");
    expect(howMeta.description).toMatch(/receipt/i);
    expect(faqMeta.title).toBe("FAQ · Defend It");
    expect(faqMeta.description).toMatch(/credit/i);
  });

  it("links terms, privacy, how it works, and the FAQ from the footer", () => {
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/how-it-works"');
    expect(footer).toContain('href="/faq"');
    expect(footer).toContain(">Terms<");
    expect(footer).toContain(">Privacy<");
    expect(footer).toContain(">How it works<");
    expect(footer).toContain(">FAQ<");
    const layout = readFileSync(join(root, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("<SiteFooter");
  });

  it("puts the credit purchase sentence on the out-of-credits notice", () => {
    expect(credit).toContain("By buying credits you agree to the");
    expect(credit).toContain('href="/terms"');
    const defend = readFileSync(join(root, "src/app/d/[token]/defend/page.tsx"), "utf8");
    expect(defend).toContain("CreditTermsNotice");
    expect(defend).toContain("isCreditWall");
  });
});
