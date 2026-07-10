// Functional tests for the operator-surface session state machine — the
// stateful flows the pure-helper unit tests can't reach. The real
// BrowserController + google-login are mocked so we exercise startProvisionSession
// → act(allow_host/type_secret) → observedHostsForSession → finish against the
// live `sessions` registry, asserting the SECURITY-relevant behavior:
//   - allow_host actually unblocks a previously-blocked goto
//   - a sealed slot value is typed into the page but NEVER appears in the audit
//   - the precondition gate fails closed without starting the browser
//   - credential egress seed excludes mid_session task scope
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { constants, publicEncrypt } from "node:crypto";

const h = vi.hoisted(() => ({
  providers: ["google"] as string[],
  oauthStatus: "already_valid" as string,
  typed: [] as Array<{ selector: string; text: string }>,
  gotos: [] as string[],
  started: 0,
  currentUrl: "",
  elements: [] as unknown[],
  visibleText: "",
  scrolls: [] as string[],
  captchaVariant: "unknown" as string,
  captchaChallengeRendered: false,
  captchaToken: false,
  captchaSettled: true,
  captchaSolved: true,
  invisibleTriggered: true,
  visibleSolveCalls: 0,
  invisibleTriggerCalls: 0,
  twoCaptchaAvailable: false,
  twoCaptchaResult: { kind: "ok", token: "captcha-token", durationMs: 1 } as
    | { kind: "ok"; token: string; durationMs: number }
    | { kind: "no_key" }
    | { kind: "submission_failed"; reason: string }
    | { kind: "solve_timeout"; durationMs: number }
    | { kind: "solver_error"; reason: string },
  twoCaptchaCalls: [] as string[],
  consentDismissCalls: 0,
  consentCta: null as string | null,
}));

vi.mock("../browser.js", () => ({
  BrowserController: class {
    constructor(_opts?: unknown) {}
    async start(): Promise<void> {
      h.started += 1;
    }
    async goto(url: string): Promise<void> {
      h.gotos.push(url);
      h.currentUrl = url;
    }
    currentUrl(): string {
      return h.currentUrl;
    }
    recoverActivePage(): void {}
    async extractInteractiveElements(): Promise<unknown[]> {
      return h.elements;
    }
    async extractVisibleText(): Promise<string> {
      return h.visibleText;
    }
    async openFirstMailResult(): Promise<boolean> {
      return false;
    }
    async waitForInteractiveDom(): Promise<void> {}
    async waitForCaptchaChallengeToSettle(): Promise<boolean> {
      return h.captchaSettled;
    }
    async dismissConsentBanner(): Promise<string | null> {
      h.consentDismissCalls += 1;
      return h.consentCta;
    }
    async waitForCaptchaResponseToken(): Promise<boolean> {
      return h.captchaToken;
    }
    async hasCaptchaResponseToken(): Promise<boolean> {
      return h.captchaToken;
    }
    async detectCaptchaVariant(): Promise<{ variant: string; challengeRendered: boolean }> {
      return { variant: h.captchaVariant, challengeRendered: h.captchaChallengeRendered };
    }
    async solveVisibleCaptcha(): Promise<{ found: boolean; solved?: boolean; kind?: string }> {
      h.visibleSolveCalls += 1;
      if (h.captchaVariant === "unknown") return { found: false };
      if (h.captchaSolved) h.captchaToken = true;
      return { found: true, solved: h.captchaSolved, kind: "recaptcha" };
    }
    async triggerInvisibleRecaptcha(): Promise<boolean> {
      h.invisibleTriggerCalls += 1;
      if (h.invisibleTriggered) h.captchaToken = true;
      return h.invisibleTriggered;
    }
    async extractRecaptchaSitekey(): Promise<string | null> {
      return "6Lcaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    }
    async injectRecaptchaToken(): Promise<boolean> {
      h.captchaToken = true;
      return true;
    }
    async extractHcaptchaSitekey(): Promise<string | null> {
      return "00000000-0000-0000-0000-000000000000";
    }
    async getHcaptchaSolveContext(): Promise<{
      invisible: boolean;
      userAgent: string | null;
      rqdata: string | null;
    }> {
      return { invisible: false, userAgent: "test-agent", rqdata: null };
    }
    async injectHcaptchaToken(): Promise<boolean> {
      h.captchaToken = true;
      return true;
    }
    async extractTurnstileSitekey(): Promise<string | null> {
      return "0x4AAAAAAA";
    }
    async injectTurnstileToken(): Promise<boolean> {
      h.captchaToken = true;
      return true;
    }
    async scrollViewport(direction: string): Promise<void> {
      h.scrolls.push(direction);
    }
    async type(selector: string, text: string): Promise<void> {
      h.typed.push({ selector, text });
    }
    async click(): Promise<void> {}
    async clickViaJs(): Promise<void> {}
    async startOAuth(): Promise<void> {}
    async settleAfterOAuth(): Promise<void> {}
    async pressKey(): Promise<void> {}
    async close(): Promise<void> {
      h.started -= 1;
    }
  },
}));

vi.mock("../captcha-solver-2captcha.js", () => ({
  TwoCaptchaSolver: class {
    isAvailable(): boolean {
      return h.twoCaptchaAvailable;
    }
    async solveRecaptchaV2(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("recaptcha_v2");
      return h.twoCaptchaResult;
    }
    async solveHcaptcha(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("hcaptcha");
      return h.twoCaptchaResult;
    }
    async solveTurnstile(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("turnstile");
      return h.twoCaptchaResult;
    }
  },
}));

vi.mock("../google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../google-login.js")>();
  return {
    ...actual,
    detectActiveProviderSessions: async () => h.providers,
    ensureOAuthSession: async () => ({ status: h.oauthStatus }),
  };
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startProvisionSession,
  act,
  observe,
  observedHostsForSession,
  stashSecretSlot,
  awaitVerification,
  captchaGate,
  finishProvisionSession,
  closeAllProvisionSessions,
} from "../provision-session.js";
import {
  provisionPrepareLoginTool,
  provisionSealVaultCredentialTool,
  provisionStoreLoginTool,
  withSigninHost,
} from "../../tools/provision-drive.js";
import type { ApiClient } from "../../api-client.js";

