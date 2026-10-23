import { formatEur, FOUNDING_CAP, FOUNDING_PRICE_CENTS, getPlan, PACKS, PAYG_CENTS } from "@/lib/plans";

/** Amounts come from `plans.ts`. Checkout is not on, so this list does not name Stripe prices. */
export function PriceList() {
  const pro = getPlan("subscription");
  const team = getPlan("team");
  const enterprise = getPlan("enterprise");
  const proMonth = pro.priceCents.month ?? 0;
  const proYear = pro.priceCents.year ?? 0;
  const teamMonth = team.priceCents.month ?? 0;
  const enterpriseMonth = enterprise.priceCents.month ?? 0;
  const overage = enterprise.overageCents ?? 0;

  const rows: { name: string; price: string; detail: string }[] = [
    {
      name: "One defense",
      price: formatEur(PAYG_CENTS.defense),
      detail: "1 defense credit. VAT included.",
    },
    {
      name: "One challenge",
      price: formatEur(PAYG_CENTS.challenge),
      detail: "1 challenge credit. VAT included. You cannot take a challenge you created.",
    },
    {
      name: `${PACKS.pack3.credits}-credit pack`,
      price: formatEur(PACKS.pack3.priceCents),
      detail: "Flexible credits. Each one can pay for a defense or a challenge. VAT included.",
    },
    {
      name: `${PACKS.pack8.credits}-credit pack`,
      price: formatEur(PACKS.pack8.priceCents),
      detail: "Flexible credits, same rule as the smaller pack. VAT included.",
    },
    {
      name: "Pro, monthly",
      price: `${formatEur(proMonth)} / month`,
      detail: `${pro.defensesPerPeriod} defenses, ${pro.challengesPerPeriod} challenges, and ${pro.learnSlots} Learn projects each month. VAT included.`,
    },
    {
      name: "Pro, yearly",
      price: `${formatEur(proYear)} / year`,
      detail: `Credits are granted as shown at checkout. Learn stays capped at ${pro.learnSlots} open projects. VAT included.`,
    },
    {
      name: "Team",
      price: `${formatEur(teamMonth)} / month`,
      detail: `${team.defensesPerPeriod} defenses a month. No challenge credits are included. Learn projects are not capped. The price is before VAT.`,
    },
    {
      name: "Founding member",
      price: `${formatEur(FOUNDING_PRICE_CENTS)} once`,
      detail: `Lifetime Pro: ${pro.defensesPerPeriod} defenses, ${pro.challengesPerPeriod} challenges, and ${pro.learnSlots} Learn projects each month. Unused defenses and challenges do not roll over. ${FOUNDING_CAP} spots. VAT included.`,
    },
    {
      name: "Enterprise",
      price: `${formatEur(enterpriseMonth)} / month`,
      detail: `${enterprise.defensesPerPeriod} defenses a month, then ${formatEur(overage)} for each defense past that. The price is before VAT. Enterprise is sold by quote and invoice.`,
    },
  ];

  return (
    <div className="grid gap-3">
      <p>
        Prices are in euros. A defense spends 1 credit. A challenge spends 1 credit. Card checkout
        is off. Consumer prices include VAT. Team and Enterprise prices are before VAT.
      </p>
      <ul className="grid gap-4">
        {rows.map((row) => (
          <li key={row.name} className="grid gap-1 border-t border-[var(--line)] pt-3">
            <p className="font-semibold text-[var(--ink)]">
              {row.name} · {row.price}
            </p>
            <p>{row.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
