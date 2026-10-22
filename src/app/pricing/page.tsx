import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CheckoutButton } from "@/components/checkout-button";
import { checkoutCatalog } from "@/lib/stripe-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PricingPage() {
  await connection();
  const products = checkoutCatalog();
  if (!products) notFound();
  return (
    <div className="shell max-w-3xl">
      <h1 className="text-3xl font-bold sm:text-4xl">Pricing</h1>
      <p className="mt-3 text-[var(--ink-2)]">
        Prices are in EUR. Defenses, challenges, packs, and Pro include VAT. Team has VAT added. A defense and a
        challenge each cost 1 credit. Pack credits can be used for either. You can&apos;t claim a challenge bought
        by your own account. Enterprise is sold separately.
      </p>
      <ul className="mt-6 grid gap-4">
        {products.map((product) => (
          <li key={product.sku} className="panel p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-xl font-bold">{product.name}</h2>
              <span className="eyebrow">{product.priceLabel}</span>
            </div>
            <p className="mt-2 text-sm text-[var(--ink-2)]">{product.detail}</p>
            <CheckoutButton sku={product.sku} label={`Buy ${product.name}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}
