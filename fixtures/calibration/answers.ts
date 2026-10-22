import type { ProbeType } from "../../src/lib/types";

export type CalibrationKind = "good" | "vague" | "bad" | "idk";

interface Grounding {
  /** Phrases that identify this claim inside an extracted paragraph. */
  keys: string[];
  /** Figure, mechanism, the assumption that moves it, and the next check. */
  explain: string;
}

const MEMO: Grounding[] = [
  {
    keys: ["$12m", "$90m", "series b", "workflow layer"],
    explain:
      "We recommend a $12M Series B at a $90M post-money because Harbor is priced as the workflow layer for mid-market freight operators, not as a feature inside someone else's TMS. The $12M is the new money and the $90M is the valuation that round creates, so existing holders give up about thirteen percent. If the round grew at the same $90M, dilution would rise and the ownership case would weaken before the operating plan changed. I would not treat that valuation as signed until the next board pack confirms churn, because the $90M assumes the retention story still holds.",
  },
  {
    keys: ["$2.4b", "118%", "48 customers", "net revenue retention"],
    explain:
      "The $2.4B is top-down software spend in regional freight coordination, and the 48 customers at 118% net revenue retention are the bottom-up proof that Harbor already expands inside accounts. I use 118% because expansion is outrunning logo loss, which is what turns a TAM slide into evidence. If net retention fell under 100%, the $2.4B market would still be there but the right to win it would be the thing that breaks. I would check the cohort table behind the 118% before I treated the TAM as the investment case.",
  },
  {
    keys: ["62%", "11 months", "1.2%", "2.4%", "40%"],
    explain:
      "Contribution margin is 62% after payment processing and support, and payback on CAC is 11 months at the current sales efficiency. The sensitivity that governs the case is churn: if monthly logo churn doubles from 1.2% to 2.4%, LTV falls by about 40% and the investment case weakens materially, because the 11-month payback was computed on the 1.2% base. A 62% margin that looks fine at 1.2% does not survive that doubled rate. I would not sign the margin without the churn line in the next board pack.",
  },
  {
    keys: ["12x", "8x", "irr", "mid-20s", "exit multiple"],
    explain:
      "The base case uses a 12x ARR exit multiple in year 5, and that multiple is what puts modeled IRR in the mid-20s. At 8x on the same ARR, IRR falls into the low teens, because the exit value is the lever and the operating plan does not make up a four-turn gap. If freight software comps stayed at 8x, I would still believe the business but I would not underwrite the mid-20s. The next check is which current comps still print near 12x, and whether year-5 ARR in the model is the ARR those comps would actually pay for.",
  },
  {
    keys: ["tms", "incumbent", "sales hire", "fragile assumption"],
    explain:
      "Competitive response from incumbent TMS vendors is the most fragile assumption, because the thesis is that Harbor becomes the default workflow layer and a bundle from an incumbent removes the reason to switch. The enterprise sales hire is real execution risk, but it is secondary: a slower hire delays revenue, while a TMS bundle can erase the category. If the incumbents shipped a credible workflow bundle, the $12M case would weaken even with the hire in seat. I would read competitor release notes and the next two lost deals for that bundle before I treated the risk as background.",
  },
  {
    keys: ["board pack", "contingent", "churn stability", "proceed"],
    explain:
      "The recommendation is to proceed, contingent on confirming churn stability in the next board pack, because the rest of the memo only holds if monthly logo churn near 1.2% is not a one-period dip. If that pack shows churn moving toward 2.4%, LTV is down about 40% and I would not close $12M at a $90M post-money. The next check is that board pack, not another pass over the TAM. Until it arrives I would leave the recommendation conditional rather than call the round done.",
  },
];