function elem(partial: Record<string, unknown>): unknown {
  return {
    index: 0,
    tag: "input",
    type: "text",
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "input",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

beforeEach(() => {
  h.providers = ["google"];
  h.oauthStatus = "already_valid";
  h.typed = [];
  h.gotos = [];
  h.consentDismissCalls = 0;
  h.consentCta = null;
  h.started = 0;
  h.currentUrl = "";
  h.elements = [];
  h.visibleText = "";
  h.scrolls = [];
  h.captchaVariant = "unknown";
  h.captchaChallengeRendered = false;
  h.captchaToken = false;
  h.captchaSettled = true;
  h.captchaSolved = true;
  h.invisibleTriggered = true;
  h.visibleSolveCalls = 0;
  h.invisibleTriggerCalls = 0;
  h.twoCaptchaAvailable = false;
  h.twoCaptchaResult = { kind: "ok", token: "captcha-token", durationMs: 1 };
  h.twoCaptchaCalls = [];
});
afterEach(async () => {
  await closeAllProvisionSessions();
});

describe("operate_start — consent-overlay auto-dismiss", () => {
  // Regression: dismissConsentBanner() shipped as DEAD CODE (zero call sites), so
  // a cookie/consent overlay (Usercentrics/OneTrust) occluded the whole form and
  // the agent gave up — the Robinhood-faucet bug. operate_start must call it
  // before the first observation.
  it("calls dismissConsentBanner before the first observation", async () => {
    await startProvisionSession({ serviceUrl: "https://faucet.example.com/" });
    expect(h.consentDismissCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops retrying as soon as a banner CTA is clicked", async () => {
    h.consentCta = "Reject all";
    await startProvisionSession({ serviceUrl: "https://faucet.example.com/" });
    // Dismissed on the first attempt → the second (retry) attempt is skipped.
    expect(h.consentDismissCalls).toBe(1);
  });
});

describe("operate session — multi-host allow-set + allow_host", () => {
  it("blocks a goto outside the start scope, then allow_host unblocks it", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://console.cloud.google.com/start",
    });
    const sid = obs.session_id;

    // A cross-app host not declared at start is blocked.
    await expect(
      act(sid, { kind: "goto", url: "https://console.firebase.google.com/project" }),
    ).rejects.toThrow(/domain-scope/i);

    // Declare it mid-session, then the same goto is permitted.
    await act(sid, { kind: "allow_host", host: "console.firebase.google.com" });
    await act(sid, { kind: "goto", url: "https://console.firebase.google.com/project" });
    expect(h.gotos).toContain("https://console.firebase.google.com/project");
  });

  it("accepts a host declared at start via allowed_hosts (multi-app)", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://console.cloud.google.com/start",
      extraAllowedHosts: ["console.firebase.google.com", "myapp.com"],
    });
    // Both declared hosts are immediately navigable (no allow_host needed).
    await act(obs.session_id, { kind: "goto", url: "https://myapp.com/settings" });
    expect(h.gotos).toContain("https://myapp.com/settings");
  });

  it("rejects a malformed allow_host (punycode spoof) and keeps the goto blocked", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://a.com/" });
    await expect(
      act(obs.session_id, { kind: "allow_host", host: "xn--80ak6aa92e.com" }),
    ).rejects.toThrow(/punycode|rejected/i);
  });
});

