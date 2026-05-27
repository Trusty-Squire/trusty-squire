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
    title: overrides.title ?? null,
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
    // Default is pending-review (two-tier registry staging slot);
    // callers pass status: "active" to bypass the verifier worker.
    expect(result.skill.status).toBe("pending-review");
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

  // rc.17 regression — generated unique names (the shape rc.15's
  // planner prompt told the bot to use) MUST templatize to
  // ${TOKEN_NAME} so each replay generates a fresh name. Without
  // this, every promoted skill bakes in a name that already exists
  // on the upstream service and replay deterministically fails at
  // the credential-creating click (Railway's silent duplicate-name
  // rejection).
  it("templatizes a generated unique fill value to ${TOKEN_NAME}", () => {
    const service = uniqueService();
    const rounds = railwayRounds(service);
    // Replace the fill value with the generated-name shape rc.15
    // produces in the wild — exactly the value that broke the
    // Run #2 → Run #3 replay path.
    rounds[1]!.observed = {
      kind: "fill",
      selector: "input[name='token-name']",
      value: "agent-zp9q",
      reason: "Fill a unique token name",
    };
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const fillStep = result.skill.steps[1]!;
    if (fillStep.kind !== "fill") throw new Error("expected fill");
    expect(fillStep.value_template).toBe("${TOKEN_NAME}");
  });

  it("keeps a non-generated fill value as a literal", () => {
    const service = uniqueService();
    // "my-api-token" — 3 hyphen-separated parts, doesn't match the
    // generated-name shape regex (^[a-z]{3,15}-[a-z0-9]{4,12}$).
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const fillStep = result.skill.steps[1]!;
    if (fillStep.kind !== "fill") throw new Error("expected fill");
    expect(fillStep.value_template).toBe("my-api-token");
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

  // rc.19 regression — Railway's icon-only modal copy button has
  // no visible text and no aria-label; its only label signal is the
  // `title="Copy Code"` attribute. Pre-rc.19 the synthesizer missed
  // it and fell back to extract_via_regex (which fails on bare
  // UUIDs). Now findCopyButton checks title + iconLabel + adds
  // "Copy Code" to its vocabulary.
  it("finds an icon-only copy button via the title attribute", () => {
    const service = uniqueService();
    const rounds = railwayRounds(service);
    // Replace the explicit-text Copy button with an icon-only one
    // labeled only via title — exactly the shape Railway ships.
    rounds[2]!.inventory = [
      inventoryElement({
        index: 0,
        tag: "button",
        visibleText: "",
        ariaLabel: null,
        title: "Copy Code",
        selector: "button.copy-code-btn",
        role: "button",
      }),
    ];
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");
    const extract = result.skill.steps[2]!;
    expect(extract.kind).toBe("extract_via_copy_button");
  });

  // rc.29 regression — IPInfo-class dashboards ship icon-only copy
  // buttons with EVERY label signal empty (no visibleText, ariaLabel,
  // title, or iconLabel — the affordance is purely visual via an SVG
  // icon). The only signal that survives into inventory is the
  // selector, which captures the button's CSS class / id. Pre-rc.29
  // the synthesizer missed these and produced extract_via_regex with
  // pattern_name=uuid_token (the synthesizer-default fallback), which
  // never matches IPInfo's 14-char hex token shape and produces
  // un-replayable skills. rc.29 adds a selector-keyword fallback in
  // findCopyButton.
  it("finds an icon-only copy button via its selector class (rc.29)", () => {
    const service = uniqueService();
    const rounds = railwayRounds(service);
    // Replace the explicit-text Copy button with an icon-only one
    // whose ONLY signal is the class name in the selector.
    rounds[2]!.inventory = [
      inventoryElement({
        index: 0,
        tag: "button",
        visibleText: "",
        ariaLabel: null,
        title: null,
        iconLabel: null,
        selector: "button.copy-btn-icon",
        role: "button",
      }),
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");
    const extract = result.skill.steps[2]!;
    expect(extract.kind).toBe("extract_via_copy_button");
  });

  // Negative: a button whose selector contains "copy" only as part of
  // a longer word ("copyright", "policy") must NOT be misclassified.
  it("does not mistake 'copyright' / 'policy' selectors for copy buttons (rc.29)", () => {
    const service = uniqueService();
    const rounds = railwayRounds(service);
    rounds[2]!.inventory = [
      inventoryElement({
        index: 0,
        tag: "button",
        visibleText: "",
        ariaLabel: null,
        title: null,
        iconLabel: null,
        selector: "button.copyright-link",
        role: "button",
      }),
      inventoryElement({
        index: 1,
        tag: "button",
        visibleText: "",
        ariaLabel: null,
        title: null,
        iconLabel: null,
        selector: "#policy-button",
        role: "button",
      }),
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");
    // Neither button is a copy button → falls back to extract_via_regex.
    expect(result.skill.steps[2]!.kind).toBe("extract_via_regex");
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
    // boundary isn't matched. (rc.24 prepends a navigate as step 0,
    // so the click is at step 1.)
    expect(result.skill.steps[0]!.kind).toBe("navigate");
    expect(result.skill.steps[1]!.kind).toBe("click");
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
    // rc.24 prepends a navigate as step 0, so the chain is now
    // navigate + click + extract; the dropped `wait` is still dropped.
    expect(result.skill.steps).toHaveLength(3);
    expect(result.skill.steps[0]!.kind).toBe("navigate");
    expect(result.skill.steps[1]!.kind).toBe("click");
    expect(result.skill.steps[2]!.kind).toBe("extract_via_copy_button");
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

// ── Multi-credential synthesis (Phase C per docs/DESIGN-multi-credential.md) ──

// Twitter-class fixture: 3 distinct credentials extracted from copy
// buttons with different surrounding labels.
function twitterMultiCredRounds(service: string): OnboardingRoundCapture[] {
  return [
    {
      service,
      round: 0,
      oauth: true,
      state: {
        url: "https://developer.twitter.com/portal/keys",
        title: "Keys and tokens",
        html:
          "<html><body>API Key Copy " +
          "API Key Secret Copy " +
          "Bearer Token Copy</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Copy",
          selector: "button.copy-api-key",
          role: "button",
          ariaLabel: "Copy API Key",
        }),
      ],
      observed: {
        kind: "extract",
        reason:
          "API Key value visible in 'API Key' section: copy button beside it.",
      },
    },
    {
      service,
      round: 1,
      oauth: true,
      state: {
        url: "https://developer.twitter.com/portal/keys",
        title: "Keys and tokens",
        html: "<html><body>API Key Secret Copy</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Copy",
          selector: "button.copy-api-key-secret",
          role: "button",
          ariaLabel: "Copy API Key Secret",
        }),
      ],
      observed: {
        kind: "extract",
        reason: "API Key Secret value visible: 'API Key Secret' section.",
      },
    },
    {
      service,
      round: 2,
      oauth: true,
      state: {
        url: "https://developer.twitter.com/portal/keys",
        title: "Keys and tokens",
        html: "<html><body>Bearer Token Copy</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Copy",
          selector: "button.copy-bearer-token",
          role: "button",
          ariaLabel: "Copy Bearer Token",
        }),
      ],
      observed: {
        kind: "extract",
        reason: "Bearer Token visible in 'Bearer Token' section.",
      },
    },
  ];
}