const ESSAY: Grounding[] = [
  {
    keys: ["hospital", "bakery", "airport", "not a luxury", "night shift"],
    explain:
      "The night bus is how the hospital night shift, the bakery, and the airport cleaners get home, so cutting it is not cutting a luxury service. I kept the route because those shifts do not have another way home at the hour they finish, and the weeknight count of 1,800 is mostly them. If the hospital stopped running a night shift, the ridership case would shrink to the bakery and the airport and I would reopen the question. The next check is the employer list on the late boards, not the daytime average, because the daytime number hides the shift the route is actually for.",
  },
  {
    keys: ["1,800", "1800", "2,400", "2400", "weeknight", "fridays"],
    explain:
      "Last year the route carried 1,800 riders on a typical weeknight and 2,400 on Fridays. I use those counts because 1,800 is the base load and Friday is the peak, and both are large enough that the bus is not an empty vehicle. If the weeknight count were a few hundred, the case for spending to keep the route would be much weaker. I would republish the hourly counts before a vote so the 1,800 is the number in the room, not a remembered total.",
  },
  {
    keys: ["$400,000", "400,000", "union", "reassigned", "paid off"],
    explain:
      "Cutting the route would save about $400,000 a year only if the drivers can be reassigned rather than paid off. The union contract makes that reassignment unlikely, so the $400,000 is an accounting saving, because the contract probably will not allow the drivers to be moved. If the contract forced a payoff, the cash saving in the first year would be smaller than $400,000 and might not clear the cut. I would ask finance for the payoff schedule before anyone quoted $400,000 as the benefit.",
  },
  {
    keys: ["2019", "12%", "tram", "connecting"],
    explain:
      "The last time a night route was cut, in 2019, evening rides on the connecting tram fell 12% within a quarter. That 12% matters because this is not a single-route decision: the night bus feeds the tram, so the lost riders show up on a different line. If the 2019 cut had left tram ridership flat, I would treat this cut as contained. I would pull the 2019 boarding file and confirm the 12% is that same connecting tram before I used it in the vote.",
  },
  {
    keys: ["12:30", "2:00", "after midnight", "shift change", "empty"],
    explain:
      "The proposal treats the bus as empty after midnight, but the counts between 12:30 and 2:00 are the hospital shift change, which is the load the route exists for. I would not call it empty because those ninety minutes are the shift, not dead time. If the shift change moved earlier, the post-midnight case would weaken and a shorter span would be the honest cut. The next check is the hospital roster set against the 12:30 to 2:00 boardings.",
  },
  {
    keys: ["$90,000", "90,000", "1:30", "3:00", "last hour"],
    explain:
      "A smaller saving, about $90,000, is available by ending the route at 1:30 instead of 3:00. That keeps the 12:30 hospital shift change and drops the nearly empty last hour, so it saves money without the full cut's hit to the connecting tram. If the 1:30 bus still missed the shift, I would not take the $90,000, because the saving would land on the riders the route is for. I would compare the hourly sheet past 1:30 with the roster before recommending the shorter span.",
  },
  {
    keys: ["11pm", "11 pm", "publish the hourly", "keep the route", "assumption to watch"],
    explain:
      "I would keep the route and publish the hourly counts. The assumption to watch is the hospital shift time: if that shift moves to 11pm, the case for the buses after midnight gets weaker, because the 12:30 to 2:00 load would move earlier. Until that happens, cutting the route trades a real shift change for a $400,000 figure the contract may not deliver. The next check is a written shift time from the hospital, published beside the counts.",
  },
];

const NOTE: Grounding[] = [
  {
    keys: ["30 seconds", "full jitter", "8 times", "at most 8", "parked"],
    explain:
      "The retry wrapper caps backoff at 30 seconds and uses full jitter, and a delivery is attempted at most 8 times before it is parked. The cap is 30 seconds because an unbounded backoff would stall a worker on one dead receiver, and 8 attempts is where we stop spending that worker. If the cap were longer than 30 seconds, a single stuck endpoint would hold capacity the rest of the queue needs. I would check the park rate after the eighth attempt before I raised either number.",
  },
  {
    keys: ["24 hours", "idempotency", "redis", "original response", "second job"],
    explain:
      "Idempotency keys are stored for 24 hours in Redis, and a repeated key returns the original response and does not enqueue a second job. The 24 hours is the window in which a client retry is safe. If a key disappeared before those 24 hours were up, the same delivery would enqueue twice and the receiver would see a duplicate. The next check is the Redis TTL on a fresh key, because the guarantee is the key, not the caller's good behavior.",
  },
  {
    keys: ["nullable", "backfill", "6 hours", "application code"],
    explain:
      "The migration adds a nullable column so it can ship before the application code, and a backfill job fills that column within 6 hours of deploy. The column stays nullable because that is what makes the order safe: old code does not have to write the column on the day of the deploy. If the backfill slipped past 6 hours, readers that assume the column is full would see nulls and mis-handle the row. I would watch the backfill cursor until it finishes, and I would not flip the read path before that.",
  },
  {
    keys: ["900ms", "250ms", "256 kb", "256kb", "queue split", "p99"],
    explain:
      "Webhook delivery p99 latency dropped from 900ms to 250ms after the queue split. That drop assumes payload size stays under 256 KB, because the split removed head-of-line blocking for normal payloads and a larger body puts the time back into serialization. If payloads grew past 256 KB, I would not expect the 250ms to hold. The next check is the payload-size histogram against that 256 KB line before anyone calls the new p99 the steady state.",
  },
  {
    keys: ["dead-letter", "weekday", "3x", "dropped events", "load test"],
    explain:
      "Failed deliveries land in a dead-letter queue that is reviewed each weekday, and load tests at 3x peak traffic showed no dropped events. The weekday review is the backstop, because a silent queue would hide the failures the retries park and the latency chart does not show. If the 3x test had dropped events, I would not trust the queue split as a reliability result even with a 250ms p99. I would rerun the 3x test after any worker-pool change and keep the weekday review on the calendar.",
  },
  {
    keys: ["eviction", "duplicate jobs", "durable store", "fragile assumption", "live idempotency"],
    explain:
      "The fragile assumption is that Redis eviction will not delete a live idempotency key. If eviction rises, duplicate jobs become possible until the key TTL is moved to a durable store, because a missing key looks like a new delivery and the wrapper will enqueue it again. I still accept the Redis window for now because 24 hours fits in memory at the current key rate. I would move the TTL the week the eviction counter on that prefix moves, and not before.",
  },
];

