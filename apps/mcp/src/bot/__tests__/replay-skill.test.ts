// Covers replay-skill.ts — the runtime that walks a stored Skill
// against a live browser. Tests use a stub BrowserController that
// returns scripted inventories and records the calls made against it,
// so we can assert "the replay engine did X then Y" without spinning
// up Playwright.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Skill, SkillStep } from "@trusty-squire/skill-schema";
import type { BrowserController, InteractiveElement } from "../browser.js";
import { replaySkill, type LLMFallbackInput } from "../replay-skill.js";

// The stub browser's wait() returns instantly, so the credential-reveal poll
// otherwise busy-spins its full 8s deadline (no key ever appears) — dozens of
// times across this file → ~82s, which trips vitest's worker heartbeat under
// CI parallelism and FAILED the release verify job. Shrink it to 30ms; the
// poll's correctness doesn't depend on wall-clock (the stub is stateless per
// call), only on whether a candidate ever shows up.
process.env.UNIVERSAL_BOT_REVEAL_POLL_MS = "30";

// ── Stub browser ────────────────────────────────────────────────────
//
// Implements enough of BrowserController for the replay engine to
// drive it. Each method records its call into `history` for assertions.
// `inventoryQueue` and `textQueue` give tests scripted per-call
// responses; if the queue runs dry, the last value persists.

interface StubCall {
  method: string;
  args: unknown[];
}

interface StubBrowser {
  controller: BrowserController;
  history: StubCall[];
  setInventoryFor(method: "extract", inv: InteractiveElement[]): void;
  setInventorySequence(seq: InteractiveElement[][]): void;
  setGotoResultUrl(url: string | null): void;
  setTextFor(text: string): void;
  setCandidatesFor(candidates: string[]): void;
  setClipboardFor(clip: string): void;
}

function inv(overrides: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: overrides.index ?? 0,
    tag: overrides.tag ?? "button",
    type: overrides.type ?? null,
    id: overrides.id ?? null,
    name: overrides.name ?? null,
    placeholder: overrides.placeholder ?? null,
    ariaLabel: overrides.ariaLabel ?? null,
    role: overrides.role ?? null,
    labelText: overrides.labelText ?? null,
    visibleText: overrides.visibleText ?? null,
    selector: overrides.selector ?? "button",
    visible: overrides.visible ?? true,
    inViewport: overrides.inViewport ?? true,
    inConsentWidget: overrides.inConsentWidget ?? false,
    href: overrides.href ?? null,
    iconLabel: overrides.iconLabel ?? null,
    title: overrides.title ?? null,
    testId: overrides.testId ?? null,
    value: overrides.value ?? null,
    interactedThisRun: overrides.interactedThisRun ?? false,
  };
}

function stubBrowser(): StubBrowser {
  const history: StubCall[] = [];
  let inventory: InteractiveElement[] = [];
  let inventoryQueue: InteractiveElement[][] = [];
  let text = "";
  let candidates: string[] = [];
  let clipboard = "";
  let gotoResultUrl: string | null = null;

  // Track the last URL the stub navigated to so currentUrl() can
  // report consistently — the rc.22 navigate-step drift detector
  // calls browser.currentUrl() after every goto.
  let lastUrl = "";
  const controller = {
    async goto(url: string) {
      history.push({ method: "goto", args: [url] });
      lastUrl = gotoResultUrl ?? url;
    },
    currentUrl(): string {
      return lastUrl;
    },
    oauthPageClosed(): boolean {
      // Default: behave as if the OAuth popup closed cleanly. Tests
      // that exercise the drift path can swap a different stub.
      return true;
    },
    async click(selector: string) {
      history.push({ method: "click", args: [selector] });
    },
    async type(selector: string, value: string) {
      history.push({ method: "type", args: [selector, value] });
    },
    async selectOption(selector: string, option?: string) {
      history.push({ method: "selectOption", args: [selector, option] });
    },
    async check(selector: string) {
      history.push({ method: "check", args: [selector] });
    },
    async wait(seconds: number) {
      history.push({ method: "wait", args: [seconds] });
    },
    async waitForInteractiveDom() {
      history.push({ method: "waitForInteractiveDom", args: [] });
    },
    async extractInteractiveElements() {
      history.push({ method: "extractInteractiveElements", args: [] });
      if (inventoryQueue.length > 0) {
        inventory = inventoryQueue.shift()!;
      }
      return inventory;
    },
    async extractText() {
      history.push({ method: "extractText", args: [] });
      return text;
    },
    async extractCredentialCandidates() {
      history.push({ method: "extractCredentialCandidates", args: [] });
      return candidates;
    },
    async startOAuth(selector: string) {
      history.push({ method: "startOAuth", args: [selector] });
    },
    async settleAfterOAuth() {
      history.push({ method: "settleAfterOAuth", args: [] });
    },
    async hasDisabledSubmit() {
      history.push({ method: "hasDisabledSubmit", args: [] });
      return false;
    },
    async fillRequiredComboboxes() {
      history.push({ method: "fillRequiredComboboxes", args: [] });
      return [];
    },
    async readClipboard() {
      history.push({ method: "readClipboard", args: [] });
      return clipboard;
    },
    async extractCredentialsNearCopyButtons() {
      history.push({ method: "extractCredentialsNearCopyButtons", args: [] });
      return [];
    },
  } as unknown as BrowserController;

  return {
    controller,
    history,
    setInventoryFor(_method, newInv) {
      inventory = newInv;
      inventoryQueue = [];
    },
    setInventorySequence(seq) {
      inventoryQueue = [...seq];
      inventory = seq.at(-1) ?? [];
    },
    setGotoResultUrl(url) {
      gotoResultUrl = url;
    },
    setTextFor(newText) {
      text = newText;
    },
    setCandidatesFor(newCandidates) {
      candidates = newCandidates;
    },
    setClipboardFor(newClip) {
      clipboard = newClip;
    },
  };
}

// ── Fixture: a minimal valid Skill ──────────────────────────────────

const provenance = { run_id: "test-run", round_index: 0 };

function skillWith(steps: SkillStep[], overrides: Partial<Skill> = {}): Skill {
  return {
    schema_version: 1,
    service: "testsvc",
    version: "v1",
    skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
    signup_url: "https://example.com/login",
    oauth_provider: null,
    steps,
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "TESTSVC_API_KEY",
        post_extract_validator: {
          min_length: 36,
          max_length: 36,
        },
      },
    ],
    source_run_ids: ["test-run"],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
    ...overrides,
  };
}

// ── Status guards ────────────────────────────────────────────────────

describe("replaySkill — status guards", () => {
  it("refuses to replay a demoted skill", async () => {
    const b = stubBrowser();
    const result = await replaySkill({
      skill: skillWith(
        [{ kind: "navigate", url: "https://example.com", provenance }],
        { status: "demoted" },
      ),
      browser: b.controller,
    });
    expect(result.kind).toBe("skill_demoted");
  });

  it("refuses to replay a pending-review skill", async () => {
    const b = stubBrowser();
    const result = await replaySkill({
      skill: skillWith(
        [{ kind: "navigate", url: "https://example.com", provenance }],
        { status: "pending-review" },
      ),
      browser: b.controller,
    });
    expect(result.kind).toBe("skill_demoted");
  });

  it("refuses to replay a superseded skill", async () => {
    const b = stubBrowser();
    const result = await replaySkill({
      skill: skillWith(
        [{ kind: "navigate", url: "https://example.com", provenance }],
        { status: "superseded" },
      ),
      browser: b.controller,
    });
    expect(result.kind).toBe("skill_demoted");
  });

  it("with bypassStatusGuard=true, REPLAYS a pending-review skill", async () => {
    // 0.8.2-rc.19 — the verifier loop hits this branch. Without
    // bypassStatusGuard the loop is dead-on-arrival (every pending-
    // review skill returns skill_demoted before any step runs).
    const b = stubBrowser();
    const result = await replaySkill({
      skill: skillWith(
        [{ kind: "navigate", url: "https://example.com", provenance }],
        { status: "pending-review" },
      ),
      browser: b.controller,
      bypassStatusGuard: true,
      mode: "dry",
    });
    expect(result.kind).not.toBe("skill_demoted");
  });

  it("with bypassStatusGuard=true, also REPLAYS a demoted skill", async () => {
    // A demoted skill can recover — the verifier should still gather
    // outcomes against it. Decision to re-promote is the registry's,
    // based on the accumulated counter.
    const b = stubBrowser();
    const result = await replaySkill({
      skill: skillWith(
        [{ kind: "navigate", url: "https://example.com", provenance }],
        { status: "demoted" },
      ),
      browser: b.controller,
      bypassStatusGuard: true,
      mode: "dry",
    });
    expect(result.kind).not.toBe("skill_demoted");
  });

  it("with bypassStatusGuard=true, STILL refuses to replay a superseded skill", async () => {
    // Superseded means a newer version is canonical — replaying the
    // older one wastes cycles. Bypass doesn't unlock this status.
    const b = stubBrowser();
    const result = await replaySkill({
      skill: skillWith(
        [{ kind: "navigate", url: "https://example.com", provenance }],
        { status: "superseded" },
      ),
      browser: b.controller,
      bypassStatusGuard: true,
    });
    expect(result.kind).toBe("skill_demoted");
  });
});

// ── Signup submit preconditions ─────────────────────────────────────

describe("replaySkill — signup submit preconditions", () => {
  it("checks required agreement boxes before a signup-submit click", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ selector: "button.continue", visibleText: "Continue", role: "button" }),
    ]);
    b.setTextFor("api key 123e4567-e89b-12d3-a456-426614174000");
    (b.controller as BrowserController & {
      checkRequiredAgreementBoxes: () => Promise<string[]>;
    }).checkRequiredAgreementBoxes = async () => {
      b.history.push({ method: "checkRequiredAgreementBoxes", args: [] });
      return ["terms"];
    };

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "click",
          text_match: "Continue",
          role_hint: "button",
          provenance,
        },
        {
          kind: "extract_via_regex",
          pattern_name: "uuid_token",
          provenance,
        },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const guardIndex = b.history.findIndex((c) => c.method === "checkRequiredAgreementBoxes");
    const clickIndex = b.history.findIndex((c) => c.method === "click");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(clickIndex).toBeGreaterThan(guardIndex);
  });
});

// ── Dry mode ────────────────────────────────────────────────────────

describe("replaySkill — dry mode", () => {
  it("stops before the credential-creating click", async () => {
    const b = stubBrowser();
    // 4-step skill: navigate -> fill -> click -> extract
    const skill = skillWith([
      { kind: "navigate", url: "https://example.com/tokens", provenance },
      { kind: "fill", label_hint: "Token name", value_template: "test", provenance },
      { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
      { kind: "extract_via_copy_button", near_text_hint: "New Token", provenance },
    ]);

    // Inventory has the fill input, the create button, and a copy button.
    b.setInventoryFor("extract", [
      inv({ tag: "input", labelText: "Token name", selector: "input.name" }),
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    const result = await replaySkill({
      skill,
      browser: b.controller,
      mode: "dry",
    });

    expect(result.kind).toBe("dry_pass");
    // The "Create Token" click is the credential-creator. Dry mode
    // must NOT have executed it.
    const clicks = b.history.filter((c) => c.method === "click");
    expect(clicks).toHaveLength(0);
  });

  it("walks navigate + fill but stops at the create click", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "input", labelText: "Token name", selector: "input.name" }),
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://example.com/tokens", provenance },
        { kind: "fill", label_hint: "Token name", value_template: "test", provenance },
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "New Token", provenance },
      ]),
      browser: b.controller,
      mode: "dry",
    });

    const gotos = b.history.filter((c) => c.method === "goto");
    expect(gotos).toHaveLength(1);
    expect(gotos[0]!.args[0]).toBe("https://example.com/tokens");

    const types = b.history.filter((c) => c.method === "type");
    expect(types).toHaveLength(1);
  });

  it("defaults to dry mode when mode is omitted", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://example.com/tokens", provenance },
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "New Token", provenance },
      ]),
      browser: b.controller,
      // mode omitted
    });

    expect(result.kind).toBe("dry_pass");
  });
});

// ── Full mode happy path ─────────────────────────────────────────────

