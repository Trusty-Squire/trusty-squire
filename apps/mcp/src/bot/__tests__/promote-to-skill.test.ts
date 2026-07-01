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
import { parseSkill, type Skill } from "@trusty-squire/skill-schema";
import {
  captureOnboardingRound,
  type OnboardingRoundCapture,
} from "../onboarding-capture.js";
import {
  promoteToSkill,
  pickHrefHint,
  hasEphemeralPathSegment,
  generalizeCapturedUrl,
  stableSignupEntryUrl,
  isIdentityProviderUrl,
  isUnstableSignupEntryUrl,
} from "../promote-to-skill.js";
import type { InteractiveElement } from "../browser.js";

describe("ephemeral-identifier generalization (stuck-pending class)", () => {
  function link(href: string): InteractiveElement {
    return {
      index: 0, tag: "a", type: null, id: null, name: null, placeholder: null,
      ariaLabel: null, role: "link", labelText: null, visibleText: "open",
      selector: "a", visible: true, inViewport: true, inConsentWidget: false,
      href,
    } as InteractiveElement;
  }

  it("hasEphemeralPathSegment flags UUID / long-hex segments, not normal slugs", () => {
    expect(hasEphemeralPathSegment("/database/36f231a7-e459-4061-a1b2-c3d4e5f6a7b8")).toBe(true);
    expect(hasEphemeralPathSegment("/o/9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c")).toBe(true);
    expect(hasEphemeralPathSegment("/dashboard/api-keys")).toBe(false);
    expect(hasEphemeralPathSegment("/settings")).toBe(false);
  });

  it("pickHrefHint drops a created-resource href (weaviate class), keeps a stable route", () => {
    expect(pickHrefHint(link("/database/36f231a7-e459-4061-a1b2-c3d4e5f6a7b8"))).toBeNull();
    expect(pickHrefHint(link("/dashboard/settings"))).toBe("/dashboard/settings");
  });

  it("generalizeCapturedUrl strips per-run session params (kinde class)", () => {
    expect(generalizeCapturedUrl("https://app.kinde.com/register?psid=019e89eac2ca34fd&intent=business")).toBe(
      "https://app.kinde.com/register?intent=business",
    );
    expect(generalizeCapturedUrl("https://x.co/signup?redirect_to=%2Fsetup%2Fabc&plan=free")).toBe(
      "https://x.co/signup?plan=free",
    );
  });

  it("generalizeCapturedUrl is byte-identical for a clean URL (byte-equivalence guard)", () => {
    const clean = "https://ipinfo.io/signup";
    expect(generalizeCapturedUrl(clean)).toBe(clean);
    const cleanWithParam = "https://x.co/signup?plan=free";
    expect(generalizeCapturedUrl(cleanWithParam)).toBe(cleanWithParam);
  });

  it("generalizeCapturedUrl strips a per-run email param (zilliz verify URL)", () => {
    expect(
      generalizeCapturedUrl(
        "https://cloud.zilliz.com/signup/verify?&email=ghall284%40trustysquire.ai",
      ),
    ).toBe("https://cloud.zilliz.com/signup/verify");
    expect(generalizeCapturedUrl("https://x.co/signup?email=a@b.co&plan=pro")).toBe(
      "https://x.co/signup?plan=pro",
    );
  });

  it("stableSignupEntryUrl rewrites login routes only for captured signup forms", () => {
    const signupRounds = [
      {
        observed: {
          kind: "fill",
          selector: "#confirm-password",
          value: "pw",
          reason: "Fill the signup password",
        },
        inventory: [
          {
            selector: "#confirm-password",
            labelText: "Confirm Password",
            placeholder: "Re-enter Password",
          },
        ],
      },
    ] as any;
    const loginRounds = [
      {
        observed: {
          kind: "fill",
          selector: "#password",
          value: "pw",
          reason: "Fill password",
        },
        inventory: [{ selector: "#password", labelText: "Password" }],
      },
    ] as any;

    expect(stableSignupEntryUrl("https://app.mor.org/signin", signupRounds)).toBe(
      "https://app.mor.org/signup",
    );
    expect(stableSignupEntryUrl("https://app.mor.org/signin", loginRounds)).toBe(
      "https://app.mor.org/signin",
    );
  });

  it("isIdentityProviderUrl flags IdP domains, not service domains", () => {
    // The deepseek-N26 bug: round 0 landed on a Google domain mid-OAuth,
    // and the synthesizer adopted it as signup_url.
    expect(isIdentityProviderUrl("https://myaccount.google.com/")).toBe(true);
    expect(isIdentityProviderUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isIdentityProviderUrl("https://github.com/login/oauth/authorize")).toBe(true);
    expect(isIdentityProviderUrl("https://login.microsoftonline.com/common")).toBe(true);
    // Service domains must NOT be flagged.
    expect(isIdentityProviderUrl("https://platform.deepseek.com/sign_up")).toBe(false);
    expect(isIdentityProviderUrl("https://platform.deepseek.com/api_keys")).toBe(false);
    expect(isIdentityProviderUrl("https://ipinfo.io/signup")).toBe(false);
    // Don't false-positive on a service whose name merely contains an IdP token.
    expect(isIdentityProviderUrl("https://mygoogle.com.evil.io/x")).toBe(false);
    // Malformed / relative → not an IdP entry.
    expect(isIdentityProviderUrl("/signup")).toBe(false);
  });

  it("isUnstableSignupEntryUrl rejects stale transaction entries, not valid deep key pages", () => {
    expect(isUnstableSignupEntryUrl("https://app.baseten.co/overview")).toBe(true);
    expect(isUnstableSignupEntryUrl("https://app.kinde.com/auth/cx/_:nav&m:login")).toBe(true);
    expect(
      isUnstableSignupEntryUrl(
        "https://console.anyscale.com/register/create-user-new-org-confirmation",
      ),
    ).toBe(true);
    expect(isUnstableSignupEntryUrl("https://replit.com/~")).toBe(true);

    expect(isUnstableSignupEntryUrl("https://railway.com/account/tokens")).toBe(false);
    expect(isUnstableSignupEntryUrl("https://ipinfo.io/account/token")).toBe(false);
    expect(isUnstableSignupEntryUrl("https://example.com/signup")).toBe(false);
  });
});

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
    href: overrides.href ?? null,
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

// A capture where EVERY round is an identity-provider or per-tenant
// (auth0-class) URL — no captured round qualifies as a clean entry.
function idpOnlyRounds(service: string): OnboardingRoundCapture[] {
  return [
    {
      service,
      round: 0,
      oauth: true,
      state: {
        url: "https://accounts.google.com/o/oauth2/auth?client_id=x",
        title: "Sign in - Google",
        html: "<html><body>Google</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({ index: 0, tag: "button", visibleText: "Google", selector: "button.g", role: "button" }),
      ],
      observed: { kind: "click", selector: "button.g", reason: "Continue with Google" },
    },
    {
      service,
      round: 1,
      oauth: true,
      state: {
        // per-tenant dashboard — host ends with auth0.com (an IdP host) AND the
        // path is tenant-specific, so neither a clean nor stable entry.
        url: "https://manage.auth0.com/dashboard/us/dev-abc123/applications",
        title: "Applications",
        html: "<html><body>API Key db3a32ea-dd1b-4e28-9680-db2991c81e3e <button>Copy</button></body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        inventoryElement({ index: 0, tag: "button", visibleText: "Copy", selector: "button.copy", role: "button", ariaLabel: "Copy to clipboard" }),
      ],
      observed: {
        kind: "extract",
        reason: "The API key db3a32ea-dd1b-4e28-9680-db2991c81e3e is shown in the credentials panel.",
      },
    },
  ];
}

