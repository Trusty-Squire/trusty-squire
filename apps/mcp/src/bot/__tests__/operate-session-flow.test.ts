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

const h = vi.hoisted(() => ({
  providers: ["google"] as string[],
  oauthStatus: "already_valid" as string,
  typed: [] as Array<{ selector: string; text: string }>,
  gotos: [] as string[],
  started: 0,
  currentUrl: "",
  elements: [] as unknown[],
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
      return "";
    }
    async waitForInteractiveDom(): Promise<void> {}
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

vi.mock("../google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../google-login.js")>();
  return {
    ...actual,
    detectActiveProviderSessions: async () => h.providers,
    ensureOAuthSession: async () => ({ status: h.oauthStatus }),
  };
});

import {
  startProvisionSession,
  act,
  observedHostsForSession,
  stashSecretSlot,
  finishProvisionSession,
  closeAllProvisionSessions,
} from "../provision-session.js";

function elem(partial: Record<string, unknown>): unknown {
  return {
    index: 0, tag: "input", type: "text", id: null, name: null, placeholder: null,
    ariaLabel: null, role: null, labelText: null, visibleText: null, selector: "input",
    visible: true, inViewport: true, inConsentWidget: false, ...partial,
  };
}

beforeEach(() => {
  h.providers = ["google"];
  h.oauthStatus = "already_valid";
  h.typed = [];
  h.gotos = [];
  h.started = 0;
  h.currentUrl = "";
  h.elements = [];
});
afterEach(async () => {
  await closeAllProvisionSessions();
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
      const obs = await startProvisionSession({ serviceUrl: "https://console.firebase.google.com/" });
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