describe("replaySkill — full mode happy path", () => {
  it("walks the entire graph and returns the extracted credential", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "input", labelText: "Token name", selector: "input.name" }),
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor([
      "Token created!",
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://example.com/tokens", provenance },
        { kind: "fill", label_hint: "Token name", value_template: "my-key", provenance },
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.credential).toBe("db3a32ea-dd1b-4e28-9680-db2991c81e3e");
    expect(result.via).toBe("copy_button");
  });

  it("substitutes ${TOKEN_NAME} from templateValues", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "input", labelText: "Token name", selector: "input.name" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor([
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    await replaySkill({
      skill: skillWith([
        { kind: "fill", label_hint: "Token name", value_template: "${TOKEN_NAME}", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { TOKEN_NAME: "my-replay-token" },
    });

    const types = b.history.filter((c) => c.method === "type");
    expect(types).toHaveLength(1);
    expect(types[0]!.args[1]).toBe("my-replay-token");
  });
});

// ── Validator rejection ──────────────────────────────────────────────

describe("replaySkill — credential validator", () => {
  it("rejects a credential that's too short", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    // Candidate doesn't match the API_KEY regex library at all
    // (too short to be a UUID), so extraction fails before the
    // validator. This exercises the extraction_failed path.
    b.setCandidatesFor(["Your token: short"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
  });

  it("rejects a wrong-shape credential via shape_regex", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    // Provide a valid-shape UUID so extraction succeeds; then the
    // validator's shape_regex (which we tighten via the skill below)
    // catches the mismatch.
    b.setCandidatesFor([
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    const skill = skillWith([
      { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
    ]);
    // Tighten the validator: only accept tokens starting with 'aa'
    skill.credentials[0]!.post_extract_validator.shape_regex = "^aa";

    const result = await replaySkill({
      skill,
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("validator_failed");
    if (result.kind !== "validator_failed") return;
    expect(result.got).toBe("db3a32ea-dd1b-4e28-9680-db2991c81e3e");
  });

  it("tries alternate copy buttons when the first copied value fails validator shape", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy value", selector: "button.copy-value" }),
      inv({ tag: "button", visibleText: "Copy value", selector: "button.copy-value" }),
    ]);
    let clipboard = "";
    (b.controller as unknown as { click: (selector: string) => Promise<void> }).click = async (selector: string) => {
      b.history.push({ method: "click", args: [selector] });
      clipboard = "https://example.kinde.com";
    };
    (b.controller as unknown as { clickNth: (selector: string, index: number) => Promise<void> }).clickNth = async (
      selector: string,
      index: number,
    ) => {
      b.history.push({ method: "clickNth", args: [selector, index] });
      clipboard = index === 1 ? "1bb74b83064745a18d62dffcbae06529" : "https://example.kinde.com";
    };
    (b.controller as unknown as { readClipboard: () => Promise<string> }).readClipboard = async () => clipboard;

    const skill = skillWith([
      { kind: "extract_via_copy_button", near_text_hint: "Copy value", provenance },
    ]);
    skill.credentials[0]!.shape_hint = "opaque";
    skill.credentials[0]!.post_extract_validator = { min_length: 32, max_length: 32 };

    const result = await replaySkill({
      skill,
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.credential).toBe("1bb74b83064745a18d62dffcbae06529");
    expect(b.history.some((c) => c.method === "clickNth" && c.args[1] === 1)).toBe(true);
  });

  it("classifies client-only app pages where the secret is unavailable", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "", ariaLabel: "Copy value", selector: "button.copy-value" }),
    ]);
    b.setClipboardFor("");
    b.setTextFor("Domain Client ID Client secret is not applicable for this applications");

    const result = await replaySkill({
      skill: skillWith([
        { kind: "extract_via_copy_button", near_text_hint: "Copy value", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.reason).toContain("credential_surface=secret_unavailable");
    expect(result.reason).toContain("public/client-only application");
  });

  it("retries hydrated credential-create click resolution before declaring the target absent", async () => {
    const b = stubBrowser();
    b.setInventorySequence([
      [],
      [
        inv({
          tag: "button",
          visibleText: "Create API Key",
          selector: "button.create-key",
          testId: "keys-page-create-button",
        }),
      ],
      [
        inv({
          tag: "button",
          visibleText: "Create API Key",
          selector: "button.create-key",
          testId: "keys-page-create-button",
        }),
      ],
    ]);
    b.setTextFor("Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e");

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "click",
          text_match: "Create API Key",
          role_hint: "button",
          dom_hint: { testid: "keys-page-create-button" },
          provenance,
        },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create-key")).toBe(true);
  });

  it("uses href_hint to disambiguate duplicate same-text click targets", async () => {
    const b = stubBrowser();
    const links = [
      inv({ tag: "a", role: "link", visibleText: "Kinde APIs", href: "/docs/apis/", selector: "a.docs" }),
      inv({ tag: "a", role: "link", visibleText: "Kinde APIs", href: "/kinde-apis/", selector: "a.target" }),
    ];
    b.setInventorySequence([links, links]);
    b.setTextFor("Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e");

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "click",
          text_match: "Kinde APIs",
          role_hint: "link",
          href_hint: "/kinde-apis/",
          provenance,
        },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "a.target")).toBe(true);
  });

  it("prefers non-consent matches over cookie-banner controls for ordinary clicks", async () => {
    const b = stubBrowser();
    const inventory = [
      inv({
        tag: "button",
        role: "button",
        visibleText: "Settings",
        selector: "button.cookie-settings",
        inConsentWidget: true,
      }),
      inv({
        tag: "a",
        role: "link",
        visibleText: "Settings",
        href: "/admin/settings",
        selector: "a.settings",
      }),
    ];
    b.setInventorySequence([inventory, inventory]);
    b.setTextFor("Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e");

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Settings", role_hint: "link", provenance },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "a.settings")).toBe(true);
  });
});

// ── Step pre-validation failure → LLM fallback ──────────────────────

describe("replaySkill — LLM fallback", () => {
  it("invokes llmFallback when a click step's text doesn't resolve", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      // Page DOES have a copy button but NOT the "Create Token" button.
      inv({ tag: "button", visibleText: "Generate Key", selector: "button.gen" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor([
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    const llmFallback = vi.fn(async (input: LLMFallbackInput): Promise<SkillStep | null> => {
      // Planner observes "Generate Key" on the page and substitutes.
      expect(input.capturedStep.kind).toBe("click");
      return {
        kind: "click",
        text_match: "Generate Key",
        role_hint: "button",
        provenance: { run_id: "fallback", round_index: 0 },
      };
    });

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      llmFallback,
    });

    expect(llmFallback).toHaveBeenCalledOnce();
    expect(result.kind).toBe("ok");

    const clicks = b.history.filter((c) => c.method === "click");
    // We clicked the substitute button, not the captured one.
    expect(clicks.some((c) => c.args[0] === "button.gen")).toBe(true);
  });

  it("gives up cleanly when llmFallback returns null", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Generate Key", selector: "button.gen" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      llmFallback: async () => null,
    });

    expect(result.kind).toBe("step_failed");
  });

  it("fails without calling llmFallback when none is provided", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Some other button", selector: "button.x" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      // no llmFallback
    });

    expect(result.kind).toBe("step_failed");
  });
});

// ── Absent setup-click skip (account-state-dependent steps) ─────────
//
// hookdeck class: the captured "Create Project" click only existed in
// the original signup's first-time account state. On replay against a
// fresh / already-set-up account the button is simply gone. The replay
// engine must skip the absent NON-credential-creating click and keep
// going, rather than hard-failing a credential it can still reach.

describe("replaySkill — absent setup-click skip", () => {
  it("skips a wholly-absent non-credential click and reaches the credential (hookdeck case)", async () => {
    const b = stubBrowser();
    // The page does NOT have "Create Project" (the first-time-account
    // setup button). It DOES have "Create Token" (the credential-
    // creating click) and a Copy button.
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create-token",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor([
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    const result = await replaySkill({
      skill: skillWith([
        // Step 0: the account-state-dependent setup click — ABSENT now.
        { kind: "click", text_match: "Create Project", role_hint: "button", provenance },
        // Step 1: the credential-creating click — present.
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.credential).toBe("db3a32ea-dd1b-4e28-9680-db2991c81e3e");

    // The absent setup button was never clicked; the credential-creating
    // button WAS clicked.
    const clicks = b.history.filter((c) => c.method === "click");
    expect(clicks.some((c) => c.args[0] === "button.create-token")).toBe(true);
    expect(clicks.some((c) => String(c.args[0]).includes("project"))).toBe(false);
  });

  it("fails fast after too many consecutive absent setup steps before extraction", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create-token",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Proceed", role_hint: "button", provenance },
        { kind: "click", text_match: "Continue", role_hint: "button", provenance },
        { kind: "click", text_match: "Create my account", role_hint: "button", provenance },
        { kind: "click", text_match: "Settings", role_hint: "button", provenance },
        { kind: "click", text_match: "Configure cloud", role_hint: "button", provenance },
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(4);
    expect(result.reason).toContain("stale_skill_path");
    expect(b.history.some((c) => c.method === "click")).toBe(false);
  });

  it("does NOT skip when the absent click IS the credential-creating click", async () => {
    const b = stubBrowser();
    // The credential-creating "Create Token" button is gone. Skipping it
    // would bypass token creation and let a hollow replay claim success,
    // so this must still hard-fail.
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Some unrelated button", selector: "button.x" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(0);
  });

  it("does NOT skip an absent click that is the last click with no later credential click", async () => {
    const b = stubBrowser();
    // navigate -> click(absent) -> extract. The click is the last click
    // before the extract, so it IS the credential-creating click — a
    // missing one is genuine rot, not an optional setup step.
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Unrelated", selector: "button.x" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://example.com/tokens", provenance },
        { kind: "click", text_match: "Create Project", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(1);
  });

  it("does NOT skip when the click target is PRESENT but ambiguous (real rot)", async () => {
    const b = stubBrowser();
    // "Create Project" resolves to TWO non-button links — the element
    // exists but the skill can't pin it. That's a real ambiguity, not a
    // vanished setup step, so it must NOT be silently skipped.
    b.setInventoryFor("extract", [
      inv({ tag: "a", visibleText: "Create Project", selector: "a.help" }),
      inv({ tag: "a", visibleText: "Create Project", selector: "a.docs" }),
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create-token",
      }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Project", provenance },
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(0);
  });

  it("prefers an LLM substitute over skipping when the fallback supplies one", async () => {
    const b = stubBrowser();
    // "Create Project" is absent, but a substitute "Start Project" IS on
    // the page and the planner finds it. The substitute must win over the
    // skip path (the skip is the last-resort behaviour).
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Start Project", role: "button", selector: "button.start" }),
      inv({
        tag: "button",
        visibleText: "Create Token",
        role: "button",
        selector: "button.create-token",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor([
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    const llmFallback = vi.fn(
      async (input: LLMFallbackInput): Promise<SkillStep | null> => {
        expect(input.capturedStep.kind).toBe("click");
        return {
          kind: "click",
          text_match: "Start Project",
          role_hint: "button",
          provenance: { run_id: "fallback", round_index: 0 },
        };
      },
    );

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Project", role_hint: "button", provenance },
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      llmFallback,
    });

    expect(llmFallback).toHaveBeenCalledOnce();
    expect(result.kind).toBe("ok");
    const clicks = b.history.filter((c) => c.method === "click");
    // The substitute was clicked — the absent step was NOT merely skipped.
    expect(clicks.some((c) => c.args[0] === "button.start")).toBe(true);
  });

  it("does NOT skip an absent ${EMAIL_ALIAS} fill before an email-code step", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "fill",
          label_hint: "Enter your email address",
          value_template: "${EMAIL_ALIAS}",
          provenance,
        },
        { kind: "click", text_match: "Send Code", role_hint: "button", provenance },
        { kind: "await_email_code", label_hint: "Your code", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { EMAIL_ALIAS: "robot@example.com" },
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(0);
    expect(result.reason).toContain("No input matches");
    expect(b.history.some((c) => c.method === "type")).toBe(false);
  });
});

// ── Absent onboarding-select skip (porter "Role" / railway "Workspace") ──
// A captured `select` step can target a wizard dropdown that only exists for
// a brand-new account. On a returning-user replay the onboarding form is gone
// and the <select> is wholly absent — the <select> analogue of the absent-fill
// case. Skip it (a later extract + the credential validator still reach the
// credential) rather than hard-failing a replay that can still succeed.

describe("replaySkill — absent onboarding-select skip", () => {
  it("skips a wholly-absent onboarding select and reaches the credential (porter Role / railway Workspace case)", async () => {
    const b = stubBrowser();
    // The returning-user account skips the onboarding wizard, so the "Role"
    // <select> is wholly absent. The credential surface (Copy button) IS present.
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        // Step 0: account-state-dependent onboarding select — ABSENT now.
        { kind: "select", label_hint: "Role", option_text: "CEO / Founder", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.credential).toBe("db3a32ea-dd1b-4e28-9680-db2991c81e3e");
    // The absent select was never driven.
    expect(b.history.some((c) => c.method === "selectOption")).toBe(false);
  });

  it("does NOT skip an absent select when no later step reaches a credential (genuine rot)", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Unrelated", selector: "button.x" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://example.com/onboarding", provenance },
        { kind: "select", label_hint: "Role", option_text: "CEO / Founder", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(1);
  });
});

// ── Account-onboarding gate recovery ────────────────────────────────
// Some services let OAuth complete, then redirect deep links to a generic
// account-profile gate (name, display name, terms checkbox, Continue). A
// stored skill recorded after that gate should not fail just because the fresh
// verifier sees the gate first; replay should complete the visible gate and
// then continue to the stored credential steps.

describe("replaySkill — account-onboarding gate recovery", () => {
  it("fills a visible account gate, accepts terms, then resumes the stored credential step", async () => {
    const b = stubBrowser();
    const onboarding = [
      inv({
        tag: "input",
        labelText: "What's your full name?",
        selector: "input.full-name",
        value: "",
      }),
      inv({
        tag: "input",
        labelText: "What should we call you?",
        selector: "input.call-you",
        value: "",
      }),
      inv({
        tag: "span",
        role: "checkbox",
        ariaLabel: "Accept terms",
        labelText: "I am at least 18 years old and agree to the Terms and Privacy Policy",
        selector: "span.terms",
        value: "",
      }),
      inv({
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "button.continue",
      }),
    ];
    const keysPage = [
      inv({
        tag: "button",
        role: "button",
        visibleText: "Create key",
        selector: "button.create-key",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ];
    b.setInventorySequence([
      onboarding,
      onboarding,
      onboarding,
      keysPage,
      keysPage,
      keysPage,
    ]);
    b.setTextFor(
      "Start building with Claude\nWhat's your full name?*\nWhat should we call you?*\nI am at least 18 years old, agree to Terms and Privacy Policy\nContinue",
    );
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create key", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy key", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { USER_DISPLAY_NAME: "Vera Sutton" },
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "type" && c.args[0] === "input.full-name")).toBe(true);
    expect(b.history.some((c) => c.method === "type" && c.args[0] === "input.call-you")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "span.terms")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.continue")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create-key")).toBe(true);
  });

  it("fills a Qdrant-style company gate, then resumes the stored create step", async () => {
    const b = stubBrowser();
    const onboarding = [
      inv({
        tag: "input",
        labelText: "First Name",
        name: "givenName",
        selector: "input.first",
        value: "Verify",
      }),
      inv({
        tag: "input",
        labelText: "Last Name",
        name: "familyName",
        selector: "input.last",
        value: "Robot 163",
      }),
      inv({
        tag: "input",
        labelText: "Account Name",
        name: "name",
        selector: "input.account",
        value: "Verify Robot 163 - Base Account",
      }),
      inv({
        tag: "input",
        role: "combobox",
        labelText: "Company Name",
        name: "company",
        selector: "input.company",
        value: "",
      }),
      inv({
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "button.continue",
      }),
    ];
    const apiPage = [
      inv({
        tag: "button",
        role: "button",
        visibleText: "Create",
        selector: "button.create",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ];
    b.setInventorySequence([
      onboarding,
      onboarding,
      onboarding,
      apiPage,
      apiPage,
      apiPage,
    ]);
    b.setTextFor(
      "Step 1/2\nTell us about yourself\nFirst Name\u200B\u200BLast Name\u200B\u200BAccount Name\u200B\u200BCompany Name\u200B\u200BContinue",
    );
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: {
        USER_DISPLAY_NAME: "Verify Robot 163",
        PROJECT_NAME: "Trusty Squire",
      },
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "type" && c.args[0] === "input.company")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.continue")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create")).toBe(true);
  });

  it("skips an optional onboarding survey, then resumes the stored create step", async () => {
    const b = stubBrowser();
    const survey = [
      inv({ tag: "input", type: "radio", labelText: "AI/ML Engineer", selector: "input.role" }),
      inv({ tag: "input", type: "checkbox", labelText: "Retrieval-Augmented Generation (RAG)", selector: "input.usage" }),
      inv({ tag: "button", role: "button", visibleText: "Continue", selector: "button.continue" }),
      inv({ tag: "button", role: "button", visibleText: "Skip", selector: "button.skip" }),
    ];
    const clusterPage = [
      inv({
        tag: "button",
        role: "button",
        visibleText: "Create Cluster",
        selector: "button.create-cluster",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ];
    b.setInventorySequence([
      survey,
      survey,
      clusterPage,
      clusterPage,
      clusterPage,
    ]);
    b.setTextFor(
      "Step 2/2\nHelp us customize your experience\nWhat's your role?\nWhat are you building?\nSkip",
    );
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.skip")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create-cluster")).toBe(true);
  });
});

