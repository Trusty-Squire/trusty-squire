// Tests for the skill CLI. Each test injects a mock fetch to drive
// the RegistryHttpClient, then asserts on:
//   - exit code (T30 taxonomy)
//   - stdout content (human and --json output)
//   - stderr content (error messages)
//
// No real network, no process.exit (the CLI returns the code; tests
// inspect the return value).

import { describe, expect, it } from "vitest";
import { ExitCode } from "../errors.js";
import { runSkillCli } from "../cli.js";
import { RegistryHttpClient } from "../registry-http.js";

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
