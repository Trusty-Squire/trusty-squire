// The connect/settings decision summary must surface the operator
// inbox-OTP consent even when the user never opens advanced setup — it
// defaults ON internally (readInboxConsent() in provision-drive.ts), and a
// setting that's on by default but invisible in the summary is exactly the
// bug this test guards against.

import { describe, expect, it, vi } from "vitest";

const noteCalls: Array<{ message: string }> = [];
const confirmCalls: Array<{ message: string; initialValue?: boolean }> = [];
const confirmAnswers: boolean[] = [];

vi.mock("@clack/prompts", () => ({
  note: (message: string) => {
    noteCalls.push({ message });
  },
  intro: () => {},
  outro: () => {},
  select: () => Promise.resolve("claude-code"),
  confirm: (options: { message: string; initialValue?: boolean }) => {
    confirmCalls.push(options);
    const answer = confirmAnswers.shift();
    if (answer === undefined) throw new Error(`Missing scripted answer for: ${options.message}`);
    return Promise.resolve(answer);
  },
  password: () => Promise.resolve(""),
  isCancel: () => false,
  cancel: () => {},
}));

import { runSettingsSetup, summarize } from "../interactive.js";
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

  it("offers and returns the default-on Email OTP setting through interactive settings", async () => {
    noteCalls.length = 0;
    confirmCalls.length = 0;
    // Advanced setup, registry, Email OTP, 2Captcha, then Save.
    confirmAnswers.push(true, true, true, false, true);

    const settings = await runSettingsSetup({ initialTarget: "claude-code" });

    expect(
      confirmCalls.find((call) => call.message.includes("matching OTP/verification emails")),
    ).toMatchObject({ initialValue: true });
    expect(settings.consentOperatorInboxOtp).toBe(true);
    expect(noteCalls.at(-1)?.message).toContain("Email OTP:    allowed");
  });
});
