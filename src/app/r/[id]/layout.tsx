import type { Metadata } from "next";
import type { ReactNode } from "react";
import { resultCardCopy } from "@/lib/challenges";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const card = await resultCardCopy(id);
  const description = card.score ? `${card.subtitle}. Score ${card.score} out of 100.` : card.subtitle;
  return {
    title: card.title,
    description: [card.kicker, description].filter(Boolean).join(" · "),
  };
}

export default function ReceiptLayout({ children }: { children: ReactNode }) {
  return children;
}
