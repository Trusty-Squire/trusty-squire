import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { InMemoryVaultAuditStore, VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAgentSession } from "../auth/agent.js";
import { credentialMutationPayload } from "../routes/credential-mutations.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { InMemoryCredentialMutationApprovalStore } from "../services/credential-mutation-approval-store.js";
import {
  CREDENTIAL_MUTATION_VOUCH_CONTEXT,
  PAYMENT_VOUCH_CONTEXT,
  createVouchMandateVerifier,
  hashVouchPayload,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "credential-mutation-test-session-secret";
const AUDIENCE = "credential-mutation-test-customer";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe("vouch-gated credential mutations", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let nowMs: number;
  let agentToken: string;
  let signingKey: SigningKey;
  let vouchVerifier: VouchMandateVerifier;

  beforeEach(async () => {
    nowMs = Date.parse("2026-08-22T12:00:00.000Z");
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", AUDIENCE);
    const keys = await generateKeyPair("ES256");
    signingKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = "credential-mutation-test-key";
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date(nowMs),
    });
    vouchVerifier = createVouchMandateVerifier(
      async () => Response.json({ keys: [publicJwk] }),
      "https://vouchflow.test",
    );
    server = await buildServer({ deps, vouchVerifier });
    const account = await deps.accountStore.createAccount("mutator@example.test", "Mutator");
    const session = issueAgentSession({
      account_id: account.id,
      agent_identity: "codex",
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(session.record);
    agentToken = session.raw_token;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  async function storeCredential(
    service = "OpenAI",
    label = "default",
    value = "sk-secret-never-returned",
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { service, label, value },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { reference: string }).reference;
  }

  async function createMutation(payload: Record<string, unknown>) {
    return await server.inject({
      method: "POST",
      url: "/v1/vault/mutation-approvals",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-squire-agent-identity": "Codex",
      },
      payload,
    });
  }

  async function mutationCeremony(id: string) {
    const response = await server.inject({
      method: "GET",
      url: `/v1/vault/mutation-approvals/${id}/ceremony`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      payload: unknown;
      payload_sha256: string;
      operation: "edit" | "delete";
    };
  }

  async function signHash(
    hash: string,
    context: string,
    mandateId: string,
    expiration: string | number = "10m",
  ): Promise<string> {
    return await new SignJWT({
      context,
      payload_sha256: hash,
      confidence: "low",
      mandate_id: mandateId,
    })
      .setProtectedHeader({ alg: "ES256", kid: "credential-mutation-test-key" })
      .setIssuer("https://vouchflow.dev")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(signingKey);
  }

  async function approveMutation(id: string, context = CREDENTIAL_MUTATION_VOUCH_CONTEXT) {
    const ceremony = await mutationCeremony(id);
    const jws = await signHash(ceremony.payload_sha256, context, `mandate_${id}`);
    return await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${id}/approve`,
      payload: { jws },
    });
  }

  it("requires a valid signed vouch and changes only allowed_hosts metadata", async () => {
    const reference = await storeCredential();
    const before = await deps.credentialStore.findActive(reference);
    expect(before).not.toBeNull();

    const created = await createMutation({
      operation: "edit",
      reference,
      changes: {
        allowed_hosts: { mode: "replace", hosts: ["api.example.test", "API.EXAMPLE.TEST"] },
      },
    });
    expect(created.statusCode).toBe(201);
    const approval = created.json() as { approval_id: string; before: unknown; after: unknown };
    expect(created.body).not.toContain("sk-secret-never-returned");

    // Creating/polling an approval is not authority to mutate.
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toEqual([
      "api.openai.com",
    ]);
    const unsigned = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${approval.approval_id}/approve`,
      payload: {},
    });
    expect(unsigned.statusCode).toBe(400);
    const badSignature = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${approval.approval_id}/approve`,
      payload: { jws: "not.a.valid-jws" },
    });
    expect(badSignature.statusCode).toBe(403);
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toEqual([
      "api.openai.com",
    ]);

    const wrongContext = await approveMutation(approval.approval_id, PAYMENT_VOUCH_CONTEXT);
    expect(wrongContext.statusCode).toBe(403);
    expect(wrongContext.json()).toEqual({ error: "invalid_mandate_context" });
    const ceremony = await mutationCeremony(approval.approval_id);
    const expiredJws = await signHash(
      ceremony.payload_sha256,
      CREDENTIAL_MUTATION_VOUCH_CONTEXT,
      "expired_mandate",
      1,
    );
    const expiredMandate = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${approval.approval_id}/approve`,
      payload: { jws: expiredJws },
    });
    expect(expiredMandate.statusCode).toBe(403);
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toEqual([
      "api.openai.com",
    ]);

    const approved = await approveMutation(approval.approval_id);
    expect(approved.statusCode).toBe(200);
    expect(approved.body).not.toContain("sk-secret-never-returned");
    const after = await deps.credentialStore.findActive(reference);
    expect(after?.allowed_hosts).toEqual(["api.example.test"]);
    expect(after?.field_names).toEqual(before?.field_names);
    expect(after?.ciphertext.equals(before!.ciphertext)).toBe(true);
    expect(after?.encrypted_dek.equals(before!.encrypted_dek)).toBe(true);
    expect(after?.account_kek_blob.equals(before!.account_kek_blob)).toBe(true);

    const immutableField = await createMutation({
      operation: "edit",
      reference,
      changes: { value: "attempted-secret-overwrite" },
    });
    expect(immutableField.statusCode).toBe(400);
    expect(
      (await deps.credentialStore.findActive(reference))?.ciphertext.equals(before!.ciphertext),
    ).toBe(true);

    const addCreated = await createMutation({
      operation: "edit",
      reference,
      changes: { allowed_hosts: { mode: "add", hosts: ["uploads.example.test"] } },
    });
    expect(
      (await approveMutation((addCreated.json() as { approval_id: string }).approval_id))
        .statusCode,
    ).toBe(200);
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toEqual([
      "api.example.test",
      "uploads.example.test",
    ]);

    const removeCreated = await createMutation({
      operation: "edit",
      reference,
      changes: { allowed_hosts: { mode: "remove", hosts: ["api.example.test"] } },
    });
    expect(
      (await approveMutation((removeCreated.json() as { approval_id: string }).approval_id))
        .statusCode,
    ).toBe(200);
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toEqual([
      "uploads.example.test",
    ]);
    expect(
      (await deps.credentialStore.findActive(reference))?.ciphertext.equals(before!.ciphertext),
    ).toBe(true);
  });

  it("deletes only after approval and repeats the approved approval idempotently", async () => {
    const reference = await storeCredential("Resend");
    const created = await createMutation({ operation: "delete", reference });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { approval_id: string }).approval_id;
    expect(await deps.credentialStore.findActive(reference)).not.toBeNull();

    const approved = await approveMutation(id);
    expect(approved.statusCode).toBe(200);
    expect(await deps.credentialStore.findActive(reference)).toBeNull();
    expect(await deps.credentialStore.findByReferenceIncludingDeleted(reference)).not.toBeNull();

    const repeated = await approveMutation(id);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ status: "approved", operation: "delete" });

    const invalidRetry = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${id}/approve`,
      payload: { jws: "not.a.valid-jws" },
    });
    expect(invalidRetry.statusCode).toBe(403);
    expect(await deps.credentialStore.findActive(reference)).toBeNull();
  });

  it("fails closed after expiry and when signed metadata drifts before execution", async () => {
    const reference = await storeCredential();
    const expiredCreated = await createMutation({ operation: "delete", reference });
    const expiredId = (expiredCreated.json() as { approval_id: string }).approval_id;
    nowMs += 11 * 60 * 1000;
    const expired = await approveMutation(expiredId);
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: "credential_mutation_approval_expired" });
    expect(await deps.credentialStore.findActive(reference)).not.toBeNull();

    nowMs -= 11 * 60 * 1000;
    const editCreated = await createMutation({
      operation: "edit",
      reference,
      changes: { allowed_hosts: { mode: "add", hosts: ["new.example.test"] } },
    });
    const editId = (editCreated.json() as { approval_id: string }).approval_id;
    await deps.credentialStore.setAllowedHosts(reference, ["drift.example.test"]);
    const drifted = await approveMutation(editId);
    expect(drifted.statusCode).toBe(409);
    expect(drifted.json()).toEqual({ error: "credential_metadata_changed" });
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toEqual([
      "drift.example.test",
    ]);
  });

  it("rechecks approval expiry after mandate verification", async () => {
    const reference = await storeCredential();
    const created = await createMutation({ operation: "delete", reference });
    const id = (created.json() as { approval_id: string }).approval_id;
    await server.close();
    server = await buildServer({
      deps,
      vouchVerifier: async () => {
        nowMs += 11 * 60 * 1000;
        return { mandate_id: "mandate_slow_verification" };
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${id}/approve`,
      payload: { jws: "synthetic-valid-mandate" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "credential_mutation_approval_expired" });
    expect(await deps.credentialStore.findActive(reference)).not.toBeNull();
  });

  it("does not reuse a pending approval across requesting agents", async () => {
    const reference = await storeCredential();
    const first = await createMutation({ operation: "delete", reference });
    const accountId = (await deps.credentialStore.findActive(reference))!.account_id;
    const secondSession = issueAgentSession({
      account_id: accountId,
      agent_identity: "claude",
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(secondSession.record);
    const second = await server.inject({
      method: "POST",
      url: "/v1/vault/mutation-approvals",
      headers: {
        authorization: `Bearer ${secondSession.raw_token}`,
        "x-squire-agent-identity": "Claude",
      },
      payload: { operation: "delete", reference },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = (first.json() as { approval_id: string }).approval_id;
    const secondId = (second.json() as { approval_id: string }).approval_id;
    expect(secondId).not.toBe(firstId);
    expect((await deps.credentialMutationApprovalStore.getById(firstId))?.agent).toBe("Codex");
    expect((await deps.credentialMutationApprovalStore.getById(secondId))?.agent).toBe("Claude");
  });

  it("leaves approval and metadata pending when the atomic audit write fails", async () => {
    const reference = await storeCredential();
    await server.close();
    const audit = new InMemoryVaultAuditStore(() => new Date(nowMs));
    const originalRecord = audit.record.bind(audit);
    let failMetadataAudit = true;
    audit.record = async (event) => {
      if (failMetadataAudit && event.type === VAULT_AUDIT_TYPES.metadataEdited) {
        failMetadataAudit = false;
        throw new Error("synthetic audit outage");
      }
      await originalRecord(event);
    };
    deps.vaultAuditStore = audit;
    deps.credentialMutationApprovalStore = new InMemoryCredentialMutationApprovalStore(
      deps.credentialStore,
      audit,
      () => new Date(nowMs),
    );
    server = await buildServer({ deps, vouchVerifier });
    const created = await createMutation({
      operation: "edit",
      reference,
      changes: { allowed_hosts: { mode: "add", hosts: ["recovery.example.test"] } },
    });
    const id = (created.json() as { approval_id: string }).approval_id;
    const ceremony = await mutationCeremony(id);
    const jws = await signHash(
      ceremony.payload_sha256,
      CREDENTIAL_MUTATION_VOUCH_CONTEXT,
      "mandate_recovery",
    );
    const first = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${id}/approve`,
      payload: { jws },
    });
    expect(first.statusCode).toBe(500);
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).not.toContain(
      "recovery.example.test",
    );
    expect((await deps.credentialMutationApprovalStore.getById(id))?.status).toBe("pending");

    const retried = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${id}/approve`,
      payload: { jws },
    });
    expect(retried.statusCode).toBe(200);
    expect((await deps.credentialMutationApprovalStore.getById(id))?.status).toBe("approved");
    expect((await deps.credentialStore.findActive(reference))?.allowed_hosts).toContain(
      "recovery.example.test",
    );
    const audits = await deps.vaultAuditStore.list(
      (await deps.credentialStore.findActive(reference))!.account_id,
      { type: VAULT_AUDIT_TYPES.metadataEdited, reference },
    );
    expect(audits.filter((event) => event.payload.approval_id === id)).toHaveLength(1);
  });

  it("atomically rejects concurrent renames into the same service label", async () => {
    const firstReference = await storeCredential("Stripe", "first", "sk-first");
    const secondReference = await storeCredential("Stripe", "second", "sk-second");
    const first = await createMutation({
      operation: "edit",
      reference: firstReference,
      changes: { label: "shared" },
    });
    const second = await createMutation({
      operation: "edit",
      reference: secondReference,
      changes: { label: "shared" },
    });
    const firstId = (first.json() as { approval_id: string }).approval_id;
    const secondId = (second.json() as { approval_id: string }).approval_id;
    const firstCeremony = await mutationCeremony(firstId);
    const secondCeremony = await mutationCeremony(secondId);
    const [firstJws, secondJws] = await Promise.all([
      signHash(firstCeremony.payload_sha256, CREDENTIAL_MUTATION_VOUCH_CONTEXT, "mandate_first"),
      signHash(secondCeremony.payload_sha256, CREDENTIAL_MUTATION_VOUCH_CONTEXT, "mandate_second"),
    ]);

    const responses = await Promise.all([
      server.inject({
        method: "POST",
        url: `/v1/vault/mutation-approvals/${firstId}/approve`,
        payload: { jws: firstJws },
      }),
      server.inject({
        method: "POST",
        url: `/v1/vault/mutation-approvals/${secondId}/approve`,
        payload: { jws: secondJws },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toEqual({
      error: "credential_name_conflict",
    });
    const accountId = (await deps.credentialStore.findByReferenceIncludingDeleted(firstReference))!
      .account_id;
    const active = await deps.credentialStore.listByAccount(accountId);
    expect(active.filter((credential) => credential.label === "shared")).toHaveLength(1);
  });

  it("returns typed missing and ambiguous selector failures without creating an approval", async () => {
    await storeCredential("Stripe", "prod", "sk-prod");
    await storeCredential("Stripe", "dev", "sk-dev");
    const ambiguous = await createMutation({
      operation: "delete",
      service: "stripe",
    });
    expect(ambiguous.statusCode).toBe(409);
    const ambiguousBody = ambiguous.json() as { error: string; candidates: unknown[] };
    expect(ambiguousBody.error).toBe("ambiguous_credential");
    expect(ambiguousBody.candidates).toHaveLength(2);

    const missing = await createMutation({
      operation: "edit",
      reference: "vault://missing",
      changes: { allowed_hosts: { mode: "add", hosts: ["api.example.test"] } },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "credential_not_found" });
  });

  it("cannot replay a credential-mutation mandate as payment or a payment mandate as mutation", async () => {
    const reference = await storeCredential();
    const mutationCreated = await createMutation({ operation: "delete", reference });
    const mutationId = (mutationCreated.json() as { approval_id: string }).approval_id;
    const mutationCeremonyBody = await mutationCeremony(mutationId);
    const mutationJws = await signHash(
      mutationCeremonyBody.payload_sha256,
      CREDENTIAL_MUTATION_VOUCH_CONTEXT,
      "mandate_mutation",
    );

    const paymentCreated = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}`, "x-squire-agent-identity": "Codex" },
      payload: {
        merchant: "Example Shop",
        checkout_origin: "https://checkout.example.test",
        amount_cents: 1200,
        currency: "USD",
        card_ref: "card_synthetic",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Example item",
        reason: "Replay isolation test",
      },
    });
    expect(paymentCreated.statusCode).toBe(201);
    const payment = paymentCreated.json() as { id: string; nonce: string; agent: string };
    const recipientHash = createHash("sha256")
      .update(Buffer.from("c3ludGhldGljLW9wZXJhdG9yLWtleQ", "base64url"))
      .digest("base64url");
    const paymentHash = hashVouchPayload({
      agent: payment.agent,
      amount_cents: 1200,
      approval_id: payment.id,
      card_ref: "card_synthetic",
      checkout_origin: "https://checkout.example.test",
      currency: "USD",
      item: "Example item",
      merchant: "Example Shop",
      nonce: payment.nonce,
      reason: "Replay isolation test",
      recipient_pubkey_hash: recipientHash,
    }).toString("base64url");
    const paymentJws = await signHash(paymentHash, PAYMENT_VOUCH_CONTEXT, "mandate_payment");

    // Payments use the same verifier: matching claims with a corrupted
    // signature still fail before a candidate is stored.
    const paymentJwsParts = paymentJws.split(".");
    const paymentSignature = paymentJwsParts[2]!;
    const badPaymentJws = `${paymentJwsParts[0]}.${paymentJwsParts[1]}.${
      paymentSignature[0] === "A" ? "B" : "A"
    }${paymentSignature.slice(1)}`;
    const badPaymentSignature = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${payment.id}/approve`,
      payload: { jws: badPaymentJws, sealed_card: "c2VhbGVkLWNhcmQ" },
    });
    expect(badPaymentSignature.statusCode).toBe(403);
    expect((badPaymentSignature.json() as { error: string }).error).toBe(
      "mandate_verification_failed",
    );

    const paymentAsMutation = await server.inject({
      method: "POST",
      url: `/v1/vault/mutation-approvals/${mutationId}/approve`,
      payload: { jws: paymentJws },
    });
    expect(paymentAsMutation.statusCode).toBe(403);
    expect(await deps.credentialStore.findActive(reference)).not.toBeNull();

    const mutationAsPayment = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${payment.id}/approve`,
      payload: { jws: mutationJws, sealed_card: "c2VhbGVkLWNhcmQ" },
    });
    expect(mutationAsPayment.statusCode).toBe(403);
    expect((mutationAsPayment.json() as { error: string }).error).toBe(
      "payment_approval_binding_mismatch",
    );

    const validPayment = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${payment.id}/approve`,
      payload: { jws: paymentJws, sealed_card: "c2VhbGVkLWNhcmQ" },
    });
    expect(validPayment.statusCode).toBe(202);

    const storedMutation = await deps.credentialMutationApprovalStore.getById(mutationId);
    expect(storedMutation).not.toBeNull();
    expect(hashVouchPayload(credentialMutationPayload(storedMutation!)).toString("base64url")).toBe(
      mutationCeremonyBody.payload_sha256,
    );
  });
});
