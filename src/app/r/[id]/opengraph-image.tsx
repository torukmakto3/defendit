import { renderResultCard } from "@/components/receipt/ResultCardImage";
import { loadShareCard } from "@/lib/result-card-loader";
import { cacheControlForImage, CARD_HEIGHT, CARD_WIDTH } from "@/lib/result-card";

export const alt = "DefendIT receipt card";
export const size = { width: CARD_WIDTH, height: CARD_HEIGHT };
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One image per visibility. The id is `v1-public`, `v1-score_hidden`,
 * `v1-private`, or `v1-unknown`, so a visibility change is a new URL.
 * `params` is awaited: Next 16 passes a promise here, and awaiting a plain
 * object is a no-op if a caller still passes one.
 */
export async function generateImageMetadata({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const { id } = await params;
  const card = await loadShareCard(id);
  return [
    {
      id: card.imageId,
      alt: card.alt,
      size,
      contentType,
    },
  ];
}

export default async function Image({
  params,
  id,
}: {
  params: Promise<{ id: string }>;
  id: Promise<string>;
}) {
  const { id: receiptId } = await params;
  const requested = await id;
  const card = await loadShareCard(receiptId);
  return renderResultCard(card, cacheControlForImage(requested, card));
}
