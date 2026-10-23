import { cookies } from "next/headers";
import { getUserFromRequest, SESSION_COOKIE } from "./auth";
import type { CheckoutGatePlan } from "./checkout-gate";
import { getUserPlan } from "./credits";

/** The signed-in account's plan, or null when there is no session. */
export async function signedInPlan(): Promise<CheckoutGatePlan | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await getUserFromRequest(
    new Request("http://internal", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
  );
  if (!user) return null;
  const plan = await getUserPlan(user.id);
  return { interval: plan.interval, status: plan.status };
}
