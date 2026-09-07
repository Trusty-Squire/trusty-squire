// Operator crash hardening: malformed / erroring operate_* calls must come
// back as clean per-call tool errors, and the server must keep serving the
// NEXT call. A live Hermes-driven checkout run sent a batch of operator calls
// with a wrong action kind and the whole MCP server process went down —
// stranding the host agent ("unreachable after 3 connection attempts"). These
// tests lock the per-call boundary; the process-level unhandledRejection
// backstop is covered in bin-smoke.test.ts against the built artifact.

import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";
import type { ApiClient } from "../api-client.js";
import type { BrowserController } from "../bot/browser.js";
import {
  closeAllProvisionSessions,
  startHarnessProvisionSession,
} from "../bot/provision-session.js";

async function connectedClient(): Promise<Client> {
  const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
  const server = await buildServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "resilience-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join(" ");
}

describe("operate_* bad input is a per-call error, never a server failure", () => {
  it("preserves the same active in-memory session through malformed and unknown calls", async () => {
    const url = "https://operator-resilience.test/checkout";
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      recoverActivePage: vi.fn(),
      armOpenedTabAdoption: vi.fn(),
      adoptOpenedTab: vi.fn(async () => null),
      extractInteractiveElements: vi.fn().mockResolvedValue([]),
      extractVisibleText: vi.fn().mockResolvedValue("Checkout session still active"),
      currentUrl: vi.fn().mockReturnValue(url),
      readCheckoutSummary: vi.fn().mockRejectedValue(new Error("no checkout total")),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserController;
    const started = await startHarnessProvisionSession({ serviceUrl: url, browser });
    const client = await connectedClient();

    try {
      const malformed = await client.callTool({
        name: "operate_click",
        arguments: {
          session_id: started.session_id,
          ref: 2,
        },
      });
      const unknown = await client.callTool({ name: "operate_not_real", arguments: {} });
      const observed = await client.callTool({
        name: "operate_observe",
        arguments: { session_id: started.session_id },
      });

      expect(JSON.parse(resultText(malformed)).error.code).toBe("invalid_arguments");
      expect(JSON.parse(resultText(unknown)).error.code).toBe("unknown_tool");
      expect(observed.isError).not.toBe(true);
      expect(started.text).toBe("Checkout session still active");
      expect(JSON.parse(resultText(observed))).toMatchObject({
        session_id: started.session_id,
        url,
        text_unchanged: true,
      });
      expect(browser.currentUrl).toHaveBeenCalled();
    } finally {
      await client.close();
      await closeAllProvisionSessions();
    }
  });

  it("a removed tool is unknown and the server answers the next flat-verb call", async () => {
    const client = await connectedClient();
    try {
      const bad = await client.callTool({
        name: "operate_act",
        arguments: { session_id: "s1", kind: "set_value" },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(resultText(bad)).error.code).toBe("unknown_tool");
      const next = await client.callTool({
        name: "operate_select",
        arguments: { session_id: "s1", ref: "e1", values: ["2"] },
      });
      expect(next.isError).toBe(true);
      expect(resultText(next)).toContain("unknown provision session");
    } finally {
      await client.close();
    }
  });

  it("a malformed target and a not-ready session each fail their own call cleanly", async () => {
    const client = await connectedClient();
    try {
      const noSession = await client.callTool({
        name: "operate_observe",
        arguments: { session_id: "never-started" },
      });
      expect(noSession.isError).toBe(true);
      expect(resultText(noSession)).toContain("unknown provision session");

      const badTarget = await client.callTool({
        name: "operate_click",
        arguments: { session_id: "never-started" },
      });
      expect(badTarget.isError).toBe(true);
      const { error } = JSON.parse(resultText(badTarget));
      expect(error.code).toBe("invalid_arguments");
      expect(error.message).toContain("ref");
    } finally {
      await client.close();
    }
  });

  it("validates each flat verb before crossing the session boundary", async () => {
    const client = await connectedClient();
    const cases = [
      { name: "operate_type", arguments: { session_id: "s1", ref: "e1" }, message: "text or slot" },
      { name: "operate_select", arguments: { session_id: "s1" }, message: "ref + values" },
      {
        name: "operate_extract",
        arguments: { session_id: "s1", store: { service: "" } },
        message: "store.service",
      },
      {
        name: "operate_scroll",
        arguments: { session_id: "s1", direction: "sideways" },
        message: "direction",
      },
    ];
    try {
      for (const testCase of cases) {
        const result = await client.callTool(testCase);
        expect(result.isError).toBe(true);
        const { error } = JSON.parse(resultText(result));
        expect(error.code).toBe("invalid_arguments");
        expect(error.message).toContain(testCase.message);
      }
    } finally {
      await client.close();
    }
  });

  it("a burst of erroring calls leaves the server reachable", async () => {
    const client = await connectedClient();
    try {
      const burst = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          client.callTool({
            name: "operate_click",
            arguments: { session_id: "s1", ref: i },
          }),
        ),
      );
      for (const result of burst) expect(result.isError).toBe(true);

      // Follow-up succeeds: the process and transport survived the batch.
      const observe = await client.callTool({
        name: "operate_observe",
        arguments: { session_id: "s1" },
      });
      expect(observe.isError).toBe(true);
      expect(resultText(observe)).toContain("unknown provision session");
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
