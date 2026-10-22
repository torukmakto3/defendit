import { describe, expect, it } from "vitest";
import { publicTierTitle, TIER_DEFENDED_MIN, TIER_STRONG_MIN, tierForScore } from "../src/lib/challenge-tier";
import {
  buildResultCard,
  cacheControlForImage,
  cardFromReceipt,
  demoSampleCard,
  CARD_HEIGHT,
  CARD_WIDTH,
  fileFingerprint,
  questionCountOf,
  renderShareMetaTags,
  RESULT_CARD_CACHE_CONTROL,
  shareMetadata,
  toNextMetadata,
  withCardCopy,
  type ResultCard,
} from "../src/lib/result-card";
import type { ReceiptPayload } from "../src/lib/types";

const HASH_A = "3f9a" + "11".repeat(28) + "c71e";
const HASH_B = "a12d" + "22".repeat(28) + "9b04";
const HASH_C = "77be" + "33".repeat(28) + "02fa";

function fullCard(overrides?: Partial<Parameters<typeof buildResultCard>[0]>) {
  return buildResultCard({
    visibility: "public",
    score: 85,
    difficulty: "hard",
    questionCount: 8,
    sha256: HASH_A,
    createdAt: "2026-10-19T12:00:00.000Z",
    receiptId: "xxxx",
    defenderName: "@handle",
    fileLabel: "launch-architecture.md",
    challengerName: "@challenger",
    host: "defendit.me",
    ...overrides,
  });
}

function blob(card: ResultCard): string {
  return [card.title, card.description, card.alt, card.headline, ...card.lines.map((line) => line.text)].join("\n");
}

describe("challenge tiers", () => {
  it("uses the shipped tier lines: Strong at 85, Defended from 70", () => {
    expect(TIER_STRONG_MIN).toBe(85);
    expect(TIER_DEFENDED_MIN).toBe(70);
    expect(tierForScore(100)).toBe("Strong");
    expect(tierForScore(85)).toBe("Strong");
    expect(tierForScore(84)).toBe("Defended");
    expect(tierForScore(75)).toBe("Defended");
    expect(tierForScore(70)).toBe("Defended");
    expect(tierForScore(69)).toBe("Still sharpening");
    expect(tierForScore(58)).toBe("Still sharpening");
    expect(tierForScore(0)).toBe("Still sharpening");
    expect(tierForScore(Number.NaN)).toBe("Still sharpening");
    expect(publicTierTitle("Strong")).toBe("Defended · Strong");
    expect(publicTierTitle("Defended")).toBe("Defended");
    expect(publicTierTitle("Still sharpening")).toBe("Still sharpening");
    expect(publicTierTitle(null)).toBe("Defended");
  });
});