describe("promoteToSkill — auth0-class unstable entry URL", () => {
  it("rejects unstable_signup_url when no captured round is a clean entry and no signup_url is supplied", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(idpOnlyRounds(service));
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.error_kind).toBe("unstable_signup_url");
  });

  it("falls back to the known input signup_url even when it's an IdP host (auth0 is the target service, not the IdP)", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(idpOnlyRounds(service));
    const result = promoteToSkill({
      dir,
      service,
      run_id: runId,
      signupUrl: "https://auth0.com/signup",
      oauthProvider: "google",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // The known input signup_url is used as the entry instead of rejecting,
    // even though auth0.com is in IDENTITY_PROVIDER_HOSTS.
    expect(result.skill.signup_url).toBe("https://auth0.com/signup");
    expect(result.skill.steps.some((s) => s.kind === "click_oauth_button")).toBe(true);
  });
});

describe("promoteToSkill — confirmation-modal fill (pubnub class)", () => {
  it("soft-drops an unlabeled 'type UPDATE to confirm' fill instead of hard-rejecting missing_text_hint", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: false,
        state: {
          url: "https://admin.pubnub.com/account/1/app/2/key/3",
          title: "Keyset",
          html: "<html><body><h4>Confirm</h4><input></body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({ index: 0, tag: "input", type: "text", selector: "div > div:nth-of-type(2) > div > input" }),
        ],
        observed: {
          kind: "fill",
          selector: "div > div:nth-of-type(2) > div > input",
          value: "UPDATE",
          reason: "Confirm the secret key update by typing UPDATE.",
        },
      },
      {
        service,
        round: 1,
        oauth: false,
        state: {
          url: "https://admin.pubnub.com/account/1/app/2/key/3",
          title: "Keyset",
          html: "<html><body>Subscribe Key sub-c-db3a32ea-dd1b-4e28-9680-db2991c81e3e <button>Copy</button></body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({ index: 0, tag: "button", visibleText: "Copy", selector: "button.copy", role: "button", ariaLabel: "Copy to clipboard" }),
        ],
        observed: {
          kind: "extract",
          reason: "The subscribe key sub-c-db3a32ea-dd1b-4e28-9680-db2991c81e3e is shown.",
        },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.skill.steps.some((s) => s.kind === "fill")).toBe(false);
    expect(result.skill.steps.some((s) => s.kind.startsWith("extract"))).toBe(true);
  });

  it("still HARD-rejects an unlabeled fill whose value is real data (load-bearing, not a confirmation)", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: false,
        state: { url: "https://x.com/new", title: "New", html: "<html><body><input></body></html>", screenshot: "data:image/png;base64,iVBORw0KGgo=" },
        inventory: [inventoryElement({ index: 0, tag: "input", type: "text", selector: "div > input" })],
        observed: { kind: "fill", selector: "div > input", value: "my-project-name", reason: "Name the project." },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.error_kind).toBe("missing_text_hint");
  });
});

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
    if (result.kind !== "ok") throw new Error(`expected ok: ${JSON.stringify(result)}`);

    const fillStep = result.skill.steps[1]!;
    if (fillStep.kind !== "fill") throw new Error("expected fill");
    expect(fillStep.value_template).toBe("${TOKEN_NAME}");
  });

  // 0.8.3-rc.1 — even when the captured value doesn't match the
  // rc.17 generated-name shape, an input whose context signals
  // "this is a token / API-key name field" (placeholder/label
  // mentions API key, token name, or "production-api-key" style
  // example) MUST still templatize. The baseten regression: a
  // planner-chosen literal "ts-random" (no digits) would have been
  // kept verbatim, baking in a name already used on baseten, leaving
  // every replay's submit button disabled.
  // Baseten-class case from the verifier drain marathon. The
  // planner used a name generator that produces strings the rc.17
  // value-shape regex doesn't recognise ("ts-random" has no digits;
  // "ts-agent-x9k2m" has two hyphens). The input's placeholder
  // "e.g. production-api-key" should trigger templatization.
  it("templatizes a Baseten-style 'e.g. production-api-key' input regardless of value shape", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            id: "name",
            placeholder: "e.g. production-api-key",
            selector: "input#name",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Create API key",
            role: "button",
            selector: "button.submit",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input#name",
          value: "ts-random",
          reason: "Fill API-key name",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html>Token: abc123def456ghi789</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy API key",
            role: "button",
            selector: "button.copy",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const fillStep = result.skill.steps.find((s) => s.kind === "fill");
    if (fillStep === undefined || fillStep.kind !== "fill") {
      throw new Error("expected fill");
    }
    expect(fillStep.value_template).toBe("${TOKEN_NAME}");
  });

  it("templatizes a context-signalled token-name input even when the value isn't shape-matched", () => {
    const service = uniqueService();
    // Railway's input already has labelText "Token name" — that's the
    // context signal. "my-api-token" wouldn't match the value-shape
    // regex (no digit in the tail), but the input's context wins.
    const { dir, runId } = setupCaptures(railwayRounds(service));

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const fillStep = result.skill.steps[1]!;
    if (fillStep.kind !== "fill") throw new Error("expected fill");
    expect(fillStep.value_template).toBe("${TOKEN_NAME}");
  });

  it("keeps a non-generated fill value as a literal when the input ISN'T a token-name field", () => {
    const service = uniqueService();
    // Custom rounds where the input is a plain "Display name" — a
    // human's name field, NOT a token name. No API/token/key vocab
    // in placeholder/label/aria. The literal value must pass through.
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/profile",
          title: "Profile",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            id: "display-name",
            placeholder: "Your name",
            selector: "input#display-name",
            labelText: "Display name",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Save",
            role: "button",
            selector: "button.save",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input#display-name",
          value: "my-display-name",
          reason: "Fill display name",
        },
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
            role: "button",
            selector: "button.copy",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const fillStep = result.skill.steps.find((s) => s.kind === "fill");
    if (fillStep === undefined || fillStep.kind !== "fill") {
      throw new Error("expected fill");
    }
    expect(fillStep.value_template).toBe("my-display-name");
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

  it("does not persist a quoted credential value as near_text_hint", () => {
    const service = uniqueService();
    const rounds = railwayRounds(service);
    rounds[2]!.observed = {
      kind: "extract",
      reason:
        "The full API token 'db3a32ea-dd1b-4e28-9680-db2991c81e3e' " +
        "is visible next to the copy button.",
    };
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");

    const extract = result.skill.steps[2]!;
    if (extract.kind !== "extract_via_copy_button") {
      throw new Error("expected extract_via_copy_button");
    }
    expect(extract.near_text_hint).toBe("Copy");
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
    // 0.8.3 — uuid validator widened from {36, 36} to {32, 80} so
    // shape-misinference (page has a UUID-shaped distractor near a
    // non-UUID credential) doesn't lock the validator down to a
    // range the real credential can never satisfy. Real UUIDs still
    // fall inside the range; replicate-class r8_…40-char keys
    // (mis-tagged as uuid in some captures) also pass.
    expect(result.skill.credentials[0]!.post_extract_validator.min_length).toBe(32);
    expect(result.skill.credentials[0]!.post_extract_validator.max_length).toBe(80);
  });

  // 0.8.3-rc.1 — bug #5: when the dashboard HTML happens to contain
  // a UUID-shaped string that ISN'T the credential (a session ID, a
  // tracking ID, a workspace ID, …), the synthesizer used to lock the
  // shape to "uuid" and the validator to UUID bounds — rejecting the
  // real credential. The context-proximity check requires the UUID
  // to sit near token/key/api/secret vocabulary; standalone session
  // UUIDs no longer satisfy the check.
  it("does NOT infer uuid when a stray UUID is far from any credential context (ipinfo-class)", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://ipinfo.io/dashboard",
          title: "Dashboard",
          html:
            // Page chrome with an unrelated tracking UUID, far from
            // any credential-context word.
            "<html><head><script>window.__SESSION='019e4b8d-6b2b-0000-8d9a-5671913d8dfd'</script></head>" +
            "<body>" +
            // 800 chars of nav/footer noise to push the UUID outside the
            // credential context's window.
            "<nav>" + "x".repeat(800) + "</nav>" +
            // The actual credential context sits much later in the
            // document.
            "<label>API Token</label>" +
            "<code>f9a062f02fadf5</code>" +
            "<button>Copy</button>" +
            "</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            role: "button",
            selector: "button.copy",
          }),
        ],
        observed: {
          kind: "extract",
          reason: "The API token is now visible: f9a062f02fadf5",
        },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");
    // The stray UUID is in a <script> block far from the credential
    // label; shape must NOT be uuid.
    expect(result.skill.credentials[0]!.shape_hint).not.toBe("uuid");
    // Validator bounds should accommodate the 14-char real key.
    const v = result.skill.credentials[0]!.post_extract_validator;
    expect(v.min_length).toBeLessThanOrEqual(14);
    expect(v.max_length).toBeGreaterThanOrEqual(14);
  });

  it("still infers uuid when the UUID IS adjacent to credential context (Railway-class)", () => {
    // Railway's "New Token <uuid>" pattern: UUID right after the
    // credential context word. Must keep tagging as uuid.
    const service = uniqueService();
    const { dir, runId } = setupCaptures(railwayRounds(service));
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.skill.credentials[0]!.shape_hint).toBe("uuid");
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

  it("preserves an explicit OAuth provider even when the captured graph starts after OAuth", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
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
    const result = promoteToSkill({
      dir,
      service,
      run_id: runId,
      oauthProvider: "google",
    });

    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.skill.oauth_provider).toBe("google");
  });

  it("uses caller signupUrl and prepends OAuth when capture starts after provider callback", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://app.openpipe.ai/account/complete-profile",
          title: "Complete profile",
          html: "<html><button>Continue</button></html>",
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
        observed: { kind: "click", selector: "button.continue", reason: "Continue" },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://app.openpipe.ai/p/project/settings",
          title: "Project settings",
          html: "<html>Project API Keys <button>Copy</button> opk_3181b37872f7f1aaf4ebd1ba7ebc7e219fd2948b44</html>",
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
        observed: { kind: "extract", reason: "api_key='opk_3181b37872f7f1aaf4ebd1ba7ebc7e219fd2948b44'" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({
      dir,
      service,
      run_id: runId,
      oauthProvider: "google",
      signupUrl: "https://app.openpipe.ai/",
    });

    if (result.kind !== "ok") throw new Error(`expected ok: ${JSON.stringify(result)}`);
    expect(result.skill.signup_url).toBe("https://app.openpipe.ai/");
    expect(result.skill.oauth_provider).toBe("google");
    expect(result.skill.steps[0]).toMatchObject({
      kind: "navigate",
      url: "https://app.openpipe.ai/",
    });
    expect(result.skill.steps[1]).toMatchObject({
      kind: "click_oauth_button",
      provider: "google",
    });
    expect(result.skill.steps[2]).toMatchObject({
      kind: "navigate",
      url: "https://app.openpipe.ai/account/complete-profile",
    });
  });

  it("drops a premature duplicate submit before required form fills", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: false,
        state: {
          url: "https://example.com/signup",
          title: "Signup",
          html: "<html><label>Company</label><input placeholder=\"Acme\"><button>Continue</button></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            placeholder: "Acme",
            selector: "input.company",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Continue",
            selector: "button.continue",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.continue", reason: "Tried submit too early" },
      },
      {
        service,
        round: 1,
        oauth: false,
        state: {
          url: "https://example.com/signup",
          title: "Signup",
          html: "<html><label>Company</label><input placeholder=\"Acme\"><button>Continue</button></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            placeholder: "Acme",
            selector: "input.company",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Continue",
            selector: "button.continue",
            role: "button",
          }),
        ],
        observed: { kind: "fill", selector: "input.company", value: "Acme", reason: "Fill company" },
      },
      {
        service,
        round: 2,
        oauth: false,
        state: {
          url: "https://example.com/signup",
          title: "Signup",
          html: "<html><label>Company</label><input placeholder=\"Acme\"><button>Continue</button></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            placeholder: "Acme",
            selector: "input.company",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Continue",
            selector: "button.continue",
            role: "button",
          }),
        ],
        observed: { kind: "click", selector: "button.continue", reason: "Submit after fill" },
      },
      {
        service,
        round: 3,
        oauth: false,
        state: {
          url: "https://example.com/settings",
          title: "Settings",
          html: "<html><button>Copy</button> sk_test_abcdefghijklmnopqrstuvwxyz123456</html>",
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
        observed: { kind: "extract", reason: "api_key='sk_test_abcdefghijklmnopqrstuvwxyz123456'" },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    if (result.kind !== "ok") throw new Error(`expected ok: ${JSON.stringify(result)}`);
    const clicks = result.skill.steps.filter((s) => s.kind === "click");
    expect(clicks).toHaveLength(1);
    expect(result.skill.steps.map((s) => s.kind)).toContain("fill");
    expect(clicks[0]).toMatchObject({ text_match: "Continue" });
  });

  it("does not stamp an explicit OAuth provider onto an email-signup graph", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: false,
        state: {
          url: "https://example.com/register",
          title: "Register",
          html: "<html><label>Email</label><input name=\"email\"></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            labelText: "Email",
            selector: "input[name='email']",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input[name='email']",
          value: "bot@example.com",
          reason: "Fill the signup email",
        },
      },
      {
        service,
        round: 1,
        oauth: false,
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
    const result = promoteToSkill({
      dir,
      service,
      run_id: runId,
      oauthProvider: "google",
    });

    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.skill.oauth_provider).toBeNull();
    expect(result.skill.steps.some((s) => s.kind === "fill" && s.value_template === "${EMAIL_ALIAS}")).toBe(true);
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

  it("soft-drops an ambiguous click when a later extract round recovers (0.8.1)", () => {
    // Pre-0.8.1 this case rejected the whole skill on ambiguous_text_match
    // — the synthesizer refused to translate a click that resolved to two
    // same-labeled inventory elements. In practice the bot's planner
    // captures these noise rounds constantly (failed click on
    // disabled-but-text-collision buttons, no-progress retries on a
    // duplicate-label dashboard nav). When a clean extract follows, the
    // skill is recoverable by dropping the noise click — the replay
    // engine walks linearly and finds the credential.
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
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // The ambiguous click was dropped; only the navigate (added by
    // the synthesizer's first-step-navigate rule) + extract remain.
    const kinds = result.skill.steps.map((s) => s.kind);
    expect(kinds).not.toContain("click");
    expect(kinds.some((k) => k === "extract_via_regex" || k === "extract_via_copy_button")).toBe(true);
  });

  it("surfaces the soft-drop rejection when no extract round follows (0.8.1)", () => {
    // When a click is soft-dropped AND nothing downstream produces an
    // extract step, we surface the FIRST soft-drop rejection rather
    // than the generic no_extract_step — operator wants the actual
    // diagnostic (which round had the ambiguous label) so they can
    // fix the planner prompt or re-capture.
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
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.stage).toBe("synthesis");
    expect(result.error_kind).toBe("ambiguous_text_match");
    expect(result.offending_round).toBe(0);
  });

  it("emits near_text_hint for an ambiguous click when a unique nearby label disambiguates (baseten modal, 0.8.3-rc.1)", () => {
    // Baseten's "Create API key" modal submit button shares its
    // visible text with the listing page's "Create API key" trigger
    // still rendered in the DOM behind the modal. Pre-0.8.3 the
    // synthesizer soft-dropped the submit click and the resulting
    // skill replayed past fill straight to extract — picking up only
    // the token name, not the actual key. Now: the modal context
    // (form labels, "Cancel" button) provides unique nearby text,
    // so the synthesizer emits a near_text_hint and the submit click
    // survives.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          // Sidebar / page chrome.
          inventoryElement({
            index: 0,
            tag: "a",
            visibleText: "API keys",
            selector: "nav > a.api-keys",
          }),
          // Listing's open-form trigger — collides with modal submit.
          inventoryElement({
            index: 1,
            tag: "button",
            visibleText: "Create API key",
            selector: "button.listing-create",
            role: "button",
          }),
          // Modal form preceded by its distinctive labels.
          inventoryElement({
            index: 2,
            tag: "label",
            visibleText: "Name",
            labelText: "Name",
            selector: "form > label[for=name]",
          }),
          inventoryElement({
            index: 3,
            tag: "input",
            type: "text",
            id: "name",
            placeholder: "e.g. production-api-key",
            selector: "input#name",
            labelText: "Name",
          }),
          inventoryElement({
            index: 4,
            tag: "button",
            visibleText: "Cancel",
            selector: "form > button.cancel",
            role: "button",
          }),
          // The modal submit — same visibleText as the listing trigger.
          inventoryElement({
            index: 5,
            tag: "button",
            visibleText: "Create API key",
            selector: "form > button.modal-submit",
            role: "button",
          }),
        ],
        observed: {
          kind: "click",
          selector: "form > button.modal-submit",
          reason: "Submit the create-API-key form",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html>Token: 2fmMCMCB.YLfZheHsb2vw93EGFVHoDJgwb4B2h97s</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy API key",
            selector: "button.copy-token",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const clickStep = result.skill.steps.find(
      (s) => s.kind === "click" && s.text_match === "Create API key",
    );
    expect(clickStep).toBeDefined();
    if (clickStep === undefined || clickStep.kind !== "click") return;
    // The disambiguator must point at the modal's nearby text, not at
    // the colliding "Create API key" itself.
    expect(clickStep.near_text_hint).toBeDefined();
    expect(clickStep.near_text_hint).not.toBe("Create API key");
    // The replay-engine path will use filterByNearTextHint to pick
    // the modal-submit button. The exact value depends on the
    // disambiguator's preceding-window walk; "Cancel" (closest
    // preceding unique text) is the expected pick here.
    expect(clickStep.near_text_hint).toBe("Cancel");
  });

  it("soft-drops a click whose element has no visible text or aria-label (0.8.1)", () => {
    // Was a hard reject pre-0.8.1. Cloudinary's "card radio" disabled
    // buttons are the canonical case: the planner picked them, but they
    // have no text/aria-label of any kind. The bot's NEXT round shows the
    // planner re-routing to a real target, so the failed click should
    // be dropped — not the entire skill rejected.
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
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.skill.steps.some((s) => s.kind === "click")).toBe(false);
  });

  it("soft-drops a click whose selector isn't in inventory when extract recovers (0.8.1)", () => {
    // Was a hard reject pre-0.8.1. Symptom: the planner emitted a
    // selector the bot couldn't find (model-invention, or DOM raced the
    // capture). When a subsequent round produces a clean extract, drop
    // the broken-selector click and continue.
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
    expect(result.kind).toBe("ok");
  });
});

