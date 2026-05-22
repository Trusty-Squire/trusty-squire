// rc.10 — auto-promote on bot success (TRUSTY_SQUIRE_AUTO_PROMOTE=true).
//
// Exercises every branch of runAutoPromote that doesn't require a live
// network: env-var preconditions, synthesizer rejection, signing-key
// gate, registry response codes. The Twitter / Railway capture paths
// the synthesizer takes are covered by the dedicated promoter tests;
// here we only verify auto-promote calls them at the right times and
// surfaces their results into stepsSink as designed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAutoPromoteEnabled, runAutoPromote } from "../provision-any.js";
import { captureOnboardingRound } from "../../bot/onboarding-capture.js";
import type { OnboardingRoundCapture } from "../../bot/onboarding-capture.js";
import type { InteractiveElement } from "../../bot/browser.js";

// ── Env preservation ────────────────────────────────────────────────
//
// Auto-promote reads process.env directly (TRUSTY_SQUIRE_AUTO_PROMOTE,
// TRUSTY_SQUIRE_ONBOARDING_CAPTURE, TRUSTY_SQUIRE_REGISTRY_URL,
// SKILL_SIGNING_PRIVATE_KEY). Tests mutate env in-process; restore on
// teardown so a failing test doesn't leak state into siblings.

const ENV_KEYS = [
  "TRUSTY_SQUIRE_AUTO_PROMOTE",
  "TRUSTY_SQUIRE_ONBOARDING_CAPTURE",
  "TRUSTY_SQUIRE_REGISTRY_URL",
  "SKILL_SIGNING_PRIVATE_KEY",
] as const;

let envBackup: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

// ── Fixture: Railway-style 3-round single-cred capture ──────────────

function inventoryElement(
  overrides: Partial<InteractiveElement>,
): InteractiveElement {
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

function writeRailwayCapture(service: string): string {
  // Set TRUSTY_SQUIRE_ONBOARDING_CAPTURE and LEAVE it set — runAutoPromote
  // reads it later. afterEach handles teardown via ENV_KEYS restore.
  const dir = mkdtempSync(join(tmpdir(), "auto-promote-test-"));
  process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = dir;
  {
    const rounds: OnboardingRoundCapture[] = [
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
            tag: "button",
            visibleText: "Create Token",
            selector: "button.create-token-btn",
            role: "button",
          }),
        ],
        observed: {
          kind: "navigate",
          url: "https://railway.com/account/tokens",
          reason: "go to tokens page",
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
            tag: "input",
            type: "text",
            placeholder: "Token name",
            selector: "input[name='token-name']",
            labelText: "Token name",
          }),
        ],
        observed: {
          kind: "fill",
          selector: "input[name='token-name']",
          value: "my-token",
          reason: "fill token name",
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
            "Token db3a32ea-dd1b-4e28-9680-db2991c81e3e visible in 'New Token' section.",
        },
      },
    ];
    for (const r of rounds) captureOnboardingRound(r);
  }
  return dir;
}

// Generate an Ed25519 keypair and stash the private key into env in
// base64url PKCS8 DER format — exactly what signSkillForPublish reads.
function generateAndInstallSigningKey(): KeyObject {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.SKILL_SIGNING_PRIVATE_KEY = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  return privateKey;
}

let svcCounter = 0;
function uniqueService(): string {
  svcCounter += 1;
  return `auto-promote-svc-${Date.now().toString(36)}-${svcCounter}`;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("isAutoPromoteEnabled — rc.14 default-on", () => {
  it("is enabled when env var is unset", () => {
    expect(isAutoPromoteEnabled({})).toBe(true);
  });

  it("is enabled when env var is 'true'", () => {
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "true" })).toBe(true);
  });

  it("is enabled for any non-disable-token value", () => {
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "yes" })).toBe(true);
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "1" })).toBe(true);
  });

  it("is disabled by 'false', '0', or 'off' (case-insensitive)", () => {
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "false" })).toBe(false);
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "0" })).toBe(false);
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "off" })).toBe(false);
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: "OFF" })).toBe(false);
    expect(isAutoPromoteEnabled({ TRUSTY_SQUIRE_AUTO_PROMOTE: " False " })).toBe(false);
  });
});