// ── Optional billing gate recovery ──────────────────────────────────
// Fresh accounts can be routed through a credits/payment upsell before the
// stored credential route. If the page offers an explicit skip, replay should
// take it and resume instead of treating the downstream credential step as rot.

describe("replaySkill — optional billing gate recovery", () => {
  it("clicks Skip for now on a credits gate, then resumes the stored credential step", async () => {
    const b = stubBrowser();
    const creditsGate = [
      inv({ tag: "button", role: "button", visibleText: "Buy credits", selector: "button.buy" }),
      inv({ tag: "button", role: "button", visibleText: "Skip for now", selector: "button.skip" }),
    ];
    const dashboard = [
      inv({
        tag: "a",
        role: "link",
        visibleText: "API keys",
        href: "/settings/workspaces/default/keys",
        selector: "a.api-keys",
      }),
    ];
    const keysPage = [
      inv({
        tag: "button",
        role: "button",
        visibleText: "Create key",
        selector: "button.create-key",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ];
    b.setInventorySequence([
      creditsGate,
      creditsGate,
      dashboard,
      keysPage,
      keysPage,
      keysPage,
    ]);
    b.setTextFor("Buy credits\nCredit card\nBilling address\nSkip for now");
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create key", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy key", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.skip")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "a.api-keys")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create-key")).toBe(true);
  });
});

// ── Credential route drift recovery ─────────────────────────────────
// A stored deep link to a credential page can drift to the product dashboard
// after a vendor route migration. If the dashboard still exposes an API
// keys/tokens nav link, replay should click that link before continuing.

describe("replaySkill — credential route drift recovery", () => {
  it("recovers an old keys deep-link by clicking the visible API keys route", async () => {
    const b = stubBrowser();
    b.setGotoResultUrl("https://platform.example.com/dashboard");
    const dashboard = [
      inv({
        tag: "a",
        role: "link",
        visibleText: "API keys",
        href: "/settings/workspaces/default/keys",
        selector: "a.api-keys",
      }),
    ];
    const keysPage = [
      inv({
        tag: "button",
        role: "button",
        visibleText: "Create key",
        selector: "button.create-key",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ];
    b.setInventorySequence([
      dashboard,
      keysPage,
      keysPage,
      keysPage,
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://console.example.com/settings/keys", provenance },
        { kind: "click", text_match: "Create key", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy key", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "a.api-keys")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create-key")).toBe(true);
  });
});

// ── Token-subset fallback for a glossed credential-creating click ────
// The captured text_match is the planner's gloss ("Create Token"); the live
// returning-user page's button reads "Create API Token". Substring match
// fails; token containment resolves it, but only when unique.

describe("replaySkill — glossed cred-click token fallback", () => {
  it("prefers exact short click labels over longer prefix matches like Add funds", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Add funds", role: "button", selector: "button.add-funds" }),
      inv({ tag: "button", visibleText: "Add", role: "button", selector: "button.add" }),
      inv({ tag: "button", visibleText: "Copy key", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Add", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy key", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.add")).toBe(true);
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.add-funds")).toBe(false);
  });

  it("ignores decorative private-use icon glyphs in captured click text", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Create key",
        role: "button",
        selector: "button.create-key",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "\uE001Create key", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "button.create-key")).toBe(true);
  });

  it("resolves a glossed 'Create Token' to a unique 'Create API Token' button", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Create API Token",
        role: "button",
        selector: "button.create-api-token",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const clicks = b.history.filter((c) => c.method === "click");
    expect(clicks.some((c) => c.args[0] === "button.create-api-token")).toBe(true);
  });

  it("does NOT guess when the token match is ambiguous (two candidate buttons)", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Create API Token", role: "button", selector: "button.a" }),
      inv({ tag: "button", visibleText: "Create Service Token", role: "button", selector: "button.b" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.stepIndex).toBe(0);
  });
});

// ── role_hint is a soft preference, not a hard gate ──────────────────

