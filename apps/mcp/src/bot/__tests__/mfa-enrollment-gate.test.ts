// looksLikeMfaEnrollmentGate — a mandatory MFA / 2-Step-Verification gate that
// locks the authenticated console until the account enables 2SV. MEASURED
// 2026-06-23: console.firebase.google.com replaced the whole console with this
// card for a personal Gmail without 2SV. The bot can't satisfy it (2SV needs a
// phone/authenticator on the account), so it's a distinct account-config
// terminal — not the misleading `oauth_required` it used to emit.

import { describe, expect, it } from "vitest";
import { looksLikeMfaEnrollmentGate } from "../agent.js";

describe("looksLikeMfaEnrollmentGate", () => {
  it("fires on the Firebase 'Enable MFA / Turn on 2SV' console gate (verbatim)", () => {
    expect(
      looksLikeMfaEnrollmentGate(
        "Enable Multi-factor Authentication (MFA) Multi-factor authentication (MFA), " +
          "also called 2-step verification (2SV), is now required for users. You must " +
          "enable MFA to gain access to Firebase. Turn on 2SV Learn more",
      ),
    ).toBe(true);
  });

  it("fires on a terse 'enable 2SV to access' variant", () => {
    expect(
      looksLikeMfaEnrollmentGate("You must enable 2SV to gain access to the console."),
    ).toBe(true);
  });

  it("does NOT fire on a page that merely links to security settings", () => {
    expect(
      looksLikeMfaEnrollmentGate(
        "Security Manage your two-factor authentication and recovery options in Settings.",
      ),
    ).toBe(false);
  });

  it("does NOT fire on an unrelated dashboard", () => {
    expect(
      looksLikeMfaEnrollmentGate("Welcome to your project Create API key Usage Billing"),
    ).toBe(false);
  });

  it("does NOT fire on a normal 2FA login prompt (not an enrollment mandate)", () => {
    // A login-time 2FA code entry is a different state — handled elsewhere.
    expect(
      looksLikeMfaEnrollmentGate("Enter the 6-digit code from your authenticator app"),
    ).toBe(false);
  });
});