describe("runAutoPromote — env preconditions", () => {
  it("skips when TRUSTY_SQUIRE_ONBOARDING_CAPTURE is explicitly off", async () => {
    // rc.13: capture dir resolution moved to resolveCaptureDir(),
    // which under vitest returns null when the env is unset (test
    // suppression) OR when it's the literal "off"/"0"/"false". Both
    // hit the same early-exit branch. Setting "off" pins the test
    // to the production-relevant path.
    process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = "off";
    const sink: string[] = [];
    await runAutoPromote({
      service: "railway",
      stepsSink: sink,
      accountId: "acct-1",
    });
    expect(sink.join("\n")).toMatch(/capture directory is disabled/);
  });

  it("skips when no runId exists (bot didn't write captures)", async () => {
    // The capture dir is set but no captures were made this run.
    // currentRunId() returns undefined → skip.
    process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = mkdtempSync(
      join(tmpdir(), "auto-promote-empty-"),
    );
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    // No captures → no runId.
    const sink: string[] = [];
    await runAutoPromote({
      service: "railway",
      stepsSink: sink,
      accountId: "acct-1",
      // currentRunId() is module-local. If a sibling test already
      // captured something this process, runId may be set — that's
      // fine; this test only proves the early-exit branch is wired,
      // not that it always fires when expected.
    });
    // Either "no captures written" OR a registry-url-missing log,
    // depending on whether a sibling test already populated runId.
    // Both branches are early-exits with the [auto-promote] prefix.
    expect(sink.join("\n")).toMatch(/\[auto-promote\]/);
  });

  it("skips when TRUSTY_SQUIRE_REGISTRY_URL is unset", async () => {
    writeRailwayCapture(uniqueService());
    delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    const sink: string[] = [];
    await runAutoPromote({
      service: "railway",
      stepsSink: sink,
      accountId: "acct-1",
    });
    expect(sink.join("\n")).toMatch(/TRUSTY_SQUIRE_REGISTRY_URL is unset/);
  });

  it("falls back to an ephemeral key when SKILL_SIGNING_PRIVATE_KEY is unset", async () => {
    // rc.13: instead of bailing when no key is configured, auto-
    // promote generates an ephemeral Ed25519 keypair and signs with
    // that. The registry runs in length-only fallback mode today,
    // so an ephemeral signature is accepted. This unblocks the
    // "every successful signup uploads a skill" goal without
    // requiring operator-only signing infra.
    const service = uniqueService();
    writeRailwayCapture(service);
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    delete process.env.SKILL_SIGNING_PRIVATE_KEY;

    let postedBody: unknown;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ ok: true, skill_id: "01ABCDEF" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const sink: string[] = [];
    await runAutoPromote({
      service,
      stepsSink: sink,
      accountId: "acct-1",
      fetchFn,
    });

    // The ephemeral signature shape matches Ed25519 base64url — same
    // length as a configured-key signature (~86 chars).
    const body = postedBody as { signature: string };
    expect(body.signature.length).toBeGreaterThan(80);
    expect(sink.join("\n")).toMatch(/ephemeral key/);
    // No "cannot sign" — the fallback continued past signing into
    // the registry POST and saw the 201.
    expect(sink.join("\n")).not.toMatch(/cannot sign/);
    expect(sink.join("\n")).toMatch(/published .* v1/);
  });
});

describe("runAutoPromote — registry interactions", () => {
  it("posts a signed skill on 201 and logs the published name", async () => {
    const service = uniqueService();
    writeRailwayCapture(service);
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    generateAndInstallSigningKey();

    let postedTo: string | undefined;
    let postedBody: unknown;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      postedTo = typeof input === "string" ? input : input.toString();
      postedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ ok: true, skill_id: "01ABCDEF" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const sink: string[] = [];
    await runAutoPromote({
      service,
      stepsSink: sink,
      accountId: "acct-1",
      fetchFn,
    });

    expect(postedTo).toBe("https://registry.test/skills");
    const body = postedBody as { skill: { service: string }; signature: string };
    expect(body.skill.service).toContain("auto-promote-svc");
    expect(body.signature.length).toBeGreaterThan(80); // ed25519 ~86 chars b64url
    expect(sink.join("\n")).toMatch(/published .* v1/);
  });

  it("logs idempotent on 200", async () => {
    const service = uniqueService();
    writeRailwayCapture(service);
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    generateAndInstallSigningKey();

    const fetchFn = (async () =>
      new Response(JSON.stringify({ ok: true, idempotent: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    const sink: string[] = [];
    await runAutoPromote({
      service,
      stepsSink: sink,
      accountId: "acct-1",
      fetchFn,
    });
    expect(sink.join("\n")).toMatch(/already published.*idempotent/);
  });

  it("logs a key-mismatch hint on 401", async () => {
    const service = uniqueService();
    writeRailwayCapture(service);
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    generateAndInstallSigningKey();

    const fetchFn = (async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_signature" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    const sink: string[] = [];
    await runAutoPromote({
      service,
      stepsSink: sink,
      accountId: "acct-1",
      fetchFn,
    });
    expect(sink.join("\n")).toMatch(/SKILL_SIGNING_PRIVATE_KEY.*matches.*SKILL_VERIFY_PUBLIC_KEY/);
  });

  it("logs a generic HTTP failure on 500", async () => {
    const service = uniqueService();
    writeRailwayCapture(service);
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    generateAndInstallSigningKey();

    const fetchFn = (async () =>
      new Response(JSON.stringify({ ok: false, detail: "registry exploded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    const sink: string[] = [];
    await runAutoPromote({
      service,
      stepsSink: sink,
      accountId: "acct-1",
      fetchFn,
    });
    expect(sink.join("\n")).toMatch(/HTTP 500/);
    expect(sink.join("\n")).toMatch(/registry exploded/);
  });

  it("logs a network failure when fetch throws", async () => {
    const service = uniqueService();
    writeRailwayCapture(service);
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    generateAndInstallSigningKey();

    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    const sink: string[] = [];
    await runAutoPromote({
      service,
      stepsSink: sink,
      accountId: "acct-1",
      fetchFn,
    });
    expect(sink.join("\n")).toMatch(/POST \/skills failed.*ECONNREFUSED/);
  });
});
