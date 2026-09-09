import assert from "node:assert/strict";

export const FORCE_FRESH_CREDENTIAL_POLICY = "force_fresh";

export function createFreshCredentialRun(runId, serviceIndex, cleanupPolicy, now = Date.now()) {
  assert.equal(typeof runId, "string");
  assert.ok(runId.length > 0);
  assert.ok(cleanupPolicy === "retain" || cleanupPolicy === "revoke");
  return {
    credential_policy: FORCE_FRESH_CREDENTIAL_POLICY,
    run_id: runId,
    run_label: `trusty-squire-${runId}-${serviceIndex}`,
    started_at: now,
    cleanup_policy: cleanupPolicy,
  };
}

const stringSet = (values, label) => {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  return new Set(
    values.map((value) => {
      assert.equal(typeof value, "string", `${label} entries must be strings`);
      return value;
    }),
  );
};

/** Validate metadata-only evidence. The harness performs the authenticated
 * probe itself after this check, using `vault_reference` exactly. */
export function qualifyFreshCredentialEvidence({
  run,
  baseline,
  evidence,
  vaultCredentials,
  now = Date.now(),
}) {
  assert.equal(run.credential_policy, FORCE_FRESH_CREDENTIAL_POLICY);
  assert.ok(evidence && typeof evidence === "object", "Fresh-credential evidence missing");
  if (!("cleanup" in evidence)) {
    throw new Error("Explicit credential cleanup policy missing");
  }
  assert.deepEqual(
    Object.keys(evidence).sort(),
    ["cleanup", "credential_policy", "probe", "provider_credential", "vault_reference"],
    "Fresh-credential evidence must remain metadata-only",
  );
  assert.equal(evidence.credential_policy, FORCE_FRESH_CREDENTIAL_POLICY);
  const baselineProviderIds = stringSet(baseline?.provider_credential_ids, "provider baseline");
  const baselineVaultRefs = stringSet(baseline?.vault_references, "vault baseline");
  const provider = evidence?.provider_credential;
  assert.deepEqual(
    Object.keys(provider ?? {}).sort(),
    ["account_id", "created_at", "id", "label"],
    "Provider evidence must remain metadata-only",
  );
  assert.equal(typeof provider?.id, "string", "New provider credential identity missing");
  assert.ok(!baselineProviderIds.has(provider.id), "Existing provider credential cannot qualify");
  assert.equal(provider.label, run.run_label, "Provider credential label is not run-bound");
  assert.equal(typeof provider.account_id, "string", "Provider account identity missing");
  assert.ok(provider.account_id.length > 0, "Provider account identity missing");
  assert.equal(typeof provider.created_at, "number", "Provider creation time missing");
  assert.ok(
    provider.created_at >= run.started_at && provider.created_at <= now,
    "Provider credential creation time is outside this run",
  );
  assert.equal(
    evidence.cleanup.policy,
    run.cleanup_policy,
    "Cleanup policy changed during the run",
  );
  assert.equal(typeof evidence.vault_reference, "string", "Vault reference missing");
  assert.ok(
    !baselineVaultRefs.has(evidence.vault_reference),
    "Existing vault entry cannot qualify",
  );
  const vault = vaultCredentials.find(
    (credential) => credential.reference === evidence.vault_reference,
  );
  assert.ok(vault, "Exact new vault reference is absent from metadata listing");
  assert.equal(vault.label, run.run_label, "Vault metadata is not run-bound");
  assert.equal(
    evidence.probe?.reference,
    evidence.vault_reference,
    "Probe is not exact-reference bound",
  );
  assert.equal(typeof evidence.probe?.http?.method, "string", "Harmless probe method missing");
  assert.equal(typeof evidence.probe?.http?.url, "string", "Harmless probe URL missing");
  assert.equal(evidence.probe?.harmless, true, "Driver did not classify the probe as harmless");
  assert.ok(
    evidence.cleanup?.policy === "retain" || evidence.cleanup?.policy === "revoke",
    "Explicit credential cleanup policy missing",
  );
  assert.equal(
    evidence.cleanup?.status,
    evidence.cleanup.policy === "retain" ? "retained" : "revoked",
    "Credential cleanup status is incomplete",
  );
  return { provider, vault, probe: evidence.probe, cleanup: evidence.cleanup };
}
