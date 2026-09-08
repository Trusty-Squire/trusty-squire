import { mkdtemp, rm, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z, type Tool } from "../../tools/index.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { OperatorBroker, reconciliationOutcome } from "../broker/operator.js";

describe("broker dispatch custody", () => {
  it("refuses replacement after an uncertain dispatch and admits only a settled journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-"));
    const path = join(root, "dispatch.jsonl");
    try {
      const journal = new DispatchJournal(path);
      await journal.assertReconciled();
      await journal.record("session", "request", "entered");
      await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow(
        "lost mutation custody",
      );
      await journal.record("session", "request", "settled");
      await new DispatchJournal(path).assertReconciled();
      await journal.record("session", "payment-custody", "entered");
      await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow(
        "lost mutation custody",
      );
      await journal.record("session", "payment-custody", "settled");
      await new DispatchJournal(path).assertReconciled();
      await appendFile(path, '{"session');
      await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow("incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not retain startup-only failures while retaining recipe mutation custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-start-"));
    const path = join(root, "dispatch.jsonl");
    installBrokerBrowserCustody({
      acquire: async () => {
        throw new Error("not used");
      },
      cleanupAdmission: async () => true,
      release: async () => undefined,
      identity: async (operation) => await operation(),
    });
    const journal = new DispatchJournal(path);
    const broker = new OperatorBroker(
      {
        accountId: "account",
        agentSessionToken: "token",
        apiBaseUrl: "http://unused.test",
        registryBaseUrl: "http://unused.test",
      },
      "cell",
      journal,
    );
    const failedTool = (name: "operate_start" | "operate_recipe_run"): Tool => ({
      name,
      description: "",
      inputSchema: z.object({}).strict(),
      jsonInputSchema: {},
      handler: async () => {
        throw new Error(`${name} failed`);
      },
    });
    Object.defineProperty(broker, "tools", {
      value: [failedTool("operate_start"), failedTool("operate_recipe_run")],
    });
    const principal = { accountId: "account", agentId: "agent", clientId: "client" };
    try {
      await expect(
        broker.call(principal, "tool", { name: "operate_start", args: {} }, "start-request"),
      ).rejects.toThrow("operate_start failed");
      await expect(journal.assertReconciled()).resolves.toBeUndefined();
      await expect(
        broker.call(
          principal,
          "tool",
          { name: "operate_recipe_run", args: {} },
          "recipe-request",
        ),
      ).rejects.toThrow("operate_recipe_run failed");
      await expect(journal.assertReconciled()).rejects.toThrow("lost mutation custody");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a returned mutation until its client receipt is durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-reconcile-"));
    const path = join(root, "dispatch.jsonl");
    const journal = new DispatchJournal(path);
    try {
      await journal.record("session", "request", "entered", {
        agentId: "agent",
        forwarderId: "forwarder",
        operation: "operate_pay",
      });
      await journal.record("session", "request", "outcome", {
        agentId: "agent",
        forwarderId: "forwarder",
        operation: "operate_pay",
        outcome: { status: "completed" },
      });
      await expect(new DispatchJournal(path).assertReconciled()).resolves.toBeUndefined();
      await expect(new DispatchJournal(path).pendingOutcomes("forwarder")).resolves.toEqual([
        { sessionId: "session", requestId: "request", operation: "operate_pay" },
      ]);
      expect(await journal.hasOutstanding("session")).toBe(true);
      await expect(journal.acknowledge("forwarder", "request")).resolves.toBe(true);
      expect(await journal.hasOutstanding("session")).toBe(false);
      expect(await journal.hasCompleted("forwarder", "request")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves scrubbed pending payment outcomes across journal restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-payment-outcomes-"));
    const path = join(root, "dispatch.jsonl");
    const outcomes = [
      {
        requestId: "three-ds",
        result: {
          status: "payment_3ds_required",
          approval_url: "https://approval.test/private",
          needs_user: { message: "private challenge", wall: "3ds" },
          next: { tool: "operate_payment_status", wait_seconds: 15, hint: "private" },
        },
        expected: {
          status: "payment_3ds_required" as const,
          next: { tool: "operate_payment_status" as const, wait_seconds: 15 },
        },
      },
      {
        requestId: "unknown",
        result: {
          status: "payment_outcome_unknown",
          approval_url: "https://approval.test/private",
          merchant: "Private Merchant",
          next: { tool: "operate_payment_status", wait_seconds: 15, hint: "private" },
        },
        expected: {
          status: "payment_outcome_unknown" as const,
          next: { tool: "operate_payment_status" as const, wait_seconds: 15 },
        },
      },
    ];
    const journal = new DispatchJournal(path);
    try {
      for (const { requestId, result, expected } of outcomes) {
        const outcome = reconciliationOutcome("operate_pay", result);
        expect(outcome).toEqual(expected);
        await journal.record("session", requestId, "entered", {
          agentId: "agent",
          forwarderId: "forwarder",
          operation: "operate_pay",
          inputHash: `${requestId}-hash`,
        });
        await journal.record("session", requestId, "outcome", {
          agentId: "agent",
          forwarderId: "forwarder",
          operation: "operate_pay",
          inputHash: `${requestId}-hash`,
          outcome,
        });
      }
      const restarted = new DispatchJournal(path);
      for (const { requestId, expected } of outcomes) {
        await expect(
          restarted.completedOutcome("forwarder", requestId, {
            operation: "operate_pay",
            inputHash: `${requestId}-hash`,
          }),
        ).resolves.toMatchObject({ requestId, operation: "operate_pay", outcome: expected });
      }
      expect(await restarted.hasOutstanding("session")).toBe(true);
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { phase: string; outcome?: unknown });
      expect(records.filter((record) => record.phase === "outcome").map((record) => record.outcome)).toEqual(
        outcomes.map((entry) => entry.expected),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
