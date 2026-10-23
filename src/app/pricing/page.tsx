import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CheckoutButton } from "@/components/checkout-button";
import { PortalButton } from "@/components/portal-button";
import { checkoutUiAction, paidPlanBlocksCheckout, type CheckoutGatePlan } from "@/lib/checkout-gate";
import { publicFoundingAvailability } from "@/lib/founding";
import { signedInPlan } from "@/lib/signed-in-plan";
import { checkoutCatalog, type CheckoutProduct, type CheckoutSku } from "@/lib/stripe-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PricingPage() {
  await connection();
  const products = checkoutCatalog();
  if (!products) notFound();
  const founding = products.find((product) => product.sku === "founding_lifetime") ?? null;
  const rest = products.filter((product) => product.sku !== "founding_lifetime");
  const spots = founding ? await publicFoundingAvailability() : null;
  const plan = await signedInPlan();
  return (
    <div className="shell grid max-w-3xl gap-8">
      <header className="grid max-w-[68ch] gap-4">
        <h1 className="type-page">Pricing</h1>
        <p className="text-[var(--ink-2)]">
          Prices are in EUR. Defenses, challenges, packs, Pro, and founding include VAT. Team has VAT added. A
          defense and a challenge each cost 1 credit. Pack credits can be used for either. You can&apos;t claim a
          challenge bought by your own account. Enterprise is sold separately.
        </p>
        {paidPlanBlocksCheckout(plan) && (
          <p className="text-sm text-[var(--ink-2)]">
            This account already has a paid plan. Pro, Team, and founding open the billing portal. Cancel a Pro or
            Team subscription there and wait until it ends before buying a founding membership.
          </p>
        )}
      </header>
      <ul className="grid gap-4">
        {founding && spots && (
          <li className="panel grid gap-3 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="type-section">{founding.name}</h2>
              <span className="eyebrow">{founding.priceLabel}</span>
            </div>
            <p className="text-sm text-[var(--ink-2)]">{founding.detail}</p>
            <p className="label mb-0">{spots.remaining} of {spots.cap} spots left</p>
            {spots.remaining > 0 ? (
              <PlanAction sku={founding.sku} label={`Buy ${founding.name}`} plan={plan} />
            ) : (
              <p className="text-sm text-[var(--ink-2)]">Founding membership is sold out.</p>
            )}
          </li>
        )}
        {rest.map((product) => (
          <ProductCard key={product.sku} product={product} plan={plan} />
        ))}
      </ul>
      <p className="text-sm text-[var(--ink-2)]">
        <a href="/terms" className="underline hover:text-[var(--blueprint)]">
          Terms
        </a>
      </p>
    </div>
  );
}

function ProductCard({ product, plan }: { product: CheckoutProduct; plan: CheckoutGatePlan | null }) {
  return (
    <li className="panel grid gap-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="type-section">{product.name}</h2>
        <span className="eyebrow">{product.priceLabel}</span>
      </div>
      <p className="text-sm text-[var(--ink-2)]">{product.detail}</p>
      <PlanAction sku={product.sku} label={`Buy ${product.name}`} plan={plan} />
    </li>
  );
}

function PlanAction({
  sku,
  label,
  plan,
}: {
  sku: CheckoutSku;
  label: string;
  plan: CheckoutGatePlan | null;
}) {
  if (checkoutUiAction(sku, plan) === "portal") {
    return <PortalButton label="Open billing portal" />;
  }
  return <CheckoutButton sku={sku} label={label} />;
}
