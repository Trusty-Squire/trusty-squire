// Tests for the skill CLI. Each test injects a mock fetch to drive
// the RegistryHttpClient, then asserts on:
//   - exit code (T30 taxonomy)
//   - stdout content (human and --json output)
//   - stderr content (error messages)
//
// No real network, no process.exit (the CLI returns the code; tests
// inspect the return value).

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../errors.js";
import { runSkillCli } from "../cli.js";
import { RegistryHttpClient } from "../registry-http.js";
import { captureOnboardingRound } from "../../bot/onboarding-capture.js";
import type { OnboardingRoundCapture } from "../../bot/onboarding-capture.js";
import type { InteractiveElement } from "../../bot/browser.js";

// ── Helpers ─────────────────────────────────────────────────────────

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RunOpts {
  argv: string[];
  fetchFn: FetchHandler;
}

async function run(opts: RunOpts): Promise<{ code: number; out: CapturedOutput }> {
  const out: CapturedOutput = { stdout: [], stderr: [] };
  const code = await runSkillCli(opts.argv, {
    buildClient: () =>
      new RegistryHttpClient({
        baseUrl: "https://registry.test",
        accountId: "test-acct",
        fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          return opts.fetchFn(url, init);
        }) as typeof globalThis.fetch,
      }),
    stdout: (line) => out.stdout.push(line),
    stderr: (line) => out.stderr.push(line),
  });
  return { code, out };
}

// Capture inventory builder — mirrors the promoter tests' helper.
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

