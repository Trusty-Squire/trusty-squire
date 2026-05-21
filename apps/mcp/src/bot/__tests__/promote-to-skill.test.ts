// Covers promote-to-skill.ts — the Stage 1 synthesizer. The properties
// we care about:
//
//   1. Determinism — same captures in, byte-identical skill out (modulo
//      generated fields that are themselves derived from the captures).
//   2. Translation correctness — every PostVerifyStep kind maps to the
//      right SkillStep, with the right text hints.
//   3. Rejection paths — each error_kind is reachable and produces a
//      well-formed PromoteRejection.
//   4. Pure — no filesystem writes from the synthesizer itself; only
//      reads via verifyCaptureChain.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkill, type Skill } from "@trusty-squire/adapter-sdk";
import {
  captureOnboardingRound,
  type OnboardingRoundCapture,
} from "../onboarding-capture.js";
import { promoteToSkill } from "../promote-to-skill.js";
import type { InteractiveElement } from "../browser.js";

// ── Test fixtures ────────────────────────────────────────────────────

function inventoryElement(overrides: Partial<InteractiveElement>): InteractiveElement {
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

function setupCaptures(rounds: OnboardingRoundCapture[]): {
  dir: string;
  service: string;
  runId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "promote-test-"));
  const prev = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = dir;
  try {
    for (const r of rounds) captureOnboardingRound(r);
  } finally {
    if (prev === undefined) delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    else process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = prev;
  }
  // Reconstruct the runId from the filename. All rounds in a single
  // setupCaptures call share one runId, so any file's prefix works.
  const sample = readdirSync(dir).find((f) => f.endsWith(".json"));
  if (sample === undefined) throw new Error("setupCaptures wrote no files");
  const service = rounds[0]!.service;
  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const afterSlug = sample.slice(slug.length + 1);
  const runId = afterSlug.slice(0, afterSlug.lastIndexOf("-r"));
  return { dir, service, runId };
}

// Per-test service slug — onboarding-capture maintains per-(service,
// runId) chain state at module scope, so reusing slugs across tests
// can mix chains.
let counter = 0;
function uniqueService(): string {
  counter += 1;
  return `prosvc-${Date.now().toString(36)}-${counter}`;
}

// Build a realistic Railway-style 3-round capture sequence.
function railwayRounds(service: string): OnboardingRoundCapture[] {
  return [
    {
      service,
      round: 0,
      oauth: true,
      state: {
        url: "https://railway.com/account/tokens",
        title: "Account Tokens",
        html: "<html><body>Create Token</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Create Token",
          selector: "button.create-token-btn",
          role: "button",
        }),
        inventoryElement({
          index: 1,
          tag: "input",
          type: "text",
          placeholder: "Token name",
          selector: "input[name='token-name']",
          labelText: "Token name",
        }),
      ],
      observed: {
        kind: "navigate",
        url: "https://railway.com/account/tokens",
        reason: "Go to the tokens page",
      },
    },
    {
      service,
      round: 1,
      oauth: true,
      state: {
        url: "https://railway.com/account/tokens",
        title: "Account Tokens",
        html: "<html><body><input placeholder='Token name' /></body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "input",
          type: "text",
          placeholder: "Token name",
          selector: "input[name='token-name']",
          labelText: "Token name",
        }),
        inventoryElement({
          index: 1,
          tag: "button",
          visibleText: "Create Token",
          selector: "button.create-token-btn",
          role: "button",
        }),
      ],
      observed: {
        kind: "fill",
        selector: "input[name='token-name']",
        value: "my-api-token",
        reason: "Fill the token name",
      },
    },
    {
      service,
      round: 2,
      oauth: true,
      state: {
        url: "https://railway.com/account/tokens",
        title: "Account Tokens",
        html:
          "<html><body>New Token db3a32ea-dd1b-4e28-9680-db2991c81e3e " +
          "<button>Copy</button></body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Copy",
          selector: "button.copy-token-btn",
          role: "button",
          ariaLabel: "Copy to clipboard",
        }),
      ],
      observed: {
        kind: "extract",
        reason:
          "The full API token db3a32ea-dd1b-4e28-9680-db2991c81e3e " +
          "is visible on the page in the 'New Token' section.",
      },
    },
  ];
}

// ── Happy path ───────────────────────────────────────────────────────

