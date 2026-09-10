import { describe, expect, it } from "vitest";
import {
  createFreshCredentialRun,
  probeThenCleanupFreshCredential,
  qualifyCredentialCleanup,
  qualifyFreshCredentialEvidence,
  qualifyOldCredentialControl,
  reviewedCredentialProbe,
  validateReviewedCredentialProbeResponse,
} from "./fresh-credential-policy.mjs";

const started = 1_000;
const run = createFreshCredentialRun("run-unique", 1, "retain", "resend", "account-a", started);
const baseline = {
  provider_credential_ids: ["provider-old"],
  vault_references: ["vault-old"],
};
const vaultCredentials = [
  {
    reference: "vault-old",
    label: "old",
    service: "Resend",
    allowed_hosts: ["api.resend.com"],
  },
  {
    reference: "vault-new",
    label: run.run_label,
    service: "Resend",
    allowed_hosts: ["api.resend.com"],
  },
];
const validEvidence = () => ({
  credential_policy: "force_fresh",
  provider_credential: {
    id: "provider-new",
    label: run.run_label,
    created_at: started + 1,
    account_id: "account-a",
  },
  vault_reference: "vault-new",
});
const qualify = (evidence = validEvidence()) =>
  qualifyFreshCredentialEvidence({
    run,
    baseline,
    evidence,
    vaultCredentials,
    now: started + 10,
  });

describe("force-fresh credential acceptance policy", () => {
  it("uses a fixed provider-reviewed GET instead of driver-asserted harmlessness", () => {
    expect(reviewedCredentialProbe("resend")).toEqual({
      id: "resend:list-domains:v1",
      http: {
        method: "GET",
        url: "https://api.resend.com/domains",
        headers: {
          Authorization: "Bearer ${SECRET}",
          "User-Agent": "trusty-squire-credential-qualification",
        },
      },
    });
    expect(() => reviewedCredentialProbe("xata")).toThrow(/No reviewed/);
    expect(() => reviewedCredentialProbe("driver-says-this-is-safe")).toThrow(/No reviewed/);
    const selfAsserted = { ...validEvidence(), probe: { harmless: true, method: "DELETE" } };
    expect(() => qualify(selfAsserted)).toThrow(/metadata-only/);
  });

  it("requires an old valid key in both provider and vault baselines", () => {
    expect(
      qualifyOldCredentialControl({
        run,
        baseline,
        control: {
          provider_credential_id: "provider-old",
          vault_reference: "vault-old",
        },
        vaultCredentials,
      }),
    ).toMatchObject({
      provider_credential_id: "provider-old",
      vault_reference: "vault-old",
      probe: { id: "resend:list-domains:v1" },
    });
    expect(() =>
      qualifyOldCredentialControl({
        run,
        baseline,
        control: { provider_credential_id: "provider-new", vault_reference: "vault-old" },
        vaultCredentials,
      }),
    ).toThrow(/pre-run baseline/);
  });

  it("rejects old identities, wrong accounts, stale creation, and extra raw fields", () => {
    for (const mutate of [
      (e) => (e.provider_credential.id = "provider-old"),
      (e) => (e.vault_reference = "vault-old"),
      (e) => (e.provider_credential.account_id = "account-b"),
      (e) => (e.provider_credential.created_at = started - 1),
      (e) => (e.secret = "should-never-appear"),
    ]) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(() => qualify(evidence)).toThrow();
    }
  });

  it("accepts only the exact new provider identity and vault reference", () => {
    expect(qualify()).toMatchObject({
      provider: { id: "provider-new", account_id: "account-a" },
      vault: { reference: "vault-new" },
      probe: { id: "resend:list-domains:v1" },
    });
  });

  it("requires the exact vault entry to authorize the reviewed probe host", () => {
    const credentials = structuredClone(vaultCredentials);
    credentials[1].allowed_hosts = ["example.invalid"];
    expect(() =>
      qualifyFreshCredentialEvidence({
        run,
        baseline,
        evidence: validEvidence(),
        vaultCredentials: credentials,
        now: started + 10,
      }),
    ).toThrow(/reviewed probe host/);
  });

  it.each([
    ["resend", { object: "list", data: [] }],
    ["neon", { projects: [] }],
  ])("validates the provider-specific %s response shape", (provider, body) => {
    expect(
      validateReviewedCredentialProbeResponse(provider, {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        truncated: false,
      }),
    ).toBe(true);
  });

  it("rejects Xata qualification even with a valid provider response", () => {
    expect(() =>
      validateReviewedCredentialProbeResponse("xata", {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaces: [] }),
        truncated: false,
      }),
    ).toThrow(/No reviewed/);
  });

  it("rejects cleanup evidence that precedes the exact fresh-key probe", () => {
    const qualified = qualify();
    expect(() =>
      qualifyCredentialCleanup({
        run,
        qualified,
        probeCompletedAt: started + 5,
        cleanupEvidence: {
          policy: "retain",
          status: "retained",
          provider_credential_id: "provider-new",
          completed_at: started + 4,
        },
        now: started + 10,
      }),
    ).toThrow(/before the authenticated probe/);
  });

  it("accepts retention only after probing the exact fresh identity", () => {
    const qualified = qualify();
    expect(
      qualifyCredentialCleanup({
        run,
        qualified,
        probeCompletedAt: started + 5,
        cleanupEvidence: {
          policy: "retain",
          status: "retained",
          provider_credential_id: "provider-new",
          completed_at: started + 6,
        },
        now: started + 10,
      }),
    ).toMatchObject({ status: "retained", provider_credential_id: "provider-new" });
  });

  it("executes the reviewed probe before optional revoke", async () => {
    const revokeRun = createFreshCredentialRun(
      "run-revoke",
      1,
      "revoke",
      "resend",
      "account-a",
      started,
    );
    const revokeEvidence = validEvidence();
    revokeEvidence.provider_credential.label = revokeRun.run_label;
    const qualified = qualifyFreshCredentialEvidence({
      run: revokeRun,
      baseline,
      evidence: revokeEvidence,
      vaultCredentials: [
        vaultCredentials[0],
        {
          reference: "vault-new",
          label: revokeRun.run_label,
          service: "Resend",
          allowed_hosts: ["api.resend.com"],
        },
      ],
      now: started + 10,
    });
    const events = [];
    let clock = started + 2;
    const result = await probeThenCleanupFreshCredential({
      run: revokeRun,
      qualified,
      callUseCredential: async (request) => {
        events.push(["probe", request.reference, request.http.method]);
        return {
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ object: "list", data: [] }),
            truncated: false,
          },
        };
      },
      revokeCredential: async (providerCredential) => {
        events.push(["revoke", providerCredential.id]);
        return {
          policy: "revoke",
          status: "revoked",
          provider_credential_id: providerCredential.id,
          completed_at: ++clock,
        };
      },
      now: () => ++clock,
    });
    expect(events).toEqual([
      ["probe", "vault-new", "GET"],
      ["revoke", "provider-new"],
    ]);
    expect(result.cleanup.status).toBe("revoked");
  });
});
