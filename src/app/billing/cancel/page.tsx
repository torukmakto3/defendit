import Link from "next/link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function BillingCancelPage() {
  return (
    <div className="shell max-w-xl">
      <h1 className="text-3xl font-bold">Checkout canceled</h1>
      <p className="mt-3 text-[var(--ink-2)]">No charge was made.</p>
      <Link href="/pricing" className="btn btn-ghost mt-6">
        Back to pricing
      </Link>
    </div>
  );
}
