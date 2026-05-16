// Locks the Tier-0 zero-friction invariant (TODOS.md A1 hard constraint).
//
// The universal-bot → mcp bundling merge must NOT reintroduce signup or
// pairing gating. Guarded here:
//   1. `install` issues an anonymous machine token — it never pairs
//      unless the user explicitly passes --pair.
//   2. At Tier 0 (no paired account → buildServer(null)) the server
//      still exposes `provision_any_service`, while account-scoped
//      tools are turned away at the Tier-1 pairing gate.
//
// The server gate is verified through an account-scoped tool
// (get_credential) because the server returns the pairing error
// *before* invoking that tool's handler — side-effect-free. We do not
// invoke provision_any_service's handler here: at Tier 0 it dispatches
// straight into the live bot (network + browser), which is exercised
// by the bot's own __tests__ suite, not a server unit test.

import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";
import { parseArgs } from "../install/cli.js";

describe("Tier 0 — install is anonymous (no pairing)", () => {
  it("`install` does not pair by default", () => {
    expect(parseArgs(["install"]).withPair).toBe(false);
    expect(parseArgs(["install", "--target=claude-code"]).withPair).toBe(false);
  });

  it("pairing is opt-in only, via --pair", () => {
    expect(parseArgs(["install", "--pair"]).withPair).toBe(true);
  });
});

describe("Tier 0 — server tool gate is selective", () => {
  it("exposes provision_any_service and gates account-scoped tools", async () => {
    // buildServer(null) = Tier 0: no paired account, no ApiClient.
    const server = await buildServer(null);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "tier0-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      // The free-tier bot tool stays available with no account.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("provision_any_service");

      // An account-scoped tool, called at Tier 0, is turned away at the
      // pairing gate — the server returns before invoking the handler.
      const gated = await client.callTool({
        name: "get_credential",
        arguments: { reference: "ref", purpose: "tier0 gate test" },
      });
      expect(JSON.stringify(gated)).toMatch(/requires pairing|Tier 1/i);
    } finally {
      await client.close();
    }
  });
});
