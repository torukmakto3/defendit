import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it } from "vitest";
import { track } from "../src/lib/analytics-store";

it("swallows a storage failure instead of throwing", async () => {
  const blocker = join(tmpdir(), `defendit-not-a-dir-${process.pid}`);
  writeFileSync(blocker, "x");
  process.env.ANALYTICS_ENABLED = "true";
  delete process.env.DATABASE_URL;
  process.env.DATABASE_PATH = join(blocker, "analytics.db");
  await expect(track({ name: "landing_view", props: { utm_source: "x" } })).resolves.toBeUndefined();
});
