import { receiptGate } from "./challenges";
import { appUrl } from "./config";
import { getReceipt } from "./services";
import { buildResultCard, cardFromReceipt, unknownResultCard, type ResultCard } from "./result-card";

/** Host shown on the card, without a scheme. */
export function shareHost(): string {
  try {
    return new URL(appUrl()).host;
  } catch {
    return "defendit.me";
  }
}

/**
 * Card for a receipt link.
 *
 * A receipt that is not part of a challenge is public to anyone with the
 * link. A challenge receipt uses the visibility the defender stored: public,
 * score hidden, or private. Private and not-yet-published results render the
 * generic card, with no score and no file name.
 */
export async function loadShareCard(receiptId: string): Promise<ResultCard> {
  const gate = await receiptGate(receiptId, null);
  if (gate.mode === "challenge") {
    const chosen = gate.result?.visibility;
    if ((chosen !== "public" && chosen !== "score_hidden") || !gate.result) return privateShareCard(receiptId);
    const receipt = await getReceipt(receiptId);
    if (!receipt) return unknownResultCard();
    return cardFromReceipt({
      payload: receipt.payload,
      visibility: chosen,
      fileLabel: gate.result.subject,
      host: shareHost(),
    });
  }
  const receipt = await getReceipt(receiptId);
  if (!receipt) return unknownResultCard();
  return cardFromReceipt({
    payload: receipt.payload,
    visibility: "public",
    host: shareHost(),
  });
}

function privateShareCard(receiptId: string): ResultCard {
  return buildResultCard({
    visibility: "private",
    score: 0,
    difficulty: "standard",
    questionCount: 0,
    sha256: "",
    createdAt: "",
    receiptId,
    host: shareHost(),
  });
}
