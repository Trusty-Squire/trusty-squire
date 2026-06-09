// rc.39 — detectFormFillIsDashboard pivots the form-fill loop to
// post-verify when the planner's notes/action reasons describe a
// logged-in dashboard or billing wall instead of a signup form.
//
// Motivated by PlanetScale: auth.planetscale.com/sign-up serves a
// create-database form to authenticated users; detectAlreadySignedIn
// (URL-based) excludes /sign-up paths, so the bot blindly filled the
// "database name" input and clicked "Add credit card" as the submit
// button.

import { describe, expect, it } from "vitest";
import { detectFormFillIsDashboard } from "../agent.js";

describe("detectFormFillIsDashboard — positive", () => {
  it("flags billing-wall language (Add credit card)", () => {
    expect(
      detectFormFillIsDashboard({
        notes: "The submit button is 'Add credit card' for the PS-5 plan.",
        actions: [{ reason: "Fill the database name field." }],
      }),
    ).toBe(true);
  });

  it("flags product-creation language (create the database)", () => {
    expect(
      detectFormFillIsDashboard({
        actions: [
          { reason: "Database name field with valid lowercase name to create the database." },
        ],
      }),
    ).toBe(true);
  });

  it("flags Koyeb-style create-app phrasing", () => {
    expect(
      detectFormFillIsDashboard({
        notes: "Creating a new app on the dashboard.",
        actions: [{ reason: "Click Continue." }],
      }),
    ).toBe(true);
  });

  it("flags explicit 'already signed in'", () => {
    expect(
      detectFormFillIsDashboard({
        actions: [
          { reason: "This is the logged in dashboard, not a signup form." },
        ],
      }),
    ).toBe(true);
  });
});

describe("detectFormFillIsDashboard — negative", () => {
  it("does NOT flag a normal signup form's planner output", () => {
    expect(
      detectFormFillIsDashboard({
        notes: "Standard email signup form.",
        actions: [
          { reason: "Fill the email field." },
          { reason: "Fill the password field." },
          { reason: "Submit the signup form." },
        ],
      }),
    ).toBe(false);
  });

  it("does NOT flag a 'create account' button (account ≠ product)", () => {
    expect(
      detectFormFillIsDashboard({
        actions: [{ reason: "Click 'Create account' to submit the signup form." }],
      }),
    ).toBe(false);
  });

  it("does NOT flag mention of 'project name' on a signup welcome form", () => {
    expect(
      detectFormFillIsDashboard({
        notes: "Signup with optional project name field.",
        actions: [{ reason: "Fill project name." }],
      }),
    ).toBe(false);
  });

  it("ignores empty plans", () => {
    expect(detectFormFillIsDashboard({ actions: [] })).toBe(false);
  });

  // MEASURED 2026-06-09: fathom. The planner correctly identified a LOGIN
  // page (pre-auth) and proposed clicking "Start a free trial" to reach the
  // real signup form. The old bare "not a signup" branch false-pivoted this
  // into key extraction (→ 404-walk → 600s timeout). A login page is NOT a
  // logged-in dashboard; the bot must execute the click toward signup.
  it("does NOT flag a login page whose plan reaches signup via 'Start a free trial' (fathom)", () => {
    expect(
      detectFormFillIsDashboard({
        notes:
          "This is a login page, not a signup page. The only path to account " +
          "creation is the 'Start a free trial' link.",
        actions: [
          { reason: "Click 'Start a free trial' to navigate to the actual signup form." },
        ],
      }),
    ).toBe(false);
  });

  it("does NOT flag a bare 'sign in page, not a signup' note (ambiguous → not dashboard)", () => {
    expect(
      detectFormFillIsDashboard({
        notes: "This looks like a sign-in page, not a signup form.",
        actions: [{ reason: "Click the link to register." }],
      }),
    ).toBe(false);
  });
});
