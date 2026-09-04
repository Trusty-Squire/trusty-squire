// The connect/settings decision summary must surface the operator
// inbox-OTP consent even when the user never opens advanced setup — it
// defaults ON internally (readInboxConsent() in provision-drive.ts), and a
// setting that's on by default but invisible in the summary is exactly the
// bug this test guards against.

import { describe, expect, it, vi } from "vitest";

const noteCalls: Array<{ message: string }> = [];

vi.mock("@clack/prompts", () => ({
  note: (message: string) => {
    noteCalls.push({ message });
  },
}));

import { summarize } from "../interactive.js";
import type { InteractiveConfig } from "../interactive.js";

function baseConfig(overrides: Partial<InteractiveConfig> = {}): InteractiveConfig {
  return {
    target: "claude-code",
    registryEnabled: true,
    advancedConfigured: false,
    ...overrides,
  };
}

describe("summarize (setup summary)", () => {
  it("surfaces Email OTP as allowed-by-default when the user never opened advanced setup", () => {
    noteCalls.length = 0;
    summarize(baseConfig({ advancedConfigured: false }));
    const message = noteCalls.at(-1)?.message ?? "";
    expect(message).toContain("Email OTP:");
    expect(message.toLowerCase()).toContain("allowed");
  });

  it("shows Email OTP as allowed when the user explicitly opted in during advanced setup", () => {
    noteCalls.length = 0;
    summarize(baseConfig({ consentOperatorInboxOtp: true, advancedConfigured: true }));
    const message = noteCalls.at(-1)?.message ?? "";
    expect(message).toContain("Email OTP:    allowed");
  });

  it("shows Email OTP as off when the user explicitly opted out during advanced setup", () => {
    noteCalls.length = 0;
    summarize(baseConfig({ consentOperatorInboxOtp: false, advancedConfigured: true }));
    const message = noteCalls.at(-1)?.message ?? "";
    expect(message).toContain("Email OTP:    off");
  });
});