describe("promoteToSkill — multi-credential (Twitter-class)", () => {
  it("produces a skill with N distinct credentials and N named extract steps", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(twitterMultiCredRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // Three distinct credentials.
    expect(result.skill.credentials).toHaveLength(3);
    const names = result.skill.credentials.map((c) => c.name).sort();
    expect(names).toEqual(["api_key", "api_key_secret", "bearer_token"]);

    // Each extract step is the *_named variant referencing its credential.
    const extractSteps = result.skill.steps.filter(
      (s) =>
        s.kind === "extract_via_copy_button_named" ||
        s.kind === "extract_via_regex_named",
    );
    expect(extractSteps).toHaveLength(3);
    for (const s of extractSteps) {
      const produces = (s as { produces: string }).produces;
      expect(names).toContain(produces);
    }
    // No legacy extract kinds slipped through.
    const legacyExtracts = result.skill.steps.filter(
      (s) => s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
    );
    expect(legacyExtracts).toHaveLength(0);
  });

  it("derives <SERVICE>_<PRODUCES> env vars per credential", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(twitterMultiCredRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const upperService = service.toUpperCase().replace(/-/g, "_");
    const envVars = new Set(result.skill.credentials.map((c) => c.env_var_suggestion));
    expect(envVars.has(`${upperService}_API_KEY`)).toBe(true);
    expect(envVars.has(`${upperService}_API_KEY_SECRET`)).toBe(true);
    expect(envVars.has(`${upperService}_BEARER_TOKEN`)).toBe(true);
  });

  it("rejects when two extract rounds derive the same produces", () => {
    // Two rounds with the same label → same produces → duplicate.
    const service = uniqueService();
    const rounds = twitterMultiCredRounds(service);
    // Force a duplicate by re-using "API Key" reason for round 1.
    rounds[1]!.observed = {
      kind: "extract",
      reason: "Second API Key value in 'API Key' section.",
    };
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.error_kind).toBe("duplicate_credential_produces");
  });

  it("single-credential captures still produce a credentials[0].name = undefined skill", () => {
    // Regression net: the multi-cred dispatch must NOT fire for
    // single-cred captures. The Railway fixture is single-cred; its
    // output should keep the legacy shape (one credentials entry,
    // no `name` field, legacy extract step kinds).
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.skill.credentials).toHaveLength(1);
    // Backward-compat invariant: single-cred skills omit `name`.
    expect(result.skill.credentials[0]!.name).toBeUndefined();
    // Legacy step kinds preserved.
    const legacy = result.skill.steps.filter(
      (s) => s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
    );
    expect(legacy.length).toBeGreaterThan(0);
    const named = result.skill.steps.filter(
      (s) =>
        s.kind === "extract_via_copy_button_named" ||
        s.kind === "extract_via_regex_named",
    );
    expect(named).toHaveLength(0);
  });
});