describe("operate session — egress seed excludes mid_session task scope", () => {
  it("does not include an allow_host (mid_session) host in the egress seed", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://console.cloud.google.com/start",
    });
    const sid = obs.session_id;
    await act(sid, { kind: "allow_host", host: "console.firebase.google.com" });
    const egress = observedHostsForSession(sid);
    expect(egress).toContain("console.cloud.google.com"); // start host included
    expect(egress).not.toContain("console.firebase.google.com"); // mid_session excluded
  });
});

describe("operate session — sealed credential transfer", () => {
  it("type_secret types the real slot value into the page but never logs it", async () => {
    const secret = "GOCSPX-supersecret-value-1234567890";
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const obs = await startProvisionSession({
        serviceUrl: "https://console.firebase.google.com/",
      });
      const sid = obs.session_id;
      // Seal a secret (as operate_extract{into_slot} would) and target a field.
      stashSecretSlot(sid, "oauth_secret", secret);
      h.elements = [elem({ visibleText: "Client secret", selector: "#secret" })];
      await act(sid, { kind: "type_secret", slot: "oauth_secret", target: "Client secret" });

      // The REAL value reached the page...
      expect(h.typed.some((t) => t.text === secret)).toBe(true);
      // ...but NEVER appears in any audit line.
      const auditText = writes.join("");
      expect(auditText).not.toContain(secret);
      expect(auditText).toContain("type_secret"); // the action IS audited (by slot, not value)
    } finally {
      spy.mockRestore();
    }
  });

  it("type_secret on an unknown slot fails loudly", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://a.com/" });
    h.elements = [elem({ visibleText: "Field", selector: "#f" })];
    await expect(
      act(obs.session_id, { kind: "type_secret", slot: "missing", target: "Field" }),
    ).rejects.toThrow(/no sealed slot/i);
  });
});

describe("operate session — Change 5 precondition gate", () => {
  it("fails closed (needs_user) without starting the browser when no live Google session", async () => {
    h.providers = []; // no live session
    h.oauthStatus = "failed"; // and we cannot establish one
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      requireLiveIdentity: true,
    });
    expect(obs.needs_user).toBeDefined();
    expect(obs.needs_user?.wall).toBe("google_session");
    expect(h.started).toBe(0); // the browser was NEVER started — task did not begin
    expect(h.gotos).toHaveLength(0);
  });

  it("proceeds normally when a live Google session exists", async () => {
    h.providers = ["google"];
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      requireLiveIdentity: true,
    });
    expect(obs.needs_user).toBeUndefined();
    expect(h.started).toBe(1);
    await finishProvisionSession(obs.session_id);
  });
});

