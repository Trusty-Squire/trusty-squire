// SUCCEED-EVEN-WHEN-ACCOUNT-EXISTS coverage.
//
// 5 services (axiom, lambda-labs, mailtrap, render → bailed with
// no_credentials_after_already_signed_in; mistral → existing_account
// _no_extract) failed because the bot's shared Google identity already
// had an account, so signup landed on an authenticated dashboard with
// masked / once-shown keys and the bot bailed. The product requirement
// is to SUCCEED: navigate to the keys page and either extract a
// readable key OR mint a fresh one ("Create new key") and extract it.
//
// Two surfaces are covered:
//   findCreateKeyAffordance — the pure inventory scanner that locates a
//     key-minting button/link. Unit-tested directly.
//   SignupAgent.attemptMintNewKey — the existing-account recovery flow:
//     navigate-to-keys → extract-readable | reveal | mint-and-extract,
//     returning null only when there is genuinely no way to mint a key.
//     Driven through a configurable fake BrowserController, mirroring
//     the captcha-short-circuit test's documented encapsulation break.

import { describe, expect, it } from "vitest";
import { findApiKeysNavLink, findCreateKeyAffordance, SignupAgent } from "../agent.js";
import type { BrowserController, InteractiveElement } from "../browser.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../llm-client.js";

class FakeLLM implements LLMClient {
  readonly name = "fake";
  async createMessage(_req: LLMRequest): Promise<LLMResponse> {
    return { text: "{}", backend: this.name };
  }
}

// A minimal InteractiveElement factory — fills the required fields with
// inert defaults so a test only states the signals it cares about.
function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#el",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

describe("findCreateKeyAffordance", () => {
  it("finds a 'Create API Key' button", () => {
    const inv = [
      el({ visibleText: "Docs", selector: "#docs", tag: "a" }),
      el({ visibleText: "Create API Key", selector: "#create" }),
    ];
    expect(findCreateKeyAffordance(inv)?.selector).toBe("#create");
  });

  it("finds 'Generate new token' and 'New API key' phrasings", () => {
    expect(
      findCreateKeyAffordance([el({ visibleText: "Generate new token", selector: "#g" })])
        ?.selector,
    ).toBe("#g");
    expect(
      findCreateKeyAffordance([el({ visibleText: "New API key", selector: "#n" })])
        ?.selector,
    ).toBe("#n");
  });

  it("matches an icon-only mint button via aria-label / title", () => {
    expect(
      findCreateKeyAffordance([
        el({ visibleText: null, ariaLabel: "Create new API key", selector: "#aria" }),
      ])?.selector,
    ).toBe("#aria");
    expect(
      findCreateKeyAffordance([
        el({ visibleText: null, title: "Generate API token", selector: "#title" }),
      ])?.selector,
    ).toBe("#title");
  });

  it("prefers the most specific affordance (api-key phrase over a bare 'Add key')", () => {
    const inv = [
      el({ visibleText: "Add key", selector: "#bare" }),
      el({ visibleText: "Create API Key", selector: "#specific" }),
    ];
    expect(findCreateKeyAffordance(inv)?.selector).toBe("#specific");
  });

  it("ignores non-clickable elements (an <input> named 'key' is not the create action)", () => {
    const inv = [
      el({ tag: "input", type: "text", name: "api_key", visibleText: null, selector: "#field" }),
    ];
    expect(findCreateKeyAffordance(inv)).toBeNull();
  });

  it("ignores hidden elements", () => {
    expect(
      findCreateKeyAffordance([
        el({ visibleText: "Create API Key", selector: "#hidden", visible: false }),
      ]),
    ).toBeNull();
  });

  it("does not match unrelated buttons (no key/token noun)", () => {
    const inv = [
      el({ visibleText: "Create project", selector: "#proj" }),
      el({ visibleText: "Add member", selector: "#member" }),
      el({ visibleText: "Generate report", selector: "#report" }),
    ];
    expect(findCreateKeyAffordance(inv)).toBeNull();
  });

  it("returns null on an empty inventory", () => {
    expect(findCreateKeyAffordance([])).toBeNull();
  });
});