// ── Combobox-button visibleText fallback ─────────────────────────────

describe("promoteToSkill — fill/select hint resolution (0.8.1)", () => {
  it("uses visibleText as the label hint for combobox-shaped buttons", () => {
    // Resend / OpenAI / Radix-based dashboards ship their selects as
    // <button role="combobox"> with the current value rendered as
    // visibleText and no labelText / placeholder / ariaLabel. Pre-0.8.1
    // resolveLabelHint rejected these with missing_text_hint. Now we
    // fall back to visibleText for that specific shape (combobox role
    // + button tag), letting the synthesizer keep the select step.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Pick",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            role: "combobox",
            visibleText: "All domains",
            selector: "form > div > button",
          }),
        ],
        observed: {
          kind: "select",
          selector: "form > div > button",
          option_text: "All domains",
          reason: "pick All domains",
        },
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
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const selectStep = result.skill.steps.find((s) => s.kind === "select");
    expect(selectStep).toBeDefined();
    if (selectStep === undefined || selectStep.kind !== "select") return;
    expect(selectStep.label_hint).toBe("All domains");
    expect(selectStep.option_text).toBe("All domains");
  });

  it("emits near_text_hint for an ambiguous select when a unique nearby label exists (Sentry grid, 0.8.2-rc.3)", () => {
    // Sentry's permission grid is the canonical case: each row's
    // <select> reports labelText="Permission". Pre-rc.3 the synthesizer
    // hard-rejected with ambiguous_text_match. Now: the inventory's
    // nearby visible text uniquely identifies each row (Project / Team
    // / Member), so the synthesizer emits near_text_hint and the skill
    // is promotable.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://sentry.io/settings/api/applications/new/",
          title: "Sentry Permissions",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          // Row 1: Project (label) + select labeled "Permission".
          inventoryElement({
            index: 0,
            tag: "div",
            visibleText: "Project",
            selector: "div.row-project > h4",
          }),
          inventoryElement({
            index: 1,
            tag: "select",
            labelText: "Permission",
            selector: "select.row-project-perm",
            selectOptions: [
              { value: "no", text: "No Access" },
              { value: "read", text: "Read" },
              { value: "write", text: "Write" },
              { value: "admin", text: "Admin" },
            ],
          }),
          // Row 2: Team + select labeled "Permission".
          inventoryElement({
            index: 2,
            tag: "div",
            visibleText: "Team",
            selector: "div.row-team > h4",
          }),
          inventoryElement({
            index: 3,
            tag: "select",
            labelText: "Permission",
            selector: "select.row-team-perm",
            selectOptions: [
              { value: "no", text: "No Access" },
              { value: "read", text: "Read" },
              { value: "write", text: "Write" },
              { value: "admin", text: "Admin" },
            ],
          }),
        ],
        observed: {
          kind: "select",
          selector: "select.row-team-perm",
          option_text: "Admin",
          reason: "Set Team permission to Admin",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://sentry.io/done",
          title: "Done",
          html: "<html>Token: sntrys_abcdefghijklmnopqrstuvw</html>",
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
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const selectStep = result.skill.steps.find((s) => s.kind === "select");
    expect(selectStep).toBeDefined();
    if (selectStep === undefined || selectStep.kind !== "select") return;
    expect(selectStep.label_hint).toBe("Permission");
    // The disambiguator must point at THIS row (Team), not the sibling
    // (Project).
    expect(selectStep.near_text_hint).toBe("Team");
    expect(selectStep.option_text).toBe("Admin");
  });

  it("still rejects when label_hint collides AND no unique nearby text disambiguates (0.8.2-rc.3 fallback)", () => {
    // Two inputs sharing the same labelText AND surrounded by the same
    // sibling text — there's nothing to use as a disambiguator. The
    // synthesizer falls back to ambiguous_text_match.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com",
          title: "Twin Inputs",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            labelText: "Name",
            selector: "input.a",
          }),
          inventoryElement({
            tag: "input",
            type: "text",
            labelText: "Name",
            selector: "input.b",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input.a",
          value: "Alice",
          reason: "fill name",
        },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.error_kind).toBe("ambiguous_text_match");
    expect(result.message).toMatch(/no unique nearby visible text/);
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

