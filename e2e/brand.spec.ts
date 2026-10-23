import { expect, test } from "@playwright/test";

/**
 * The tab icon is the placeholder D monogram, and the header no longer
 * carries a revision label. File conventions in `src/app` emit the links.
 */
test("the head links the brand icons and the header has no revision label", async ({ page }) => {
  await page.goto("/");

  const links = await page.locator("head link").evaluateAll((els) =>
    els.map((el) => ({
      rel: el.getAttribute("rel") ?? "",
      href: el.getAttribute("href") ?? "",
      type: el.getAttribute("type") ?? "",
    })),
  );
  const icons = links.filter((link) => link.rel === "icon");
  const apple = links.filter((link) => link.rel === "apple-touch-icon");

  expect(icons.some((link) => link.href.includes("favicon.ico"))).toBe(true);
  expect(icons.some((link) => link.href.includes("icon.png") || link.type === "image/png")).toBe(true);
  expect(icons.some((link) => link.href.includes("icon.svg") || link.type === "image/svg+xml")).toBe(true);
  expect(apple.some((link) => link.href.includes("apple-icon"))).toBe(true);

  for (const link of [...icons, ...apple]) {
    const response = await page.request.get(link.href);
    expect(response.ok(), link.href).toBe(true);
  }

  const header = page.getByRole("banner");
  await expect(header).toContainText("Defend It");
  await expect(header).not.toContainText(/rev\s*b/i);
  await expect(page.locator("body")).not.toContainText(/rev\s*b/i);
});
