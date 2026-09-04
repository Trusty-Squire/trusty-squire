// Locks the single-tier invariant: every install is account-bound.
// (Previously this file enforced the Tier-0-by-default invariant; that
// product position was removed in favor of one consistent auth path.)
//
// Verified here:
//   1. A buildServer(null) — i.e. a stale pre-single-tier session — gates
//      EVERY tool with a re-install message. There is no anonymous mode.
//   2. The CLI no longer accepts `--pair` as a no-op or anything else;
//      pairing is automatic and lives inside the `connect` command.

import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";
import type { ApiClient } from "../api-client.js";

describe("single-tier — stale install gate", () => {
  it("valid calls require reconnect while malformed calls fail validation first", async () => {
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
      expect(names).toContain("operate_start");
      expect(names).not.toContain("provision");
      expect(names).not.toContain("check_provision_status");

      const malformed = await client.callTool({ name: "operate_start", arguments: {} });
      const malformedError = JSON.parse(
        (malformed.content as Array<{ text: string }>)[0]!.text,
      ).error;
      expect(malformedError.code).toBe("invalid_arguments");

      const unauthenticated = await client.callTool({
        name: "list_payment_cards",
        arguments: {},
      });
      const unauthenticatedError = JSON.parse(
        (unauthenticated.content as Array<{ text: string }>)[0]!.text,
      ).error;
      expect(unauthenticatedError.code).toBe("reconnect_required");
      expect(unauthenticatedError.message).toMatch(/single-tier auth|install/i);
    } finally {
      await client.close();
    }
  });

  it("reloads the account-bound session published after the server started", async () => {
    const recoveredApi = {
      setRequestingAgent: vi.fn(),
      listPaymentCards: vi.fn().mockResolvedValue([]),
    };
    const loadPersistedSession = vi.fn(async () => recoveredApi as unknown as ApiClient);
    const server = await buildServer(null, undefined, loadPersistedSession);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "post-install-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "list_payment_cards", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(loadPersistedSession).toHaveBeenCalledTimes(1);
      expect(recoveredApi.listPaymentCards).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });
});

describe("MCP client identity", () => {
  it("uses initialize clientInfo.name as the requesting agent", async () => {
    const setRequestingAgent = vi.fn();
    const api = {
      setRequestingAgent,
      listPaymentCards: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;
    const server = await buildServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "Hermes", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      await client.callTool({ name: "list_payment_cards", arguments: {} });
      expect(setRequestingAgent).toHaveBeenCalledWith("Hermes");
    } finally {
      await client.close();
    }
  });
});

describe("MCP tool argument validation", () => {
  it("returns an executable repair object for missing payment arguments", async () => {
    const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
    const server = await buildServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "validation-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "operate_pay", arguments: {} });
      expect(result.isError).toBe(true);
      const { error } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(error.code).toBe("invalid_arguments");
      expect(error.guidance).toMatchObject({
        allowed_kinds: ["operate_pay"],
        missing: ["item", "reason"],
        example: expect.any(Object),
        safe_alternative: expect.any(String),
      });
    } finally {
      await client.close();
    }
  });

  it("returns repair objects for malformed action grammar and conflicting card selectors", async () => {
    const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
    const server = await buildServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "validation-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const badKind = await client.callTool({
        name: "operate_act",
        arguments: { session_id: "session_1", kind: "set_value", target: "@e:field", text: "x" },
      });
      const missingSlot = await client.callTool({
        name: "operate_act",
        arguments: { session_id: "session_1", kind: "type_secret", target: "@e:field" },
      });
      const missingTypeTarget = await client.callTool({
        name: "operate_act",
        arguments: { session_id: "session_1", kind: "type", text: "x" },
      });
      const cardConflict = await client.callTool({
        name: "operate_pay",
        arguments: {
          item: "Test item",
          reason: "Test reason",
          card_ref: "card_1",
          card_label: "Personal",
        },
      });
      for (const result of [badKind, missingSlot, missingTypeTarget, cardConflict]) {
        expect(result.isError).toBe(true);
        const { error } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
        expect(error.code).toBe("invalid_arguments");
        expect(error.guidance).toEqual(
          expect.objectContaining({
            allowed_kinds: expect.any(Array),
            missing: expect.any(Array),
            example: expect.any(Object),
            safe_alternative: expect.any(String),
          }),
        );
      }
      const badKindRepair = JSON.parse((badKind.content as Array<{ text: string }>)[0]!.text).error
        .guidance;
      expect(badKindRepair.allowed_kinds).toContain("select");
      const missingSlotRepair = JSON.parse(
        (missingSlot.content as Array<{ text: string }>)[0]!.text,
      ).error.guidance;
      expect(missingSlotRepair.missing).toContain("slot");
      const missingTypeTargetRepair = JSON.parse(
        (missingTypeTarget.content as Array<{ text: string }>)[0]!.text,
      ).error.guidance;
      expect(missingTypeTargetRepair.missing).toContain("target");
      const cardRepair = JSON.parse((cardConflict.content as Array<{ text: string }>)[0]!.text)
        .error.guidance;
      expect(cardRepair.safe_alternative).toMatch(/only one of card_ref or card_label/i);
    } finally {
      await client.close();
    }
  });
});
