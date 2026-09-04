// The tool-call boundary's answer to "which account am I serving?". A server
// whose own account entry is gone must fail loud instead of falling back to
// whichever account connected most recently.

import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";
import type { ApiClient } from "../api-client.js";
import type { SessionGuard, SessionGuardReport } from "../session-guard.js";

function guardStub(reports: SessionGuardReport[]): SessionGuard {
  const queue = [...reports];
  return {
    bind: async () => null,
    inspect: async () => queue.shift() ?? { problem: null },
    boundAccountId: () => null,
  };
}

async function callThrough(
  guard: SessionGuard,
): Promise<{ code: string; message: string } | undefined> {
  const api = {
    setRequestingAgent: vi.fn(),
    listPaymentCards: vi.fn().mockResolvedValue([]),
  } as unknown as ApiClient;
  const server = await buildServer(api, undefined, undefined, guard);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "session-guard-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "list_payment_cards", arguments: {} });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      error?: { code: string; message: string };
    };
    return payload.error;
  } finally {
    await client.close();
  }
}

describe("tool-call session guard", () => {
  it("refuses the call when this server's own account entry is gone", async () => {
    const error = await callThrough(
      guardStub([
        {
          problem: {
            code: "account_session_missing",
            message:
              "This Trusty Squire server (pid 1595293, v1.1.13-rc.26) is bound to account " +
              "01KS0BKR, but that account no longer has a session on this machine " +
              "(installed: 01M1N0CB). Re-run connect.",
          },
        },
      ]),
    );
    expect(error?.code).toBe("account_session_missing");
    expect(error?.message).toContain("01KS0BKR");
    expect(error?.message).toContain("01M1N0CB");
    expect(error?.message).toContain("connect");
  });

  it("serves the call normally when the account entry is ours and present", async () => {
    expect(await callThrough(guardStub([]))).toBeUndefined();
  });
});
