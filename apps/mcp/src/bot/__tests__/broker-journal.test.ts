import { markOperatorMutationDispatchAttempted } from "../request-cancellation.js";
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
        if (name === "operate_recipe_run") await markOperatorMutationDispatchAttempted();
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
        operation: "inject_card",
        inputHash: "card-input",
      });
      await journal.record("session", "request", "outcome", {
        forwarderId: "forwarder",
        operation: "inject_card",
        inputHash: "card-input",
        outcome: { status: "completed" },
      });
      await expect(new DispatchJournal(path).assertReconciled()).resolves.toBeUndefined();
      await expect(
        new DispatchJournal(path).recoveryOutcome("forwarder", {
          operation: "inject_card",
          inputHash: "card-input",
        }),
      ).resolves.toMatchObject({ sessionId: "session", requestId: "request" });
      expect(await journal.hasOutstanding("session")).toBe(true);
      await expect(journal.acknowledge("forwarder", "request")).resolves.toBe(true);
      expect(await journal.hasOutstanding("session")).toBe(false);
      expect(await journal.hasCompleted("forwarder", "request")).toBe(true);
      await expect(
        new DispatchJournal(path).recoveryOutcome("forwarder", {
          operation: "inject_card",
          inputHash: "card-input",
        }),
      ).resolves.toMatchObject({ sessionId: "session", requestId: "request" });
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
    expect(brokerCommandMutates("inject_card", { session_id: "session" })).toBe(true);
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
      const startOutcome = {
        forwarderId,
        start: true,
        operation: "operate_start",
        inputHash: createHmac("sha256", createHash("sha256").update(credential("a")).digest())
          .update(
            '{"args":{"otp":"123456","service_url":"https://example.test"},"capability":null,"name":"operate_start"}',
          )
          .digest("hex"),
        outcome: { status: "completed" },
      } as const;
      await journal.record(
        capability.sessionId,
        "forwarder:old-process:request",
        "outcome",
        startOutcome,
      );
      await journal.record(
        capability.sessionId,
        "forwarder:current-process:request",
        "outcome",
        startOutcome,
      );
      await expect(
        broker.recover(principal, {
          name: "operate_start",
          args,
          requestId: "forwarder:current-process:request",
        }),
      ).resolves.toMatchObject({
        requestId: "forwarder:current-process:request",
        capability,
      });
      await expect(
        broker.recover(principal, {
          name: "operate_start",
          args,
          requestId: "forwarder:missing-process:request",
        }),
      ).resolves.toBeNull();
      await expect(
        broker.recover(principal, {
          name: "operate_start",
          args,
        }),
      ).resolves.toMatchObject({
        requestId: "forwarder:current-process:request",
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

});

it("retains lineage-bound closure proof across acknowledgement and journal restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-terminal-receipt-"));
  const path = join(root, "dispatch.jsonl");
  try {
    const journal = new DispatchJournal(path);
    const receipt = {
      session_id: "session",
      operation_id: "finish-1",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
    };
    await journal.recordTerminalReceipt("owner", receipt);
    await journal.acknowledge("owner", "finish-1");
    const restarted = new DispatchJournal(path);
    expect(await restarted.terminalReceipt("owner", "session")).toEqual(receipt);
    expect(await restarted.terminalReceipt("foreign", "session")).toBeUndefined();
    expect(await restarted.terminalReceipt("owner", "unknown")).toBeUndefined();
    await expect(
      restarted.recordTerminalReceipt("owner", { ...receipt, closed: false, cleanup: "unknown" }),
    ).rejects.toThrow("established closure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retries terminal persistence after a failure before any journal append", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-terminal-write-retry-"));
  const directory = join(root, "journal");
  try {
    await appendFile(directory, "fixture blocking directory creation");
    const journal = new DispatchJournal(join(directory, "dispatch.jsonl"));
    const receipt = {
      session_id: "session",
      operation_id: "finish",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
    };
    await expect(journal.recordTerminalReceipt("owner", receipt)).rejects.toThrow();
    await rm(directory);
    await journal.recordTerminalReceipt("owner", receipt);
    expect(await journal.terminalReceipt("owner", "session")).toEqual(receipt);
    expect(
      await new DispatchJournal(join(directory, "dispatch.jsonl")).terminalReceipt(
        "owner",
        "session",
      ),
    ).toEqual(receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains the capture identity across durable dispatch transitions and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-dispatch-"));
  const path = join(root, "journal.jsonl");
  try {
    const journal = new DispatchJournal(path);
    const detail = {
      operation: "operate_click",
      inputHash: "input",
      dispatchTracked: true as const,
    };
    const capture = {
      write_id: "original",
      binding: "account-service",
      stored: false,
      storage: "unknown" as const,
    };
    await journal.recordCapture("lineage", "session", "create", capture, false, detail);
    await journal.record("session", "create", "dispatch_attempted", {
      forwarderId: "lineage",
      ...detail,
    });
    const restarted = new DispatchJournal(path);
    expect(await restarted.hasCaptureWrite("lineage", "session", "original")).toBe(true);
    expect(await restarted.unresolvedCapture("lineage", "session")).toEqual(capture);
    await expect(restarted.assertReconciled()).rejects.toThrow("lost mutation custody");
    await expect(
      restarted.recordCapture(
        "lineage",
        "session",
        "recover",
        { ...capture, binding: "other" },
        true,
      ),
    ).rejects.toThrow("original service-bound");
    await restarted.recordCapture(
      "lineage",
      "session",
      "recover",
      { ...capture, stored: true, storage: "stored", reference: "vault://new" },
      true,
    );
    expect(await restarted.unresolvedCapture("lineage", "session")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
