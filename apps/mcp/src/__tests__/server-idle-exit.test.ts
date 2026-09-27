import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { buildServer, createServerCallAdmission, runBoundedServerCleanup } from "../server.js";

describe("server shutdown call admission", () => {
  it("runs terminal cleanup and returns at the deadline when an admitted call is stuck", async () => {
    vi.useFakeTimers();
    try {
      const stuck = new Promise<void>(() => undefined);
      const cleanup = vi.fn(async () => undefined);
      const result = runBoundedServerCleanup(stuck, cleanup, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe("deadline");
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes admission before draining calls that already entered", async () => {
    const admission = createServerCallAdmission();
    expect(admission.started()).toBe(true);
    expect(admission.started()).toBe(true);

    let drained = false;
    const drain = admission.closeAndDrain().then(() => {
      drained = true;
    });

    expect(admission.started()).toBe(false);
    admission.finished();
    await Promise.resolve();
    expect(drained).toBe(false);
    admission.finished();
    await drain;
    expect(drained).toBe(true);
  });

  it("rejects a tool call that arrives after shutdown closes admission", async () => {
    const admission = createServerCallAdmission();
    const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
    const server = await buildServer(api, admission);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "shutdown-admission-test", version: "1" });
    await client.connect(clientTransport);
    await admission.closeAndDrain();
    try {
      const result = await client.callTool({ name: "list_credentials", arguments: {} });
      const text = (result.content as Array<{ text?: string }>)
        .map((entry) => entry.text ?? "")
        .join("");
      expect(JSON.parse(text).error.code).toBe("server_unavailable");
      expect(api.setRequestingAgent).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
