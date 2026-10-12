import { test, expect } from "@playwright/test";
test("Public shell renders and anonymous document/workspace access fails closed", async ({
  page,
  request,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: /Des opportunités aux offres/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ouvrir le Command Center →" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/contractos-public.png", fullPage: true });
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/login$/);
  const health = await request.get("/api/health");
  expect([200, 503]).toContain(health.status());
  expect((await health.json()).databaseConnectivity).toBe("not_checked");
  const document = await request.get(
    "/api/documents/10000000-0000-4000-8000-000000000001",
  );
  expect([401, 503]).toContain(document.status());
});