// ── Multi-credential synthesis ──

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

  it("marks every multi-credential secret show_once_at_creation when extraction rounds warn once-only", () => {
    const service = uniqueService();
    const rounds = twitterMultiCredRounds(service);
    for (const round of rounds) {
      round.state.html = round.state.html.replace(
        "</body>",
        " This secret is displayed only once. Make sure to copy it now.</body>",
      );
    }
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.skill.credentials).toHaveLength(3);
    expect(result.skill.credentials.every((c) => c.visibility === "show_once_at_creation")).toBe(true);
  });

  it("collapses a re-extraction that derives the same produces (0.8.11)", () => {
    // Two rounds deriving the same `produces` are NOT a multi-cred
    // conflict — they're the post-verify loop re-extracting one
    // credential. collapseRedundantExtracts merges them, so the round-1
    // duplicate drops and the surviving extracts (api_key + bearer_token)
    // form a valid 2-credential skill instead of rejecting the whole run.
    const service = uniqueService();
    const rounds = twitterMultiCredRounds(service);
    // Force a duplicate by re-using "API Key" reason for round 1.
    rounds[1]!.observed = {
      kind: "extract",
      reason: "Second API Key value in 'API Key' section.",
    };
    const { dir, runId } = setupCaptures(rounds);

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // The duplicate api_key collapsed; api_key + bearer_token remain.
    const names = result.skill.credentials.map((c) => c.name).sort();
    expect(names).toEqual(["api_key", "bearer_token"]);
    const namedExtracts = result.skill.steps.filter(
      (s) =>
        s.kind === "extract_via_copy_button_named" ||
        s.kind === "extract_via_regex_named",
    );
    expect(namedExtracts).toHaveLength(2);
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

// ── Consecutive-duplicate step dedup (0.8.2-rc.21) ───────────────────

describe("promoteToSkill — stable-attribute fallback (0.8.3-rc.1, bug #4)", () => {
  // Mistral-class case: a Terms-of-Service checkbox renders with a
  // runtime-generated `id="_R_75klubsnimdb_"` (react-aria-utils) AND a
  // stable `name="terms"`. Pre-0.8.3 the synthesizer rejected the
  // capture with missing_text_hint because there was no visibleText
  // / ariaLabel. The fallback to the `name` attribute now lets the
  // synthesizer produce a valid step.
  it("synthesizes a click step using the element's `name` attribute when no text/aria-label exists", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://console.mistral.ai/signup",
          title: "Signup",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "checkbox",
            id: "_R_75klubsnimdb_",
            name: "terms",
            role: "checkbox",
            selector: "input[name=\"terms\"]",
          }),
        ],
        observed: {
          kind: "check",
          selector: "input[name=\"terms\"]",
          reason: "Accept terms",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://console.mistral.ai/done",
          title: "Done",
          html: "<html>Token: sk-abcdefghij1234567890abc</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            role: "button",
            selector: "button.copy",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const clickStep = result.skill.steps.find((s) => s.kind === "click");
    expect(clickStep).toBeDefined();
    if (clickStep === undefined || clickStep.kind !== "click") return;
    expect(clickStep.text_match).toBe("terms");
  });

  it("rejects when the element has runtime-only id AND no stable name", () => {
    // A pure react-aria-style runtime ID with no visible text and no
    // stable name has no usable anchor. Synthesizer continues to
    // reject — the fallback only fires when there's a stable attr to
    // use.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/x",
          title: "X",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            id: "react-aria3800282830-_r_69_",
            selector: "#react-aria3800282830-_r_69_",
          }),
        ],
        observed: {
          kind: "click",
          selector: "#react-aria3800282830-_r_69_",
          reason: "Click something",
        },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.error_kind).toBe("missing_text_hint");
  });
});