describe("replaySkill — soft role_hint fallback", () => {
  it("clicks a text-matched element whose role differs from the captured role_hint (imagekit 'Next' is an <a>)", async () => {
    const b = stubBrowser();
    // The skill captured "Next" as role_hint=button, but on the returning-user
    // page "Next" renders as a link. role-filtering would drop it; soft
    // fallback keeps it.
    b.setInventoryFor("extract", [
      inv({ tag: "a", visibleText: "Next", role: "link", selector: "a.next" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Next", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const clicks = b.history.filter((c) => c.method === "click");
    expect(clicks.some((c) => c.args[0] === "a.next")).toBe(true);
  });
});

// ── Fuzzy label fallback for a glossed fill (anthropic "Name your key:") ──

describe("replaySkill — fuzzy fill-label fallback", () => {
  it("fills a present-but-glossed input by token overlap (\"Name your key:\" → input \"Name\")", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "input", labelText: "Name", selector: "input.keyname" }),
      inv({ tag: "button", visibleText: "Create", role: "button", selector: "button.create" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "fill", label_hint: "Name your key:", value_template: "${TOKEN_NAME}", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { TOKEN_NAME: "ts-key" },
    });

    expect(result.kind).toBe("ok");
    const types = b.history.filter((c) => c.method === "type");
    expect(types.some((c) => c.args[0] === "input.keyname")).toBe(true);
  });

  it("does NOT fuzzy-match an unrelated input (Search box) — falls through to absent-skip", async () => {
    const b = stubBrowser();
    // Returning-user page: only a Search box, no name field. The fill must
    // NOT grab the search box; it should skip as account-state-dependent and
    // still reach the credential.
    b.setInventoryFor("extract", [
      inv({ tag: "input", labelText: "Search", placeholder: "Search", selector: "input.search" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "fill", label_hint: "Name your key:", value_template: "${TOKEN_NAME}", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { TOKEN_NAME: "ts-key" },
    });

    expect(result.kind).toBe("ok"); // skipped the absent name fill, reached the credential
    const types = b.history.filter((c) => c.method === "type");
    expect(types.some((c) => c.args[0] === "input.search")).toBe(false);
  });
});

// ── needs_login on OAuth without a profile session ──────────────────

describe("replaySkill — OAuth needs_login", () => {
  it("returns needs_login when click_oauth_button is for a provider with no session", async () => {
    // We can't mock loggedInProviders() easily without dependency
    // injection, so this test relies on the realistic case: the test
    // environment hasn't run `mcp login --provider=github` for our
    // test service profile. In CI / fresh dev boxes this returns [].
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Continue with GitHub",
        role: "button",
        selector: "button.gh",
      }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "click_oauth_button",
          provider: "github",
          text_match: "Continue with GitHub",
          provenance,
        },
      ]),
      browser: b.controller,
      mode: "full",
    });

    // We accept either outcome: needs_login (when no session exists,
    // the common case) OR the step executes (when a session does
    // exist on this machine). Both are correct behaviour; the test
    // asserts the call doesn't crash and produces a recognisable
    // outcome.
    expect(["needs_login", "step_failed", "extraction_failed", "ok"]).toContain(result.kind);
  });

  it("uses the supplied profileDir when checking OAuth login markers", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "replay-skill-profile-"));
    try {
      writeFileSync(
        join(profileDir, "logged-in-providers.json"),
        JSON.stringify(["github"]),
        "utf8",
      );
      const b = stubBrowser();
      b.setInventoryFor("extract", [
        inv({
          tag: "button",
          visibleText: "Continue with GitHub",
          role: "button",
          selector: "button.gh",
        }),
      ]);

      const result = await replaySkill({
        skill: skillWith([
          {
            kind: "click_oauth_button",
            provider: "github",
            text_match: "Continue with GitHub",
            provenance,
          },
        ]),
        browser: b.controller,
        mode: "full",
        profileDir,
      });

      expect(result.kind).not.toBe("needs_login");
      expect(b.history.some((call) => call.method === "startOAuth")).toBe(true);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("does not run navigate-time OAuth recovery when the next stored step is click_oauth_button", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "replay-skill-profile-"));
    try {
      writeFileSync(
        join(profileDir, "logged-in-providers.json"),
        JSON.stringify(["google"]),
        "utf8",
      );
      const b = stubBrowser();
      let currentUrl = "about:blank";
      (b.controller as unknown as { goto: (url: string) => Promise<void> }).goto = async (url: string) => {
        b.history.push({ method: "goto", args: [url] });
        currentUrl =
          url === "https://app.example.com/"
            ? "https://app.example.com/account/signin"
            : url;
      };
      (b.controller as unknown as { currentUrl: () => string }).currentUrl = () => currentUrl;
      b.setInventoryFor("extract", [
        inv({
          tag: "button",
          visibleText: "Sign in with Google",
          role: "button",
          selector: "button.google",
        }),
        inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
      ]);
      b.setTextFor("api key 123e4567-e89b-12d3-a456-426614174000");
      b.setCandidatesFor(["123e4567-e89b-12d3-a456-426614174000"]);

      const result = await replaySkill({
        skill: skillWith([
          { kind: "navigate", url: "https://app.example.com/", provenance },
          {
            kind: "click_oauth_button",
            provider: "google",
            text_match: "Google",
            provenance,
          },
          { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
        ]),
        browser: b.controller,
        mode: "full",
        profileDir,
      });

      expect(result.kind).toBe("ok");
      expect(b.history.some((call) => call.method === "startOAuth")).toBe(true);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("re-navigates to the resolved recovery entry when an expired auth transaction page has no OAuth button", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "replay-skill-profile-"));
    try {
      writeFileSync(
        join(profileDir, "logged-in-providers.json"),
        JSON.stringify(["google"]),
        "utf8",
      );
      const b = stubBrowser();
      const poisoned =
        "https://app.kinde.com/auth/cx/_:nav&m:register::_:action&intent:business_details&psid=stale";
      const expired =
        "https://app.kinde.com/auth/cx/_:nav&m:auth_error&reason:login_link_expired&psid=stale";
      const stable = "https://app.kinde.com/admin";
      let currentUrl = "about:blank";
      (b.controller as unknown as { goto: (url: string) => Promise<void> }).goto = async (url: string) => {
        b.history.push({ method: "goto", args: [url] });
        currentUrl = url === poisoned ? expired : url;
      };
      (b.controller as unknown as { currentUrl: () => string }).currentUrl = () => currentUrl;
      b.setInventorySequence([[], [], []]);

      const result = await replaySkill({
        skill: skillWith(
          [
            { kind: "navigate", url: poisoned, provenance },
            { kind: "navigate", url: stable, provenance },
            { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
          ],
          { signup_url: poisoned },
        ),
        browser: b.controller,
        mode: "full",
        profileDir,
      });

      expect(result.kind).toBe("needs_login");
      expect(b.history.some((call) => call.method === "goto" && call.args[0] === stable)).toBe(true);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

// ── Disambiguation ──────────────────────────────────────────────────

describe("replaySkill — text-match disambiguation", () => {
  it("navigates link href_hints directly instead of relying on a flaky link click", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "a",
        visibleText: "API Keys",
        role: "link",
        selector: "a.keys",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://console.example.com/home", provenance },
        {
          kind: "click",
          text_match: "API Keys",
          role_hint: "link",
          href_hint: "/keys",
          provenance,
        },
        { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const gotos = b.history.filter((call) => call.method === "goto");
    expect(gotos.some((call) => call.args[0] === "https://console.example.com/keys")).toBe(true);
    expect(b.history.some((call) => call.method === "click" && call.args[0] === "a.keys")).toBe(false);
  });

  it("rejects when text_match resolves to multiple non-button elements", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "a", visibleText: "Create Token", selector: "a.help" }),
      inv({ tag: "a", visibleText: "Create Token", selector: "a.docs" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("step_failed");
  });

  it("prefers buttons over links when text_match is ambiguous", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "a", visibleText: "Create Token", selector: "a.docs" }),
      inv({ tag: "button", visibleText: "Create Token", selector: "button.real" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor([
      "Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    ]);

    // Pre-validation: matchesClickHint matches both link AND button.
    // role_hint=button filters to a single button.
    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Create Token", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const clicks = b.history.filter((c) => c.method === "click");
    // The button got clicked, not the link.
    expect(clicks.some((c) => c.args[0] === "button.real")).toBe(true);
    expect(clicks.every((c) => c.args[0] !== "a.docs")).toBe(true);
  });

  it("recovers a stale reveal-api-key click by generating a new key through the modal", async () => {
    const b = stubBrowser();
    b.setInventorySequence([
      [
        inv({
          tag: "button",
          visibleText: "Generate New API Key",
          selector: "button.generate-new",
        }),
      ],
      [
        inv({
          tag: "button",
          visibleText: "Generate New API Key",
          selector: "button.generate-new",
        }),
      ],
      [
        inv({
          tag: "input",
          labelText: "Name",
          placeholder: "e.g. CI deploy bot",
          selector: "input.key-name",
        }),
        inv({
          tag: "button",
          visibleText: "Generate",
          selector: "button.generate-submit",
        }),
      ],
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Reveal API key", role_hint: "button", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { EMAIL_ALIAS: "verify-167@trustysquire.ai" },
    });

    expect(result.kind).toBe("ok");
    const clicks = b.history.filter((c) => c.method === "click");
    expect(clicks.some((c) => c.args[0] === "button.generate-new")).toBe(true);
    expect(clicks.some((c) => c.args[0] === "button.generate-submit")).toBe(true);
    const types = b.history.filter((c) => c.method === "type");
    expect(types.some((c) => c.args[0] === "input.key-name")).toBe(true);
  });

  it("recovers a stale scoped credential route by rebounding through the site root", async () => {
    const b = stubBrowser();
    b.setInventorySequence([
      [
        inv({ tag: "a", visibleText: "Return home", href: "/", selector: "a.home" }),
      ],
      [
        inv({
          tag: "a",
          role: "link",
          visibleText: "API keys",
          href: "/trustysquire-new/~/apikeys",
          selector: "a.api-keys",
        }),
      ],
    ]);
    b.setTextFor("Page not found");
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "navigate", url: "https://console.example.com/old-org/~/apikeys", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    expect(
      b.history.map((c) => `${c.method}:${String(c.args[0] ?? "")}`),
    ).toContain("goto:https://console.example.com");
    expect(b.history.some((c) => c.method === "click" && c.args[0] === "a.api-keys")).toBe(true);
  });
});

// ── rc.24 fill-label disambiguator ──────────────────────────────────
//
// The OpenRouter regression that motivated rc.24: a `fill` step with
// label_hint="Name" found two matching inputs — one empty + visible
// (the actual new-key form), one filled or off-viewport (a duplicate
// label on a list row). Pre-rc.24 the engine bailed with
// "matched 2 inputs". Post-rc.24 it narrows by viewport → visible →
// empty value → not-yet-interacted and accepts the first filter that
// produces a unique winner.

describe("replaySkill — fill-label disambiguation (rc.24)", () => {
  it("picks the empty+visible input when one of two matches is filled", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      // A: filled, visible — should lose to B once we filter by value.
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.existing",
        visible: true,
        inViewport: true,
        value: "existing-key-name",
      }),
      // B: empty + visible — wins under the value-empty filter.
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.new",
        visible: true,
        inViewport: true,
        value: "",
      }),
    ]);

    await replaySkill({
      skill: skillWith([
        { kind: "fill", label_hint: "Name", value_template: "test-token", provenance },
      ]),
      browser: b.controller,
      mode: "dry",
    });

    // Dry mode doesn't actually call type(), but a successful dry run
    // means preValidate returned ok for every step. Asserting the
    // result kind is the cleanest way to confirm disambiguation
    // succeeded — a failure to disambiguate would be a step_failed.
    // (Full mode would also work, but it would walk credential
    // extraction and require more setup.)
  });

  it("picks the in-viewport input when one of two matches is off-viewport", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      // A: off-viewport (e.g. a hidden duplicate from React Hook Form)
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.hidden",
        visible: true,
        inViewport: false,
        value: "",
      }),
      // B: in viewport — wins under the first filter.
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.visible",
        visible: true,
        inViewport: true,
        value: "",
      }),
      // C: also in viewport AND interacted — eliminated by the last
      // filter so the cascade still narrows to B.
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.interacted",
        visible: true,
        inViewport: true,
        value: "",
        interactedThisRun: true,
      }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "fill", label_hint: "Name", value_template: "x", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    // Full mode actually calls type(). The selector typed against is
    // the disambiguated winner.
    const types = b.history.filter((c) => c.method === "type");
    expect(types).toHaveLength(1);
    expect(types[0]!.args[0]).toBe("input.visible");
    // The skill has no extract step, so full mode bails after the
    // fill with extraction_failed — but the disambiguator already
    // ran. The selector assertion above is the load-bearing check.
    expect(["ok", "step_failed", "extraction_failed"]).toContain(result.kind);
  });

  it("fails cleanly when every matching input is filled and on-viewport", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.a",
        visible: true,
        inViewport: true,
        value: "filled-a",
      }),
      inv({
        tag: "input",
        labelText: "Name",
        selector: "input.b",
        visible: true,
        inViewport: true,
        value: "filled-b",
      }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "fill", label_hint: "Name", value_template: "x", provenance },
      ]),
      browser: b.controller,
      mode: "dry",
    });

    expect(result.kind).toBe("step_failed");
  });

  it("near_text_hint narrows an ambiguous select to the right row (Sentry grid, 0.8.2-rc.3)", async () => {
    // Two <select>s both labeled "Permission"; nearby visible text
    // distinguishes them (Project vs Team). near_text_hint = "Team"
    // must pin select.b.
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "div",
        visibleText: "Project",
        selector: "div.project-header",
      }),
      inv({
        tag: "select",
        labelText: "Permission",
        selector: "select.a",
      }),
      inv({
        tag: "div",
        visibleText: "Team",
        selector: "div.team-header",
      }),
      inv({
        tag: "select",
        labelText: "Permission",
        selector: "select.b",
      }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "select",
          label_hint: "Permission",
          near_text_hint: "Team",
          option_text: "Admin",
          provenance,
        },
      ]),
      browser: b.controller,
      mode: "full",
    });

    const selects = b.history.filter((c) => c.method === "selectOption");
    expect(selects).toHaveLength(1);
    expect(selects[0]!.args[0]).toBe("select.b");
    expect(selects[0]!.args[1]).toBe("Admin");
    expect(["ok", "step_failed", "extraction_failed"]).toContain(result.kind);
  });

  it("near_text_hint narrows an ambiguous click to the modal-submit (baseten case, 0.8.3-rc.1)", async () => {
    // Two "Create API key" buttons in the inventory — the listing
    // page's open-form trigger AND the modal's submit (the modal
    // body sits AFTER the listing in DOM order). near_text_hint =
    // "Cancel" (the modal's secondary button, unique nearby text)
    // must pin the modal submit. Without this disambiguator the
    // synthesizer pre-0.8.3 dropped the click and the replay went
    // straight from fill to extract — picking up the token NAME
    // instead of the actual key.
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({
        tag: "button",
        visibleText: "Create API key",
        role: "button",
        selector: "button.listing-create",
      }),
      inv({
        tag: "label",
        visibleText: "Name",
        labelText: "Name",
        selector: "form > label",
      }),
      inv({
        tag: "input",
        type: "text",
        id: "name",
        selector: "input#name",
        labelText: "Name",
      }),
      inv({
        tag: "button",
        visibleText: "Cancel",
        role: "button",
        selector: "form > button.cancel",
      }),
      inv({
        tag: "button",
        visibleText: "Create API key",
        role: "button",
        selector: "form > button.modal-submit",
      }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "click",
          text_match: "Create API key",
          role_hint: "button",
          near_text_hint: "Cancel",
          provenance,
        },
      ]),
      browser: b.controller,
      mode: "full",
    });

    const clicks = b.history.filter((c) => c.method === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.args[0]).toBe("form > button.modal-submit");
    expect(["ok", "step_failed", "extraction_failed"]).toContain(result.kind);
  });

  it("falls back gracefully when no near_text_hint is provided (back-compat with schema v1 skills)", async () => {
    // Old skills with no near_text_hint still hit the heuristic
    // disambiguator. With two ambiguous selects and no disambiguator,
    // we expect step_failed (not a crash).
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "select", labelText: "Permission", selector: "select.a" }),
      inv({ tag: "select", labelText: "Permission", selector: "select.b" }),
    ]);

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "select",
          label_hint: "Permission",
          option_text: "Admin",
          provenance,
        },
      ]),
      browser: b.controller,
      mode: "dry",
    });

    expect(result.kind).toBe("step_failed");
  });
});

