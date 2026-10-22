import { connection } from "next/server";
import { HomePage } from "@/components/home-page";
import { demoEnabled } from "@/lib/demo-policy";

export const dynamic = "force-dynamic";

export default async function Page() {
  await connection();
  return <HomePage demoEnabled={demoEnabled()} />;
}