describe("promoteToSkill — retry-sequence stripping (0.8.3-rc.1)", () => {
  it("drops a capture-time fill+submit retry, keeping the successful trailing path", () => {
    // Baseten-class case from the 2026-05-28 verifier drain marathon.
    // The bot's planner emitted fill("ts-random") → click submit →
    // fill("ts-agent-x9k2m") → click submit because the first name
    // collided with an existing key on the capture-time account. At
    // replay time each replay generates a fresh ${TOKEN_NAME}, so
    // the first submit succeeds and the retry fill targets a now-
    // closed form. Synthesizer must recognise the retry path and
    // strip it.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            id: "name",
            placeholder: "e.g. production-api-key",
            selector: "input#name",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Cancel",
            role: "button",
            selector: "form > button.cancel",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Create API key",
            role: "button",
            selector: "form > button.submit",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input#name",
          value: "ts-random",
          reason: "Fill API-key name",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            id: "name",
            placeholder: "e.g. production-api-key",
            selector: "input#name",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Cancel",
            role: "button",
            selector: "form > button.cancel",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Create API key",
            role: "button",
            selector: "form > button.submit",
          }),
        ],
        observed: {
          kind: "click",
          selector: "form > button.submit",
          reason: "Submit (first try — name will conflict)",
        },
      },
      {
        service,
        round: 2,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            id: "name",
            placeholder: "e.g. production-api-key",
            selector: "input#name",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Cancel",
            role: "button",
            selector: "form > button.cancel",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Create API key",
            role: "button",
            selector: "form > button.submit",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input#name",
          value: "ts-agent-x9k2m",
          reason: "Retry with a unique name",
        },
      },
      {
        service,
        round: 3,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "text",
            id: "name",
            placeholder: "e.g. production-api-key",
            selector: "input#name",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Cancel",
            role: "button",
            selector: "form > button.cancel",
          }),
          inventoryElement({
            tag: "button",
            visibleText: "Create API key",
            role: "button",
            selector: "form > button.submit",
          }),
        ],
        observed: {
          kind: "click",
          selector: "form > button.submit",
          reason: "Submit (second try — name unique now)",
        },
      },
      {
        service,
        round: 4,
        oauth: true,
        state: {
          url: "https://app.baseten.co/settings/api_keys",
          title: "API Keys",
          html: "<html>Token: abc123def456ghi789</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy API key",
            role: "button",
            selector: "button.copy",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const kinds = result.skill.steps.map((s) => s.kind);
    // Expected after strip: navigate (synthesised), fill, click, extract.
    // The retry pair (first fill + first click) is gone.
    expect(kinds).toEqual(["navigate", "fill", "click", "extract_via_copy_button"]);
    // The surviving fill must be the SECOND one — at round_index 2 in
    // the capture, not round_index 0.
    const fillStep = result.skill.steps.find((s) => s.kind === "fill");
    expect(fillStep?.provenance.round_index).toBe(2);
  });

  it("does NOT strip two same-label fills that ARE NOT a retry (different label_hints)", () => {
    // Sanity guard: when the same form asks for two different inputs
    // that happen to share text near them (password / confirm
    // password), the synthesizer must keep both. Different label_hint
    // → different identity → no retry collapse.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/signup",
          title: "Signup",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "password",
            labelText: "Password",
            selector: "input#password",
          }),
          inventoryElement({
            tag: "input",
            type: "password",
            labelText: "Confirm password",
            selector: "input#confirm",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input#password",
          value: "secret",
          reason: "fill password",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/signup",
          title: "Signup",
          html: "<html></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "input",
            type: "password",
            labelText: "Password",
            selector: "input#password",
          }),
          inventoryElement({
            tag: "input",
            type: "password",
            labelText: "Confirm password",
            selector: "input#confirm",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input#confirm",
          value: "secret",
          reason: "fill confirm password",
        },
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
            role: "button",
            selector: "button.copy",
          }),
        ],
        observed: { kind: "extract", reason: "extract" },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const fillCount = result.skill.steps.filter((s) => s.kind === "fill").length;
    expect(fillCount).toBe(2);
  });
});