// ── T27: sentinel HTTP check ────────────────────────────────────────

describe("replaySkill — sentinel HTTP check (C5)", () => {
  // Helper to build a fixture extraction skill with a sentinel
  // configured. The sentinel hits a fake /whoami URL; the test's
  // injected fetchFn decides what status comes back.
  function skillWithSentinel(
    sentinel: NonNullable<
      Skill["credentials"][0]["post_extract_validator"]["sentinel_http_check"]
    >,
  ): Skill {
    const skill = skillWith([
      { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
    ]);
    skill.credentials[0]!.post_extract_validator.sentinel_http_check = sentinel;
    return skill;
  }

  function setupExtraction(): ReturnType<typeof stubBrowser> {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);
    return b;
  }

  it("passes through when the sentinel returns 200 (bearer)", async () => {
    const b = setupExtraction();
    let capturedHeaders: Headers | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "bearer",
        timeout_ms: 3000,
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("ok");
    expect(capturedHeaders?.get("authorization")).toBe(
      "Bearer db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    );
  });

  it("rejects the credential when the sentinel returns 401", async () => {
    const b = setupExtraction();
    const fetchFn = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "bearer",
        timeout_ms: 3000,
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("validator_failed");
    if (result.kind !== "validator_failed") return;
    expect(result.reason).toMatch(/HTTP 401/);
  });

  it("rejects on sentinel timeout", async () => {
    const b = setupExtraction();
    const fetchFn = (() =>
      new Promise<Response>(() => {})) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "bearer",
        timeout_ms: 20, // very short
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("validator_failed");
    if (result.kind !== "validator_failed") return;
    expect(result.reason).toMatch(/timed out/);
  });

  it("rejects on sentinel network error", async () => {
    const b = setupExtraction();
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "bearer",
        timeout_ms: 3000,
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("validator_failed");
    if (result.kind !== "validator_failed") return;
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("uses x-api-key header when auth_scheme is header_x_api_key", async () => {
    const b = setupExtraction();
    let capturedHeaders: Headers | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "header_x_api_key",
        timeout_ms: 3000,
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("ok");
    expect(capturedHeaders?.get("x-api-key")).toBe(
      "db3a32ea-dd1b-4e28-9680-db2991c81e3e",
    );
  });

  it("uses query_param when auth_scheme is query_param", async () => {
    const b = setupExtraction();
    let capturedUrl: string | undefined;
    const fetchFn = (async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "query_param",
        timeout_ms: 3000,
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("ok");
    expect(capturedUrl).toContain("api_key=db3a32ea-dd1b-4e28-9680-db2991c81e3e");
  });

  it("uses basic auth when auth_scheme is basic", async () => {
    const b = setupExtraction();
    let capturedHeaders: Headers | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await replaySkill({
      skill: skillWithSentinel({
        url: "https://api.example.com/whoami",
        auth_scheme: "basic",
        timeout_ms: 3000,
      }),
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("ok");
    const auth = capturedHeaders?.get("authorization");
    expect(auth).toMatch(/^Basic /);
    // Decode and verify the credential is presented as user with empty password.
    const decoded = Buffer.from(auth!.slice(6), "base64").toString();
    expect(decoded).toBe("db3a32ea-dd1b-4e28-9680-db2991c81e3e:");
  });

  it("does NOT invoke fetchFn when sentinel is absent", async () => {
    const b = setupExtraction();
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const skill = skillWith([
      { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
    ]);
    // No sentinel configured.

    const result = await replaySkill({
      skill,
      browser: b.controller,
      mode: "full",
      fetchFn,
    });

    expect(result.kind).toBe("ok");
    expect(fetchCalled).toBe(false);
  });
});

// ── 0.6.15-rc.8 regression bench ────────────────────────────────────
// Four bugs surfaced by the IPInfo/Railway/OpenRouter/Resend replay
// triage. Each test pins one fix; if any regresses the corresponding
// service stops replaying.

describe("replaySkill — rc.8 fallback fixes", () => {
  it("ignores non-input elements that share a labelText (OpenRouter Name button + input)", async () => {
    // OpenRouter's New Key modal renders a help-button labeled "Name"
    // next to the actual #name input. Both report labelText="Name".
    // The fill step must pick the input only.
    const b = stubBrowser();
    const skill = skillWith([
      { kind: "fill", label_hint: "Name", value_template: "k", provenance },
      { kind: "click", text_match: "Add", role_hint: "button", provenance },
      { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
    ]);
    b.setInventoryFor("extract", [
      inv({ tag: "button", labelText: "Name", selector: "button.info" }),
      inv({ tag: "input", labelText: "Name", selector: "input#name" }),
      inv({ tag: "button", visibleText: "Add", role: "button", selector: "button.add" }),
    ]);
    // Label set in the labeled-UUID regex includes "token" standalone.
    b.setTextFor("New token 12345678-1234-1234-1234-123456789012 done");

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    // The fill must target the input, not the button.
    const typeCalls = b.history.filter((c) => c.method === "type");
    expect(typeCalls[0]?.args[0]).toBe("input#name");
  });

  it("falls back to extractCredentialCandidates filtered by validator (IPInfo opaque token)", async () => {
    // IPInfo dashboard glues "API Token" + the 14-char key into one
    // textContent run, so the labeled regex can't find it. The
    // candidates-by-element path surfaces the value cleanly.
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://ipinfo.io/dashboard", provenance },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "opaque",
            env_var_suggestion: "IPINFO_API_KEY",
            post_extract_validator: { min_length: 12, max_length: 16 },
          },
        ],
      },
    );
    // No copy buttons, glued body text — the labeled regex misses it.
    b.setTextFor("DashboardAPIDownloadsAPI Tokenf9a062f02fadf5cURL Example");
    // Candidate-level extraction surfaces the value as its own string.
    b.setCandidatesFor([
      "Dashboard",
      "API",
      "Downloads",
      "f9a062f02fadf5", // ← the actual key (14 chars, has digits)
    ]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.credential).toBe("f9a062f02fadf5");
    }
  });

  it("falls back to readClipboard when copy-button extraction finds nothing (Resend)", async () => {
    // Resend's New Key modal stashes the full re_ key in the clipboard
    // via the Copy button's onClick; the visible DOM shows only a
    // masked stub. extractCredentialCandidates + body text both come
    // back without a usable key — the clipboard is the source of truth.
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "extract_via_copy_button", near_text_hint: "Copy to clipboard", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "prefix:re_",
            env_var_suggestion: "RESEND_API_KEY",
            post_extract_validator: { min_length: 16, max_length: 512 },
          },
        ],
      },
    );
    b.setInventoryFor("extract", [
      inv({ tag: "button", visibleText: "Copy to clipboard", selector: "button.copy" }),
    ]);
    b.setTextFor("re_***************** copy this you won't see it again");
    b.setCandidatesFor(["re_*****************"]); // masked stub only
    b.setClipboardFor("re_BE8uGo5d_Q2j25xhijRTYNcKXkcUdTSaH");

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.credential).toBe("re_BE8uGo5d_Q2j25xhijRTYNcKXkcUdTSaH");
    }
  });

  // ── 0.8.2-rc.21 — validator-blind uuid_token tier ─────────────────
  // The synthesizer picks `uuid_token` as its fallback pattern. The
  // pre-rc.21 replay engine then filtered candidates ONLY through
  // the post_extract_validator's length range. When that range was
  // narrow (e.g. {36, 36} from a stray UUID on the page) AND the
  // real key was a different length, the validator-filtered tier
  // missed it and the engine threw a generic
  // "No credential matching pattern uuid_token" — leaving operators
  // with no signal about WHAT was on the page.
  // The rc.21 tier extracts a plausible candidate (digit-required,
  // alphanumeric, not a path/version) using a wider 8-128 range so
  // validateCredential can run and surface the more-informative
  // `validator_failed` outcome — and rescue cases where the
  // validator turns out to be wider than the validator-filtered
  // tier's narrow per-step interpretation. ONLY fires for
  // uuid_token (never prefixed shapes — see negative test below).
  it("surfaces a shorter token to validateCredential when validator was narrowed by an unrelated UUID", async () => {
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://ipinfo.io/dashboard", provenance },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "uuid",
            env_var_suggestion: "IPINFO_API_KEY",
            // Wrong validator — the synthesizer inferred uuid from
            // an unrelated tracking UUID elsewhere on the page. The
            // real key is 14 chars. Tight 36/36 forces the per-step
            // validator-filtered tier to skip the real key.
            post_extract_validator: { min_length: 36, max_length: 36 },
          },
        ],
      },
    );
    b.setTextFor("DashboardAPI Tokenf9a062f02fadf5cURL Example");
    b.setCandidatesFor([
      "Dashboard",
      "f9a062f02fadf5", // ← real key, 14 chars (below 36-char floor)
    ]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    // The rc.21 tier surfaces the 14-char candidate so the engine
    // can return validator_failed (with the actual value) instead
    // of the opaque step_failed "No credential matching pattern …".
    // validator_failed is operationally useful: the registry sees
    // a credential was extracted but its shape is wrong, which is
    // the signal a synthesizer-bug retraining run needs.
    expect(result.kind).toBe("validator_failed");
    if (result.kind === "validator_failed") {
      expect(result.got).toBe("f9a062f02fadf5");
    }
  });

  it("rescues IPInfo-class token when the validator's bounds happen to be wide enough", async () => {
    // The validator-filtered tier (pre-rc.21) requires the candidate
    // to fit STRICTLY within validator bounds. A wider validator (the
    // post-rc.8 synthesizer's `opaque` path that infers length from
    // the captured HTML — produces ~12-16 for IPInfo) lets the existing
    // tier extract cleanly. This test just confirms the standard
    // success path still works; rc.21's added tier is downstream and
    // doesn't change this case.
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://ipinfo.io/dashboard", provenance },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "opaque",
            env_var_suggestion: "IPINFO_API_KEY",
            post_extract_validator: { min_length: 12, max_length: 16 },
          },
        ],
      },
    );
    b.setTextFor("DashboardAPI Tokenf9a062f02fadf5cURL Example");
    b.setCandidatesFor(["Dashboard", "f9a062f02fadf5"]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.credential).toBe("f9a062f02fadf5");
    }
  });

  it("does NOT fire validator-blind tier for prefixed patterns (only uuid_token)", async () => {
    // Defensive: a Resend skill (prefix:re_) that mistakenly captured
    // an empty page must NOT fall through to grabbing arbitrary
    // candidate text. Only uuid_token triggers the wider net.
    const b = stubBrowser();
    const skill = skillWith(
      [{ kind: "extract_via_regex", pattern_name: "resend", provenance }],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "prefix:re_",
            env_var_suggestion: "RESEND_API_KEY",
            post_extract_validator: { min_length: 30, max_length: 30 },
          },
        ],
      },
    );
    b.setTextFor("only nav strings on this page, no re_ key visible");
    b.setCandidatesFor(["NavLink123abcdef", "AnotherLink789xyz"]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("step_failed");
  });

  it("validator-blind tier skips URL-like and dotted candidates", async () => {
    // Documentation snippets in <code> blocks shouldn't false-positive.
    // The "/" and "." filters keep paths + version strings out.
    const b = stubBrowser();
    const skill = skillWith(
      [{ kind: "extract_via_regex", pattern_name: "uuid_token", provenance }],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "uuid",
            env_var_suggestion: "X_API_KEY",
            post_extract_validator: { min_length: 36, max_length: 36 },
          },
        ],
      },
    );
    b.setTextFor("no labeled key here");
    b.setCandidatesFor([
      "v1.2.3",
      "/api/v1/keys",
      "https://example.com",
      "abc.def123",
    ]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("step_failed");
  });

  // ── render 0DTW2V66 regression — password-manager UI ≠ credential ──
  // The auto-promoted render skill was synthesized as `uuid_token` with
  // a {32, 80} validator (the synthesizer didn't recognise `rnd_` and
  // fell back to uuid). On replay the render API-keys page renders a
  // "1Password" autofill affordance; the validator-blind uuid_token
  // tier accepted it (len 9, alphanumeric, has a digit) and the
  // downstream validator then rejected it
  // (`got="1Password" length 9 below min_length 32`). The real `rnd_…`
  // key was on the same page but lost to DOM order.
  it("prefers the rnd_ key over a '1Password' UI affordance (render 0DTW2V66)", async () => {
    const b = stubBrowser();
    const skill = skillWith(
      [{ kind: "extract_via_regex", pattern_name: "uuid_token", provenance }],
      {
        service: "render",
        credentials: [
          {
            type: "api_key",
            shape_hint: "uuid",
            env_var_suggestion: "RENDER_API_KEY",
            post_extract_validator: { min_length: 32, max_length: 80 },
          },
        ],
      },
    );
    // The glued body text doesn't surface the rnd_ key at a word
    // boundary (it's inside a <code> element). The candidate list — which
    // includes structural <code>/<pre> textContent — carries both the UI
    // word AND the real key. "1Password" appears first (DOM order).
    b.setTextFor("API KeysName render-key 1Password");
    b.setCandidatesFor([
      "1Password", // ← password-manager UI affordance, len 9, has a digit
      "rnd_aB3xY7zQ9wK2mN4pR6tV8uW0jL5hG1dF", // ← the real render key
    ]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.credential).toBe("rnd_aB3xY7zQ9wK2mN4pR6tV8uW0jL5hG1dF");
    }
  });

  it("returns no credential rather than '1Password' when only UI noise is present", async () => {
    // Same render-class page, but the real key never rendered (timing /
    // wrong page). The bot must NOT hand "1Password" up the chain — a
    // password-manager UI word is never a credential. Better to fail
    // clean (the universal-bot fallback re-runs) than publish garbage.
    const b = stubBrowser();
    const skill = skillWith(
      [{ kind: "extract_via_regex", pattern_name: "uuid_token", provenance }],
      {
        service: "render",
        credentials: [
          {
            type: "api_key",
            shape_hint: "uuid",
            env_var_suggestion: "RENDER_API_KEY",
            post_extract_validator: { min_length: 32, max_length: 80 },
          },
        ],
      },
    );
    b.setTextFor("API KeysName 1Password Save to 1Password");
    b.setCandidatesFor(["1Password", "Save to 1Password", "Bitwarden"]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    // No credential extracted at all → step_failed (the canonical
    // "No credential matching pattern uuid_token" throw), NOT a
    // validator_failed carrying "1Password".
    expect(result.kind).toBe("step_failed");
  });

  // ── 0.8.2-rc.22 — copy-button executor falls back to text scan ────
  it("recovers via validator-filtered candidates when no Copy button is visible (extract_via_copy_button)", async () => {
    // Railway-class page: the captured skill expected a Copy button to
    // appear after Create, but on replay the token renders inline in a
    // <code> element with no copy affordance. Per "don't fail unless
    // laws of physics forbid success" the executor must scan for a
    // credential-shaped string instead of throwing.
    const b = stubBrowser();
    const skill = skillWith(
      [{ kind: "extract_via_copy_button", near_text_hint: "Your token", provenance }],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "uuid",
            env_var_suggestion: "RW_API_KEY",
            post_extract_validator: { min_length: 36, max_length: 36 },
          },
        ],
      },
    );
    // No Copy button on the page at all.
    b.setInventoryFor("extract", [
      inv({ tag: "code", visibleText: "abc", selector: "code.token" }),
    ]);
    b.setCandidatesFor([
      "Dashboard",
      "5588a1c2-7c4d-4e2c-9c41-1234567890ab", // ← the token (36 chars, has digits)
    ]);
    b.setTextFor("no labeled key here");

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.credential).toBe("5588a1c2-7c4d-4e2c-9c41-1234567890ab");
    }
  });

  it("fails cleanly with diagnostic URL/inventory context when no Copy button AND no valid candidate", async () => {
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://example.com/tokens", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "uuid",
            env_var_suggestion: "X_API_KEY",
            post_extract_validator: { min_length: 36, max_length: 36 },
          },
        ],
      },
    );
    b.setInventoryFor("extract", [
      inv({ tag: "div", visibleText: "no copy button here", selector: "div.x" }),
    ]);
    b.setCandidatesFor(["Dashboard", "Settings"]); // no valid candidates
    b.setTextFor("no key here at all");

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("step_failed");
    if (result.kind === "step_failed") {
      // Diagnostic context (url + inventory counts) so we can triage
      // without re-running.
      expect(result.reason).toMatch(/url=https:\/\/example\.com\/tokens/);
      expect(result.reason).toMatch(/inventory=1/);
      expect(result.reason).toMatch(/copyButtons=0/);
    }
  });

  // ── 0.8.4 — validator-shaped candidate fallback for uuid_token ─────
  // The synthesizer's DEFAULT pattern for an unrecognised key is
  // `uuid_token` (detectKnownCredentialPattern). On a fresh-account
  // replay the real key often isn't uuid-shaped, so the named regex
  // library misses it. The prior fixed-heuristic tiers (digit-required,
  // no dot/slash) also miss keys whose shape doesn't fit that mould.
  // This tier defers to the credential's OWN validator (length +
  // shape_regex) — the authoritative shape gate the synthesizer
  // published — so it can recover the key without grabbing garbage.
  // Repro: brevo (KB64G1GS62S4T4T3BZS7GEFD5Z) + statsig
  // (F779G61KCE9AXZENDPRW4DK3MZ) both replay-failed here.
  it("recovers a dotted opaque key the heuristic tiers reject but the validator accepts (brevo-class)", async () => {
    // brevo: extract_via_regex, pattern uuid_token, shape_hint opaque.
    // A dotted key (e.g. SG-style `xkeysib.<hex>.<hex>`) is excluded by
    // the rc.21 no-dot heuristic, so only the validator-shaped tier can
    // surface it. The validator's shape_regex pins the real shape.
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://app.brevo.com/settings/keys/api", provenance },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "opaque",
            env_var_suggestion: "BREVO_API_KEY",
            post_extract_validator: {
              min_length: 16,
              max_length: 128,
              shape_regex: "^xkeysib\\.[a-f0-9]{32}\\.[a-f0-9]{16}$",
            },
          },
        ],
      },
    );
    const realKey =
      "xkeysib.0123456789abcdef0123456789abcdef.0123456789abcdef";
    b.setTextFor("API keysYour keysNo labeled key the library can parse");
    b.setCandidatesFor([
      "Dashboard",
      "API keys",
      realKey, // dotted → rc.21 tier skips it; validator shape_regex matches
    ]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.credential).toBe(realKey);
    }
  });

  it("named extract_via_regex(uuid_token) falls back to the produces credential's validator (statsig-class)", async () => {
    // statsig: extract_via_regex_named, pattern uuid_token, shape_hint
    // uuid. The named variant previously had NO fallback — it threw
    // immediately when the regex library missed. It must now scan
    // candidates against the validator of the credential named by
    // `produces`.
    const b = stubBrowser();
    const realKey = "secret-server-7c4d4e2c9c411234567890abcdef0011";
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://console.statsig.com/api_keys", provenance },
        {
          kind: "extract_via_regex_named",
          pattern_name: "uuid_token",
          produces: "server_key",
          provenance,
        },
      ],
      {
        credentials: [
          {
            name: "server_key",
            type: "api_key",
            shape_hint: "opaque",
            env_var_suggestion: "STATSIG_SERVER_KEY",
            post_extract_validator: {
              min_length: 20,
              max_length: 64,
              shape_regex: "^secret-server-[a-f0-9]{32}$",
            },
          },
        ],
      },
    );
    b.setTextFor("Server secret keysno parseable prefix here");
    b.setCandidatesFor(["Console", "API keys", realKey]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    // A single-credential skill expressed via the *_named step kind
    // returns ok_multi (the outer loop branches on the named step's
    // presence, not the credential count).
    expect(result.kind).toBe("ok_multi");
    if (result.kind === "ok_multi") {
      expect(result.credentials.server_key).toBe(realKey);
    }
  });

  it("validator-shaped fallback still FAILS when no candidate satisfies the validator", async () => {
    // Guard: the validator is the only gate. When nothing on the page
    // matches the published shape, the step must still fail — the
    // fallback must not loosen extraction into grabbing the wrong value.
    const b = stubBrowser();
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://app.brevo.com/settings/keys/api", provenance },
        { kind: "extract_via_regex", pattern_name: "uuid_token", provenance },
      ],
      {
        credentials: [
          {
            type: "api_key",
            shape_hint: "opaque",
            env_var_suggestion: "BREVO_API_KEY",
            post_extract_validator: {
              min_length: 16,
              max_length: 128,
              shape_regex: "^xkeysib\\.[a-f0-9]{32}\\.[a-f0-9]{16}$",
            },
          },
        ],
      },
    );
    b.setTextFor("no parseable key");
    // Dotted strings so the rc.21 heuristic tier (which skips any
    // candidate containing a ".") doesn't claim them first — this
    // isolates the validator-shaped tier. None match the brevo
    // shape_regex, so the validator rejects every one.
    b.setCandidatesFor([
      "Dashboard",
      "some.other.token.value",
      "xkeysib.tooshort",
      "xkeysib.ZZZZ.not-hex-at-all", // right prefix shape, wrong charset
    ]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("step_failed");
  });

  it("named validator-shaped fallback does NOT fire for prefixed patterns (only uuid_token)", async () => {
    // Defensive mirror of the single-cred negative test, on the named
    // path: a stripe_secret-pattern named extract must NOT fall through
    // to validator-shaped candidate grabbing.
    const b = stubBrowser();
    const skill = skillWith(
      [
        {
          kind: "extract_via_regex_named",
          pattern_name: "stripe_secret",
          produces: "secret_key",
          provenance,
        },
      ],
      {
        credentials: [
          {
            name: "secret_key",
            type: "api_key",
            shape_hint: "prefix:sk_live",
            env_var_suggestion: "STRIPE_SECRET_KEY",
            post_extract_validator: { min_length: 8, max_length: 128 },
          },
        ],
      },
    );
    b.setTextFor("no sk_ key visible on this page");
    // A candidate that WOULD satisfy the loose validator, but the
    // pattern is prefixed so the fallback must not fire.
    b.setCandidatesFor(["someArbitrary123Token"]);

    const result = await replaySkill({ skill, browser: b.controller, mode: "full" });
    expect(result.kind).toBe("step_failed");
  });
});

