import path from "path";
import { defineConfig } from "vitest/config";

/** Billing regressions that SQLite does not catch. Requires DATABASE_URL. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/billing-postgres.test.ts", "tests/founding-postgres.test.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
