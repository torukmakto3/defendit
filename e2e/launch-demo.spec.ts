import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * Launch posts link this file directly. It is a static asset in `public/launch`
 * and must answer without a session cookie or a redirect.
 */
test("GET /launch/demo.mp4 returns the public video", async ({ request }) => {
  const response = await request.get("/launch/demo.mp4", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect((response.headers()["content-type"] ?? "").split(";")[0]).toBe("video/mp4");
  const body = await response.body();
  expect(body.length).toBe(2112882);
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    "a77cb7425de13519f3559e8d36bdd747fd3301dd9a021f7d8b95f35c4b80daeb",
  );
});