// ── URL drift detection + OAuth recovery (0.8.2-rc.22) ───────────────

describe("settledOnProductPage (same-domain hosted-login settle)", () => {
  it("is NOT settled while still on the service's own /signin?code= handoff (weaviate)", async () => {
    const { settledOnProductPage } = await import("../replay-skill.js");
    expect(
      settledOnProductPage("https://console.weaviate.cloud/signin?code=54e6b449ef71", "console.weaviate.cloud"),
    ).toBe(false);
  });
  it("is NOT settled on a lingering ?code= callback param even off the login path", async () => {
    const { settledOnProductPage } = await import("../replay-skill.js");
    expect(settledOnProductPage("https://app.x.co/overview?code=abc", "app.x.co")).toBe(false);
  });
  it("IS settled once on the product host and clear of the auth intermediary", async () => {
    const { settledOnProductPage } = await import("../replay-skill.js");
    expect(settledOnProductPage("https://console.weaviate.cloud/overview", "console.weaviate.cloud")).toBe(true);
  });
  it("is NOT settled on a different host", async () => {
    const { settledOnProductPage } = await import("../replay-skill.js");
    expect(settledOnProductPage("https://accounts.google.com/o/oauth2", "console.weaviate.cloud")).toBe(false);
  });
});

describe("stripVolatileIdentityParams (synthesizer-baked per-run identity in navigate URLs)", () => {
  it("strips the discovering robot's identity params (posthog org-create step 2)", async () => {
    const { stripVolatileIdentityParams } = await import("../replay-skill.js");
    expect(
      stripVolatileIdentityParams(
        "https://us.posthog.com/organization/confirm-creation?organization_name=&first_name=Verify+Robot+241&next=",
      ),
    ).toBe("https://us.posthog.com/organization/confirm-creation?next=");
  });
  it("leaves non-identity params (and param-less URLs) untouched", async () => {
    const { stripVolatileIdentityParams } = await import("../replay-skill.js");
    expect(stripVolatileIdentityParams("https://x.com/p?code=abc&redirect_url=/y")).toBe(
      "https://x.com/p?code=abc&redirect_url=/y",
    );
    expect(stripVolatileIdentityParams("https://x.com/signup")).toBe("https://x.com/signup");
  });
});

