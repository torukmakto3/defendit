import type { Metadata } from "next";
import type { ReactNode } from "react";
import { appUrl } from "@/lib/config";
import { loadShareCard } from "@/lib/result-card-loader";
import { shareMetadata, toNextMetadata } from "@/lib/result-card";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const card = await loadShareCard(id);
  return {
    metadataBase: new URL(appUrl()),
    ...toNextMetadata(shareMetadata(card, id), `/r/${id}`),
  };
}

export default function ReceiptLayout({ children }: { children: ReactNode }) {
  return children;
}
