import { notFound } from "next/navigation";
import { ReportForm } from "@/components/challenge/actions";
import { challengesEnabled } from "@/lib/challenge-tier";
import { getPublicChallenge } from "@/lib/challenges";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!challengesEnabled()) notFound();
  const { slug } = await params;
  const view = await getPublicChallenge(slug, null);
  if (!view) notFound();
  return (
    <div className="shell max-w-2xl">
      <p className="eyebrow">Report</p>
      <h1 className="mt-2 text-3xl font-bold">Report this challenge</h1>
      <p className="mt-3 text-[var(--ink-2)]">{view.subject}</p>
      <ReportForm slug={view.slug} />
    </div>
  );
}