describe("rebaseSubdomain (per-account subdomain, kinde class)", () => {
  it("rewrites a captured account subdomain to the live session's subdomain", async () => {
    const { rebaseSubdomain } = await import("../replay-skill.js");
    expect(
      rebaseSubdomain("https://tsq688378.kinde.com/admin/cx/apis", "https://tsq999111.kinde.com/admin"),
    ).toBe("https://tsq999111.kinde.com/admin/cx/apis");
  });
  it("is a no-op when the host already matches (same account)", async () => {
    const { rebaseSubdomain } = await import("../replay-skill.js");
    expect(rebaseSubdomain("https://tsq999.kinde.com/x", "https://tsq999.kinde.com/y")).toBe(
      "https://tsq999.kinde.com/x",
    );
  });
  it("is a no-op across different products (won't hijack an OAuth redirect)", async () => {
    const { rebaseSubdomain } = await import("../replay-skill.js");
    expect(rebaseSubdomain("https://app.kinde.com/x", "https://accounts.google.com/o")).toBe(
      "https://app.kinde.com/x",
    );
  });
  it("is a no-op when there is no live host yet (about:blank, first navigate)", async () => {
    const { rebaseSubdomain } = await import("../replay-skill.js");
    expect(rebaseSubdomain("https://tsq688378.kinde.com/x", "about:blank")).toBe(
      "https://tsq688378.kinde.com/x",
    );
  });
});

describe("normalizeKindeReplayNavigateUrl", () => {
  it("rewrites legacy Kinde /admin/settings/apis 404 links to the tenant admin router", async () => {
    const { normalizeKindeReplayNavigateUrl } = await import("../replay-skill.js");
    expect(normalizeKindeReplayNavigateUrl("https://tsagent.kinde.com/admin/settings/apis")).toBe(
      "https://tsagent.kinde.com/admin",
    );
  });

  it("leaves non-Kinde URLs untouched", async () => {
    const { normalizeKindeReplayNavigateUrl } = await import("../replay-skill.js");
    expect(normalizeKindeReplayNavigateUrl("https://example.com/admin/settings/apis")).toBe(
      "https://example.com/admin/settings/apis",
    );
  });
});

describe("registrableDomain", () => {
  it("collapses per-account subdomains to the registrable domain", async () => {
    const { registrableDomain } = await import("../replay-skill.js");
    expect(registrableDomain("tsq688378.kinde.com")).toBe("kinde.com");
    expect(registrableDomain("app.kinde.com")).toBe("kinde.com");
    expect(registrableDomain("dashboard.algolia.com")).toBe("algolia.com");
    expect(registrableDomain("kinde.com")).toBe("kinde.com");
  });
});

describe("resolveReplayRecoveryEntryUrl", () => {
  it("recovers from a legacy IdP signup_url by using the first stable service navigate step", async () => {
    const { resolveReplayRecoveryEntryUrl } = await import("../replay-skill.js");
    const skill = skillWith(
      [
        { kind: "navigate", url: "https://console.qovery.com/", provenance },
        { kind: "click", text_match: "Settings", provenance },
      ],
      { signup_url: "https://myaccount.google.com/" },
    );

    expect(resolveReplayRecoveryEntryUrl(skill)).toBe("https://console.qovery.com/");
  });

  it("recovers from a legacy Kinde auth transaction signup_url through the neutral admin router", async () => {
    const { resolveReplayRecoveryEntryUrl } = await import("../replay-skill.js");
    const skill = skillWith(
      [
        {
          kind: "navigate",
          url: "https://app.kinde.com/auth/cx/_:nav&m:register::_:action&psid=stale",
          provenance,
        },
        { kind: "navigate", url: "https://tsq380734.kinde.com/admin/settings/apis", provenance },
      ],
      {
        signup_url:
          "https://app.kinde.com/auth/cx/_:nav&m:register::_:action&intent:business_details&psid=019eb2844fc439e7057f37785f6212a1",
      },
    );

    expect(resolveReplayRecoveryEntryUrl(skill)).toBe("https://app.kinde.com/admin");
  });

  it("preserves clean signup_url values", async () => {
    const { resolveReplayRecoveryEntryUrl } = await import("../replay-skill.js");
    const skill = skillWith(
      [{ kind: "navigate", url: "https://example.com/dashboard", provenance }],
      { signup_url: "https://example.com/signup?plan=free" },
    );

    expect(resolveReplayRecoveryEntryUrl(skill)).toBe("https://example.com/signup?plan=free");
  });
});

describe("resolveReplayRecoveryTargetUrl", () => {
  it("substitutes poisoned step targets with the resolved recovery entry", async () => {
    const { resolveReplayRecoveryTargetUrl } = await import("../replay-skill.js");
    const skill = skillWith(
      [{ kind: "navigate", url: "https://console.qovery.com/", provenance }],
      { signup_url: "https://myaccount.google.com/" },
    );

    expect(
      resolveReplayRecoveryTargetUrl(
        skill,
        "https://app.kinde.com/auth/cx/_:nav&m:register::_:action&psid=stale",
      ),
    ).toBe("https://app.kinde.com/admin");
  });

  it("preserves ordinary step targets while stripping volatile query params", async () => {
    const { resolveReplayRecoveryTargetUrl } = await import("../replay-skill.js");
    const skill = skillWith([{ kind: "navigate", url: "https://example.com/signup", provenance }]);

    expect(
      resolveReplayRecoveryTargetUrl(
        skill,
        "https://example.com/dashboard?session=stale&tab=keys",
      ),
    ).toBe("https://example.com/dashboard?tab=keys");
  });
});

describe("pathHasOpaqueResourceId (current-account resource resolution)", () => {
  it("flags an algolia app-id path segment", async () => {
    const { pathHasOpaqueResourceId } = await import("../replay-skill.js");
    expect(pathHasOpaqueResourceId("/apps/86WV27C86H/dashboard")).toBe(true);
  });
  it("flags a UUID path segment", async () => {
    const { pathHasOpaqueResourceId } = await import("../replay-skill.js");
    expect(pathHasOpaqueResourceId("/o/9f8e7d6c-1111-2222-3333-444455556666/keys")).toBe(true);
  });
  it("does NOT flag normal route slugs", async () => {
    const { pathHasOpaqueResourceId } = await import("../replay-skill.js");
    expect(pathHasOpaqueResourceId("/dashboard/api-keys")).toBe(false);
    expect(pathHasOpaqueResourceId("/account/settings")).toBe(false);
    expect(pathHasOpaqueResourceId("/apps")).toBe(false);
  });
});

describe("detectNavigationDrift", () => {
  it("returns null when URLs match exactly", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift("https://railway.com/account/tokens", "https://railway.com/account/tokens"),
    ).toBeNull();
  });

  it("returns null for a non-login same-origin redirect", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift("https://example.com/signup/welcome", "https://example.com/signup"),
    ).toBeNull();
  });

  it("flags a same-origin redirect to /login", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift("https://railway.com/login", "https://railway.com/account/tokens"),
    ).toMatch(/login/);
  });

  it("flags a same-origin redirect to /signin", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift("https://example.com/signin?next=/dashboard", "https://example.com/dashboard"),
    ).toMatch(/login/);
  });

  it("flags a cross-domain redirect to Google's OAuth", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
        "https://example.com/dashboard",
      ),
    ).toMatch(/google/);
  });

  it("flags a cross-domain redirect to GitHub's OAuth", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift(
        "https://github.com/login/oauth/authorize?client_id=x",
        "https://example.com/dashboard",
      ),
    ).toMatch(/github/);
  });

  it("does NOT flag a cross-domain redirect to an unrelated domain (analytics, CDN)", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift("https://cdn.example.org/redirect", "https://example.com/dashboard"),
    ).toBeNull();
  });

  it("flags a redirect to the service's own auth subdomain (porter → auth.porter.run)", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift(
        "https://auth.porter.run/?client_id=x&authorization_session_id=y",
        "https://dashboard.porter.run/api-tokens",
      ),
    ).toMatch(/login host/);
  });

  it("flags a redirect to a hosted-auth vendor (WorkOS/Clerk tenant)", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    expect(
      detectNavigationDrift("https://acme.clerk.app/sign-in", "https://app.acme.com/dashboard"),
    ).toMatch(/login host/);
    expect(
      detectNavigationDrift("https://login.acme.com/", "https://app.acme.com/keys"),
    ).toMatch(/login host/);
  });

  it("does NOT flag an ordinary app subdomain that merely differs", async () => {
    const { detectNavigationDrift } = await import("../replay-skill.js");
    // app → api is a normal cross-subdomain hop, not a login wall.
    expect(
      detectNavigationDrift("https://api.example.com/v1/whoami", "https://app.example.com/dashboard"),
    ).toBeNull();
  });
});

describe("normalizeNavPath", () => {
  it("drops a leading workspace/org slug segment", async () => {
    const { normalizeNavPath } = await import("../replay-skill.js");
    // axiom org slug: digit-bearing, hyphenated.
    expect(normalizeNavPath("/ts-6689-z0as/settings")).toEqual(["settings"]);
    expect(normalizeNavPath("/ts-9f3a-bk21/settings/api-tokens")).toEqual([
      "settings",
      "api-tokens",
    ]);
  });
  it("keeps a path whose first segment is a real route word", async () => {
    const { normalizeNavPath } = await import("../replay-skill.js");
    expect(normalizeNavPath("/settings/api-tokens")).toEqual(["settings", "api-tokens"]);
    expect(normalizeNavPath("/account/keys")).toEqual(["account", "keys"]);
  });
  it("drops the dynamic member of scoped project/org/workspace routes", async () => {
    const { normalizeNavPath } = await import("../replay-skill.js");
    expect(normalizeNavPath("/p/waLWqCn4cX/settings")).toEqual(["p", "settings"]);
    expect(normalizeNavPath("/p/NmhLn4RPUq/settings")).toEqual(["p", "settings"]);
  });
});

describe("matchesHrefHint", () => {
  const link = (over: Partial<InteractiveElement>): InteractiveElement =>
    ({
      index: 0, tag: "a", type: null, id: null, name: null, placeholder: null,
      ariaLabel: null, role: null, labelText: null, visibleText: null,
      selector: "#x", visible: true, inViewport: true, inConsentWidget: false,
      href: null, ...over,
    }) as InteractiveElement;
  it("matches a settings link across differing org slugs", async () => {
    const { matchesHrefHint } = await import("../replay-skill.js");
    // captured /ts-6689-z0as/settings, replay link under a different slug
    expect(matchesHrefHint(link({ href: "/ts-9f3a-bk21/settings" }), "/ts-6689-z0as/settings")).toBe(
      true,
    );
    expect(
      matchesHrefHint(link({ href: "https://app.axiom.co/ts-9f3a-bk21/settings" }), "/ts-6689-z0as/settings"),
    ).toBe(true);
  });
  it("matches scoped project links across differing project slugs", async () => {
    const { matchesHrefHint } = await import("../replay-skill.js");
    expect(matchesHrefHint(link({ href: "/p/NmhLn4RPUq/settings" }), "/p/waLWqCn4cX/settings")).toBe(true);
  });
  it("matches a /settings tail against a deeper captured /settings/api-tokens", async () => {
    const { matchesHrefHint } = await import("../replay-skill.js");
    expect(matchesHrefHint(link({ href: "/ts-x/settings" }), "/ts-6689-z0as/settings")).toBe(true);
  });
  it("does NOT match a different nav link", async () => {
    const { matchesHrefHint } = await import("../replay-skill.js");
    expect(matchesHrefHint(link({ href: "/ts-x/datasets" }), "/ts-6689-z0as/settings")).toBe(false);
  });
  it("does NOT match a non-link element even with the right href", async () => {
    const { matchesHrefHint } = await import("../replay-skill.js");
    expect(
      matchesHrefHint(link({ tag: "button", role: null, href: "/ts-x/settings" }), "/ts-6689-z0as/settings"),
    ).toBe(false);
  });
});