describe("findApiKeysNavLink", () => {
  it("finds an anchor whose href points at a keys page", () => {
    const inv = [
      el({ tag: "a", visibleText: "Dashboard", href: "/dashboard", selector: "#d" }),
      el({ tag: "a", visibleText: "Settings", href: "/settings/api-keys", selector: "#k" }),
    ];
    expect(findApiKeysNavLink(inv)?.selector).toBe("#k");
  });

  it("finds a non-conventional keys href the URL-guesser would never reach", () => {
    // unify-ai: the keys link exists but at a path /keys, /api-keys,
    // /settings/api-keys all 404'd — only the real href works.
    const inv = [
      el({ tag: "a", visibleText: "API", href: "/org/abc/developer/api-keys", selector: "#real" }),
    ];
    expect(findApiKeysNavLink(inv)?.selector).toBe("#real");
  });

  it("matches by link text when no href is present", () => {
    expect(
      findApiKeysNavLink([el({ tag: "a", visibleText: "API Keys", selector: "#t" })])?.selector,
    ).toBe("#t");
  });

  it("prefers a real href target over a text-only match", () => {
    const inv = [
      el({ tag: "a", visibleText: "API keys", selector: "#text" }),
      el({ tag: "a", visibleText: "Keys", href: "/settings/keys", selector: "#href" }),
    ];
    expect(findApiKeysNavLink(inv)?.selector).toBe("#href");
  });

  it("skips a link already clicked", () => {
    const inv = [el({ tag: "a", visibleText: "API Keys", href: "/api-keys", selector: "#k" })];
    expect(findApiKeysNavLink(inv, new Set(["#k"]))).toBeNull();
  });

  it("ignores a 'Create API key' button (not a nav link) without a keys href", () => {
    expect(
      findApiKeysNavLink([el({ tag: "button", visibleText: "Create API key", selector: "#c" })]),
    ).toBeNull();
  });

  it("does not match unrelated nav (keyboard shortcuts, billing, docs)", () => {
    const inv = [
      el({ tag: "a", visibleText: "Keyboard shortcuts", href: "/help/shortcuts", selector: "#kb" }),
      el({ tag: "a", visibleText: "Billing", href: "/settings/billing", selector: "#b" }),
      el({ tag: "a", visibleText: "Docs", href: "/docs", selector: "#d" }),
    ];
    expect(findApiKeysNavLink(inv)).toBeNull();
  });

  it("returns null on an empty inventory", () => {
    expect(findApiKeysNavLink([])).toBeNull();
  });
});

// --- attemptMintNewKey flow -------------------------------------------

interface FakeBrowserConfig {
  url: string;
  // Inventory returned by extractInteractiveElements (the create-key
  // affordance lives here when present).
  inventory?: InteractiveElement[];
  // Credential candidate strings (extractCredentialCandidates) —
  // populated to simulate a readable key on the page.
  candidates?: string[];
  // Candidates that only appear AFTER the create button is clicked
  // (the freshly-minted key shown in a modal).
  candidatesAfterCreate?: string[];
  // revealMaskedCredentials result.
  revealClicked?: number;
  pageText?: string;
}

class FakeBrowser {
  public clicks: string[] = [];
  public gotos: string[] = [];
  private created = false;
  constructor(private readonly cfg: FakeBrowserConfig) {}

  async getState(): Promise<{ url: string; title: string; html: string; screenshot: string }> {
    return { url: this.cfg.url, title: "", html: "", screenshot: "" };
  }
  async extractText(): Promise<string> {
    return this.cfg.pageText ?? "";
  }
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    return this.cfg.inventory ?? [];
  }
  async extractCredentialCandidates(): Promise<string[]> {
    const base = this.cfg.candidates ?? [];
    if (this.created && this.cfg.candidatesAfterCreate !== undefined) {
      return [...base, ...this.cfg.candidatesAfterCreate];
    }
    return base;
  }
  async extractAllInputValues(): Promise<string[]> {
    return [];
  }
  async extractCredentialsNearCopyButtons(): Promise<string[]> {
    return [];
  }
  async extractLabeledCredentialCandidates(): Promise<
    { value: string; label: string | null; isMasked: boolean }[]
  > {
    return [];
  }
  async revealMaskedCredentials(): Promise<{ clicked: number; diagnostic: string[] }> {
    return { clicked: this.cfg.revealClicked ?? 0, diagnostic: [] };
  }
  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
    // Clicking the create affordance flips the freshly-minted key into
    // the candidate stream.
    if (this.cfg.inventory?.some((e) => e.selector === selector)) {
      this.created = true;
    }
  }
  async wait(_s: number): Promise<void> {}
  async goto(url: string): Promise<void> {
    this.gotos.push(url);
    this.cfg.url = url;
  }
  async waitForInteractiveDom(_a: number, _b: number): Promise<void> {}
}