const VAGUE: Record<"memo" | "essay" | "note", string> = {
  memo: "I think it's mostly about the general direction of the Harbor Logistics investment. The numbers seemed reasonable to me when I wrote it, so I'd stand by it.",
  essay: "I think it's mostly about the general direction of the night bus argument. The numbers seemed reasonable to me when I wrote it, so I'd stand by it.",
  note: "I think it's mostly about the general direction of the webhook design. The numbers seemed reasonable to me when I wrote it, so I'd stand by it.",
};

function bankFor(fixture: string): { id: "memo" | "essay" | "note"; rows: Grounding[] } {
  const name = fixture.toLowerCase();
  if (name.includes("essay") || name.includes("night")) return { id: "essay", rows: ESSAY };
  if (name.includes("technical") || name.includes("webhook")) return { id: "note", rows: NOTE };
  return { id: "memo", rows: MEMO };
}

function scoreGrounding(claim: string, row: Grounding): number {
  const hay = claim.toLowerCase();
  const keyed = row.keys.reduce((n, key) => n + (hay.includes(key.toLowerCase()) ? 3 : 0), 0);
  const words = new Set(hay.match(/[a-z0-9]{4,}/g) ?? []);
  const overlap = row.explain
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g)
    ?.reduce((n, word) => n + (words.has(word) ? 1 : 0), 0);
  return keyed + (overlap ?? 0);
}

function explainFor(fixture: string, claimText: string): { id: "memo" | "essay" | "note"; explain: string } {
  const bank = bankFor(fixture);
  let best = bank.rows[0];
  let bestScore = -1;
  for (const row of bank.rows) {
    const score = scoreGrounding(claimText, row);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return { id: bank.id, explain: best.explain };
}

function forProbe(type: ProbeType, explain: string, planted?: string): string {
  switch (type) {
    case "explain_back":
      return explain;
    case "counterfactual":
      return `If the main input moved against this, the conclusion moves with it. ${explain}`;
    case "weakest_link":
      return `The fragile assumption is the one the conclusion depends on, and it stays acceptable only with the check below. ${explain}`;
    case "confidence":
      return `I would put this near 70 out of 100, and the fact that would move that number is the check at the end. ${explain}`;
    case "prediction":
      return `The objection I would expect is that the figure is doing too much work, and I would answer it this way. ${explain}`;
    case "planted_error": {
      const shown = planted?.trim() ? ` The line I was shown says "${planted.trim()}".` : "";
      return `That excerpt is wrong: it was altered and does not match what I wrote.${shown} ${explain}`;
    }
    default: {
      const neverType: never = type;
      return neverType;
    }
  }
}

/** Author answers for one calibration probe. `good` explains the claim; `vague` stays on topic without figures. */
export function calibrationAnswer(input: {
  fixture: string;
  kind: CalibrationKind;
  claimText: string;
  probeType: ProbeType;
  plantedContent?: string;
}): string {
  if (input.kind === "bad") return "I guess it's fine.";
  if (input.kind === "idk") return "I don't know.";
  const grounded = explainFor(input.fixture, input.claimText);
  if (input.kind === "vague") return VAGUE[grounded.id];
  return forProbe(input.probeType, grounded.explain, input.plantedContent);
}