describe("promoteToSkill — Railway-style 3-round capture", () => {
  it("produces a valid Skill", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.skill.service).toBe(service);
    expect(result.skill.version).toBe("v1");
    expect(result.skill.signup_url).toBe("https://railway.com/account/tokens");
    expect(result.skill.oauth_provider).toBeNull(); // no oauth_button step
    expect(result.skill.status).toBe("active");
    expect(result.skill.replays_succeeded).toBe(0);
  });

  it("translates the 3 steps in order: navigate, fill, extract", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got rejection: ${JSON.stringify(result)}`);
    }

    expect(result.skill.steps).toHaveLength(3);
    expect(result.skill.steps[0]!.kind).toBe("navigate");
    expect(result.skill.steps[1]!.kind).toBe("fill");
    expect(result.skill.steps[2]!.kind).toBe("extract_via_copy_button");
  });

  it("prefers Copy button extraction over regex when a Copy button is in inventory", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const extract = result.skill.steps[2]!;
    expect(extract.kind).toBe("extract_via_copy_button");
  });

  it("pulls near_text_hint from the planner's quoted phrase", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const extract = result.skill.steps[2]!;
    if (extract.kind !== "extract_via_copy_button") {
      throw new Error("expected extract_via_copy_button");
    }
    expect(extract.near_text_hint).toBe("New Token");
  });

  it("infers shape_hint: uuid from the visible token in HTML", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    expect(result.skill.credentials[0]!.shape_hint).toBe("uuid");
    expect(result.skill.credentials[0]!.post_extract_validator.min_length).toBe(36);
    expect(result.skill.credentials[0]!.post_extract_validator.max_length).toBe(36);
  });

  it("derives env_var_suggestion from the service slug", () => {
    const service = "railway";
    // Use a fixed slug to avoid the unique-counter — single-run test
    // so the chain state doesn't cross-pollute.
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    expect(result.skill.credentials[0]!.env_var_suggestion).toBe("RAILWAY_API_KEY");
  });

  it("honours env_var_suggestion override when provided", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({
      dir,
      service,
      run_id: runId,
      env_var_suggestion: "CUSTOM_RAILWAY_TOKEN",
    });
    if (result.kind !== "ok") throw new Error("expected ok");

    expect(result.skill.credentials[0]!.env_var_suggestion).toBe("CUSTOM_RAILWAY_TOKEN");
  });
});

// ── OAuth detection ──────────────────────────────────────────────────

describe("promoteToSkill — OAuth provider detection", () => {
  it("emits click_oauth_button when the click target's text mentions a provider", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/login",
          title: "Login",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Continue with GitHub",
            selector: "button.oauth-github",
            role: "button",
          }),
        ],
        observed: {
          kind: "click",
          selector: "button.oauth-github",
          reason: "Click GitHub sign-in",
        },
      },
      // Need an extract step too — synthesizeSteps rejects without one
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/dashboard",
          title: "Dashboard",
          html: "<html>New Token re_abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "Token is visible in 'New Token'" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });

    if (result.kind !== "ok") throw new Error("expected ok");

    expect(result.skill.steps[0]!.kind).toBe("click_oauth_button");
    if (result.skill.steps[0]!.kind === "click_oauth_button") {
      expect(result.skill.steps[0]!.provider).toBe("github");
    }
    expect(result.skill.oauth_provider).toBe("github");
  });

  it("does not match 'GitTub' or other near-misses", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/login",
          title: "Login",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Continue with GitTub",
            selector: "button.fake",
            role: "button",
          }),
        ],
        observed: {
          kind: "click",
          selector: "button.fake",
          reason: "Click sign-in",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/dashboard",
          title: "Dashboard",
          html: "<html>Token: re_abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "Token visible" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    // The click should NOT be classified as OAuth — provider word
    // boundary isn't matched.
    expect(result.skill.steps[0]!.kind).toBe("click");
    expect(result.skill.oauth_provider).toBeNull();
  });
});

// ── Determinism ──────────────────────────────────────────────────────

describe("promoteToSkill — determinism", () => {
  it("produces byte-identical skills from byte-identical input", () => {
    const service = "deterministic-test";
    const rounds = railwayRounds(service);

    // Two independent capture directories with the same inputs.
    // Because runId is derived from Date.now().toString(36), we need
    // to ensure both runs use the same runId. Easiest path: feed the
    // synthesizer two PromoteInputs with identical run_id and dir
    // contents.
    const { dir, runId } = setupCaptures(rounds);

    const a = promoteToSkill({ dir, service, run_id: runId });
    const b = promoteToSkill({ dir, service, run_id: runId });

    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("expected ok");

    expect(JSON.stringify(a.skill)).toBe(JSON.stringify(b.skill));
  });

  it("derives the same skill_id from the same captures", () => {
    const service = "skill-id-determinism";
    const rounds = railwayRounds(service);
    const { dir, runId } = setupCaptures(rounds);

    const a = promoteToSkill({ dir, service, run_id: runId });
    const b = promoteToSkill({ dir, service, run_id: runId });

    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("expected ok");

    expect(a.skill.skill_id).toBe(b.skill.skill_id);
    expect(a.skill.skill_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

// ── Rejection paths ──────────────────────────────────────────────────

describe("promoteToSkill — chain rejections", () => {
  it("rejects when no rounds exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-empty-"));
    const result = promoteToSkill({ dir, service: "absent", run_id: "nope" });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("chain_verification");
    expect(result.error_kind).toBe("no_rounds");
  });

  it("rejects when a capture file has been hand-edited", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    // Tamper with round 1's state.url.
    const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const r1Path = join(dir, `${slug}-${runId}-r1.json`);
    const r1 = JSON.parse(readFileSync(r1Path, "utf8")) as Record<string, unknown>;
    const state = r1["state"] as Record<string, unknown>;
    state["url"] = "https://phishing.example.com";
    writeFileSync(r1Path, JSON.stringify(r1, null, 2));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("chain_verification");
    expect(result.error_kind).toBe("hash_mismatch");
    expect(result.offending_round).toBe(1);
  });

  it("rejects when capture has no extract step", () => {
    const service = uniqueService();
    // Build a capture sequence with no extract — just clicks.
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Login",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Click me",
            selector: "button.x",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.x", reason: "click" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("synthesis");
    expect(result.error_kind).toBe("no_extract_step");
  });

  it("rejects when a click target's text matches multiple inventory entries", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Dashboard",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            index: 0,
            tag: "button",
            visibleText: "Create",
            selector: "button.create-1",
            role: "button",
          }),
          inventoryElement({
            index: 1,
            tag: "button",
            visibleText: "Create",
            selector: "button.create-2",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.create-1", reason: "create" },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/done",
          title: "Done",
          html: "<html>Token: re_abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("synthesis");
    expect(result.error_kind).toBe("ambiguous_text_match");
    expect(result.offending_round).toBe(0);
  });

  it("rejects when an inventory element has no visible text or aria-label", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Dashboard",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: null,
            ariaLabel: null,
            selector: "button.silent",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.silent", reason: "click" },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/done",
          title: "Done",
          html: "<html>Token: re_abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("synthesis");
    expect(result.error_kind).toBe("missing_text_hint");
  });

  it("rejects when the captured selector isn't in this round's inventory", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Dashboard",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Real button",
            selector: "button.real",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.invented", reason: "click" },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/done",
          title: "Done",
          html: "<html>Token: re_abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("synthesis");
    expect(result.error_kind).toBe("inventory_entry_not_found");
  });
});

// ── Drop unsupported / flow-control step kinds ───────────────────────

describe("promoteToSkill — flow-control kinds dropped", () => {
  it("drops done/wait/scroll steps without rejecting", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Login",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Continue",
            selector: "button.continue",
            role: "button",
          }),
        ],
        observed: { kind: "wait", seconds: 1, reason: "wait" },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Login",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Continue",
            selector: "button.continue",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.continue", reason: "click" },
      },
      {
        service,
        round: 2,
        oauth: true,
        state: {
          url: "https://example.com/done",
          title: "Done",
          html: "<html>Token: re_abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    }
    expect(result.skill.steps).toHaveLength(2); // wait dropped; click + extract remain
    expect(result.skill.steps[0]!.kind).toBe("click");
    expect(result.skill.steps[1]!.kind).toBe("extract_via_copy_button");
  });
});

// ── Output shape sanity ──────────────────────────────────────────────

describe("promoteToSkill — output passes SkillSchema", () => {
  it("always produces a skill that re-parses through SkillSchema", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    // The synthesizer already calls parseSkill internally, so this is
    // a belt-and-suspenders check that no further processing breaks
    // the returned skill.
    const json = JSON.parse(JSON.stringify(result.skill));
    expect(() => {
      parseSkill(json);
    }).not.toThrow();
  });
});
