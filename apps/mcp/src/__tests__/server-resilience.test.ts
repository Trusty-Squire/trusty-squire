// Operator crash hardening: malformed / erroring operate_* calls must come
// back as clean per-call tool errors, and the server must keep serving the
// NEXT call. A live Hermes-driven checkout run sent a batch of operator calls
// with a wrong action kind and the whole MCP server process went down —
// stranding the host agent ("unreachable after 3 connection attempts"). These
// tests lock the per-call boundary; the process-level unhandledRejection
// backstop is covered in bin-smoke.test.ts against the built artifact.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchJournal } from "../bot/broker/dispatch-journal.js";
import type { OperatorForwarder } from "../bot/broker/forwarder.js";
import { createServerCallAdmission } from "../server.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { brokerRecoveryRequested, buildServer } from "../server.js";
import type { ApiClient } from "../api-client.js";
import type { BrowserController } from "../bot/browser.js";
import {
  closeAllProvisionSessions,
  startHarnessProvisionSession,
} from "../bot/provision-session.js";

async function connectedClient(persistence?: Parameters<typeof buildServer>[5]): Promise<Client> {
  const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
  const server = await buildServer(api, undefined, undefined, undefined, undefined, persistence);
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

it("accepts only the exact explicit stale-ref pre-dispatch recovery metadata", () => {
  expect(
    brokerRecoveryRequested({
      "trusty-squire/recover": {
        request_id: "broker-request",
        error: "stale_ref",
        dispatch: "not_dispatched",
      },
    }),
  ).toEqual({
    recover: true,
    preDispatchFailure: {
      requestId: "broker-request",
      error: "stale_ref",
      dispatch: "not_dispatched",
    },
  });
  expect(
    brokerRecoveryRequested({
      "trusty-squire/recover": {
        request_id: "broker-request",
        error: "provider_timeout",
        dispatch: "not_dispatched",
      },
    }),
  ).toEqual({});
  expect(
    brokerRecoveryRequested({
      "trusty-squire/recover": {
        request_id: "broker-request",
        error: "stale_ref",
        dispatch: "unknown",
      },
    }),
  ).toEqual({});
});

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
      activePage: vi.fn().mockReturnValue(null),
      takeOAuthTerminalCompletionUrl: vi.fn().mockReturnValue(null),
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
      expect(JSON.parse(resultText(next)).error).toMatchObject({
        code: "unknown_session",
        retry: { max_attempts: 0, mutation: "do_not_replay" },
      });
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

it("roundtrips flat finish schemas and typed receipts through the MCP SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-receipt-"));
  const path = join(root, "journal.jsonl");
  const client = await connectedClient({
    journal: new DispatchJournal(path),
    lineage: () => "account-lineage",
  });
  const browser = {
    goto: vi.fn().mockResolvedValue(undefined),
    recoverActivePage: vi.fn(),
    armOpenedTabAdoption: vi.fn(),
    adoptOpenedTab: vi.fn(async () => null),
    extractInteractiveElements: vi.fn().mockResolvedValue([]),
    extractVisibleText: vi.fn().mockResolvedValue("Ready"),
    currentUrl: () => "https://schema.test/",
    activePage: () => null,
    takeOAuthTerminalCompletionUrl: () => null,
    readCheckoutSummary: vi.fn().mockRejectedValue(new Error("none")),
    close: vi.fn().mockResolvedValue("closed"),
  } as unknown as BrowserController;
  const started = await startHarnessProvisionSession({
    serviceUrl: "https://schema.test/",
    browser,
  });
  try {
    const listed = await client.listTools();
    const finish = listed.tools.find((tool) => tool.name === "operate_finish");
    expect(finish?.inputSchema.properties?.outcome).toMatchObject({
      type: "string",
      enum: ["none", "credentials", "result"],
    });
    expect(finish?.outputSchema).toMatchObject({
      type: "object",
      properties: { closed: { type: "boolean" } },
    });
    for (const name of [
      "operate_click",
      "operate_type",
      "operate_select",
      "operate_press",
      "operate_extract",
    ]) {
      const tool = listed.tools.find((tool) => tool.name === name);
      expect(tool?.inputSchema.properties?.capture).toMatchObject({
        type: "object",
        required: ["store", "source"],
      });
      expect(tool?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          write_id: { type: "string" },
          stored: { type: "boolean" },
          closed: { type: "boolean" },
        },
      });
    }
    const result = await client.callTool({
      name: "operate_finish",
      arguments: {
        session_id: started.session_id,
        outcome: "result",
        data: { confirmed: true, count: 3 },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      session_id: started.session_id,
      closed: true,
      cleanup: "closed",
      data: { confirmed: true, count: 3 },
    });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
    await client.close();
    const restarted = await connectedClient({
      journal: new DispatchJournal(path),
      lineage: () => "account-lineage",
    });
    const foreign = await connectedClient({
      journal: new DispatchJournal(path),
      lineage: () => "other-lineage",
    });
    try {
      expect(
        (
          await restarted.callTool({
            name: "operate_finish",
            arguments: { session_id: started.session_id },
          })
        ).structuredContent,
      ).toMatchObject({ closed: true, cleanup: "already_closed" });
      expect(
        (
          await foreign.callTool({
            name: "operate_finish",
            arguments: { session_id: started.session_id },
          })
        ).isError,
      ).toBe(true);
      expect(browser.close).toHaveBeenCalledOnce();
    } finally {
      await restarted.close();
      await foreign.close();
    }
  } finally {
    await client.close();
    await closeAllProvisionSessions();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, args, budget] of [
  ["operate_navigate", { session_id: "session", url: "https://example.test/" }, 17_000],
  ["operate_login", { session_id: "session", provider: "google", ref: "@login" }, 17_000],
  ["operate_start", { service_url: "https://example.test/" }, 32_000],
  ["operate_finish", { session_id: "session" }, 5_000],
] as const)
  it(`bounds forwarded ${name} delivery while retaining execution custody`, async () => {
    const admission = createServerCallAdmission();
    let release!: (value: unknown) => void;
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const work = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const forwarder = {
      invoke: vi.fn(async (...input: unknown[]) => {
        signal = input[4] as AbortSignal;
        entered();
        return await work;
      }),
    } as unknown as OperatorForwarder;
    const server = await buildServer(
      { setRequestingAgent: vi.fn() } as unknown as ApiClient,
      admission,
      undefined,
      undefined,
      forwarder,
    );
    const [transport, peer] = InMemoryTransport.createLinkedPair();
    await server.connect(peer);
    const client = new Client({ name: "deadline-test", version: "1" });
    await client.connect(transport);
    vi.useFakeTimers();
    try {
      const response = client.callTool({ name, arguments: args });
      await started;
      await vi.advanceTimersByTimeAsync(budget);
      expect((await response).isError).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(admission.inFlightCount()).toBe(1);
      release({ done: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(admission.inFlightCount()).toBe(0);
    } finally {
      release({});
      vi.useRealTimers();
      await client.close();
      await server.close();
    }
  });
