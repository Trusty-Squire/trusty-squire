import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GoogleLoginModule from "../../bot/google-login.js";
import type * as ProfileModule from "../../bot/profile.js";

vi.mock("keytar", () => {
  throw new Error("keytar disabled in tests");
});

vi.mock("../../bot/google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleLoginModule>();
  return {
    ...actual,
    detectActiveProviderSessions: vi.fn(async () => {
      throw new Error("profile is in use by another Trusty Squire session");
    }),
  };
});

vi.mock("../../bot/profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfileModule>();
  return {
    ...actual,
    profilePathIdentity: vi.fn((profileDir: string) => profileDir),
    withProfileOperationGuard: vi.fn(
      async <T>(_profileDir: string, operation: () => Promise<T>): Promise<T> => await operation(),
    ),
  };
});

import { connect } from "../cli.js";
import { AGENTS } from "../agents.js";

let tmpHome: string;
let originalHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-unverified-preflight-"));
  process.env.HOME = tmpHome;
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, "trusty-squire"), { recursive: true });
  await fs.writeFile(
    path.join(process.env.XDG_CONFIG_HOME, "trusty-squire", "session.json"),
    JSON.stringify({
      api_base_url: "https://api.example.test",
      saved_at: "2026-09-04T00:00:00.000Z",
      machine_token: "machine-token",
      agent_session_token: "agent-token",
      account_id: "account-id",
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("connect unverified preflight", () => {
  it("refreshes host config without claiming the machine is connected", async () => {
    const output: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      output.push(String(message));
    });
    try {
      await connect({
        command: "connect",
        target: "cursor",
        apiBase: "https://api.example.test",
        skipBrowser: false,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
      });
    } finally {
      warn.mockRestore();
    }

    const config = JSON.parse(await fs.readFile(AGENTS.cursor.config_path(), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(config.mcpServers?.squire).toBeDefined();
    expect(output.join("\n")).toContain("profile is in use by another Trusty Squire session");
    expect(output.join("\n")).not.toContain("Already connected");
  });
});