describe("result card copy", () => {
  it("variant A matches the kit for a Strong score", () => {
    const card = fullCard();
    expect(card.variant).toBe("A");
    expect(card.headline).toBe("Defended · Strong");
    expect(card.title).toBe("Defended · Strong");
    expect(card.lines.map((line) => line.text)).toEqual([
      '@handle defended "launch-architecture.md"',
      "Score 85/100 · Hard · 8 questions",
      "File SHA-256  3f9a…c71e",
      "19 Oct 2026 · Challenged by @challenger",
      "Signed (Ed25519) · verify: defendit.me/r/xxxx",
    ]);
    expect(card.actions).toEqual(["Challenge someone", "Defend your own"]);
    expect(card.alt).toBe(
      "DefendIT receipt card. @handle defended the file launch-architecture.md on 19 October 2026, rated Strong, 85 out of 100 on Hard difficulty across 8 questions. File fingerprint SHA-256 starting 3f9a and ending c71e. Digitally signed; verify at defendit.me/r/xxxx.",
    );
    expect(blob(card)).not.toContain(HASH_A);
  });

  it("uses the Defended headline below the strong line and above the pass line", () => {
    const card = fullCard({ score: 70, questionCount: 1 });
    expect(card.variant).toBe("A");
    expect(card.headline).toBe("Defended");
    expect(blob(card)).toContain("Score 70/100 · Hard · 1 question");
    expect(card.alt).toContain("rated Defended");
  });

  it("variant B shows the tier and hides the score and the difficulty", () => {
    const card = fullCard({
      visibility: "score_hidden",
      score: 84,
      fileLabel: "README.md",
      sha256: HASH_B,
      challengerName: "@challenger",
    });
    expect(card.variant).toBe("B");
    expect(card.headline).toBe("Defended");
    expect(card.tier).toBe("Defended");
    expect(card.lines.map((line) => line.text)).toEqual([
      '@handle defended "README.md"',
      "Result: kept private by the defender",
      "File SHA-256  a12d…9b04",
      "19 Oct 2026",
      "Signed receipt · verify: defendit.me/r/xxxx",
    ]);
    expect(card.alt).toBe(
      "DefendIT receipt card. @handle defended the file README.md on 19 October 2026, rated Defended. The number stays off this card. File fingerprint SHA-256 starting a12d and ending 9b04. Signed receipt; verify at defendit.me/r/xxxx.",
    );
    const text = blob(card);
    expect(text).not.toContain("84");
    expect(text).not.toContain("Score");
    expect(text).not.toContain("Strong");
    expect(text).not.toContain("Hard");
    expect(text).not.toContain("@challenger");
    expect(text).not.toContain(HASH_B);
  });

  it("uses variant B for a Still sharpening result shared without the score", () => {
    const card = fullCard({ visibility: "score_hidden", score: 58, fileLabel: "pitch-memo.pdf" });
    expect(card.variant).toBe("B");
    expect(card.headline).toBe("Still sharpening");
    expect(blob(card)).not.toContain("58");
    expect(blob(card).toLowerCase()).not.toContain("fail");
  });

  it("a score-hidden overlay keeps the tier title and drops the number", () => {
    const card = fullCard({ visibility: "score_hidden", score: 92, fileLabel: "Tier band subject" });
    const copy = withCardCopy(card, {
      kicker: "Sponsored by DefendIT",
      title: "Defended · Strong",
      subtitle: "Tier band subject",
      foot: "Score not shown",
      score: null,
    });
    expect(copy.title).toBe("Defended · Strong");
    expect(copy.headline).toBe("Defended · Strong");
    expect(copy.score).toBeNull();
    expect(copy.subtitle).toBe("Tier band subject");
    expect(copy.foot).toBe("Score not shown");
    const drawn = [copy.title, copy.subtitle, copy.alt, ...copy.lines.map((line) => line.text)].join("\n");
    expect(drawn).not.toContain("92");
    expect(drawn).not.toContain("Hard");
  });

  it("variant C frames a public low score as progress", () => {
    const card = fullCard({
      score: 58,
      difficulty: "standard",
      sha256: HASH_C,
      fileLabel: "pitch-memo.pdf",
      attempt: 1,
      strongest: "assumptions",
      nextFocus: "edge cases",
      questionCount: 8,
    });
    expect(card.variant).toBe("C");
    expect(card.headline).toBe("Still sharpening");
    expect(card.lines.map((line) => line.text)).toEqual([
      '@handle defended "pitch-memo.pdf"',
      "Round 1 · Standard · score shown by choice: 58/100",
      "Strongest answer: assumptions · Next: edge cases",
      "File SHA-256  77be…02fa · 19 Oct 2026",
      "Verify: defendit.me/r/xxxx",
    ]);
    expect(card.actions).toEqual(["Defend your own", "Rematch"]);
    expect(card.alt).toBe(
      "DefendIT receipt card. @handle took round 1 of a defense challenge on pitch-memo.pdf on 19 October 2026, Standard difficulty, status Still sharpening, score 58 out of 100 shown by the defender's choice. Strongest area: assumptions; next to work on: edge cases. File fingerprint SHA-256 starting 77be and ending 02fa. Verify at defendit.me/r/xxxx.",
    );
    const text = blob(card).toLowerCase();
    expect(text).not.toContain("fail");
    expect(text).not.toContain("not defended");
  });

  it("a private receipt is a generic card with no score and no file name", () => {
    const card = fullCard({
      visibility: "private",
      score: 84,
      defenderName: "Ada Lovelace",
      fileLabel: "secret-launch.md",
      challengerName: "@challenger",
    });
    expect(card.variant).toBe("private");
    expect(card.imageId).toBe("v1-private");
    expect(card.actions).toEqual([]);
    const text = blob(card);
    expect(text).not.toContain("84");
    expect(text).not.toContain("secret-launch.md");
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("@challenger");
    expect(text).not.toContain("3f9a");
    expect(text).not.toContain("Hard");
    expect(text).toContain("kept this result private");
    expect(card.alt).toContain("no score and no file name");
  });

  it("drops emails, the full digest, and integrity wording", () => {
    const payload: ReceiptPayload = {
      id: "rcpt_publicreceipt0001",
      version: "defend-it-receipt-v2",
      createdAt: "2026-10-19T12:00:00.000Z",
      difficulty: "expert",
      score: 91,
      outcome: "Defended",
      bands: { strong: 4, partial: 2, weak: 0 },
      deliverable: { sha256: HASH_A, byteLength: 120 },
      rubricVersion: "defend-it-rubric-v0.4",
      modelVersions: ["mock:one"],
      integrity: { status: "Concerns" },
      attempt: 1,
      assuranceLevel: "L1",
      creator: { displayName: "ada@example.com", nameSelfReported: true },
    };
    const card = cardFromReceipt({
      payload,
      fileLabel: "notes@work.com",
      challengerName: "sam@example.com",
      host: "defendit.me",
    });
    const text = blob(card);
    expect(text).not.toContain("@");
    expect(text).not.toContain("Concerns");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain(HASH_A);
    expect(text).toContain("A defender defended a file");
    expect(text).toContain("Expert");
    expect(text).toContain("6 questions");
    expect(questionCountOf(payload.bands)).toBe(6);
    expect(fileFingerprint(HASH_A)).toEqual({ start: "3f9a", end: "c71e", label: "3f9a…c71e" });
  });

  it("omits a file name the defender did not share", () => {
    const card = fullCard({ fileLabel: "   ", challengerName: null });
    expect(blob(card)).toContain("@handle defended a file");
    expect(blob(card)).not.toContain("Challenged by");
    expect(card.alt).toContain("defended a file on 19 October 2026");
  });
});

