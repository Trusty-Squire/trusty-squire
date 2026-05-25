// rc.5 — SessionData.connected_providers round-trip + backwards
// compatibility with pre-rc.5 session files that lack the field.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStorage } from "../session.js";

let tmpFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-sess-cp-"));
  tmpFile = path.join(dir, "session.json");
});

afterEach(async () => {
  await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
});

describe("SessionData.connected_providers (rc.5)", () => {
  it("round-trips an empty list", async () => {
    const store = new FileStorage(tmpFile);
    await store.write({
      api_base_url: "https://api.test",
      saved_at: "2026-05-25T00:00:00Z",
      connected_providers: [],
    });
    const back = await store.read();
    expect(back?.connected_providers).toEqual([]);
  });

  it("round-trips both google and github in order", async () => {
    const store = new FileStorage(tmpFile);
    await store.write({
      api_base_url: "https://api.test",
      saved_at: "2026-05-25T00:00:00Z",
      connected_providers: ["google", "github"],
    });
    const back = await store.read();
    expect(back?.connected_providers).toEqual(["google", "github"]);
  });

  it("reads a pre-rc.5 session that omits connected_providers", async () => {
    // Simulate a session.json written by an older client — same
    // shape minus the new field. The file is valid JSON; reading
    // it must yield undefined for connected_providers (not crash).
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        api_base_url: "https://api.test",
        saved_at: "2026-05-01T00:00:00Z",
        machine_token: "tsm_old_token",
        agent_session_token: "mcp_sess_old",
        account_id: "acc_old",
      }),
      "utf8",
    );
    const back = await new FileStorage(tmpFile).read();
    expect(back).not.toBeNull();
    expect(back?.machine_token).toBe("tsm_old_token");
    expect(back?.connected_providers).toBeUndefined();
  });
});
