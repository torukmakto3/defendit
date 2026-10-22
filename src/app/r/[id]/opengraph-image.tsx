import { resultCardCopy } from "@/lib/challenges";
import { ogContentType, ogSize, renderOgCard } from "@/components/challenge/og";

export const alt = "Defend It result";
export const size = ogSize;
export const contentType = ogContentType;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await resultCardCopy(id);
  return renderOgCard(card);
}