describe("sample demo cards", () => {
  it("shows the sample line and no score, even when the payload scored in the top band", () => {
    const payload: ReceiptPayload = {
      id: "rcpt_demoreceipt00001",
      version: "defend-it-receipt-v2",
      createdAt: "2026-10-19T12:00:00.000Z",
      difficulty: "expert",
      score: 96,
      outcome: "Defended",
      bands: { strong: 3, partial: 0, weak: 0 },
      deliverable: { sha256: HASH_A, byteLength: 120 },
      rubricVersion: "defend-it-rubric-v0.4",
      modelVersions: ["mock:one"],
      integrity: { status: "Concerns" },
      attempt: 1,
      assuranceLevel: "L1",
      creator: { displayName: "Ada Lovelace", nameSelfReported: true },
      demo: {
        sample: true,
        credential: false,
        file: "Harbor README",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    const card = cardFromReceipt({
      payload,
      visibility: "public",
      fileLabel: "secret-launch.md",
      challengerName: "@challenger",
      host: "defendit.me",
    });
    expect(card).toEqual(demoSampleCard());
    expect(card.title).toBe("Sample demo · Not a credential");
    expect(card.headline).toBe("Sample demo · Not a credential");
    expect(card.imageId).toBe("v1-demo");
    const text = blob(card);
    expect(text).not.toContain("96");
    expect(text).not.toContain("secret-launch.md");
    expect(text).not.toContain("Harbor");
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("Strong");
    expect(text).not.toContain("Expert");
    expect(text).not.toContain("Concerns");
    expect(text).not.toContain(HASH_A);
    expect(text).toContain("Not a credential");
  });
});

describe("share metadata", () => {
  const cases: { name: string; card: ResultCard; id: string }[] = [
    { name: "A", card: fullCard(), id: "rcpt_full" },
    {
      name: "B",
      card: fullCard({ visibility: "score_hidden", score: 84, fileLabel: "README.md", sha256: HASH_B }),
      id: "rcpt_hidden",
    },
    {
      name: "C",
      card: fullCard({
        score: 58,
        difficulty: "standard",
        sha256: HASH_C,
        fileLabel: "pitch-memo.pdf",
        attempt: 1,
        strongest: "assumptions",
        nextFocus: "edge cases",
      }),
      id: "rcpt_sharpening",
    },
    { name: "private", card: fullCard({ visibility: "private", fileLabel: "secret.md", score: 12 }), id: "rcpt_private" },
  ];

  it.each(cases)("renders Open Graph and Twitter tags for $name", ({ card, id }) => {
    const share = shareMetadata(card, id);
    const tags = renderShareMetaTags(share);
    const meta = toNextMetadata(share, `/r/${id}`);
    expect(tags).toContain(`<meta property="og:title" content="${card.title}" />`);
    expect(tags).toContain(`<meta property="og:image:alt" content="${card.alt}" />`);
    expect(tags).toContain(`<meta name="twitter:card" content="summary_large_image" />`);
    expect(tags).toContain(`<meta name="twitter:image:alt" content="${card.alt}" />`);
    expect(tags.join("\n")).toContain(`/r/${id}/opengraph-image/${card.imageId}`);
    expect(tags.join("\n")).toContain(`/r/${id}/twitter-image/${card.imageId}`);
    expect(meta.twitter && "card" in meta.twitter && meta.twitter.card).toBe("summary_large_image");
    expect(meta.openGraph?.title).toBe(card.title);
    expect(meta.openGraph?.images).toEqual([
      expect.objectContaining({
        url: share.ogImagePath,
        alt: card.alt,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      }),
    ]);
    expect(share.ogImagePath).toContain(card.imageId);
    expect(card.imageId === "v1-private" || card.imageId === "v1-score_hidden" || card.imageId === "v1-public").toBe(
      true,
    );
    const rendered = tags.join("\n");
    expect(rendered).not.toContain("Concerns");
    expect(rendered).not.toContain("@example.com");
    if (card.variant === "B" || card.variant === "private") {
      expect(rendered).not.toMatch(/Score \d/);
      expect(rendered).not.toContain("secret.md");
    }
  });

  it("caches the versioned image and refuses to store a stale visibility id", () => {
    const card = fullCard();
    expect(cacheControlForImage(card.imageId, card)).toBe(RESULT_CARD_CACHE_CONTROL);
    expect(cacheControlForImage("v1-public", card)).toBe(RESULT_CARD_CACHE_CONTROL);
    expect(cacheControlForImage("v1-private", card)).toBe("private, no-store");
    expect(card.imageId).toBe("v1-public");
  });
});