function agentWith(browser: FakeBrowser): SignupAgent {
  const asController: unknown = browser;
  // BrowserController is nominal (private fields); launder the
  // structural fake the way the captcha-short-circuit test documents.
  return new SignupAgent(asController as BrowserController, new FakeLLM());
}

async function mint(
  agent: SignupAgent,
  steps: string[],
): Promise<Record<string, string> | null> {
  const fn = (
    agent as unknown as {
      attemptMintNewKey: (s: string[]) => Promise<Record<string, string> | null>;
    }
  ).attemptMintNewKey.bind(agent);
  return fn(steps);
}

describe("SignupAgent.attemptMintNewKey", () => {
  it("extracts a readable existing key already on the keys page (no minting needed)", async () => {
    const browser = new FakeBrowser({
      url: "https://app.example.test/settings/api-keys",
      candidates: ["re_livekeyexampleAAAAAAAAAA01"],
      inventory: [el({ visibleText: "Create API Key", selector: "#create" })],
    });
    const agent = agentWith(browser);
    const out = await mint(agent, []);

    expect(out).not.toBeNull();
    expect(out?.api_key).toBe("re_livekeyexampleAAAAAAAAAA01");
    // A readable key was present, so the create button must NOT be clicked.
    expect(browser.clicks).toHaveLength(0);
  });

  it("mints a fresh key when existing keys are masked (clicks Create, extracts the new value)", async () => {
    const browser = new FakeBrowser({
      url: "https://app.example.test/settings/api-keys",
      // No readable key on the page — only a masked listing.
      candidates: ["ts-••••••••••••"],
      pageText: "Existing API key  name ts-7229  ts-••••••••••",
      inventory: [el({ visibleText: "Create new API key", selector: "#create" })],
      // The fresh key surfaces only after the create click.
      candidatesAfterCreate: ["re_1234567890abcdefghijklmnop"],
    });
    const agent = agentWith(browser);
    const out = await mint(agent, []);

    expect(out).not.toBeNull();
    expect(out?.api_key).toBe("re_1234567890abcdefghijklmnop");
    expect(browser.clicks).toContain("#create");
  });

  it("walks keys-path fallbacks from a non-keys dashboard, then mints", async () => {
    const browser = new FakeBrowser({
      url: "https://app.example.test/onboarding",
      candidates: [],
      inventory: [el({ visibleText: "Create API Key", selector: "#create" })],
      candidatesAfterCreate: ["re_testkeyexampleBBBBBBBBBB02"],
    });
    const agent = agentWith(browser);
    const out = await mint(agent, []);

    expect(out).not.toBeNull();
    expect(out?.api_key).toBe("re_testkeyexampleBBBBBBBBBB02");
    // It had to navigate to a keys page first (current URL wasn't one).
    expect(browser.gotos.length).toBeGreaterThan(0);
    expect(browser.gotos[0]).toMatch(/\/settings\/keys/);
  });

  it("bails honestly (null) when there is no key-minting affordance anywhere", async () => {
    const browser = new FakeBrowser({
      url: "https://app.example.test/settings/api-keys",
      candidates: ["ts-••••••••••••"],
      pageText: "Existing API key  name ts-7229  ts-••••••••••",
      // Only unrelated buttons — key creation is paywalled / absent.
      inventory: [
        el({ visibleText: "Upgrade plan", selector: "#upgrade" }),
        el({ visibleText: "Docs", selector: "#docs", tag: "a" }),
      ],
    });
    const agent = agentWith(browser);
    const out = await mint(agent, []);

    expect(out).toBeNull();
    // No create affordance → never clicked one.
    expect(browser.clicks).toHaveLength(0);
  });
});
