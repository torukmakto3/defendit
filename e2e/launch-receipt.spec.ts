import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * Launch posts link this file directly. It is a static asset in `public/launch`
 * and must answer without a session cookie or a redirect.
 */
test("GET /launch/receipt-post4.png returns the public png", async ({ request }) => {
  const response = await request.get("/launch/receipt-post4.png", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect((response.headers()["content-type"] ?? "").split(";")[0]).toBe("image/png");
  const body = await response.body();
  expect(body.length).toBe(94761);
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    "b02e585afd8cba8072185e0d44e74ee77f4e8576ba5d08458d0a9371ede03b43",
  );
});