describe("promoteToSkill — consecutive-duplicate dedup", () => {
  it("collapses two identical consecutive select steps to one", () => {
    // The bot's planner sometimes records the same select action twice
    // in a row (the inventory between rounds didn't change in a way the
    // planner recognised as progress; it re-proposes the same step).
    // Captured naively, the SECOND select replays as a no-op or fails
    // because the chosen value is already selected. Dedup at synthesis
    // time prevents that fragility.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/tokens",
          title: "Tokens",
          html: "<html><select name='workspaceId'></select></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "select",
            name: "workspaceId",
            labelText: "Workspace",
            selector: 'select[name="workspaceId"]',
          }),
        ],
        observed: {
          kind: "select",
          selector: 'select[name="workspaceId"]',
          option_text: "No workspace",
          reason: "Pick workspace",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        // Same DOM, same observed step — duplicate.
        state: {
          url: "https://example.com/tokens",
          title: "Tokens",
          html: "<html><select name='workspaceId'></select></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "select",
            name: "workspaceId",
            labelText: "Workspace",
            selector: 'select[name="workspaceId"]',
          }),
        ],
        observed: {
          kind: "select",
          selector: 'select[name="workspaceId"]',
          option_text: "No workspace",
          reason: "Pick workspace (again)",
        },
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
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Should have exactly ONE select step, not two.
    const selectSteps = result.skill.steps.filter((s) => s.kind === "select");
    expect(selectSteps).toHaveLength(1);
  });

  it("collapses a re-extracted single credential into one single-cred skill (0.8.11, Convex-class)", () => {
    // The post-verify loop re-runs the extractor every round, so a
    // single-credential dashboard (Convex's "Copy" auth token) is
    // routinely captured as two extract rounds against the same page,
    // both deriving the same `produces`. Pre-0.8.11 the >1-extract
    // multi-cred dispatch hit duplicate_credential_produces and rejected
    // the whole skill. Now collapseRedundantExtracts merges them, so the
    // capture stays on the single-cred path: ok, ONE credential, ONE
    // (legacy, un-named) extract step.
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://example.com/done",
          title: "Done",
          html: "<html>API key: api_aaaaaaaaaaaaaaaaaaaaaaaaaaaa</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy-1",
            role: "button",
          }),
        ],
        observed: { kind: "extract", reason: "API key in dashboard." },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://example.com/done",
          title: "Done",
          html: "<html>API key: api_aaaaaaaaaaaaaaaaaaaaaaaaaaaa</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy-1",
            role: "button",
          }),
        ],
        // Same observed (kind: extract) — would be collapsed by a
        // naive dedup. Must not be — downstream duplicate-produces
        // detection needs to see both.
        observed: { kind: "extract", reason: "API key in dashboard." },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // Exactly one credential, and it keeps the single-cred (un-named)
    // shape — the multi-cred dispatch must NOT have fired.
    expect(result.skill.credentials).toHaveLength(1);
    expect(result.skill.credentials[0]!.name).toBeUndefined();

    // The redundant second extract collapsed: one legacy extract step,
    // zero named extract steps.
    const legacyExtracts = result.skill.steps.filter(
      (s) => s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
    );
    expect(legacyExtracts).toHaveLength(1);
    const namedExtracts = result.skill.steps.filter(
      (s) =>
        s.kind === "extract_via_copy_button_named" ||
        s.kind === "extract_via_regex_named",
    );
    expect(namedExtracts).toHaveLength(0);
  });
});

describe("pickHrefHint", () => {
  it("returns the path of a nav link's href (axiom Settings)", async () => {
    const { pickHrefHint } = await import("../promote-to-skill.js");
    expect(
      pickHrefHint(inventoryElement({ tag: "a", ariaLabel: "Settings", href: "/ts-6689-z0as/settings" })),
    ).toBe("/ts-6689-z0as/settings");
  });
  it("reduces an absolute href to its pathname", async () => {
    const { pickHrefHint } = await import("../promote-to-skill.js");
    expect(
      pickHrefHint(inventoryElement({ tag: "a", href: "https://app.axiom.co/ts-x/settings?u=1" })),
    ).toBe("/ts-x/settings");
  });
  it("returns null for non-link elements", async () => {
    const { pickHrefHint } = await import("../promote-to-skill.js");
    expect(pickHrefHint(inventoryElement({ tag: "button", href: "/x/settings" }))).toBeNull();
  });
  it("returns null for non-navigational hrefs and bare roots", async () => {
    const { pickHrefHint } = await import("../promote-to-skill.js");
    expect(pickHrefHint(inventoryElement({ tag: "a", href: "mailto:a@b.com" }))).toBeNull();
    expect(pickHrefHint(inventoryElement({ tag: "a", href: "#" }))).toBeNull();
    expect(pickHrefHint(inventoryElement({ tag: "a", href: "/" }))).toBeNull();
    expect(pickHrefHint(inventoryElement({ tag: "a", href: null }))).toBeNull();
  });

  it("synthesizes href_hint from a same-text anchor when the clicked target is an inner element", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://app.openpipe.ai/p/abc123/request-logs",
          title: "Request Logs",
          html: "<html>Project Settings <button>Copy</button> opk_3181b37872f7f1aaf4ebd1ba7ebc7e219fd2948b44</html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            tag: "div",
            visibleText: "Project Settings",
            selector: "a.settings > span > div",
          }),
          inventoryElement({
            tag: "a",
            visibleText: "Project Settings",
            selector: "a.settings",
            href: "/p/abc123/settings",
          }),
        ],
        observed: {
          kind: "click",
          selector: "a.settings > span > div",
          reason: "Open project settings",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://app.openpipe.ai/p/abc123/settings",
          title: "Settings",
          html: "<html><button>Copy</button> opk_3181b37872f7f1aaf4ebd1ba7ebc7e219fd2948b44</html>",
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
        observed: { kind: "extract", reason: "api_key='opk_3181b37872f7f1aaf4ebd1ba7ebc7e219fd2948b44'" },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId, oauthProvider: "google" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const click = result.skill.steps.find((s) => s.kind === "click");
    expect(click).toMatchObject({
      kind: "click",
      text_match: "Project Settings",
      href_hint: "/p/abc123/settings",
    });
  });
});

