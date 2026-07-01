// End-to-end proof of the operator-hints loop (docs/DESIGN-operator-hints.md):
// a captured provision → promoteToSkill synthesis → renderSkillHint guidance,
// driven through the REAL pipeline (captureOnboardingRound writes the integrity-
// chained rounds; promoteToSkill reads them; renderSkillHint projects the skill).
//
// The one thing no automated test can cover is a live-browser signup against a
// real site. Everything downstream of the capture is proven here.

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureOnboardingRound,
  type OnboardingRoundCapture,
} from "../onboarding-capture.js";
import { promoteToSkill } from "../promote-to-skill.js";
import { captureObserved, buildProvisionMeasurement, captureServiceSlug } from "../provision-session.js";
import { renderSkillHint, serviceSlugFromUrl } from "../skill-hint.js";
import type { InteractiveElement } from "../browser.js";
import type { Skill } from "@trusty-squire/skill-schema";

function el(overrides: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0, tag: "button", type: null, id: null, name: null, placeholder: null,
    ariaLabel: null, role: null, labelText: null, visibleText: null,
    selector: "button", visible: true, inViewport: true, inConsentWidget: false,
    value: null, title: null, href: null,
    ...overrides,
  };
}

let counter = 0;
function uniqueService(): string {
  counter += 1;
  return `hintsvc-${Date.now().toString(36)}-${counter}`;
}

// Write rounds through the real capture path, return the synthesizer inputs.
function setupCaptures(rounds: OnboardingRoundCapture[]): {
  dir: string; service: string; runId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "hints-e2e-"));
  const prev = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = dir;
  try {
    for (const r of rounds) captureOnboardingRound(r);
  } finally {
    if (prev === undefined) delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    else process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = prev;
  }
  const sample = readdirSync(dir).find((f) => f.endsWith(".json"));
  if (sample === undefined) throw new Error("setupCaptures wrote no files");
  const service = rounds[0]!.service;
  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const afterSlug = sample.slice(slug.length + 1);
  const runId = afterSlug.slice(0, afterSlug.lastIndexOf("-r"));
  return { dir, service, runId };
}

// A 3-round signup: OAuth (with a provider MENU) → navigate to keys → extract.
function oauthSignupRounds(
  service: string,
  opts: { githubOffered: boolean },
): OnboardingRoundCapture[] {
  const oauthInventory: InteractiveElement[] = [
    el({ index: 0, tag: "button", role: "button", visibleText: "Continue with Google", selector: "button.oauth-google" }),
  ];
  if (opts.githubOffered) {
    oauthInventory.push(
      el({ index: 1, tag: "button", role: "button", visibleText: "Continue with GitHub", selector: "button.oauth-github" }),
    );
  }
  return [
    {
      service, round: 0, oauth: true,
      state: {
        url: "https://svc.example.com/signup", title: "Sign up",
        html: "<html><body>Continue with Google Continue with GitHub</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: oauthInventory,
      observed: { kind: "click", selector: "button.oauth-google", reason: "Continue with Google" },
    },
    {
      service, round: 1, oauth: true,
      state: {
        url: "https://svc.example.com/account/tokens", title: "API Tokens",
        html: "<html><body>Create Token</body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        el({ index: 0, tag: "button", role: "button", visibleText: "Create Token", selector: "button.create-token" }),
      ],
      observed: { kind: "click", selector: "button.create-token", reason: "Create a new API token" },
    },
    {
      service, round: 2, oauth: true,
      state: {
        url: "https://svc.example.com/account/tokens", title: "API Tokens",
        html:
          "<html><body>New Token db3a32ea-dd1b-4e28-9680-db2991c81e3e " +
          "<button>Copy</button></body></html>",
        screenshot: "data:image/png;base64,iVBORw0KGgo=",
      },
      inventory: [
        el({ index: 0, tag: "button", role: "button", visibleText: "Copy", ariaLabel: "Copy to clipboard", selector: "button.copy-token" }),
      ],
      observed: {
        kind: "extract",
        reason: "The full API token db3a32ea-dd1b-4e28-9680-db2991c81e3e is shown; copy it now.",
      },
    },
  ];
}

function oauthStep(skill: Skill): Extract<Skill["steps"][number], { kind: "click_oauth_button" }> {
  const s = skill.steps.find((x) => x.kind === "click_oauth_button");
  if (s === undefined || s.kind !== "click_oauth_button") throw new Error("no click_oauth_button step synthesized");
  return s;
}

describe("operator-hints E2E: capture → synthesize → render", () => {
  it("records the OAuth menu (available[]) and surfaces it as guidance", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(oauthSignupRounds(service, { githubOffered: true }));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // Synthesizer: the login step carries the whole menu the page offered.
    const step = oauthStep(result.skill);
    expect(step.provider).toBe("google");
    expect(step.available).toEqual(["google", "github"]);

    // Renderer: the operator is told which providers the service offers.
    const hint = renderSkillHint(result.skill);
    expect(hint).toContain("offers sign-in with: google, github");
    expect(hint).toContain("this run used google");
    // And the durable post-auth route to the key is still there.
    expect(hint).toContain("the key");
  });

  it("omits available[] when only one provider was offered (byte-equivalence guard)", () => {
    const service = uniqueService();
    const { dir, runId } = setupCaptures(oauthSignupRounds(service, { githubOffered: false }));

    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const step = oauthStep(result.skill);
    expect(step.provider).toBe("google");
    // A single-option menu is redundant with `provider` — omitted, so pre-
    // `available` skills stay byte-identical.
    expect(step.available).toBeUndefined();

    // Renderer falls back to [provider] and still names the option.
    expect(renderSkillHint(result.skill)).toContain("offers sign-in with: google");
  });

  it("PII gate: a typed identity value is redacted, never baked into the shared skill", () => {
    const service = uniqueService();
    const rounds: OnboardingRoundCapture[] = [
      {
        service, round: 0, oauth: false,
        state: {
          url: "https://svc.example.com/signup", title: "Sign up",
          html: "<html><body>Full name Create account</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          el({ index: 0, tag: "input", type: "text", labelText: "Full name", placeholder: "Full name", selector: "#full-name" }),
          el({ index: 1, tag: "button", role: "button", visibleText: "Create account", selector: "button.submit" }),
        ],
        observed: { kind: "fill", selector: "#full-name", value: "Jane Doe", reason: "Fill the full name to sign up" },
      },
      {
        service, round: 1, oauth: false,
        state: {
          url: "https://svc.example.com/account/tokens", title: "API Tokens",
          html: "<html><body>Create Token</body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          el({ index: 0, tag: "button", role: "button", visibleText: "Create Token", selector: "button.create-token" }),
        ],
        observed: { kind: "click", selector: "button.create-token", reason: "Create a new API token" },
      },
      {
        service, round: 2, oauth: false,
        state: {
          url: "https://svc.example.com/account/tokens", title: "API Tokens",
          html:
            "<html><body>New Token db3a32ea-dd1b-4e28-9680-db2991c81e3e " +
            "<button>Copy</button></body></html>",
          screenshot: "data:image/png;base64,iVBORw0KGgo=",
        },
        inventory: [
          el({ index: 0, tag: "button", role: "button", visibleText: "Copy", ariaLabel: "Copy to clipboard", selector: "button.copy-token" }),
        ],
        observed: { kind: "extract", reason: "The full API token db3a32ea-dd1b-4e28-9680-db2991c81e3e is shown; copy it now." },
      },
    ];

    const { dir, runId } = setupCaptures(rounds);
    const result = promoteToSkill({ dir, service, run_id: runId });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // The deny assertion: the run's typed name is nowhere in the shared skill.
    expect(JSON.stringify(result.skill)).not.toContain("Jane Doe");
    // The name field's value was templatized to the identity slot.
    const fillStep = result.skill.steps.find((s) => s.kind === "fill");
    expect(fillStep).toBeDefined();
    if (fillStep !== undefined && "value_template" in fillStep) {
      expect(fillStep.value_template).toBe("${IDENTITY}");
    }
  });
});