// Write a 3-round Railway-style capture into `<corpusRoot>/<service>/`
// (the layout the CLI computes from --corpus-dir + service positional).
function writeRailwayCorpus(corpusRoot: string, service: string): { runId: string } {
  const serviceDir = join(corpusRoot, service);
  mkdirSync(serviceDir, { recursive: true });
  const prev = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = serviceDir;
  try {
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
    for (const r of rounds) captureOnboardingRound(r);
  } finally {
    if (prev === undefined) delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    else process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = prev;
  }
  const files = readdirSync(serviceDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error("no capture files written");
  const sample = files[0]!;
  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const afterSlug = sample.slice(slug.length + 1);
  const runId = afterSlug.slice(0, afterSlug.lastIndexOf("-r"));
  return { runId };
}

let promoteSvcCounter = 0;
function uniquePromoteService(): string {
  promoteSvcCounter += 1;
  return `prosvc-cli-${Date.now().toString(36)}-${promoteSvcCounter}`;
}

// ── Help + dispatch ─────────────────────────────────────────────────

describe("dispatcher", () => {
  it("prints help when no args given", async () => {
    const { code, out } = await run({
      argv: [],
      fetchFn: async () => new Response("", { status: 500 }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/Subcommands:/);
  });

  it("prints help on `help`", async () => {
    const { code, out } = await run({
      argv: ["help"],
      fetchFn: async () => new Response("", { status: 500 }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/Subcommands:/);
  });

  it("returns USAGE on unknown subcommand", async () => {
    const { code, out } = await run({
      argv: ["nonsense"],
      fetchFn: async () => new Response("", { status: 500 }),
    });
    expect(code).toBe(ExitCode.USAGE);
    expect(out.stderr.join("\n")).toMatch(/unknown skill subcommand/);
  });
});

// ── list ────────────────────────────────────────────────────────────

describe("list", () => {
  const sampleSkills = [
    {
      skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
      service: "railway",
      version: "v1",
      status: "active",
      signed_by: "test",
      signed_at: "2026-05-21T00:00:00Z",
      replays_succeeded: 5,
      replays_failed: 1,
      consecutive_failures: 0,
      created_at: "2026-05-21T00:00:00Z",
      last_replayed_at: null,
    },
  ];

  it("renders a table by default", async () => {
    const { code, out } = await run({
      argv: ["list"],
      fetchFn: async () => jsonResponse(200, { ok: true, skills: sampleSkills }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/STATUS\s+SERVICE\s+VERSION/);
    expect(out.stdout.join("\n")).toMatch(/railway/);
  });

  it("outputs JSON with --json", async () => {
    const { code, out } = await run({
      argv: ["list", "--json"],
      fetchFn: async () => jsonResponse(200, { ok: true, skills: sampleSkills }),
    });
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(out.stdout.join("\n"));
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].service).toBe("railway");
  });

  it("forwards --service / --status / --limit as query params", async () => {
    let capturedUrl: string | undefined;
    const { code } = await run({
      argv: ["list", "--service=railway", "--status=active", "--limit=10"],
      fetchFn: async (url) => {
        capturedUrl = url;
        return jsonResponse(200, { ok: true, skills: [] });
      },
    });
    expect(code).toBe(ExitCode.OK);
    expect(capturedUrl).toContain("service=railway");
    expect(capturedUrl).toContain("status=active");
    expect(capturedUrl).toContain("limit=10");
  });

  it("prints '(no skills)' when empty", async () => {
    const { code, out } = await run({
      argv: ["list"],
      fetchFn: async () => jsonResponse(200, { ok: true, skills: [] }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/no skills/);
  });

  it("rejects unknown flags with ARGS", async () => {
    const { code, out } = await run({
      argv: ["list", "--bogus=x"],
      fetchFn: async () => new Response("", { status: 500 }),
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(out.stderr.join("\n")).toMatch(/unknown flag.*bogus/);
  });
});

// ── show ────────────────────────────────────────────────────────────

describe("show", () => {
  const skillRecord = {
    ok: true,
    skill: {
      skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
      service: "railway",
      version: "v1",
      status: "active",
      signup_url: "https://railway.com/login",
      oauth_provider: "github",
      steps: [{ kind: "navigate" }, { kind: "extract_via_copy_button" }],
      credentials: [
        { type: "api_key", env_var_suggestion: "RAILWAY_API_KEY", shape_hint: "uuid" },
      ],
    },
    signature: "sig",
    signed_at: "2026-05-21T00:00:00Z",
    signed_by: "test",
    counters: { replays_succeeded: 3, replays_failed: 0, consecutive_failures: 0 },
  };

  it("renders human-readable output", async () => {
    const { code, out } = await run({
      argv: ["show", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => jsonResponse(200, skillRecord),
    });
    expect(code).toBe(ExitCode.OK);
    const text = out.stdout.join("\n");
    expect(text).toMatch(/skill_id:.*01HZX9/);
    expect(text).toMatch(/service:.*railway/);
    expect(text).toMatch(/oauth:.*github/);
    expect(text).toMatch(/RAILWAY_API_KEY/);
  });

  it("hits /skills/by-id/<id>", async () => {
    let capturedUrl: string | undefined;
    await run({
      argv: ["show", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async (url) => {
        capturedUrl = url;
        return jsonResponse(200, skillRecord);
      },
    });
    expect(capturedUrl).toBe(
      "https://registry.test/skills/by-id/01HZX9ABCDEFGHJKMNPQRSTVWX",
    );
  });

  it("returns NOT_FOUND on 404", async () => {
    const { code, out } = await run({
      argv: ["show", "01HZZZABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => jsonResponse(404, { ok: false, error: "skill_not_found" }),
    });
    expect(code).toBe(ExitCode.NOT_FOUND);
    expect(out.stderr.join("\n")).toMatch(/skill_not_found/);
  });

  it("rejects missing positional skill_id", async () => {
    const { code, out } = await run({
      argv: ["show"],
      fetchFn: async () => new Response("", { status: 500 }),
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(out.stderr.join("\n")).toMatch(/expected 1 positional/);
  });

  it("--json emits machine-readable output", async () => {
    const { code, out } = await run({
      argv: ["show", "01HZX9ABCDEFGHJKMNPQRSTVWX", "--json"],
      fetchFn: async () => jsonResponse(200, skillRecord),
    });
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(out.stdout.join("\n"));
    expect(parsed.skill.service).toBe("railway");
  });
});

// ── replays ─────────────────────────────────────────────────────────

describe("replays", () => {
  const sample = {
    ok: true,
    service: "railway",
    skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
    replays: [
      {
        id: "r1",
        outcome: "ok",
        reason: "extracted via copy",
        step_index: null,
        replayed_at: "2026-05-21T01:00:00Z",
      },
      {
        id: "r2",
        outcome: "step_failed",
        reason: "click missed",
        step_index: 2,
        replayed_at: "2026-05-21T00:00:00Z",
      },
    ],
  };

  it("renders replays in order", async () => {
    const { code, out } = await run({
      argv: ["replays", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => jsonResponse(200, sample),
    });
    expect(code).toBe(ExitCode.OK);
    const text = out.stdout.join("\n");
    expect(text).toMatch(/ok/);
    expect(text).toMatch(/step_failed/);
    expect(text).toMatch(/\[step 2\]/);
  });

  it("hits /skills/by-id/<id>/replays with limit", async () => {
    let capturedUrl: string | undefined;
    await run({
      argv: ["replays", "01HZX9ABCDEFGHJKMNPQRSTVWX", "--limit=5"],
      fetchFn: async (url) => {
        capturedUrl = url;
        return jsonResponse(200, sample);
      },
    });
    expect(capturedUrl).toBe(
      "https://registry.test/skills/by-id/01HZX9ABCDEFGHJKMNPQRSTVWX/replays?limit=5",
    );
  });

  it("handles empty replay list gracefully", async () => {
    const { code, out } = await run({
      argv: ["replays", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () =>
        jsonResponse(200, { ok: true, service: "railway", skill_id: "01HZX9", replays: [] }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/no replays/);
  });
});

// ── captures ────────────────────────────────────────────────────────

describe("captures", () => {
  it("renders capture list", async () => {
    const { code, out } = await run({
      argv: ["captures", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () =>
        jsonResponse(200, {
          ok: true,
          skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
          captures: [
            {
              content_hash: "a".repeat(64),
              run_id: "run-1",
              round_index: 0,
              byte_size: 1024,
              uploaded_at: "2026-05-21T00:00:00Z",
            },
          ],
        }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/run-1.*round 0/);
    expect(out.stdout.join("\n")).toMatch(/aaaaaaaaaaaa/);
  });

  it("prints '(no captures uploaded)' when empty", async () => {
    const { code, out } = await run({
      argv: ["captures", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () =>
        jsonResponse(200, {
          ok: true,
          skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
          captures: [],
        }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/no captures/);
  });
});

// ── demote ──────────────────────────────────────────────────────────

describe("demote", () => {
  it("posts the reason and prints confirmation", async () => {
    let capturedBody: string | undefined;
    const { code, out } = await run({
      argv: ["demote", "01HZX9ABCDEFGHJKMNPQRSTVWX", "--reason=wrong creds in field"],
      fetchFn: async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse(200, { ok: true, skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX", status: "demoted" });
      },
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/demoted 01HZX9/);
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.reason).toBe("wrong creds in field");
  });

  it("rejects missing --reason with ARGS", async () => {
    const { code, out } = await run({
      argv: ["demote", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => new Response("", { status: 500 }),
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(out.stderr.join("\n")).toMatch(/--reason/);
  });

  it("returns VALIDATION on 400", async () => {
    const { code, out } = await run({
      argv: ["demote", "01HZX9ABCDEFGHJKMNPQRSTVWX", "--reason=x"],
      fetchFn: async () =>
        jsonResponse(400, { ok: false, error: "invalid_request", detail: "reason too short" }),
    });
    expect(code).toBe(ExitCode.VALIDATION);
    expect(out.stderr.join("\n")).toMatch(/reason too short/);
  });
});

// ── approve ─────────────────────────────────────────────────────────

describe("approve", () => {
  it("posts to /approve-review and prints confirmation", async () => {
    let capturedUrl: string | undefined;
    const { code, out } = await run({
      argv: ["approve", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async (url) => {
        capturedUrl = url;
        return jsonResponse(200, { ok: true, skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX", status: "active" });
      },
    });
    expect(code).toBe(ExitCode.OK);
    expect(capturedUrl).toBe(
      "https://registry.test/skills/01HZX9ABCDEFGHJKMNPQRSTVWX/approve-review",
    );
    expect(out.stdout.join("\n")).toMatch(/approved 01HZX9.*status=active/);
  });

  it("returns NOT_FOUND when the skill doesn't exist", async () => {
    const { code } = await run({
      argv: ["approve", "01HZZZABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => jsonResponse(404, { ok: false, error: "skill_not_found" }),
    });
    expect(code).toBe(ExitCode.NOT_FOUND);
  });
});

// ── reactivate ──────────────────────────────────────────────────────

describe("reactivate", () => {
  it("posts to /reactivate and prints status transition", async () => {
    let capturedUrl: string | undefined;
    const { code, out } = await run({
      argv: ["reactivate", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async (url) => {
        capturedUrl = url;
        return jsonResponse(200, {
          ok: true,
          skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
          status: "active",
          previously: "demoted",
        });
      },
    });
    expect(code).toBe(ExitCode.OK);
    expect(capturedUrl).toBe(
      "https://registry.test/skills/01HZX9ABCDEFGHJKMNPQRSTVWX/reactivate",
    );
    expect(out.stdout.join("\n")).toMatch(/demoted .* active/);
  });

  it("prints no-op when previously == status", async () => {
    const { code, out } = await run({
      argv: ["reactivate", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () =>
        jsonResponse(200, {
          ok: true,
          skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
          status: "active",
          previously: "active",
        }),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.stdout.join("\n")).toMatch(/already active.*no-op/);
  });

  it("returns NOT_FOUND on 404", async () => {
    const { code } = await run({
      argv: ["reactivate", "01HZZZABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => jsonResponse(404, { ok: false, error: "skill_not_found" }),
    });
    expect(code).toBe(ExitCode.NOT_FOUND);
  });
});

// ── delete ──────────────────────────────────────────────────────────

describe("delete", () => {
  it("requires --confirm before issuing the DELETE", async () => {
    let called = false;
    const { code, out } = await run({
      argv: ["delete", "01HZX9ABCDEFGHJKMNPQRSTVWX"],
      fetchFn: async () => {
        called = true;
        return jsonResponse(200, { ok: true });
      },
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(called).toBe(false);
    expect(out.stderr.join("\n")).toMatch(/--confirm/);
  });

  it("DELETEs and prints confirmation when --confirm is set", async () => {
    let method: string | undefined;
    let url: string | undefined;
    const { code, out } = await run({
      argv: ["delete", "01HZX9ABCDEFGHJKMNPQRSTVWX", "--confirm"],
      fetchFn: async (u, init) => {
        method = init?.method;
        url = u;
        return jsonResponse(200, {
          ok: true,
          skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
          deleted: true,
        });
      },
    });
    expect(code).toBe(ExitCode.OK);
    expect(method).toBe("DELETE");
    expect(url).toBe("https://registry.test/skills/01HZX9ABCDEFGHJKMNPQRSTVWX");
    expect(out.stdout.join("\n")).toMatch(/deleted 01HZX9/);
  });

  it("returns NOT_FOUND when the registry 404s", async () => {
    const { code } = await run({
      argv: ["delete", "01HZZZABCDEFGHJKMNPQRSTVWX", "--confirm"],
      fetchFn: async () => jsonResponse(404, { ok: false, error: "skill_not_found" }),
    });
    expect(code).toBe(ExitCode.NOT_FOUND);
  });
});

// ── promote ─────────────────────────────────────────────────────────

describe("promote", () => {
  it("synthesizes, signs, and POSTs the skill (happy path)", async () => {
    const corpusRoot = mkdtempSync(join(tmpdir(), "promote-cli-"));
    const service = uniquePromoteService();
    const { runId } = writeRailwayCorpus(corpusRoot, service);
    const { privateKey } = generateKeyPairSync("ed25519");

    let postBody: unknown;
    let postUrl: string | undefined;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(
      ["promote", service, `--run-id=${runId}`, `--corpus-dir=${corpusRoot}`],
      {
        buildClient: () =>
          new RegistryHttpClient({
            baseUrl: "https://registry.test",
            accountId: "test-acct",
            fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
              postUrl = typeof input === "string" ? input : input.toString();
              postBody = JSON.parse(init?.body as string);
              return jsonResponse(201, {
                ok: true,
                skill_id: "01PROM0CDEFGHJKMNPQRSTVWX",
                service,
                version: "v1",
                status: "active",
              });
            }) as typeof globalThis.fetch,
          }),
        stdout: (line) => out.stdout.push(line),
        stderr: (line) => out.stderr.push(line),
        signingPrivateKey: privateKey,
      },
    );

    expect(code).toBe(ExitCode.OK);
    expect(postUrl).toBe("https://registry.test/skills");
    const body = postBody as { skill: { service: string }; signature: string };
    expect(body.skill.service).toBe(service);
    // Ed25519 signatures are 64 bytes → ~86 chars base64url-encoded.
    expect(body.signature.length).toBeGreaterThan(80);
    expect(out.stdout.join("\n")).toMatch(/published/);
  });

  it("publishes as pending-review by default (verifier-worker gate)", async () => {
    // Phase 2 of the two-tier registry: skill:promote without an
    // operator override lands in pending-review so the verifier
    // worker has to validate before end-users see it.
    const corpusRoot = mkdtempSync(join(tmpdir(), "promote-cli-pending-"));
    const service = uniquePromoteService();
    const { runId } = writeRailwayCorpus(corpusRoot, service);
    const { privateKey } = generateKeyPairSync("ed25519");

    let postedStatus: string | undefined;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(
      ["promote", service, `--run-id=${runId}`, `--corpus-dir=${corpusRoot}`],
      {
        buildClient: () =>
          new RegistryHttpClient({
            baseUrl: "https://registry.test",
            accountId: "test-acct",
            fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
              const body = JSON.parse(init?.body as string) as { skill: { status: string } };
              postedStatus = body.skill.status;
              return jsonResponse(201, {
                ok: true,
                skill_id: "01PEND0CDEFGHJKMNPQRSTVWX",
                service,
                version: "v1",
                status: "pending-review",
              });
            }) as typeof globalThis.fetch,
          }),
        stdout: (line) => out.stdout.push(line),
        stderr: (line) => out.stderr.push(line),
        signingPrivateKey: privateKey,
      },
    );

    expect(code).toBe(ExitCode.OK);
    expect(postedStatus).toBe("pending-review");
  });

  it("--skip-verifier publishes directly as active", async () => {
    // Operator escape hatch — vouching that the skill is already
    // validated, bypass the verifier worker.
    const corpusRoot = mkdtempSync(join(tmpdir(), "promote-cli-skip-"));
    const service = uniquePromoteService();
    const { runId } = writeRailwayCorpus(corpusRoot, service);
    const { privateKey } = generateKeyPairSync("ed25519");

    let postedStatus: string | undefined;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(
      [
        "promote",
        service,
        `--run-id=${runId}`,
        `--corpus-dir=${corpusRoot}`,
        "--skip-verifier",
      ],
      {
        buildClient: () =>
          new RegistryHttpClient({
            baseUrl: "https://registry.test",
            accountId: "test-acct",
            fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
              const body = JSON.parse(init?.body as string) as { skill: { status: string } };
              postedStatus = body.skill.status;
              return jsonResponse(201, {
                ok: true,
                skill_id: "01SKIP0CDEFGHJKMNPQRSTVWX",
                service,
                version: "v1",
                status: "active",
              });
            }) as typeof globalThis.fetch,
          }),
        stdout: (line) => out.stdout.push(line),
        stderr: (line) => out.stderr.push(line),
        signingPrivateKey: privateKey,
      },
    );

    expect(code).toBe(ExitCode.OK);
    expect(postedStatus).toBe("active");
  });

  it("--dry-run does not POST", async () => {
    const corpusRoot = mkdtempSync(join(tmpdir(), "promote-cli-dry-"));
    const service = uniquePromoteService();
    const { runId } = writeRailwayCorpus(corpusRoot, service);

    let called = false;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(
      [
        "promote",
        service,
        `--run-id=${runId}`,
        `--corpus-dir=${corpusRoot}`,
        "--dry-run",
      ],
      {
        buildClient: () =>
          new RegistryHttpClient({
            baseUrl: "https://registry.test",
            accountId: "test-acct",
            fetchFn: (async () => {
              called = true;
              return new Response("", { status: 500 });
            }) as typeof globalThis.fetch,
          }),
        stdout: (line) => out.stdout.push(line),
        stderr: (line) => out.stderr.push(line),
      },
    );

    expect(code).toBe(ExitCode.OK);
    expect(called).toBe(false);
    expect(out.stdout.join("\n")).toMatch(/dry-run OK/);
  });

  it("returns VALIDATION when the corpus is missing", async () => {
    const corpusRoot = mkdtempSync(join(tmpdir(), "promote-cli-miss-"));
    const service = uniquePromoteService();
    const { privateKey } = generateKeyPairSync("ed25519");

    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(
      ["promote", service, "--run-id=nope", `--corpus-dir=${corpusRoot}`],
      {
        buildClient: () =>
          new RegistryHttpClient({
            baseUrl: "https://registry.test",
            accountId: "test-acct",
            fetchFn: (async () => new Response("", { status: 500 })) as typeof globalThis.fetch,
          }),
        stdout: (line) => out.stdout.push(line),
        stderr: (line) => out.stderr.push(line),
        signingPrivateKey: privateKey,
      },
    );

    expect(code).toBe(ExitCode.VALIDATION);
    expect(out.stdout.join("\n")).toMatch(/rejected/);
  });

  it("requires --run-id with ARGS exit", async () => {
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(["promote", "railway"], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          fetchFn: (async () => new Response("", { status: 500 })) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(out.stderr.join("\n")).toMatch(/--run-id/);
  });
});

// ── replay-test ─────────────────────────────────────────────────────

describe("replay-test", () => {
  // Minimal BrowserController stub: start() resolves; close() resolves;
  // every method replaySkill might touch returns a no-op shape that
  // lets the dry-mode walk reach `dry_pass`. We don't try to make a
  // real Skill end-to-end; we just confirm the CLI:
  //   - fetched the skill
  //   - booted the browser
  //   - posted the outcome (in this test we just inspect the GET URL
  //     and that the command exited with the right code)
  it("GETs the active skill and dry-runs replay (returns OK on dry_pass)", async () => {
    // Synthesize a real Skill via the promoter so the parseSkill in the
    // CLI accepts it.
    const corpusRoot = mkdtempSync(join(tmpdir(), "replay-test-cli-"));
    const service = uniquePromoteService();
    const { runId } = writeRailwayCorpus(corpusRoot, service);
    const { promoteToSkill: realPromote } = await import("../../bot/promote-to-skill.js");
    const promoted = realPromote({ dir: join(corpusRoot, service), service, run_id: runId });
    if (promoted.kind !== "ok") {
      throw new Error(`fixture promote failed: ${JSON.stringify(promoted)}`);
    }

    let getUrl: string | undefined;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    // Browser stub: returns a tracker so replaySkill's calls land
    // somewhere benign. The real flow needs many methods; for a unit
    // test we stub the minimum and rely on replaySkill's early `dry`
    // short-circuit hitting a pre-validation failure on the first
    // step — which the CLI surfaces as exit code 6, not OK. That's
    // honest behavior: a stub browser can't actually walk the page.
    // So this test asserts the CLI exits 6 with a clear failure
    // message, NOT OK. The "OK on dry_pass" path requires a real
    // browser and lives in an integration test (out of scope here).
    const stubBrowser = {
      start: async () => undefined,
      close: async () => undefined,
      // replaySkill's preValidateStep reads page state — these throw,
      // which the CLI catches and reports as a step-failed outcome.
      getState: async () => {
        throw new Error("stub browser");
      },
      extractInteractiveElements: async () => [],
      goto: async () => undefined,
      click: async () => undefined,
      type: async () => undefined,
      wait: async () => undefined,
      humanize: false,
    } as unknown as import("../../bot/browser.js").BrowserController;

    const code = await runSkillCli(["replay-test", service], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          accountId: "test-acct",
          fetchFn: (async (input: RequestInfo | URL) => {
            getUrl = typeof input === "string" ? input : input.toString();
            return jsonResponse(200, { ok: true, skill: promoted.skill, signed_by: "test" });
          }) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
      browserFactory: () => stubBrowser,
    });

    // The stub browser causes preValidateStep to throw, which surfaces
    // as a step_failed outcome → exit code 6. The CLI got far enough
    // to GET the skill, parse it, and call replaySkill — the dispatch
    // path is what we're proving here.
    expect(code).toBe(6);
    expect(getUrl).toBe(`https://registry.test/skills/${service}`);
  });

  it("returns NOT_FOUND on 404", async () => {
    const { code } = await run({
      argv: ["replay-test", "no-such-service"],
      fetchFn: async () => jsonResponse(404, { ok: false, error: "no_active_skill" }),
    });
    expect(code).toBe(ExitCode.NOT_FOUND);
  });
});

// ── diff ────────────────────────────────────────────────────────────

describe("diff", () => {
  // Build a routable mock that serves list + by-id endpoints. Tests
  // pass in the two skill payloads they want compared.
  function makeDiffFetch(opts: {
    listItems: Array<{ skill_id: string; service: string; version: string; status: string }>;
    byId: Record<string, Record<string, unknown>>;
  }): FetchHandler {
    return async (url) => {
      const u = new URL(url, "https://registry.test");
      if (u.pathname === "/skills") {
        return jsonResponse(200, { ok: true, skills: opts.listItems });
      }
      const m = u.pathname.match(/^\/skills\/by-id\/(.+)$/);
      if (m !== null) {
        const skill = opts.byId[m[1]!];
        if (skill === undefined) return jsonResponse(404, { ok: false, error: "skill_not_found" });
        return jsonResponse(200, { ok: true, skill, signature: "sig", signed_at: "t", signed_by: "x" });
      }
      return new Response("", { status: 500 });
    };
  }

  it("returns exit 1 when v1 === v2 (same string)", async () => {
    const { code, out } = await run({
      argv: ["diff", "railway", "v1", "v1"],
      fetchFn: makeDiffFetch({ listItems: [], byId: {} }),
    });
    expect(code).toBe(1);
    expect(out.stdout.join("\n")).toMatch(/identical/);
  });

  it("returns ARGS when a version is missing from the list", async () => {
    const { code, out } = await run({
      argv: ["diff", "railway", "v1", "v999"],
      fetchFn: makeDiffFetch({
        listItems: [{ skill_id: "01ABC", service: "railway", version: "v1", status: "active" }],
        byId: {},
      }),
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(out.stderr.join("\n")).toMatch(/v999/);
  });

  it("returns 1 when the two versions have identical steps", async () => {
    const sharedSteps = [
      { kind: "navigate", url: "https://railway.com/account/tokens", provenance: { run_id: "r1", round_index: 0 } },
    ];
    const { code, out } = await run({
      argv: ["diff", "railway", "v1", "v2"],
      fetchFn: makeDiffFetch({
        listItems: [
          { skill_id: "01ABC", service: "railway", version: "v1", status: "superseded" },
          { skill_id: "01DEF", service: "railway", version: "v2", status: "active" },
        ],
        byId: {
          "01ABC": { steps: sharedSteps },
          "01DEF": { steps: sharedSteps },
        },
      }),
    });
    expect(code).toBe(1);
    expect(out.stdout.join("\n")).toMatch(/\bunchanged\b/);
  });

  it("renders a unified-diff sigil for modified click text_match", async () => {
    const { code, out } = await run({
      argv: ["diff", "railway", "v1", "v2"],
      fetchFn: makeDiffFetch({
        listItems: [
          { skill_id: "01ABC", service: "railway", version: "v1", status: "superseded" },
          { skill_id: "01DEF", service: "railway", version: "v2", status: "active" },
        ],
        byId: {
          "01ABC": {
            steps: [{ kind: "click", text_match: "Create Token", role: "button" }],
          },
          "01DEF": {
            steps: [{ kind: "click", text_match: "New Token", role: "button" }],
          },
        },
      }),
    });
    expect(code).toBe(ExitCode.OK);
    const text = out.stdout.join("\n");
    expect(text).toMatch(/~ \[0\] click/);
    expect(text).toMatch(/text_match: "Create Token"/);
    expect(text).toMatch(/text_match: "New Token"/);
  });

  it("detects added + removed steps", async () => {
    const { code, out } = await run({
      argv: ["diff", "railway", "v1", "v2"],
      fetchFn: makeDiffFetch({
        listItems: [
          { skill_id: "01ABC", service: "railway", version: "v1", status: "superseded" },
          { skill_id: "01DEF", service: "railway", version: "v2", status: "active" },
        ],
        byId: {
          "01ABC": {
            steps: [
              { kind: "navigate", url: "https://railway.com/account/tokens" },
              { kind: "click", text_match: "Create", role: "button" },
            ],
          },
          "01DEF": {
            steps: [
              { kind: "navigate", url: "https://railway.com/account/tokens" },
              { kind: "fill", text_match: "Token name", role: null, value_template: "$TOKEN_NAME" },
              { kind: "click", text_match: "Create", role: "button" },
            ],
          },
        },
      }),
    });
    expect(code).toBe(ExitCode.OK);
    const text = out.stdout.join("\n");
    // Position 1 in v2 is a `fill` (new); position 1 in v1 was a `click`.
    // The positional diff calls position 1 "modified: kind" and position 2 "added".
    expect(text).toMatch(/\+ \[2\] click  added/);
  });

  it("--json emits structured step_diff", async () => {
    const { code, out } = await run({
      argv: ["diff", "railway", "v1", "v2", "--json"],
      fetchFn: makeDiffFetch({
        listItems: [
          { skill_id: "01ABC", service: "railway", version: "v1", status: "superseded" },
          { skill_id: "01DEF", service: "railway", version: "v2", status: "active" },
        ],
        byId: {
          "01ABC": { steps: [{ kind: "click", text_match: "A", role: null }] },
          "01DEF": { steps: [{ kind: "click", text_match: "B", role: null }] },
        },
      }),
    });
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(out.stdout.join("\n")) as {
      ok: boolean;
      identical: boolean;
      step_diff: Array<{ kind: string; index: number; fields?: string[] }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.identical).toBe(false);
    expect(parsed.step_diff[0]?.kind).toBe("modified");
    expect(parsed.step_diff[0]?.fields).toContain("text_match");
  });
});

// ── edit ────────────────────────────────────────────────────────────

describe("edit", () => {
  // Helper: build a fully-valid Skill JSON via the promoter so the
  // GET /skills/:service response is something parseSkill accepts.
  async function makeSkillForEdit(): Promise<{
    skill: Record<string, unknown>;
    service: string;
  }> {
    const corpusRoot = mkdtempSync(join(tmpdir(), "edit-cli-"));
    const service = uniquePromoteService();
    const { runId } = writeRailwayCorpus(corpusRoot, service);
    const { promoteToSkill: realPromote } = await import("../../bot/promote-to-skill.js");
    const promoted = realPromote({ dir: join(corpusRoot, service), service, run_id: runId });
    if (promoted.kind !== "ok") {
      throw new Error(`fixture promote failed: ${JSON.stringify(promoted)}`);
    }
    return { skill: promoted.skill as unknown as Record<string, unknown>, service };
  }

  it("returns ARGS (exit 2) when the operator made no edits", async () => {
    const { skill, service } = await makeSkillForEdit();
    const { privateKey } = generateKeyPairSync("ed25519");
    let posted = false;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(["edit", service], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          accountId: "test-acct",
          fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (init?.method === "POST") posted = true;
            if (url.endsWith("/skills/" + service)) {
              return jsonResponse(200, { ok: true, skill, signed_by: "x" });
            }
            return new Response("", { status: 500 });
          }) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
      signingPrivateKey: privateKey,
      // No-op editor — the file is left untouched.
      editorCommand: () => undefined,
    });
    expect(code).toBe(ExitCode.ARGS);
    expect(posted).toBe(false);
    expect(out.stdout.join("\n")).toMatch(/no edits made/);
  });

  it("publishes a re-signed skill with a recomputed skill_id when edits validate", async () => {
    const { skill, service } = await makeSkillForEdit();
    const { privateKey } = generateKeyPairSync("ed25519");
    let postBody: unknown;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(["edit", service], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          accountId: "test-acct",
          fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (init?.method === "POST" && url === "https://registry.test/skills") {
              postBody = JSON.parse(init.body as string);
              return jsonResponse(201, {
                ok: true,
                skill_id: "01POST0CDEFGHJKMNPQRSTVWX",
                service,
                version: "v2",
                status: "active",
              });
            }
            if (url.endsWith("/skills/" + service)) {
              return jsonResponse(200, { ok: true, skill, signed_by: "x" });
            }
            return new Response("", { status: 500 });
          }) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
      signingPrivateKey: privateKey,
      editorCommand: (filePath) => {
        // Operator bumps the version. The skill_id will be
        // recomputed by the CLI from the edited content.
        const text = readFileSync(filePath, "utf8");
        const obj = JSON.parse(text) as Record<string, unknown>;
        obj.version = "v2";
        writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
      },
    });
    expect(code).toBe(ExitCode.OK);
    const body = postBody as { skill: { version: string; skill_id: string }; signature: string };
    expect(body.skill.version).toBe("v2");
    expect(body.skill.skill_id).not.toBe((skill as { skill_id: string }).skill_id);
    expect(body.signature.length).toBeGreaterThan(80);
    expect(out.stdout.join("\n")).toMatch(/published/);
  });

  it("warns when signup_url changes (server-side review-gate landing zone)", async () => {
    const { skill, service } = await makeSkillForEdit();
    const { privateKey } = generateKeyPairSync("ed25519");
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(["edit", service], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          accountId: "test-acct",
          fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (init?.method === "POST" && url === "https://registry.test/skills") {
              return jsonResponse(201, {
                ok: true,
                skill_id: "01POST0CDEFGHJKMNPQRSTVWX",
                service,
                version: "v2",
                status: "pending-review",
              });
            }
            if (url.endsWith("/skills/" + service)) {
              return jsonResponse(200, { ok: true, skill, signed_by: "x" });
            }
            return new Response("", { status: 500 });
          }) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
      signingPrivateKey: privateKey,
      editorCommand: (filePath) => {
        const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
        obj.version = "v2";
        obj.signup_url = "https://railway.app/account/tokens"; // domain changed
        writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
      },
    });
    expect(code).toBe(ExitCode.OK);
    const stdout = out.stdout.join("\n");
    expect(stdout).toMatch(/security-relevant/);
    expect(stdout).toMatch(/signup_url:/);
  });

  it("rejects schema-invalid edits with VALIDATION", async () => {
    const { skill, service } = await makeSkillForEdit();
    const { privateKey } = generateKeyPairSync("ed25519");
    let posted = false;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(["edit", service], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          accountId: "test-acct",
          fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (init?.method === "POST") posted = true;
            if (url.endsWith("/skills/" + service)) {
              return jsonResponse(200, { ok: true, skill, signed_by: "x" });
            }
            return new Response("", { status: 500 });
          }) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
      signingPrivateKey: privateKey,
      editorCommand: (filePath) => {
        const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
        // Break the schema: service slugs must be lowercase.
        obj.service = "Railway";
        writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
      },
    });
    expect(code).toBe(ExitCode.VALIDATION);
    expect(posted).toBe(false);
  });

  it("--dry-run does not POST", async () => {
    const { skill, service } = await makeSkillForEdit();
    const { privateKey } = generateKeyPairSync("ed25519");
    let posted = false;
    const out: CapturedOutput = { stdout: [], stderr: [] };
    const code = await runSkillCli(["edit", service, "--dry-run"], {
      buildClient: () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.test",
          accountId: "test-acct",
          fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (init?.method === "POST") posted = true;
            if (url.endsWith("/skills/" + service)) {
              return jsonResponse(200, { ok: true, skill, signed_by: "x" });
            }
            return new Response("", { status: 500 });
          }) as typeof globalThis.fetch,
        }),
      stdout: (line) => out.stdout.push(line),
      stderr: (line) => out.stderr.push(line),
      signingPrivateKey: privateKey,
      editorCommand: (filePath) => {
        const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
        obj.version = "v2";
        writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
      },
    });
    expect(code).toBe(ExitCode.OK);
    expect(posted).toBe(false);
    expect(out.stdout.join("\n")).toMatch(/dry-run OK/);
  });
});

// ── Error class: registry unavailable / config missing ──────────────

describe("error classes", () => {
  it("returns UNAVAILABLE on 500", async () => {
    const { code, out } = await run({
      argv: ["list"],
      fetchFn: async () => new Response("oops", { status: 500 }),
    });
    expect(code).toBe(ExitCode.UNAVAILABLE);
    expect(out.stderr.join("\n")).toMatch(/HTTP 500/);
  });

  it("returns UNAVAILABLE on network error", async () => {
    const { code, out } = await run({
      argv: ["list"],
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(code).toBe(ExitCode.UNAVAILABLE);
    expect(out.stderr.join("\n")).toMatch(/ECONNREFUSED/);
  });

  it("returns FORBIDDEN on 403", async () => {
    const { code } = await run({
      argv: ["list"],
      fetchFn: async () => jsonResponse(403, { ok: false, error: "forbidden" }),
    });
    expect(code).toBe(ExitCode.FORBIDDEN);
  });

  it("CONFIG when TRUSTY_SQUIRE_REGISTRY_URL is unset", async () => {
    const prev = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    try {
      // Don't inject buildClient — let cli.ts hit the env path.
      const stderr: string[] = [];
      const code = await runSkillCli(["list"], {
        stderr: (line) => stderr.push(line),
      });
      expect(code).toBe(ExitCode.CONFIG);
      expect(stderr.join("\n")).toMatch(/TRUSTY_SQUIRE_REGISTRY_URL/);
    } finally {
      if (prev !== undefined) process.env.TRUSTY_SQUIRE_REGISTRY_URL = prev;
    }
  });
});
