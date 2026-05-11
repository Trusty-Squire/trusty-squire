import { test, expect } from "@playwright/test";

test("mandate edit: change spend limit and re-sign from /policy", async ({ page }) => {
  await page.goto("/policy");

  await expect(page.getByRole("heading", { name: "Policy" })).toBeVisible();
  await expect(page.getByText(/Current: \$500\.00/)).toBeVisible();

  // Adjust the spend slider.
  const slider = page.getByLabel("Monthly spend limit in cents");
  await slider.fill("100000");
  await expect(page.getByText(/Current: \$1000\.00/)).toBeVisible();

  await page.getByPlaceholder("you@example.com").fill("test@example.com");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Policy updated.")).toBeVisible({ timeout: 15_000 });
});
