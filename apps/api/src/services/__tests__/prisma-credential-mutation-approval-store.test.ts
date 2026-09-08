import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaCredentialMutationApprovalStore } from "../prisma-credential-mutation-approval-store.js";

describe("PrismaCredentialMutationApprovalStore", () => {
  it("persists omitted attribution as caller-missing context", async () => {
    let created: Record<string, unknown> | undefined;
    const prisma = {
      credentialMutationApproval: {
        async create(args: { data: Record<string, unknown> }) {
          created = args.data;
          return { id: "approval_0" };
        },
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaCredentialMutationApprovalStore(prisma);

    await store.create("acct_1", {
      operation: "delete",
      credentialReference: "vault://acct_1/sub/cred",
      credentialService: "OpenAI",
      credentialLabel: "default",
      before: {
        label: "default",
        allowed_hosts: ["api.openai.com"],
        login_hosts: [],
        auth_strategy: null,
      },
      after: null,
      nonce: "nonce_0",
      agent: "codex",
      requesterKind: "agent",
      intentHash: "intent_0",
      expiresAt: new Date("2026-08-22T12:10:00.000Z"),
    });

    expect(created).toMatchObject({
      audit_task_id: null,
      audit_agent_identity: "codex",
      audit_invocation_id: null,
      audit_purpose: "credential.delete",
    });
  });

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
      requester_kind: "agent",
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

  it("rejects a delete when metadata changes after the signed-before read", async () => {
    const approval = {
      id: "approval_2",
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
      nonce: "nonce_2",
      agent: "codex",
      requester_kind: "agent",
      intent_hash: "intent_2",
      status: "pending",
      failure_code: null,
      mandate_id: null,
      created_at: new Date("2026-08-22T11:50:00.000Z"),
      expires_at: new Date("2026-08-22T12:10:00.000Z"),
      executed_at: null,
    };
    let failedWith: string | undefined;
    let auditWrites = 0;
    const tx = {
      async $queryRaw(strings: TemplateStringsArray) {
        const query = strings.join(" ");
        if (query.includes("credential_mutation_approvals")) return [approval];
        if (query.includes("clock_timestamp")) {
          return [{ now: new Date("2026-08-22T12:00:00.000Z") }];
        }
        if (query.includes('FROM "Credential"')) {
          return [
            {
              reference: approval.credential_reference,
              account_id: approval.account_id,
              label: "default",
              allowed_hosts: ["api.openai.com"],
              metadata: {},
              deleted_at: null,
            },
          ];
        }
        throw new Error(`unexpected query: ${query}`);
      },
      credential: {
        async updateMany(args: { where: Record<string, unknown> }) {
          expect(args.where).toMatchObject({
            label: "default",
            allowed_hosts: { equals: ["api.openai.com"] },
            metadata: { equals: {} },
          });
          return { count: 0 };
        },
      },
      credentialMutationApproval: {
        async updateMany(args: { data: { failure_code?: string } }) {
          failedWith = args.data.failure_code;
          return { count: 1 };
        },
      },
      vaultAuditEvent: {
        async create() {
          auditWrites += 1;
        },
      },
    } as unknown as ApiPrismaClient;
    const prisma = {
      async $transaction<T>(fn: (transaction: ApiPrismaClient) => Promise<T>): Promise<T> {
        return await fn(tx);
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaCredentialMutationApprovalStore(prisma);

    await expect(store.commit(approval.id, "mandate_2")).resolves.toBe("metadata_changed");
    expect(failedWith).toBe("credential_metadata_changed");
    expect(auditWrites).toBe(0);
  });

  it("writes legacy approvals with caller-missing provenance", async () => {
    const approval = {
      id: "approval_3",
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
      nonce: "nonce_3",
      agent: "legacy-agent",
      requester_kind: "agent",
      intent_hash: "intent_3",
      status: "pending",
      failure_code: null,
      mandate_id: null,
      created_at: new Date("2026-08-22T11:50:00.000Z"),
      expires_at: new Date("2026-08-22T12:10:00.000Z"),
      executed_at: null,
    };
    let payload: Record<string, unknown> | undefined;
    const tx = {
      async $queryRaw(strings: TemplateStringsArray) {
        const query = strings.join(" ");
        if (query.includes("credential_mutation_approvals")) return [approval];
        if (query.includes("clock_timestamp")) {
          return [{ now: new Date("2026-08-22T12:00:00.000Z") }];
        }
        if (query.includes('FROM "Credential"')) {
          return [
            {
              reference: approval.credential_reference,
              account_id: approval.account_id,
              label: approval.credential_label,
              allowed_hosts: ["api.openai.com"],
              metadata: {},
              deleted_at: null,
            },
          ];
        }
        throw new Error(`unexpected query: ${query}`);
      },
      credential: {
        async updateMany() {
          return { count: 1 };
        },
      },
      vaultAuditEvent: {
        async create(args: { data: { payload: Record<string, unknown> } }) {
          payload = args.data.payload;
        },
      },
      credentialMutationApproval: {
        async updateMany() {
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

    await expect(store.commit(approval.id, "mandate_3")).resolves.toBe("approved");
    expect(payload).toMatchObject({
      attribution: {
        task_id: null,
        agent_identity: "legacy-agent",
        invocation_id: null,
        purpose: "credential.delete",
        caller_missing: true,
      },
    });
  });
});