// ── Visibility / show-once-at-creation detection ────────────────────────

function showOnceRounds(service: string, phrase: string): OnboardingRoundCapture[] {
  return [
    {
      service,
      round: 0,
      oauth: true,
      state: {
        url: `https://${service}.example/dashboard/api-keys`,
        title: "API Keys",
        html: `<html><body><h1>API Keys</h1><div>${phrase}</div></body></html>`,
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Copy",
          selector: "button.copy-btn",
          role: "button",
        }),
      ],
      observed: {
        kind: "navigate",
        url: `https://${service}.example/dashboard/api-keys`,
        reason: "Navigate to API Keys page",
      },
    },
    {
      service,
      round: 1,
      oauth: true,
      state: {
        url: `https://${service}.example/dashboard/api-keys`,
        title: "API Keys",
        html: `<html><body>4e768abbf134297cb8f2d505830935 ${phrase}</body></html>`,
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({
          index: 0,
          tag: "button",
          visibleText: "Copy",
          selector: "button.copy-btn",
          role: "button",
        }),
      ],
      observed: {
        kind: "extract",
        reason: `The API key '4e768abbf134297cb8f2d505830935' is visible. Note: ${phrase}`,
      },
    },
  ];
}

describe("promoteToSkill — visibility detection", () => {
  it("defaults to always_visible when no show-once phrasing is present", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Default: visibility omitted from canonical bytes (backwards-
    // compatible — existing signed skills keep their signatures).
    expect(result.skill.credentials[0]!.visibility).toBeUndefined();
  });

  it("marks show_once_at_creation when planner reason includes 'will not be shown again'", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(
      showOnceRounds(service, "This secret will not be shown again"),
    );
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.skill.credentials[0]!.visibility).toBe("show_once_at_creation");
  });

  it("marks show_once_at_creation on 'displayed only once' phrasing", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(
      showOnceRounds(service, "This key is displayed only once for security reasons."),
    );
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.skill.credentials[0]!.visibility).toBe("show_once_at_creation");
  });

  it("marks show_once_at_creation on 'make sure to copy' phrasing", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(
      showOnceRounds(service, "Make sure to copy this token now — you won't be able to see it again."),
    );
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.skill.credentials[0]!.visibility).toBe("show_once_at_creation");
  });

  it("does NOT trigger on benign uses of 'copy'", () => {
    // "Click Copy to get the key" should NOT trip the regex — it's
    // a normal Copy-button affordance, not a show-once warning.
    const service = uniqueService();
    const { dir, runId } = setupCaptures(
      showOnceRounds(service, "Click the Copy button to copy your key to clipboard."),
    );
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Default: visibility omitted from canonical bytes (backwards-
    // compatible — existing signed skills keep their signatures).
    expect(result.skill.credentials[0]!.visibility).toBeUndefined();
  });
});
