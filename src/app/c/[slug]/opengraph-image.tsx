import { challengeCardCopy } from "@/lib/challenges";
import { ogContentType, ogSize, renderOgCard } from "@/components/challenge/og";

export const alt = "Defend It challenge";
export const size = ogSize;
export const contentType = ogContentType;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const card = await challengeCardCopy(slug);
  return renderOgCard(
    card ?? {
      kicker: "Defend It",
      title: "Challenge",
      subtitle: "",
      foot: "",
    },
  );
}
