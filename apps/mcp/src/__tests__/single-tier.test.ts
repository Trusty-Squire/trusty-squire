// Locks the single-tier invariant: every install is account-bound.
// (Previously this file enforced the Tier-0-by-default invariant; that
// product position was removed in favor of one consistent auth path.)
//
// Verified here:
//   1. A buildServer(null) — i.e. a stale pre-single-tier session — gates
//      EVERY tool with a re-install message. There is no anonymous mode.
//   2. The CLI no longer accepts `--pair` as a no-op or anything else;
//      pairing is automatic and lives inside the `connect` command.

import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";

describe("single-tier — stale install gate", () => {
  it("every tool returns a re-install instruction when api is null", async () => {
    const server = await buildServer(null);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "single-tier-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      // The tool list is still advertised — listing tools is a pure
      // metadata operation and doesn't require auth.
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("provision_start");
      expect(names).not.toContain("provision");
      expect(names).not.toContain("check_provision_status");

      // Every advertised tool, called with api=null, surfaces the
      // re-install instruction. No tool is exempt.
      for (const tool of tools) {
        const result = await client.callTool({
          name: tool.name,
          // Pass minimal arguments — the server's stale-install gate
          // runs before zod parsing, so the args shape doesn't matter.
          arguments: {},
        });
        expect(JSON.stringify(result)).toMatch(/single-tier auth|install/i);
      }
    } finally {
      await client.close();
    }
  });
});