describe("operate session — await_verification into_slot (T3 fix: OTP never round-trips)", () => {
  it("seals a found OTP into a slot (masked handle, no raw code) and type_secret enters it", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    const sid = obs.session_id;
    h.visibleText = "Your verification code is 481920. It expires in 10 minutes.";
    const res = await awaitVerification(sid, { intoSlot: "otp" });

    expect(res.found).toBe(true);
    expect(res.sealed).toBe(true);
    expect(res.code).toBeNull(); // the raw code is NOT returned to the host
    expect(res.slot?.preview).not.toContain("481920");

    // The host enters it by slot — the real digits reach the page, not the host.
    h.elements = [elem({ visibleText: "Code", selector: "#code" })];
    await act(sid, { kind: "type_secret", slot: "otp", target: "Code" });
    expect(h.typed.some((t) => t.text === "481920")).toBe(true);
  });

  it("returns the code normally when into_slot is NOT requested", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = "Your verification code is 481920.";
    const res = await awaitVerification(obs.session_id, {});
    expect(res.code).toBe("481920");
    expect(res.sealed).toBeUndefined();
  });

  it("PR2: refuses the inbox read without consent and hands the code request back", async () => {
    // No consentInboxRead → default OFF → must NOT read the (mocked) inbox.
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    h.visibleText = "Your verification code is 481920.";
    const res = await awaitVerification(obs.session_id, {});
    expect(res.found).toBe(false);
    expect(res.code).toBeNull();
    expect(res.needs_user?.resume).toBe("code");
    expect(res.needs_user?.message).toContain("not consented");
  });

  it("PR3b: grant_inbox_consent reads the inbox after an in-context yes, and is remembered", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const sid = obs.session_id;
    h.visibleText = "Your verification code is 481920.";
    // First call refuses (consent OFF).
    expect((await awaitVerification(sid, {})).found).toBe(false);
    // Host relays the user's yes → grant + read.
    const granted = await awaitVerification(sid, { grantConsent: true });
    expect(granted.found).toBe(true);
    expect(granted.code).toBe("481920");
    // Remembered for the session: a later await needs no re-grant.
    expect((await awaitVerification(sid, {})).found).toBe(true);
  });
});

describe("operate session — scroll (T5 fix: reveal below-the-fold controls)", () => {
  it("scrolls the viewport down by default and re-observes", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://console.cloud.google.com/" });
    await act(obs.session_id, { kind: "scroll" });
    expect(h.scrolls).toEqual(["down"]);
  });
  it("honors an explicit direction", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://console.cloud.google.com/" });
    await act(obs.session_id, { kind: "scroll", direction: "bottom" });
    expect(h.scrolls).toEqual(["bottom"]);
  });
});

describe("operate session — captcha gate", () => {
  it("solves a visible reCAPTCHA before returning settled=true", async () => {
    h.captchaVariant = "recaptcha_v2";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v2", settled: true });
    expect(h.visibleSolveCalls).toBe(1);
  });

  it("does not treat a cleared visible challenge as solved without a token", async () => {
    h.captchaVariant = "recaptcha_v2";
    h.captchaSolved = false;
    h.captchaSettled = true;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v2", settled: false });
    expect(h.visibleSolveCalls).toBe(1);
  });

  it("escalates visible reCAPTCHA to the token solver when configured", async () => {
    h.captchaVariant = "recaptcha_v2";
    h.captchaSolved = false;
    h.twoCaptchaAvailable = true;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v2", settled: true });
    expect(h.visibleSolveCalls).toBe(0);
    expect(h.twoCaptchaCalls).toEqual(["recaptcha_v2"]);
  });

  it("fail-fast: blocked v2 + no 2Captcha → needs_user(captcha_solver) with a settings remedy", async () => {
    h.captchaVariant = "recaptcha_v2";
    h.captchaSolved = false; // checkbox doesn't yield a token
    h.captchaSettled = false; // challenge stays up
    h.twoCaptchaAvailable = false; // no solver configured → no_key
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res.settled).toBe(false);
    expect(res.needs_user?.gate).toBe("captcha_solver");
    expect(res.needs_user?.remedy).toMatch(/2Captcha/i);
    expect(res.needs_user?.remedy).toMatch(/settings/i);
  });

  it("fail-fast: a scoring wall (blocked invisible v3) → needs_user(captcha_wall) suggesting a proxy", async () => {
    h.captchaVariant = "recaptcha_v3";
    h.invisibleTriggered = false; // scoring never mints a token
    h.captchaSettled = false;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res.settled).toBe(false);
    expect(res.needs_user?.gate).toBe("captcha_wall");
    expect(res.needs_user?.remedy).toMatch(/proxy|manual/i);
  });

  it("executes invisible reCAPTCHA and waits for a response token", async () => {
    h.captchaVariant = "recaptcha_v3";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v3", settled: true });
    expect(h.invisibleTriggerCalls).toBe(1);
  });

  it("blocks invisible reCAPTCHA when no response token is minted", async () => {
    h.captchaVariant = "recaptcha_v3";
    h.invisibleTriggered = false;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v3", settled: false });
    expect(h.invisibleTriggerCalls).toBe(1);
  });

  it("escalates invisible reCAPTCHA to the token solver when configured", async () => {
    h.captchaVariant = "recaptcha_v3";
    h.invisibleTriggered = false;
    h.twoCaptchaAvailable = true;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v3", settled: true });
    expect(h.invisibleTriggerCalls).toBe(1);
    expect(h.twoCaptchaCalls).toEqual(["recaptcha_v2"]);
  });
});

