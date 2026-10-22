import { publicTierTitle, tierForScore } from "./challenge-tier";
import { receiptGate } from "./challenges";
import { appUrl } from "./config";
import {
  buildResultCard,
  cardFromReceipt,
  demoSampleCard,
  isDemoSample,
  publicLabel,
  unknownResultCard,
  withCardCopy,
  type ResultCardCopy,
} from "./result-card";
import { getReceipt } from "./services";

function receiptCardHost(): string {
  try {
    return new URL(appUrl()).host;
  } catch {
    return "defendit.me";
  }
}

/**
 * OG copy for a receipt link.
 *
 * Receipt bytes come from `getReceipt`. A sample demo (`payload.demo.sample`)
 * is never a credential: the card says so and shows no score. A challenge
 * result otherwise follows the visibility the defender stored. A receipt that
 * is not part of a challenge is public to anyone with the link.
 */
export async function resultCardCopy(receiptId: string): Promise<ResultCardCopy> {
  const signed = await getReceipt(receiptId);
  if (signed && isDemoSample(signed.payload)) {
    return withCardCopy(demoSampleCard(), {
      kicker: "Defend It",
      title: "Sample demo · Not a credential",
      subtitle: "",
      foot: "",
      score: null,
    });
  }
  const gate = await receiptGate(receiptId, null);
  const host = receiptCardHost();
  if (gate.result && gate.result.audience === "public") {
    const show = gate.result.showScore && gate.result.score != null;
    const card = signed
      ? cardFromReceipt({
          payload: signed.payload,
          visibility: show ? "public" : "score_hidden",
          fileLabel: gate.result.subject,
          host,
        })
      : buildResultCard({
          visibility: show ? "public" : "score_hidden",
          score: gate.result.score ?? 0,
          difficulty: "standard",
          questionCount: 0,
          sha256: "",
          createdAt: "",
          receiptId,
          host,
        });
    return withCardCopy(card, {
      kicker: gate.result.sponsorLabel,
      title: publicTierTitle(gate.result.tier),
      subtitle: publicLabel(gate.result.subject, 80) ?? "",
      foot: show ? "Signed receipt" : "Score not shown",
      score: show ? String(gate.result.score) : null,
    });
  }
  if (gate.mode === "challenge") {
    const card = buildResultCard({
      visibility: "private",
      score: 0,
      difficulty: "standard",
      questionCount: 0,
      sha256: "",
      createdAt: "",
      receiptId,
      host,
    });
    return withCardCopy(card, {
      kicker: "Defend It",
      title: "Defend It",
      subtitle: "Understanding receipt",
      foot: "",
      score: null,
    });
  }
  if (!signed) {
    return withCardCopy(unknownResultCard(), {
      kicker: "Defend It",
      title: "Understanding receipt",
      subtitle: "",
      foot: "",
      score: null,
    });
  }
  const card = cardFromReceipt({ payload: signed.payload, visibility: "public", host });
  const tier = tierForScore(signed.payload.score);
  return withCardCopy(card, {
    kicker: "Understanding receipt",
    title: publicTierTitle(tier),
    subtitle: tier,
    foot: "Defend It",
    score: String(signed.payload.score),
  });
}
