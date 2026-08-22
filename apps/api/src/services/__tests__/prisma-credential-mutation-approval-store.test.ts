import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaCredentialMutationApprovalStore } from "../prisma-credential-mutation-approval-store.js";

describe("PrismaCredentialMutationApprovalStore", () => {
  it("uses the database clock after the approval lock wait", async () => {
    let releaseLock!: () => void;
    const lockWait = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let credentialWrites = 0;
    const approval = {
      id: "approval_1",
      account_id: "acct_1",
      operation: "delete",
      credential_reference: "vault://acct_1/sub/cred",
      credential_service: "OpenAI",
      credential_label: "default",
      before_metadata: {
        label: "default",
        allowed_hosts: ["api.openai.com"],
        login_hosts: [],
        auth_strategy: null,
      },
      after_metadata: null,
      nonce: "nonce_1",
      agent: "codex",
      intent_hash: "intent_1",
      status: "pending",
      failure_code: null,
      mandate_id: null,
      created_at: new Date("2026-08-22T11:50:00.000Z"),
      expires_at: new Date("2026-08-22T12:00:00.000Z"),
      executed_at: null,
    };
    const tx = {
      async $queryRaw(strings: TemplateStringsArray) {
        const query = strings.join(" ");
        if (query.includes("credential_mutation_approvals")) {
          await lockWait;
          return [approval];
        }
        if (query.includes("clock_timestamp")) {
          return [{ now: new Date("2026-08-22T12:00:01.000Z") }];
        }
        throw new Error(`unexpected query: ${query}`);
      },
      credential: {
        async updateMany() {
          credentialWrites += 1;
          return { count: 1 };
        },
      },
    } as unknown as ApiPrismaClient;
    const prisma = {
      async $transaction<T>(fn: (transaction: ApiPrismaClient) => Promise<T>): Promise<T> {
        return await fn(tx);
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaCredentialMutationApprovalStore(prisma);

    const commit = store.commit(approval.id, "mandate_1");
    await Promise.resolve();
    releaseLock();

    await expect(commit).resolves.toBe("expired");
    expect(credentialWrites).toBe(0);
  });
});
