import { test, expect } from "@playwright/test";

test("signup flow: intro → passkey → policy → sign → connect", async ({ page }) => {
  await page.goto("/signup");

  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Email").fill("test@example.com");
  await page.getByLabel("Display name").fill("Test");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/signup\/passkey$/);
  await page.getByRole("button", { name: "Set up passkey" }).click();

  await expect(page).toHaveURL(/\/signup\/policy$/);
  await expect(page.getByText(/Monthly spend limit/i)).toBeVisible();
  await page.getByRole("button", { name: "Review mandate" }).click();

  await expect(page).toHaveURL(/\/signup\/sign$/);
  await expect(page.getByText(/You are giving your squire authority/)).toBeVisible();
  await page.getByRole("button", { name: "Sign with passkey" }).click();

  await expect(page).toHaveURL(/\/signup\/connect$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Connect your coding agent" })).toBeVisible();
  await expect(page.getByText(/npx -y @trusty-squire\/mcp install --target=claude-code/)).toBeVisible();
});
