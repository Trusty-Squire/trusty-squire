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
        name: "operate_act",
        arguments: {
          session_id: started.session_id,
          kind: "set_value",
          target: "この商品のみ注文",
          text: "2",
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

  it("an unsupported action kind returns a structured error naming the valid kinds — and the server answers the next call", async () => {
    const client = await connectedClient();
    try {
      // The exact shape from the live incident: `set_value` where `select`
      // was needed, mid-checkout, Japanese UI labels as targets.
      const bad = await client.callTool({
        name: "operate_act",
        arguments: { session_id: "s1", kind: "set_value", target: "この商品のみ注文", text: "2" },
      });
      expect(bad.isError).toBe(true);
      const { error } = JSON.parse(resultText(bad));
      expect(error.code).toBe("invalid_arguments");
      const repair = error.guidance;
      expect(repair).toEqual(
        expect.objectContaining({
          error: "invalid_action_arguments",
          supplied_kind: "set_value",
          missing: ["kind"],
          example: expect.any(Object),
          safe_alternative: expect.any(String),
        }),
      );
      expect(repair.allowed_kinds).toEqual(
        expect.arrayContaining(["click", "type", "select", "goto", "press", "scroll", "upload"]),
      );

      // The transport survived: the very next call gets a real answer.
      const next = await client.callTool({
        name: "operate_act",
        arguments: { session_id: "s1", kind: "select", target: "e1", text: "2" },
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
        name: "operate_act",
        arguments: { session_id: "never-started", kind: "click" },
      });
      expect(badTarget.isError).toBe(true);
      // Schema repair names the missing field before the session lookup runs.
      const { error } = JSON.parse(resultText(badTarget));
      expect(error.code).toBe("invalid_arguments");
      const repair = error.guidance;
      expect(repair).toEqual(
        expect.objectContaining({
          error: "invalid_action_arguments",
          allowed_kinds: expect.any(Array),
          missing: expect.arrayContaining(["target"]),
          example: expect.any(Object),
          safe_alternative: expect.any(String),
        }),
      );
    } finally {
      await client.close();
    }
  });

  it("repairs every consolidated action kind without crossing workflow boundaries", async () => {
    const client = await connectedClient();
    const cases = [
      {
        arguments: { session_id: "s1", kind: "cart_add" },
        example: {
          session_id: "<session_id>",
          kind: "cart_add",
          product_identity: "<canonical-product-identity>",
          options_hash: "<selected-options-hash>",
          idempotency_key: "<stable-idempotency-key>",
        },
        guidance: [/same stable idempotency_key/i, /exact-line post-verifies/i],
      },
      {
        arguments: { session_id: "s1", kind: "select_many" },
        example: {
          session_id: "<session_id>",
          kind: "select_many",
          selections: { "Observed field label": "Visible option label" },
        },
        guidance: [/intended order/i, /re-observes after each success/i, /partial results/i],
      },
      {
        arguments: { session_id: "s1", kind: "extract", store: { service: "" } },
        example: {
          session_id: "<session_id>",
          kind: "extract",
          into_slot: "sealed_secret",
          secret_label: "API key",
        },
        guidance: [/without exposing it/i, /never put credential values in arguments/i, /masked/i],
      },
      {
        arguments: { session_id: "", kind: "solve_captcha" },
        example: { session_id: "<session_id>", kind: "solve_captcha" },
        guidance: [/dedicated solver/i, /needs_user/i, /stop driving/i],
      },
      {
        arguments: { session_id: "s1", kind: "await_verification", sender: "" },
        example: {
          session_id: "<session_id>",
          kind: "await_verification",
          sender: "service.example",
          into_slot: "otp",
          grant_inbox_consent: false,
        },
        guidance: [/OTP stays sealed/i, /explicitly agrees/i, /grant_inbox_consent:true/i],
      },
    ];

    try {
      for (const testCase of cases) {
        const result = await client.callTool({
          name: "operate_act",
          arguments: testCase.arguments,
        });
        expect(result.isError).toBe(true);
        const { error } = JSON.parse(resultText(result));
        expect(error.code).toBe("invalid_arguments");
        expect(error.guidance.example).toEqual(testCase.example);
        expect(error.guidance.supplied_kind).toBe(testCase.arguments.kind);
        expect(error.guidance.safe_alternative).toMatch(
          /Never enter card values with operate_act; use operate_pay/,
        );
        for (const pattern of testCase.guidance) {
          expect(error.guidance.safe_alternative).toMatch(pattern);
        }
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
            name: "operate_act",
            arguments: {
              session_id: "s1",
              kind: i % 2 === 0 ? "set_value" : "frobnicate",
              target: `了承${i}`,
            },
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
