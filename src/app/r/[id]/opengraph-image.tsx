import { renderOgCard } from "@/components/challenge/og";
import { resultCardCopy } from "@/lib/share-card";
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
  params?: Promise<{ id?: string }> | { id?: string };
}) {
  // Next calls this from the generated `generateStaticParams` while it is
  // collecting the build. There is no receipt id then. Skip the database so
  // a preview build does not open Postgres.
  const resolved = params ? await params : undefined;
  const id = resolved?.id;
  if (!id) {
    return [{ id: "v1-unknown", alt, size, contentType }];
  }
  const card = await resultCardCopy(id);
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
  const card = await resultCardCopy(receiptId);
  return renderOgCard(
    {
      kicker: card.kicker,
      title: card.title,
      subtitle: card.subtitle,
      foot: card.foot,
      score: card.score,
      lines: card.lines,
      actions: card.actions,
      tier: card.tier,
    },
    cacheControlForImage(requested, card),
  );
}
