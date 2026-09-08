import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z, type Tool } from "../../tools/index.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { OperatorBroker } from "../broker/operator.js";

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
});
