import { test, expect } from "@playwright/test";

test("pairing flow: token surfaced agent → approve → done", async ({ page }) => {
  await page.goto("/pair?token=abc123");

  await expect(page.getByRole("heading", { name: "Pair your coding agent" })).toBeVisible();
  await expect(page.getByText(/Trusty Squire wants to pair with/)).toBeVisible();
  // The stub status endpoint reports agent_identity: claude-code; verify it surfaces.
  await expect(page.getByText("Claude Code", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Approve pairing" }).click();
  await expect(page.getByText(/Pairing complete\./)).toBeVisible({ timeout: 15_000 });
});

test("pairing flow: missing token shows guidance", async ({ page }) => {
  await page.goto("/pair");
  await expect(page.getByText(/Missing pairing token/)).toBeVisible();
});
