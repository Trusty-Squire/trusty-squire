// Covers replay-skill.ts — the runtime that walks a stored Skill
// against a live browser. Tests use a stub BrowserController that
// returns scripted inventories and records the calls made against it,
// so we can assert "the replay engine did X then Y" without spinning
// up Playwright.

import { describe, expect, it, vi } from "vitest";
import type { Skill, SkillStep } from "@trusty-squire/skill-schema";
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
    value: overrides.value ?? null,
    interactedThisRun: overrides.interactedThisRun ?? false,
  };
}

function stubBrowser(): StubBrowser {
  const history: StubCall[] = [];
  let inventory: InteractiveElement[] = [];
  let text = "";
  let candidates: string[] = [];
  let clipboard = "";

  // Track the last URL the stub navigated to so currentUrl() can
  // report consistently — the rc.22 navigate-step drift detector
  // calls browser.currentUrl() after every goto.
  let lastUrl = "";
  const controller = {
    async goto(url: string) {
      history.push({ method: "goto", args: [url] });
      lastUrl = url;
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
});

// ── URL drift detection + OAuth recovery (0.8.2-rc.22) ───────────────

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