describe("producer: operate action → capture round mapping (captureObserved)", () => {
  const el = (selector: string): InteractiveElement => ({
    index: 0, tag: "button", type: null, id: null, name: null, placeholder: null,
    ariaLabel: null, role: null, labelText: null, visibleText: "Continue",
    selector, visible: true, inViewport: true, inConsentWidget: false,
    value: null, title: null, href: null,
  });

  it("maps click / type / goto / oauth_click to the right synthesizer step", () => {
    expect(captureObserved({ kind: "click", target: "x" }, el("#btn"))).toMatchObject({ kind: "click", selector: "#btn" });
    expect(captureObserved({ kind: "js_click", target: "x" }, el("#btn"))).toMatchObject({ kind: "click", selector: "#btn" });
    expect(captureObserved({ kind: "oauth_click", target: "x" }, el("#g"))).toMatchObject({ kind: "click", selector: "#g" });
    expect(captureObserved({ kind: "type", target: "x", text: "hello" }, el("#in"))).toMatchObject({ kind: "fill", selector: "#in", value: "hello" });
    expect(captureObserved({ kind: "goto", url: "https://svc.example.com/keys" }, null)).toMatchObject({ kind: "navigate", url: "https://svc.example.com/keys" });
  });

  it("drops non-synthesizable actions (press) — the safety default, never a phantom step", () => {
    expect(captureObserved({ kind: "press", key: "Enter" }, null)).toBeNull();
    // A click with no resolved element can't produce a targetable step.
    expect(captureObserved({ kind: "click", target: "x" }, null)).toBeNull();
  });
});

describe("producer: service slug (regression — captureService returned a dotted host → schema_invalid)", () => {
  it("produces a valid dot-free SkillSchema slug that MATCHES the hint-lookup slug", () => {
    // The bug: captureService used registrableHost → "resend.com", which fails
    // SkillSchema's service regex (^[a-z0-9][a-z0-9-]*$, no dots) so parseSkill
    // rejected EVERY real provision's synthesized skill as schema_invalid, and
    // even a valid slug had to equal serviceSlugFromUrl or the loop wouldn't close.
    for (const url of [
      "https://resend.com/signup",
      "https://www.railway.com/",
      "https://console.neon.tech/signup",
    ]) {
      const slug = captureServiceSlug(url);
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/); // valid SkillSchema service slug (no dots)
      expect(slug).toBe(serviceSlugFromUrl(url)); // == what resolveRouteHint looks up → loop closes
    }
  });
});

describe("deliverable #1: hint-lift measurement", () => {
  it("computes the measurement row (hint_present, outcome, duration, turns)", () => {
    expect(
      buildProvisionMeasurement({
        service: "firebase", hintServed: true, outcome: "success",
        startedAt: 1_000_000, now: 1_090_000, turns: 7,
      }),
    ).toEqual({ service: "firebase", hint_present: true, outcome: "success", duration_s: 90, turns: 7 });
  });

  it("clamps a negative duration and reflects hint_present=false", () => {
    const m = buildProvisionMeasurement({
      service: "x", hintServed: false, outcome: "fail",
      startedAt: 2_000, now: 1_000, turns: 0,
    });
    expect(m.duration_s).toBe(0);
    expect(m.hint_present).toBe(false);
    expect(m.outcome).toBe("fail");
  });
});
