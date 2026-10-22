import Link from "next/link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function BillingSuccessPage() {
  return (
    <div className="shell max-w-xl">
      <h1 className="text-3xl font-bold">Payment received</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Stripe is confirming the payment. Credits show on your dashboard after that confirmation. This page does not
        add credits by itself.
      </p>
      <Link href="/dashboard" className="btn btn-primary mt-6">
        Dashboard
      </Link>
    </div>
  );
}
