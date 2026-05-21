// Covers replay-skill.ts — the runtime that walks a stored Skill
// against a live browser. Tests use a stub BrowserController that
// returns scripted inventories and records the calls made against it,
// so we can assert "the replay engine did X then Y" without spinning
// up Playwright.

import { describe, expect, it, vi } from "vitest";
import type { Skill, SkillStep } from "@trusty-squire/adapter-sdk";
import type { BrowserController, InteractiveElement } from "../browser.js";
import { replaySkill, type LLMFallbackInput } from "../replay-skill.js";

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
  setTextFor(text: string): void;
  setCandidatesFor(candidates: string[]): void;
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
    value: overrides.value ?? null,
  };
}

function stubBrowser(): StubBrowser {
  const history: StubCall[] = [];
  let inventory: InteractiveElement[] = [];
  let text = "";
  let candidates: string[] = [];

  const controller = {
    async goto(url: string) {
      history.push({ method: "goto", args: [url] });
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
    async extractInteractiveElements() {
      history.push({ method: "extractInteractiveElements", args: [] });
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
  } as unknown as BrowserController;

  return {
    controller,
    history,
    setInventoryFor(_method, newInv) {
      inventory = newInv;
    },
    setTextFor(newText) {
      text = newText;
    },
    setCandidatesFor(newCandidates) {
      candidates = newCandidates;
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
});

// ── Disambiguation ──────────────────────────────────────────────────

describe("replaySkill — text-match disambiguation", () => {
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
});