describe("synthesizeLabeledExtractSteps (Phase-E multi-cred explode)", () => {
  const prov = { run_id: "r", round_index: 0 };
  it("emits one extract_labeled step per credential named in the reason", async () => {
    const { synthesizeLabeledExtractSteps } = await import("../promote-to-skill.js");
    const observed = {
      kind: "extract" as const,
      reason:
        "application_id='EXAMPLEAPPID' and search_api_key='examplesearchkey000000000000002' " +
        "and admin_api_key='exampleadminkey0000000000000002'",
    };
    // The parser validates each value appears on the page; mirror real use.
    const pageText =
      "Application ID EXAMPLEAPPID Search API Key examplesearchkey000000000000002 " +
      "Admin API Key exampleadminkey0000000000000002";
    const steps = synthesizeLabeledExtractSteps(observed, pageText, prov);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => (s.kind === "extract_labeled" ? s.produces : s.kind))).toEqual([
      "application_id",
      "search_api_key",
      "admin_api_key",
    ]);
    expect(steps!.every((s) => s.kind === "extract_labeled")).toBe(true);
    // label_hint is the space-separated form the page renders.
    const appId = steps!.find((s) => s.kind === "extract_labeled" && s.produces === "application_id");
    expect(appId && appId.kind === "extract_labeled" && appId.label_hint).toBe("application id");
  });
  it("collapses labels that share the same value (pusher secret/api_secret/app_secret → one)", async () => {
    const { synthesizeLabeledExtractSteps } = await import("../promote-to-skill.js");
    // Synthetic values only. The pusher planner reports the SAME secret token
    // under three labels; only application_id + app_key + secret are distinct.
    const observed = {
      kind: "extract" as const,
      reason:
        "app_id='example1000001' and app_key='examplekey1234567890' " +
        "and secret='examplesecret0001' and api_secret='examplesecret0001' " +
        "and app_secret='examplesecret0001'",
    };
    const pageText =
      "App ID example1000001 Key examplekey1234567890 Secret examplesecret0001";
    const steps = synthesizeLabeledExtractSteps(observed, pageText, prov);
    expect(steps).not.toBeNull();
    const produces = steps!.map((s) => (s.kind === "extract_labeled" ? s.produces : s.kind));
    // 3 distinct values → 3 steps; the duplicate-value secret labels collapse.
    expect(produces).toEqual(["application_id", "app_key", "secret"]);
    expect(produces).not.toContain("api_secret");
    expect(produces).not.toContain("app_secret");
  });

  it("returns null when two labels collapse to a single distinct value", async () => {
    const { synthesizeLabeledExtractSteps } = await import("../promote-to-skill.js");
    const observed = {
      kind: "extract" as const,
      reason: "api_key='examplekey1234567890' and token='examplekey1234567890'",
    };
    const pageText = "API key examplekey1234567890";
    // Both labels carry one value → not genuinely multi-cred → legacy path.
    expect(synthesizeLabeledExtractSteps(observed, pageText, prov)).toBeNull();
  });

  it("returns null for a single-credential reason (legacy path preserved)", async () => {
    const { synthesizeLabeledExtractSteps } = await import("../promote-to-skill.js");
    const observed = { kind: "extract" as const, reason: "the api_key='re_abc123def456' is shown" };
    expect(synthesizeLabeledExtractSteps(observed, "", prov)).toBeNull();
  });
  it("returns null when the reason names no labeled credentials", async () => {
    const { synthesizeLabeledExtractSteps } = await import("../promote-to-skill.js");
    const observed = { kind: "extract" as const, reason: "credentials are visible on the page" };
    expect(synthesizeLabeledExtractSteps(observed, "", prov)).toBeNull();
  });
});

describe("collapseConsecutiveDuplicateSteps (porter ×N noise)", () => {
  const prov = { run_id: "r", round_index: 0 };

  it("collapses a run of byte-identical consecutive clicks to one (porter Create API token ×3)", async () => {
    const { collapseConsecutiveDuplicateSteps } = await import("../promote-to-skill.js");
    const click = {
      kind: "click" as const,
      text_match: "Create API token",
      role_hint: "button" as const,
      provenance: prov,
    };
    const steps = [
      { kind: "navigate" as const, url: "https://x/api-tokens", provenance: prov },
      { ...click },
      { ...click },
      { ...click },
      { kind: "extract_via_copy_button" as const, near_text_hint: "Your token", provenance: prov },
    ];
    const out = collapseConsecutiveDuplicateSteps(steps);
    const clicks = out.filter((s) => s.kind === "click");
    expect(clicks.length).toBe(1);
    expect(out.map((s) => s.kind)).toEqual(["navigate", "click", "extract_via_copy_button"]);
  });

  it("keeps consecutive clicks that differ in text_match (real flow)", async () => {
    const { collapseConsecutiveDuplicateSteps } = await import("../promote-to-skill.js");
    const steps = [
      { kind: "click" as const, text_match: "Account settings", role_hint: "button" as const, provenance: prov },
      { kind: "click" as const, text_match: "API tokens", role_hint: "link" as const, provenance: prov },
      { kind: "click" as const, text_match: "Create Token", role_hint: "button" as const, provenance: prov },
    ];
    const out = collapseConsecutiveDuplicateSteps(steps);
    expect(out.length).toBe(3);
  });

  it("does NOT collapse consecutive extract steps (multi-cred preserved)", async () => {
    const { collapseConsecutiveDuplicateSteps } = await import("../promote-to-skill.js");
    const steps = [
      { kind: "extract_labeled" as const, label_hint: "app key", produces: "app_key", provenance: prov },
      { kind: "extract_labeled" as const, label_hint: "app key", produces: "app_key", provenance: prov },
    ];
    const out = collapseConsecutiveDuplicateSteps(steps);
    expect(out.length).toBe(2);
  });
});

// ── Email-OTP signups → await_email_code step ───────────────────────