describe("operate session — PR3c username/password login (capture-at-login sourced)", () => {
  let profileDir: string;
  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), "ts-pr3c-"));
  });
  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  function withEmail(email: string): void {
    writeFileSync(join(profileDir, "provider-emails.json"), JSON.stringify({ google: email }));
  }

  it("prepare_login seals the captured user email + a generated password (masked handles only)", async () => {
    withEmail("ada@example.com");
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    const res = (await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    )) as {
      slots: { login: { preview: string }; password: { length: number } };
      email_preview: string;
    };
    // Neither the handle preview nor the email_preview leaks the raw address.
    expect(res.email_preview).not.toContain("ada@example.com");
    expect(res.slots.login.preview).not.toContain("ada@example.com");
    expect(res.slots.password.length).toBeGreaterThanOrEqual(16);
  });

  it("prepare_login hands back when no user email was captured", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    const res = (await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    )) as { needs_user?: { wall: string; resume: string } };
    expect(res.needs_user?.wall).toBe("user_email");
    expect(res.needs_user?.resume).toBe("connect");
  });

  it("store_login vaults the sealed email+password as username_password, no raw values returned", async () => {
    withEmail("ada@example.com");
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    );

    let captured:
      | {
          service: string;
          type?: string;
          auth_strategy?: string;
          fields?: Record<string, string>;
          login_hosts?: string[];
          signin_url?: string;
        }
      | undefined;
    const api = {
      storeCredential: async (input: {
        service: string;
        type?: string;
        auth_strategy?: string;
        fields?: Record<string, string>;
        login_hosts?: string[];
        signin_url?: string;
      }) => {
        captured = input;
        return {
          reference: "vault://acct/login1",
          service: input.service,
          label: "default",
          field_names: ["login", "password"],
          auth_strategy: "username_password",
          login_hosts: input.login_hosts ?? [],
          signin_url: input.signin_url ?? null,
          allowed_hosts: [],
          created_at: "now",
          updated: false,
        };
      },
    } as unknown as ApiClient;

    const res = (await provisionStoreLoginTool.handler(
      {
        session_id: obs.session_id,
        service: "example",
        login_hosts: ["app.example.com"],
        signin_url: "https://app.example.com/login",
      },
      api,
    )) as { reference: string; type: string; login_hosts: string[] };

    expect(captured?.type).toBe("username_password");
    expect(captured?.auth_strategy).toBe("username_password");
    expect(captured?.fields?.login).toBe("ada@example.com");
    expect((captured?.fields?.password ?? "").length).toBeGreaterThanOrEqual(16);
    expect(captured?.login_hosts).toEqual(["app.example.com"]);
    expect(res.login_hosts).toEqual(["app.example.com"]);
    expect(res.reference).toBe("vault://acct/login1");
    // The raw password must not appear in the tool's response.
    expect(JSON.stringify(res)).not.toContain(captured?.fields?.password ?? "UNSET");
  });

  it("seal_vault_credential stashes browser-fill fields as slots without returning raw values", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/login",
      profileDir,
    });
    let captured:
      | {
          current_host: string;
          reference?: string;
          fields: string[];
          encrypted_response_public_key: string;
        }
      | undefined;
    const api = {
      browserFillCredential: async (input: {
        current_host: string;
        reference?: string;
        fields: string[];
        encrypted_response_public_key: string;
      }) => {
        captured = input;
        const encrypt = (value: string) =>
          publicEncrypt(
            {
              key: input.encrypted_response_public_key,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            Buffer.from(value, "utf8"),
          ).toString("base64");
        return {
          reference: input.reference ?? "vault://acct/login1",
          encrypted_fields: {
            login: encrypt("ada@example.com"),
            password: encrypt("correct-horse"),
          },
        };
      },
    } as unknown as ApiClient;

    const res = (await provisionSealVaultCredentialTool.handler(
      {
        session_id: obs.session_id,
        reference: "vault://acct/login1",
        fields: ["login", "password"],
        slot_prefix: "signin",
      },
      api,
    )) as { reference: string; slots: Record<string, { slot: string }> };

    expect(captured).toMatchObject({
      current_host: "https://app.example.com/login",
      reference: "vault://acct/login1",
      fields: ["login", "password"],
    });
    expect(res.reference).toBe("vault://acct/login1");
    expect(res.slots.login?.slot).toBe("signin_login");
    expect(res.slots.password?.slot).toBe("signin_password");
    expect(JSON.stringify(res)).not.toContain("ada@example.com");
    expect(JSON.stringify(res)).not.toContain("correct-horse");

    h.elements = [elem({ visibleText: "Email", selector: "#email" })];
    await act(obs.session_id, { kind: "type_secret", slot: "signin_login", target: "Email" });
    expect(h.typed.some((t) => t.selector === "#email" && t.text === "ada@example.com")).toBe(true);
  });
});

