import { mkdtemp, rm, appendFile, readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z, type Tool } from "../../tools/index.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { OperatorBroker, brokerCommandMutates, reconciliationOutcome } from "../broker/operator.js";

const credential = (character: string) => character.repeat(43);

async function authenticate(
  broker: OperatorBroker,
  clientId: string,
  lineageCredential: string = credential("a"),
) {
  const identity = await broker.authenticate("token", "local-agent", lineageCredential);
  if (identity === null) throw new Error("Test broker authentication failed");
  return { ...identity, clientId };
}

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
      orphanAdmission: async () => undefined,
      orphan: async () => undefined,
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
    const principal = await authenticate(broker, "client");
    void broker.authority.claimForwarder(principal);
    try {
      await expect(
        broker.call(principal, "tool", { name: "operate_start", args: {} }, "start-request"),
      ).rejects.toThrow("operate_start failed");
      await expect(journal.assertReconciled()).resolves.toBeUndefined();
      await expect(
        broker.call(principal, "tool", { name: "operate_recipe_run", args: {} }, "recipe-request"),
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
        forwarderId: "forwarder",
        operation: "operate_pay",
        inputHash: "payment-input",
      });
      await journal.record("session", "request", "outcome", {
        forwarderId: "forwarder",
        operation: "operate_pay",
        inputHash: "payment-input",
        outcome: { status: "completed" },
      });
      await expect(new DispatchJournal(path).assertReconciled()).resolves.toBeUndefined();
      await expect(
        new DispatchJournal(path).recoveryOutcome("forwarder", {
          operation: "operate_pay",
          inputHash: "payment-input",
        }),
      ).resolves.toMatchObject({ sessionId: "session", requestId: "request" });
      expect(await journal.hasOutstanding("session")).toBe(true);
      await expect(journal.acknowledge("forwarder", "request")).resolves.toBe(true);
      expect(await journal.hasOutstanding("session")).toBe(false);
      expect(await journal.hasCompleted("forwarder", "request")).toBe(true);
      await expect(
        new DispatchJournal(path).recoveryOutcome("forwarder", {
          operation: "operate_pay",
          inputHash: "payment-input",
        }),
      ).resolves.toMatchObject({ sessionId: "session", requestId: "request" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes a bounded detached payment quarantine without replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-detached-payment-"));
    const path = join(root, "dispatch.jsonl");
    const journal = new DispatchJournal(path);
    const config = {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    };
    let dispatches = 0;
    try {
      const original = new OperatorBroker(config, "cell", journal);
      const owner = await authenticate(original, "owner");
      if (owner.forwarderId === undefined) throw new Error("Test broker lineage is missing");
      const paymentArgs = { session_id: "stuck-session", item: "first" };
      const paymentInputHash = createHmac(
        "sha256",
        createHash("sha256").update(credential("a")).digest(),
      )
        .update('{"args":{"item":"first","session_id":"stuck-session"},"name":"operate_pay"}')
        .digest("hex");
      await journal.record("stuck-session", "dispatched-payment", "entered", {
        forwarderId: owner.forwarderId,
        operation: "operate_pay",
        inputHash: paymentInputHash,
      });
      await expect(
        journal.recordDetachedPaymentUncertainty("stuck-session", owner.forwarderId),
      ).resolves.toBe(true);
      await journal.record("stuck-session", "dispatched-payment", "outcome", {
        forwarderId: owner.forwarderId,
        operation: "operate_pay",
        inputHash: paymentInputHash,
        outcome: { status: "done" },
      });
      await expect(
        journal.hasOnlyDetachedPaymentUncertainty("stuck-session", owner.forwarderId),
      ).resolves.toBe(true);

      const restarted = new OperatorBroker(config, "cell", new DispatchJournal(path));
      Object.defineProperty(restarted, "tools", {
        value: [
          {
            name: "operate_pay",
            description: "",
            inputSchema: z.object({ session_id: z.string(), item: z.string() }).strict(),
            jsonInputSchema: {},
            handler: async () => {
              dispatches += 1;
            },
          } satisfies Tool,
        ],
      });
      const sameLineage = await authenticate(restarted, "restarted");
      const foreign = await authenticate(restarted, "foreign", credential("b"));

      await expect(
        restarted.recover(sameLineage, {
          name: "operate_pay",
          args: paymentArgs,
        }),
      ).resolves.toEqual({
        requestId: "dispatched-payment",
        result: {
          reconciliation: {
            request_id: "dispatched-payment",
            operation: "operate_pay",
            status: "payment_outcome_unknown",
          },
        },
      });
      await expect(
        restarted.recover(sameLineage, {
          name: "operate_pay",
          args: { ...paymentArgs, item: "second" },
        }),
      ).resolves.toBeNull();
      await expect(
        restarted.recover(foreign, {
          name: "operate_pay",
          args: paymentArgs,
        }),
      ).resolves.toBeNull();
      expect(dispatches).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats extraction as mutating only when it writes to the vault", () => {
    expect(brokerCommandMutates("operate_extract", { session_id: "session" })).toBe(false);
    expect(
      brokerCommandMutates("operate_extract", {
        session_id: "session",
        store: { service: "example" },
      }),
    ).toBe(true);
    expect(brokerCommandMutates("operate_pay", { session_id: "session" })).toBe(true);
  });

  it("recovers and acknowledges the latest reset-ID dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-latest-recovery-"));
    const path = join(root, "dispatch.jsonl");
    const journal = new DispatchJournal(path);
    const detail = {
      forwarderId: "forwarder",
      operation: "operate_click",
      inputHash: "stable-input",
    };
    const outcome = {
      ...detail,
      outcome: { status: "completed" as const },
    };
    try {
      await journal.record("session", "old-request", "entered", detail);
      await journal.record("session", "old-request", "outcome", outcome);
      await journal.acknowledge("forwarder", "old-request");
      await journal.record("session", "new-request", "entered", detail);
      await journal.record("session", "new-request", "outcome", outcome);

      await expect(
        new DispatchJournal(path).recoveryOutcome("forwarder", {
          operation: "operate_click",
          inputHash: "stable-input",
        }),
      ).resolves.toMatchObject({ requestId: "new-request" });
      await journal.acknowledge("forwarder", "new-request");
      await expect(journal.hasOutstanding("session", "forwarder")).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an existing start capability after a lost response", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-start-recovery-"));
    const path = join(root, "dispatch.jsonl");
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
    const principal = await authenticate(broker, "restarted");
    if (principal.forwarderId === undefined) throw new Error("Test broker lineage is missing");
    const forwarderId = principal.forwarderId;
    const args = { service_url: "https://example.test", otp: "123456" };
    try {
      void broker.authority.claimForwarder(principal);
      Object.defineProperty(broker, "tools", {
        value: [
          {
            name: "operate_start",
            description: "",
            inputSchema: z.object({ service_url: z.string(), otp: z.string() }).strict(),
            jsonInputSchema: {},
            handler: async () => undefined,
          } satisfies Tool,
        ],
      });
      const capability = await broker.authority.open(principal, ["site:a"], async () => ({
        targetId: "target",
        invoke: async () => undefined,
        close: async () => true,
        orphan: async () => undefined,
      }));
      await journal.record(capability.sessionId, "forwarder:old-process:request", "outcome", {
        forwarderId,
        start: true,
        operation: "operate_start",
        inputHash: createHmac("sha256", createHash("sha256").update(credential("a")).digest())
          .update(
            '{"args":{"otp":"123456","service_url":"https://example.test"},"capability":null,"name":"operate_start"}',
          )
          .digest("hex"),
        outcome: { status: "completed" },
      });
      await expect(
        broker.recover(principal, {
          name: "operate_start",
          args,
        }),
      ).resolves.toMatchObject({
        capability,
        result: { session_id: capability.sessionId, broker: { targetId: "target" } },
      });
      await expect(
        broker.recover(principal, {
          name: "operate_start",
          args: { ...args, otp: "654321" },
        }),
      ).resolves.toBeNull();
      const foreign = await authenticate(broker, "foreign", credential("b"));
      await expect(broker.recover(foreign, { name: "operate_start", args })).resolves.toBeNull();
      await expect(readFile(path, "utf8")).resolves.not.toContain("123456");
      expect(broker.authority.inventory()).toEqual({ active: 1, quarantined: 0, admitting: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns only the durable start record after a daemon restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-daemon-recovery-"));
    const path = join(root, "dispatch.jsonl");
    const journal = new DispatchJournal(path);
    const config = {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    };
    const args = { service_url: "https://example.test", otp: "123456" };
    const inputHash = createHmac("sha256", createHash("sha256").update(credential("a")).digest())
      .update(
        '{"args":{"otp":"123456","service_url":"https://example.test"},"capability":null,"name":"operate_start"}',
      )
      .digest("hex");
    let starts = 0;
    try {
      const original = new OperatorBroker(config, "cell", journal);
      const originalPrincipal = await authenticate(original, "original");
      if (originalPrincipal.forwarderId === undefined)
        throw new Error("Test broker lineage is missing");
      await journal.record("lost-session", "old-process-request", "outcome", {
        forwarderId: originalPrincipal.forwarderId,
        start: true,
        operation: "operate_start",
        inputHash,
        outcome: { status: "completed" },
      });
      await journal.acknowledge(originalPrincipal.forwarderId, "old-process-request");

      const restarted = new OperatorBroker(config, "cell", new DispatchJournal(path));
      Object.defineProperty(restarted, "tools", {
        value: [
          {
            name: "operate_start",
            description: "",
            inputSchema: z.object({ service_url: z.string(), otp: z.string() }).strict(),
            jsonInputSchema: {},
            handler: async () => {
              starts += 1;
            },
          } satisfies Tool,
        ],
      });
      const sameLineage = await authenticate(restarted, "restarted");
      const foreign = await authenticate(restarted, "foreign", credential("b"));
      void restarted.authority.claimForwarder(sameLineage);

      await expect(
        restarted.recover(sameLineage, { name: "operate_start", args }),
      ).resolves.toEqual({
        requestId: "old-process-request",
        result: {
          reconciliation: {
            request_id: "old-process-request",
            operation: "operate_start",
            status: "completed",
          },
          recovery: {
            status: "session_unavailable",
            next_step:
              "Broker restart ended the session; reconcile this recorded outcome before any new work.",
          },
        },
      });
      await expect(restarted.recover(foreign, { name: "operate_start", args })).resolves.toBeNull();
      await expect(
        restarted.call(
          sameLineage,
          "tool",
          { name: "operate_start", args },
          "fresh-process-request",
        ),
      ).rejects.toThrow("Prior start result awaits caller delivery");
      expect(starts).toBe(0);
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { phase: string; inputHash?: string; outcome?: unknown },
        );
      expect(records.some((record) => record.phase === "recovered")).toBe(true);
      expect(records.every((record) => record.inputHash !== "123456")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only an acknowledged payment's scoped status custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-payment-custody-"));
    const path = join(root, "dispatch.jsonl");
    const journal = new DispatchJournal(path);
    try {
      await journal.record("session", "payment-custody", "entered", {
        forwarderId: "forwarder-a",
      });
      await expect(journal.hasOnlyPaymentCustody("session", "forwarder-a")).resolves.toBe(true);
      await expect(journal.hasOnlyPaymentCustody("session", "forwarder-b")).resolves.toBe(false);
      await journal.record("session", "payment", "outcome", {
        forwarderId: "forwarder-a",
        operation: "operate_pay",
        outcome: { status: "payment_3ds_required" },
      });
      await expect(journal.hasOnlyPaymentCustody("session", "forwarder-a")).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits only the reclaimed session's pending payment status", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-payment-status-"));
    const path = join(root, "dispatch.jsonl");
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
    const principal = {
      accountId: "account",
      agentId: "local-agent",
      forwarderId: "forwarder-a",
      clientId: "reclaimed",
    };
    try {
      void broker.authority.claimForwarder(principal);
      const capability = await broker.authority.open(principal, ["site:a"], async () => ({
        targetId: "target",
        invoke: async () => undefined,
        close: async () => true,
        orphan: async () => undefined,
      }));
      await journal.record(capability.sessionId, "payment-custody", "entered", {
        forwarderId: principal.forwarderId,
      });
      const params = {
        name: "operate_payment_status",
        args: { session_id: capability.sessionId },
        capability,
      };
      await expect(broker.canContinuePaymentStatus(principal, params)).resolves.toBe(true);
      await expect(
        broker.canContinuePaymentStatus(
          { ...principal, forwarderId: "forwarder-b", clientId: "foreign" },
          params,
        ),
      ).resolves.toBe(false);
      await journal.record(capability.sessionId, "pay", "outcome", {
        forwarderId: principal.forwarderId,
        operation: "operate_pay",
        outcome: { status: "payment_3ds_required" },
      });
      await expect(broker.canContinuePaymentStatus(principal, params)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves scrubbed pending payment outcomes across journal restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-payment-outcomes-"));
    const path = join(root, "dispatch.jsonl");
    const outcomes = [
      {
        requestId: "done",
        result: {
          status: "payment_submitted",
          approval_url: "https://approval.test/private",
          merchant: "Private Merchant",
        },
        expected: { status: "done" as const },
      },
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
          forwarderId: "forwarder",
          operation: "operate_pay",
          inputHash: `${requestId}-hash`,
        });
        await journal.record("session", requestId, "outcome", {
          forwarderId: "forwarder",
          operation: "operate_pay",
          inputHash: `${requestId}-hash`,
          outcome,
        });
      }
      expect(reconciliationOutcome("operate_pay", { status: "succeeded" })).toEqual({
        status: "completed",
      });
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
        .map((line) => JSON.parse(line) as { phase: string; outcome?: unknown; agentId?: unknown });
      expect(
        records.filter((record) => record.phase === "outcome").map((record) => record.outcome),
      ).toEqual(outcomes.map((entry) => entry.expected));
      expect(records.every((record) => record.agentId === undefined)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