describe("promoteToSkill — email verification (await_email_code)", () => {
  function otpRounds(service: string): OnboardingRoundCapture[] {
    const signupForm = [
      inventoryElement({
        index: 0,
        tag: "input",
        type: "email",
        name: "email",
        placeholder: "Email",
        selector: "input[name='email']",
      }),
      inventoryElement({
        index: 1,
        tag: "button",
        visibleText: "Send code",
        selector: "button.send-code",
        role: "button",
      }),
    ];
    return [
      // The signup-form preamble — captured so the replay graph is
      // self-sufficient (email entered + code dispatched before the wait).
      {
        service,
        round: 0,
        oauth: false,
        state: {
          url: "https://cloud.example.com/signup",
          title: "Sign up",
          html: "<html><body>Sign up</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: signupForm,
        observed: {
          kind: "fill",
          selector: "input[name='email']",
          value: "jane.doe482@trustysquire.ai",
          reason: "Fill the signup email",
        },
      },
      {
        service,
        round: 1,
        oauth: false,
        state: {
          url: "https://cloud.example.com/signup",
          title: "Sign up",
          html: "<html><body>Sign up</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: signupForm,
        observed: {
          kind: "click",
          selector: "button.send-code",
          reason: "Click Send code to dispatch the verification email",
        },
      },
      {
        service,
        round: 2,
        oauth: false,
        state: {
          url: "https://cloud.example.com/signup/verify",
          title: "Verify Your Email",
          html: "<html><body>Enter the verification code we emailed you</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            index: 0,
            tag: "input",
            type: "tel",
            // Deliberately attribute-less — the zilliz OTP box. A `fill`
            // step would hard-reject missing_text_hint here.
            selector: "div > div > div > input",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "div > div > div > input",
          value: "482913",
          reason: "Fill the verification code into the first OTP input box",
        },
      },
      {
        service,
        round: 3,
        oauth: false,
        state: {
          url: "https://cloud.example.com/dashboard/keys",
          title: "API Keys",
          html:
            "<html><body>Your API key db3a32ea-dd1b-4e28-9680-db2991c81e3e " +
            "<button>Copy</button></body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            index: 0,
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
            ariaLabel: "Copy API key",
          }),
        ],
        observed: {
          kind: "extract",
          reason:
            "The API key db3a32ea-dd1b-4e28-9680-db2991c81e3e is visible on the page.",
        },
      },
    ];
  }

  it("synthesizes an OTP-code fill as await_email_code + an ${EMAIL_ALIAS} preamble", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(otpRounds(service));
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const kinds = result.skill.steps.map((s) => s.kind);
    expect(kinds).toContain("await_email_code");
    // The signup email is templatized so replay fills a fresh alias.
    const emailFill = result.skill.steps.find(
      (s) => s.kind === "fill" && s.value_template === "${EMAIL_ALIAS}",
    );
    expect(emailFill).toBeDefined();
    // The stale code must NOT be baked into a fill step.
    const baked = result.skill.steps.some(
      (s) => s.kind === "fill" && s.value_template.includes("482913"),
    );
    expect(baked).toBe(false);
  });

  it("REJECTS an OTP skill whose capture lacks the signup-form preamble", () => {
    // The original zilliz bug: capture began on the verify page, so there's
    // no ${EMAIL_ALIAS} fill before await_email_code → nothing dispatches a
    // code. The replay-graph gate must catch it at synthesis.
    const service = uniqueService();
    const rounds = otpRounds(service).slice(2).map((r, i) => ({ ...r, round: i }));
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.error_kind).toBe("incomplete_replay_graph");
  });

  it("does not synthesize a billing ZIP code fill as await_email_code", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service,
        round: 0,
        oauth: true,
        state: {
          url: "https://console.perplexity.ai/account/setup",
          title: "Set up your API account",
          html: "<html><body>Billing zip code <input placeholder='94102'></body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            index: 0,
            tag: "input",
            placeholder: "94102",
            ariaLabel: "Billing zip code",
            selector: "input.zip",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input.zip",
          value: "94102",
          reason: "Fill in the billing zip code.",
        },
      },
      {
        service,
        round: 1,
        oauth: true,
        state: {
          url: "https://console.perplexity.ai/group/abc/settings",
          title: "API Keys",
          html: "<html><body>API Key pplx-abcdefghijklmnopqrstuvwxyz0123456789</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [],
        observed: {
          kind: "extract",
          reason: "API key pplx-abcdefghijklmnopqrstuvwxyz0123456789 is visible.",
        },
      },
    ];
    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.skill.steps.map((s) => s.kind)).not.toContain("await_email_code");
    const zipFill = result.skill.steps.find(
      (s) => s.kind === "fill" && s.value_template === "94102",
    );
    expect(zipFill).toBeDefined();
  });
});

// ── Duplicate generic placeholder → unique stable name/id ───────────

describe("promoteToSkill — duplicate placeholder disambiguated by name", () => {
  function dupPlaceholderRounds(service: string): OnboardingRoundCapture[] {
    // MUI/antd form: two visible inputs share the generic placeholder
    // "Please input"; each has a distinct `name`. The synthesizer must
    // resolve the fill target by its unique name, not reject ambiguous.
    const formInventory = [
      inventoryElement({
        index: 0,
        tag: "input",
        type: "text",
        name: "firstName",
        placeholder: "Please input",
        selector: "input[name='firstName']",
      }),
      inventoryElement({
        index: 1,
        tag: "input",
        type: "text",
        name: "company",
        placeholder: "Please input",
        selector: "input[name='company']",
      }),
      inventoryElement({
        index: 2,
        tag: "button",
        visibleText: "Copy",
        selector: "button.copy",
        role: "button",
        ariaLabel: "Copy API key",
      }),
    ];
    return [
      {
        service,
        round: 0,
        oauth: false,
        state: {
          url: "https://cloud.example.com/information",
          title: "Set up your account",
          html: "<html><body>Set up your account</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: formInventory,
        observed: {
          kind: "fill",
          selector: "input[name='company']",
          value: "Acme Inc",
          reason: "Fill the required Company field",
        },
      },
      {
        service,
        round: 1,
        oauth: false,
        state: {
          url: "https://cloud.example.com/keys",
          title: "API Keys",
          html:
            "<html><body>Key db3a32ea-dd1b-4e28-9680-db2991c81e3e " +
            "<button>Copy</button></body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          inventoryElement({
            index: 0,
            tag: "button",
            visibleText: "Copy",
            selector: "button.copy",
            role: "button",
            ariaLabel: "Copy API key",
          }),
        ],
        observed: {
          kind: "extract",
          reason:
            "The API key db3a32ea-dd1b-4e28-9680-db2991c81e3e is visible.",
        },
      },
    ];
  }

  it("resolves the fill to the unique name instead of rejecting ambiguous", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(dupPlaceholderRounds(service));
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const fill = result.skill.steps.find((s) => s.kind === "fill");
    expect(fill).toBeDefined();
    if (fill?.kind !== "fill") return;
    // Hint is the unique name "company", NOT the duplicated placeholder.
    expect(fill.label_hint).toBe("company");
  });
});

describe("entry-url: per-account id in the path (Deepgram / Neon)", () => {
  it("hasEphemeralPathSegment catches a project UUID and an org-<digits> slug", () => {
    expect(hasEphemeralPathSegment("/project/68b812fb-f90f-4a08-a235-a64a01123aa9")).toBe(true);
    expect(hasEphemeralPathSegment("/app/org-nameless-base-41435035/projects")).toBe(true);
    // stable pages must NOT trip it
    expect(hasEphemeralPathSegment("/projects")).toBe(false);
    expect(hasEphemeralPathSegment("/settings/api-keys")).toBe(false);
    expect(hasEphemeralPathSegment("/team-settings")).toBe(false);
  });
  it("stableSignupEntryUrl falls back to the origin when the path is account-scoped", () => {
    expect(
      stableSignupEntryUrl("https://console.deepgram.com/project/68b812fb-f90f-4a08-a235-a64a01123aa9/keys", []),
    ).toBe("https://console.deepgram.com/");
    expect(
      stableSignupEntryUrl("https://console.neon.tech/app/org-nameless-base-41435035/projects", []),
    ).toBe("https://console.neon.tech/");
    // a clean url is preserved
    expect(stableSignupEntryUrl("https://app.resend.com/signup", [])).toBe("https://app.resend.com/signup");
  });
});
