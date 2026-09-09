import { describe, expect, it } from "vitest";
import {
  createFreshCredentialRun,
  qualifyFreshCredentialEvidence,
} from "./fresh-credential-policy.mjs";

const started = 1_000;
const run = createFreshCredentialRun("run-unique", 1, "retain", started);
const validEvidence = () => ({
  credential_policy: "force_fresh",
  provider_credential: {
    id: "provider-new",
    label: run.run_label,
    created_at: started + 1,
    account_id: "account-a",
  },
  vault_reference: "vault-new",
  probe: {
    reference: "vault-new",
    harmless: true,
    http: { method: "GET", url: "https://api.fake.test/whoami" },
  },
  cleanup: { policy: "retain", status: "retained" },
});
const qualify = (evidence = validEvidence()) =>
  qualifyFreshCredentialEvidence({
    run,
    baseline: { provider_credential_ids: ["provider-old"], vault_references: ["vault-old"] },
    evidence,
    vaultCredentials: [{ reference: "vault-new", label: run.run_label, service: "fake" }],
    now: started + 10,
  });

describe("force-fresh credential acceptance policy", () => {
  it("rejects existing credentials and healthy-account evidence as a fresh success", () => {
    const existing = validEvidence();
    existing.provider_credential.id = "provider-old";
    expect(() => qualify(existing)).toThrow(/Existing provider credential/);
    expect(() =>
      qualifyFreshCredentialEvidence({
        run,
        baseline: { provider_credential_ids: ["provider-old"], vault_references: ["vault-old"] },
        evidence: { healthy_project: true },
        vaultCredentials: [],
        now: started + 10,
      }),
    ).toThrow(/metadata-only|cleanup policy/);
  });

  it.each([
    ["old vault copy", (e) => (e.vault_reference = e.probe.reference = "vault-old")],
    ["wrong account", (e) => (e.provider_credential.account_id = "")],
    ["stale creation", (e) => (e.provider_credential.created_at = started - 1)],
    ["missing probe", (e) => delete e.probe],
  ])("rejects %s", (_name, mutate) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(() => qualify(evidence)).toThrow();
  });

  it("accepts only the exact new provider identity, vault reference, and harmless probe", () => {
    expect(qualify()).toMatchObject({
      provider: { id: "provider-new" },
      vault: { reference: "vault-new" },
      probe: { reference: "vault-new", harmless: true },
    });
    const leaked = { ...validEvidence(), secret: "should-never-appear" };
    expect(() => qualify(leaked)).toThrow(/metadata-only/);
  });

  it("requires explicit cleanup status and never silently changes retention policy", () => {
    const missing = validEvidence();
    delete missing.cleanup;
    expect(() => qualify(missing)).toThrow(/cleanup policy/);
    const changed = validEvidence();
    changed.cleanup = { policy: "revoke", status: "revoked" };
    expect(() => qualify(changed)).toThrow(/changed during the run/);
  });
});
