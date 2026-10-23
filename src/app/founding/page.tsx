import type { Metadata } from "next";
import { connection } from "next/server";
import { CheckoutButton } from "@/components/checkout-button";
import { FoundingWaitlistForm } from "@/components/founding-waitlist-form";
import { PortalButton } from "@/components/portal-button";
import { checkoutUiAction } from "@/lib/checkout-gate";
import { publicFoundingAvailability } from "@/lib/founding";
import { SUPPORT_EMAIL } from "@/lib/operator";
import { billingEnabled, formatEur, FOUNDING_CAP, FOUNDING_PRICE_CENTS, getPlan } from "@/lib/plans";
import { signedInPlan } from "@/lib/signed-in-plan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Founding member · Defend It",
  description: "Founding member, €149 once, lifetime Pro, 100 spots.",
};

export default async function FoundingPage() {
  await connection();
  const billing = billingEnabled();
  const spots = billing ? await publicFoundingAvailability() : null;
  const plan = billing ? await signedInPlan() : null;
  const pro = getPlan("subscription");
  const price = formatEur(FOUNDING_PRICE_CENTS);
  const sendToPortal = checkoutUiAction("founding_lifetime", plan) === "portal";

  return (
    <div className="shell grid max-w-2xl gap-8">
      <header className="grid max-w-[68ch] gap-4">
        <p className="eyebrow">Founding member</p>
        <h1 className="type-page">Founding member, {price} once, lifetime Pro, {FOUNDING_CAP} spots</h1>
        <p className="text-[var(--ink-2)]">
          One payment of {price}. Then Pro every month: {pro.defensesPerPeriod} defenses, {pro.challengesPerPeriod}{" "}
          challenges, and {pro.learnSlots} Learn projects. Unused defenses and challenges do not roll over. VAT
          included.
        </p>
      </header>
      <section className="panel grid gap-4 p-5 sm:p-6">
        {billing && spots ? (
          <>
            <p className="label mb-0">{spots.remaining} spots left</p>
            <p className="text-sm text-[var(--ink-2)]">
              {spots.remaining === 0
                ? "All 100 spots are taken."
                : sendToPortal
                  ? plan?.interval === "lifetime"
                    ? "This account already has a founding membership."
                    : "Cancel the current Pro or Team subscription in the billing portal and wait until it ends. Founding checkout stays closed until then, and it does not cancel that subscription."
                  : "Checkout holds a spot for about 35 minutes."}
            </p>
            {spots.remaining === 0 ? (
              <p>
                Questions? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              </p>
            ) : sendToPortal ? (
              <PortalButton label="Open billing portal" />
            ) : (
              <CheckoutButton sku="founding_lifetime" label={`Become a founding member · ${price}`} />
            )}
          </>
        ) : (
          <>
            <h2 className="type-section">Founding spots coming soon, join the waitlist</h2>
            <p className="text-sm text-[var(--ink-2)]">
              Billing is not open yet. Leave an email and we will write when the {FOUNDING_CAP} spots are on sale. No
              account is required.
            </p>
            <FoundingWaitlistForm />
          </>
        )}
      </section>
    </div>
  );
}
