import { formatEur, getPlan, PACKS, PAYG_CENTS, periodsForInterval } from "@/lib/plans";

/**
 * Stripe price lookup_keys from the 22 Oct 2026 integration plan.
 * The app sku is the word in parentheses. Amounts come from `plans.ts`.
 */
const LOOKUP = {
  defense: "dit_defense_payg",
  challenge: "dit_challenge_payg",
  pack3: "dit_pack_3",
  pack8: "dit_pack_8",
  proMonth: "dit_pro_monthly",
  proYear: "dit_pro_yearly",
  team: "dit_team_monthly",
  enterprise: "dit_enterprise_base",
  extra: "dit_enterprise_extra_unit",
} as const;

export function PriceList() {
  const pro = getPlan("subscription");
  const team = getPlan("team");
  const enterprise = getPlan("enterprise");
  const yearMonths = periodsForInterval("year");
  const proMonth = pro.priceCents.month ?? 0;
  const proYear = pro.priceCents.year ?? 0;
  const teamMonth = team.priceCents.month ?? 0;
  const enterpriseMonth = enterprise.priceCents.month ?? 0;
  const overage = enterprise.overageCents ?? 0;
  const yearDefenses = pro.defensesPerPeriod * yearMonths;
  const yearChallenges = pro.challengesPerPeriod * yearMonths;

  const rows: { name: string; price: string; lookup: string; detail: string }[] = [
    {
      name: "One defense",
      price: formatEur(PAYG_CENTS.defense),
      lookup: LOOKUP.defense,
      detail: "1 defense credit. VAT included.",
    },
    {
      name: "One challenge",
      price: formatEur(PAYG_CENTS.challenge),
      lookup: LOOKUP.challenge,
      detail: "1 challenge credit. VAT included. You cannot take a challenge you created.",
    },
    {
      name: `${PACKS.pack3.credits}-credit pack`,
      price: formatEur(PACKS.pack3.priceCents),
      lookup: LOOKUP.pack3,
      detail: "Flexible credits. Each one can pay for a defense or a challenge. VAT included.",
    },
    {
      name: `${PACKS.pack8.credits}-credit pack`,
      price: formatEur(PACKS.pack8.priceCents),
      lookup: LOOKUP.pack8,
      detail: "Flexible credits, same rule as the smaller pack. VAT included.",
    },
    {
      name: "Pro, monthly",
      price: `${formatEur(proMonth)} / month`,
      lookup: LOOKUP.proMonth,
      detail: `${pro.defensesPerPeriod} defenses, ${pro.challengesPerPeriod} challenges, and ${pro.learnSlots} Learn projects each month. The app calls this plan Subscription. VAT included.`,
    },
    {
      name: "Pro, yearly",
      price: `${formatEur(proYear)} / year`,
      lookup: LOOKUP.proYear,
      detail: `Twelve months, paid once. That payment grants ${yearDefenses} defenses and ${yearChallenges} challenges together. Unused subscription credits expire at the next renewal. Learn stays capped at ${pro.learnSlots} open projects. VAT included.`,
    },
    {
      name: "Team",
      price: `${formatEur(teamMonth)} / month`,
      lookup: LOOKUP.team,
      detail: `${team.defensesPerPeriod} defenses a month. No challenge credits are included. Learn projects are not capped. The price is before VAT. Team is not switched with Pro in the customer portal.`,
    },
    {
      name: "Enterprise",
      price: `${formatEur(enterpriseMonth)} / month`,
      lookup: `${LOOKUP.enterprise}, extra ${LOOKUP.extra}`,
      detail: `${enterprise.defensesPerPeriod} defenses a month, then ${formatEur(overage)} for each defense past that. The price is before VAT. Enterprise is sold by quote and invoice, not in self-serve checkout.`,
    },
  ];

  return (
    <div className="grid gap-3">
      <p>
        Prices are in euros. A defense spends 1 credit. A challenge spends 1 credit. Card checkout
        stays off until billing is turned on. Until a VAT registration is on, checkout does not add
        tax on top of these prices.
      </p>
      <ul className="grid gap-4">
        {rows.map((row) => (
          <li key={row.lookup} className="grid gap-1 border-t border-[var(--line)] pt-3">
            <p className="font-semibold text-[var(--ink)]">
              {row.name} · {row.price}
            </p>
            <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">{row.lookup}</p>
            <p>{row.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