describe("observation detail ladder (none < compact < full)", () => {
  it("default is compact: no screen/accessibility, value_len, elements_total, no container", async () => {
    h.elements = [
      elem({ tag: "input", type: "text", value: "acme", screenPath: "form:x > input:org", container: "form:x" }),
    ];
    h.visibleText = "Org";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(obs.screen).toBeUndefined();
    expect(obs.accessibility).toBeUndefined();
    expect(obs.elements_total).toBe(1);
    const e = obs.elements[0]!;
    const bag = e as unknown as Record<string, unknown>;
    expect(bag.value).toBeUndefined();
    expect(e.value_len).toBe(4);
    expect(bag.container).toBeUndefined();
    expect(e.path).toBe("form:x > input:org");
  });

  it("operate_observe detail:'full' restores the screen + accessibility views", async () => {
    h.elements = [elem({ tag: "button", visibleText: "Go", screenPath: "main:x > button:go", container: "main:x" })];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const full = await observe(obs.session_id, "full");
    expect(full.screen).toBeDefined();
    expect(full.accessibility).toBeDefined();
  });

  it("operate_act detail:'none' returns a minimal ack (no perception)", async () => {
    h.elements = [elem({ tag: "button", visibleText: "Go", screenPath: "main:x > button:go" })];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const ack = await act(obs.session_id, { kind: "scroll", direction: "down" }, "none");
    expect(ack.observed).toBe("none");
    expect(ack.elements).toEqual([]);
    expect(ack.screen).toBeUndefined();
  });

  it("operate_act detail:'full' returns the legacy payload", async () => {
    h.elements = [elem({ tag: "button", visibleText: "Go", screenPath: "main:x > button:go", container: "main:x" })];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const full = await act(obs.session_id, { kind: "scroll", direction: "down" }, "full");
    expect(full.screen).toBeDefined();
    expect(full.accessibility).toBeDefined();
  });
});

describe("withSigninHost (operate_store_login — cover the sign-in page's host)", () => {
  it("folds the signin_url host into login_hosts (the Plunk browser-fill 403)", () => {
    // Agent stored the apex, but the login form lives on app.<domain> — the
    // signin_url host must be a valid fill target.
    expect(withSigninHost(["useplunk.com"], "https://app.useplunk.com/login")).toEqual([
      "useplunk.com",
      "app.useplunk.com",
    ]);
  });
  it("does not duplicate an already-listed host, strips www, no-ops without a signin_url", () => {
    expect(withSigninHost(["app.useplunk.com"], "https://app.useplunk.com/login")).toEqual(["app.useplunk.com"]);
    expect(withSigninHost(["x.com"], "https://www.x.com/login")).toEqual(["x.com"]);
    expect(withSigninHost(["x.com"], undefined)).toEqual(["x.com"]);
    expect(withSigninHost(["x.com"], "not a url")).toEqual(["x.com"]);
  });
});