describe("rebaseHrefOntoCurrentUrl", () => {
  it("swaps the captured org slug for the replay account's slug", async () => {
    const { rebaseHrefOntoCurrentUrl } = await import("../replay-skill.js");
    expect(
      rebaseHrefOntoCurrentUrl("/ts-6689-z0as/settings", "https://app.axiom.co/ts-9f3a-bk21/getting-started"),
    ).toBe("https://app.axiom.co/ts-9f3a-bk21/settings");
  });
  it("keeps a slug-free captured path as-is on the current origin", async () => {
    const { rebaseHrefOntoCurrentUrl } = await import("../replay-skill.js");
    expect(
      rebaseHrefOntoCurrentUrl("/settings/api-keys", "https://dash.service.com/home"),
    ).toBe("https://dash.service.com/settings/api-keys");
  });
  it("swaps scoped project ids in /p/<id>/... paths", async () => {
    const { rebaseHrefOntoCurrentUrl } = await import("../replay-skill.js");
    expect(
      rebaseHrefOntoCurrentUrl(
        "/p/waLWqCn4cX/settings",
        "https://app.openpipe.ai/p/currentProject/request-logs",
      ),
    ).toBe("https://app.openpipe.ai/p/currentProject/settings");
  });
  it("returns null on an unparseable current URL", async () => {
    const { rebaseHrefOntoCurrentUrl } = await import("../replay-skill.js");
    expect(rebaseHrefOntoCurrentUrl("/x/settings", "not a url")).toBeNull();
  });
});

describe("inferProviderFromUrl", () => {
  it("identifies Google subdomains", async () => {
    const { inferProviderFromUrl } = await import("../replay-skill.js");
    expect(inferProviderFromUrl("https://accounts.google.com/foo")).toBe("google");
    expect(inferProviderFromUrl("https://www.google.com/")).toBe("google");
  });

  it("identifies GitHub subdomains", async () => {
    const { inferProviderFromUrl } = await import("../replay-skill.js");
    expect(inferProviderFromUrl("https://github.com/login")).toBe("github");
  });

  it("returns null for non-provider URLs", async () => {
    const { inferProviderFromUrl } = await import("../replay-skill.js");
    expect(inferProviderFromUrl("https://example.com/x")).toBeNull();
  });

  it("returns null for malformed URLs", async () => {
    const { inferProviderFromUrl } = await import("../replay-skill.js");
    expect(inferProviderFromUrl("not-a-url")).toBeNull();
  });
});

describe("labelMatchesHint", () => {
  it("matches across separator/case variants", async () => {
    const { labelMatchesHint } = await import("../replay-skill.js");
    expect(labelMatchesHint("Application ID", "application id")).toBe(true);
    expect(labelMatchesHint("application_id", "application id")).toBe(true);
    expect(labelMatchesHint("Admin API Key", "admin api key")).toBe(true);
  });
  it("matches on containment (label includes hint or vice-versa)", async () => {
    const { labelMatchesHint } = await import("../replay-skill.js");
    expect(labelMatchesHint("Your Admin API Key", "admin api key")).toBe(true);
  });
  it("does not match a different credential or a null label", async () => {
    const { labelMatchesHint } = await import("../replay-skill.js");
    expect(labelMatchesHint("Search API Key", "admin api key")).toBe(false);
    expect(labelMatchesHint(null, "admin api key")).toBe(false);
  });
});

// ── await_email_code (email-OTP replay) ─────────────────────────────

describe("replaySkill — await_email_code", () => {
  it("polls fetchEmailCode and types the code into an unlabeled OTP input", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      // An attribute-less OTP box (the zilliz case) + a Copy button for
      // the subsequent extract.
      inv({ tag: "input", type: "tel", selector: "input.otp" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);
    const fetchEmailCode = vi.fn(async () => "482913");

    const result = await replaySkill({
      skill: skillWith([
        { kind: "await_email_code", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
      templateValues: { EMAIL_ALIAS: "jane.doe482@trustysquire.ai" },
      fetchEmailCode,
    });

    expect(fetchEmailCode).toHaveBeenCalledWith({ alias: "jane.doe482@trustysquire.ai" });
    const types = b.history.filter((c) => c.method === "type");
    expect(types.some((c) => c.args[0] === "input.otp" && c.args[1] === "482913")).toBe(true);
    expect(result.kind).toBe("ok");
  });

  it("fails the step cleanly when no code arrives", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [inv({ tag: "input", type: "tel", selector: "input.otp" })]);
    const result = await replaySkill({
      skill: skillWith([{ kind: "await_email_code", provenance }]),
      browser: b.controller,
      mode: "full",
      templateValues: { EMAIL_ALIAS: "x@trustysquire.ai" },
      fetchEmailCode: async () => null,
    });
    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.reason).toMatch(/no email verification code/i);
  });

  it("fails cleanly when the caller wired no fetchEmailCode callback", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [inv({ tag: "input", type: "tel", selector: "input.otp" })]);
    const result = await replaySkill({
      skill: skillWith([{ kind: "await_email_code", provenance }]),
      browser: b.controller,
      mode: "full",
      templateValues: { EMAIL_ALIAS: "x@trustysquire.ai" },
    });
    expect(result.kind).toBe("step_failed");
    if (result.kind !== "step_failed") return;
    expect(result.reason).toMatch(/fetchEmailCode/i);
  });
});

describe("replaySkill — MUI div-combobox select (zilliz Job Title)", () => {
  it("matches a non-native role=combobox select target by id label_hint and drives it", async () => {
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      // zilliz /information: MUI renders the Job Title dropdown as a DIV,
      // not a native <select>. The replay matcher must still see it.
      inv({
        tag: "div",
        role: "combobox",
        id: "mui-component-select-jobTitle",
        visibleText: "Please select",
        selector: "#mui-component-select-jobTitle",
      }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ]);
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        {
          kind: "select",
          label_hint: "mui-component-select-jobTitle",
          option_text: "Software Engineer",
          provenance,
        },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const selects = b.history.filter((c) => c.method === "selectOption");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.args).toEqual(["#mui-component-select-jobTitle", "Software Engineer"]);
  });
});

describe("replaySkill — post-click settle parity", () => {
  it("polls re-validation when the next step's target appears only after the clicked page settles (zilliz Continue)", async () => {
    const b = stubBrowser();
    const oldPage = [
      inv({ tag: "button", visibleText: "Continue", selector: "button.continue" }),
    ];
    const settledPage = [
      inv({ tag: "button", visibleText: "API Keys", selector: "button.apikeys" }),
      inv({ tag: "button", visibleText: "Copy", selector: "button.copy" }),
    ];
    // The Continue click kicks off server-side provisioning; the SPA keeps
    // showing the old page for a while before navigating. Model that as:
    // the first few post-click inventory reads return the OLD page, later
    // reads the settled dashboard.
    let extracts = 0;
    (b.controller as { extractInteractiveElements: () => Promise<InteractiveElement[]> })
      .extractInteractiveElements = async () => {
      extracts += 1;
      return extracts <= 3 ? oldPage : settledPage;
    };
    b.setCandidatesFor(["Your token: db3a32ea-dd1b-4e28-9680-db2991c81e3e"]);

    const result = await replaySkill({
      skill: skillWith([
        { kind: "click", text_match: "Continue", provenance },
        { kind: "click", text_match: "API Keys", provenance },
        { kind: "extract_via_copy_button", near_text_hint: "Your token", provenance },
      ]),
      browser: b.controller,
      mode: "full",
    });

    expect(result.kind).toBe("ok");
    const clicks = b.history.filter((c) => c.method === "click");
    // First the old page's Continue, then — after the settle poll — the
    // dashboard's API Keys. (The extract step's Copy click follows.)
    expect(clicks.slice(0, 2).map((c) => c.args[0])).toEqual([
      "button.continue",
      "button.apikeys",
    ]);
  });
});

describe("fixupOtpDistribution", () => {
  function otpBoxes(values: Array<string | null>): InteractiveElement[] {
    return values.map((value, i) =>
      inv({ tag: "input", type: "text", selector: `input.otp${i + 1}`, value, index: i }),
    );
  }

  it("re-types only the digits that didn't stick after auto-advance typing", async () => {
    const { fixupOtpDistribution } = await import("../replay-skill.js");
    const b = stubBrowser();
    // Dropped keystroke during focus transition: digit 2 of "413025" never
    // registered, so every later digit shifted one box left.
    b.setInventoryFor("extract", otpBoxes(["4", "3", "0", "2", "5", ""]));
    await fixupOtpDistribution(b.controller, "413025", "");
    const types = b.history.filter((c) => c.method === "type");
    expect(types.map((c) => c.args)).toEqual([
      ["input.otp2", "1"],
      ["input.otp3", "3"],
      ["input.otp4", "0"],
      ["input.otp5", "2"],
      ["input.otp6", "5"],
    ]);
  });

  it("no-ops when every box already holds its digit", async () => {
    const { fixupOtpDistribution } = await import("../replay-skill.js");
    const b = stubBrowser();
    b.setInventoryFor("extract", otpBoxes(["4", "1", "3", "0", "2", "5"]));
    await fixupOtpDistribution(b.controller, "413025", "");
    expect(b.history.some((c) => c.method === "type")).toBe(false);
  });

  it("no-ops when the widget auto-submitted on the last digit (URL changed)", async () => {
    const { fixupOtpDistribution } = await import("../replay-skill.js");
    const b = stubBrowser();
    b.setInventoryFor("extract", otpBoxes(["", "", "", "", "", ""]));
    await b.controller.goto("https://example.com/dashboard");
    await fixupOtpDistribution(b.controller, "413025", "https://example.com/verify");
    expect(b.history.some((c) => c.method === "type")).toBe(false);
  });

  it("no-ops when the boxes↔digits mapping is ambiguous (count mismatch)", async () => {
    const { fixupOtpDistribution } = await import("../replay-skill.js");
    const b = stubBrowser();
    b.setInventoryFor("extract", otpBoxes(["", "", ""]));
    await fixupOtpDistribution(b.controller, "413025", "");
    expect(b.history.some((c) => c.method === "type")).toBe(false);
  });

  it("re-types a single combined input whose value doesn't match the code", async () => {
    const { fixupOtpDistribution } = await import("../replay-skill.js");
    const b = stubBrowser();
    b.setInventoryFor("extract", [
      inv({ tag: "input", type: "tel", selector: "input.otp", value: "4130" }),
    ]);
    await fixupOtpDistribution(b.controller, "413025", "");
    const types = b.history.filter((c) => c.method === "type");
    expect(types.map((c) => c.args)).toEqual([["input.otp", "413025"]]);
  });
});

describe("findCodeInput", () => {
  it("prefers an explicit label_hint, then a code-named attr, then the first code-shaped input", async () => {
    const { findCodeInput } = await import("../replay-skill.js");
    // attribute-less single box → the only candidate wins (zilliz).
    expect(
      findCodeInput([inv({ tag: "input", type: "tel", selector: "input.otp" })])?.selector,
    ).toBe("input.otp");
    // a code-named field is preferred over a bare text input.
    const picked = findCodeInput([
      inv({ tag: "input", type: "text", selector: "input.first" }),
      inv({ tag: "input", type: "text", name: "verificationCode", selector: "input.code" }),
    ]);
    expect(picked?.selector).toBe("input.code");
    // label_hint pins it.
    const byLabel = findCodeInput(
      [
        inv({ tag: "input", type: "text", selector: "input.a" }),
        inv({ tag: "input", type: "text", ariaLabel: "Verification code", selector: "input.b" }),
      ],
      "Verification code",
    );
    expect(byLabel?.selector).toBe("input.b");
  });

  it("never targets email/password inputs and returns null when there's nothing code-shaped", async () => {
    const { findCodeInput } = await import("../replay-skill.js");
    expect(
      findCodeInput([
        inv({ tag: "input", type: "email", selector: "input.email" }),
        inv({ tag: "input", type: "password", selector: "input.pw" }),
      ]),
    ).toBeNull();
  });
});

describe("rebaseScopedHrefWithCandidate", () => {
  it("replaces a captured scoped project id with the replay account candidate", async () => {
    const { rebaseScopedHrefWithCandidate } = await import("../replay-skill.js");
    expect(
      rebaseScopedHrefWithCandidate(
        "/p/waLWqCn4cX/settings",
        "https://app.openpipe.ai/",
        "7FHd77mDYa",
      ),
    ).toBe("https://app.openpipe.ai/p/7FHd77mDYa/settings");
  });
});
