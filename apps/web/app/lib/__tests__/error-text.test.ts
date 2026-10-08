import { describe, expect, it } from "vitest";
import { errorText } from "../error-text";

describe("errorText", () => {
  it("explains expired and invalid approval links", () => {
    expect(errorText(new Error("payment_approval_not_found"), "Approval unavailable.")).toBe(
      "This approval link is invalid or was already used.",
    );
    expect(errorText(new Error("credential_fetch_approval_expired"), "Approval failed.")).toBe(
      "This approval has expired. Ask the agent to request a new one.",
    );
  });

  it("uses the caller's copy for other API machine codes", () => {
    expect(errorText(new Error("v1_account_mismatch"), "Wrong account.")).toBe("Wrong account.");
  });

  it("keeps human messages and falls back for empty errors", () => {
    expect(errorText(new Error("The passkey was cancelled."), "Try again.")).toBe(
      "The passkey was cancelled.",
    );
    expect(errorText(new Error("  "), "Try again.")).toBe("Try again.");
  });
});
