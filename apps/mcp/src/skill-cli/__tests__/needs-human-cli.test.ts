// T8 — `mcp skill needs-human`: reads the admin-gated /admin/needs-human
// worklist (T6). Admin-bearer-authed via REGISTRY_ADMIN_BEARER with its
// own fetch (the shared client only carries x-account-id), so these tests
// stub global fetch + env rather than the client.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSkillCli } from "../cli.js";

const REGISTRY = "https://registry.test";

describe("skill needs-human (T8)", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = REGISTRY;
  });
  afterEach(() => {
    process.env = savedEnv;
    vi.unstubAllGlobals();
  });

  async function run(argv: string[]): Promise<{ code: number; out: string[] }> {
    const out: string[] = [];
    const code = await runSkillCli(argv, { stdout: (l) => out.push(l), stderr: () => {} });
    return { code, out };
  }

  it("errors CONFIG (65) when REGISTRY_ADMIN_BEARER is unset", async () => {
    delete process.env.REGISTRY_ADMIN_BEARER;
    const { code } = await run(["needs-human"]);
    expect(code).toBe(65);
  });

  it("authes with the bearer and prints the worklist", async () => {
    process.env.REGISTRY_ADMIN_BEARER = "admin-secret";
    const seen: { url: string; auth: string | null } = { url: "", auth: null };
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen.url = String(url);
      const h = new Headers(init?.headers);
      seen.auth = h.get("authorization");
      return new Response(
        JSON.stringify({
          ok: true,
          count: 2,
          items: [
            { service: "neon", skill_id: "01A", status: "demoted", reason: "rot:step_failed", needs: "rediscovery-or-manual", last_attempt_at: "2026-06-02T10:00:00Z", verifier_failed: 3 },
            { service: "cloudflare", skill_id: "01B", status: "quarantined", reason: "wall:captcha_blocked", needs: "manual", last_attempt_at: "2026-06-02T09:00:00Z", verifier_failed: 1 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const { code, out } = await run(["needs-human"]);
    expect(code).toBe(0);
    expect(seen.url).toContain("/admin/needs-human");
    expect(seen.auth).toBe("Bearer admin-secret");
    const text = out.join("\n");
    expect(text).toMatch(/neon/);
    expect(text).toMatch(/rot:step_failed/);
    expect(text).toMatch(/cloudflare/);
    expect(text).toMatch(/wall:captcha_blocked/);
    expect(text).toMatch(/2 service\(s\) need a human/);
  });

  it("reports a healthy registry when the worklist is empty", async () => {
    process.env.REGISTRY_ADMIN_BEARER = "admin-secret";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: true, count: 0, items: [] }), { status: 200 }),
    );
    const { code, out } = await run(["needs-human"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/healthy/);
  });

  it("--json emits the raw payload", async () => {
    process.env.REGISTRY_ADMIN_BEARER = "admin-secret";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: true, count: 0, items: [] }), { status: 200 }),
    );
    const { code, out } = await run(["needs-human", "--json"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/"items"/);
  });

  it("maps a 401 to CONFIG", async () => {
    process.env.REGISTRY_ADMIN_BEARER = "wrong";
    vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
    const { code } = await run(["needs-human"]);
    expect(code).toBe(65);
  });
});
