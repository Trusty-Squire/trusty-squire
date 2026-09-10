import assert from "node:assert/strict";

export const FORCE_FRESH_CREDENTIAL_POLICY = "force_fresh";

// This catalog is the reviewed authority for qualification probes. Drivers do
// not get to assert that an arbitrary request is harmless. Each entry is an
// authenticated, provider-documented GET that cannot create, send, update, or
// delete provider state.
const PROVIDER_PROBES = Object.freeze({
  resend: Object.freeze({
    id: "resend:list-domains:v1",
    http: Object.freeze({
      method: "GET",
      url: "https://api.resend.com/domains",
      headers: Object.freeze({
        Authorization: "Bearer ${SECRET}",
        "User-Agent": "trusty-squire-credential-qualification",
      }),
    }),
  }),
  neon: Object.freeze({
    id: "neon:list-projects:v1",
    http: Object.freeze({
      method: "GET",
      url: "https://console.neon.tech/api/v2/projects",
      headers: Object.freeze({ Authorization: "Bearer ${SECRET}" }),
      query: Object.freeze({ limit: "1", timeout: "100" }),
    }),
  }),
  xata: Object.freeze({
    id: "xata:list-workspaces:v1",
    http: Object.freeze({
      method: "GET",
      url: "https://api.xata.io/workspaces",
      headers: Object.freeze({
        Authorization: "Bearer ${SECRET}",
        "Content-Type": "application/json",
      }),
    }),
  }),
});

const copy = (value) => structuredClone(value);

export function reviewedCredentialProbe(provider) {
  assert.equal(typeof provider, "string", "Provider identifier missing");
  const probe = PROVIDER_PROBES[provider.toLowerCase()];
  assert.ok(probe, `No reviewed read-only credential probe for provider ${provider}`);
  return copy(probe);
}

export function createFreshCredentialRun(
  runId,
  serviceIndex,
  cleanupPolicy,
  provider,
  providerAccountId,
  now = Date.now(),
) {
  assert.equal(typeof runId, "string");
  assert.ok(runId.length > 0);
  assert.ok(cleanupPolicy === "retain" || cleanupPolicy === "revoke");
  assert.equal(typeof provider, "string", "Provider identifier missing");
  assert.ok(provider.length > 0, "Provider identifier missing");
  assert.equal(typeof providerAccountId, "string", "Expected provider account identity missing");
  assert.ok(providerAccountId.length > 0, "Expected provider account identity missing");
  reviewedCredentialProbe(provider);
  return {
    credential_policy: FORCE_FRESH_CREDENTIAL_POLICY,
    run_id: runId,
    run_label: `trusty-squire-${runId}-${serviceIndex}`,
    started_at: now,
    cleanup_policy: cleanupPolicy,
    provider: provider.toLowerCase(),
    provider_account_id: providerAccountId,
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

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} missing`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} must remain metadata-only`,
  );
}

export function qualifyOldCredentialControl({ run, baseline, control, vaultCredentials }) {
  exactKeys(control, ["provider_credential_id", "vault_reference"], "Old-credential control");
  const providerIds = stringSet(baseline?.provider_credential_ids, "provider baseline");
  const vaultRefs = stringSet(baseline?.vault_references, "vault baseline");
  assert.ok(
    providerIds.has(control.provider_credential_id),
    "Old provider credential is absent from the pre-run baseline",
  );
  assert.ok(
    vaultRefs.has(control.vault_reference),
    "Old vault credential is absent from the pre-run baseline",
  );
  const vault = vaultCredentials.find(
    (credential) => credential.reference === control.vault_reference,
  );
  assert.ok(vault, "Old vault credential is absent from the pre-run metadata listing");
  const probe = reviewedCredentialProbe(run.provider);
  assert.ok(
    Array.isArray(vault.allowed_hosts) &&
      vault.allowed_hosts.includes(new URL(probe.http.url).hostname),
    "Old vault credential does not authorize the reviewed probe host",
  );
  return {
    provider_credential_id: control.provider_credential_id,
    vault_reference: control.vault_reference,
    provider: run.provider,
    probe,
  };
}

/** Validate metadata-only creation evidence and bind the centrally reviewed
 * probe. This function runs before the authenticated probe and before cleanup. */
export function qualifyFreshCredentialEvidence({
  run,
  baseline,
  evidence,
  vaultCredentials,
  now = Date.now(),
}) {
  assert.equal(run.credential_policy, FORCE_FRESH_CREDENTIAL_POLICY);
  exactKeys(
    evidence,
    ["credential_policy", "provider_credential", "vault_reference"],
    "Fresh-credential evidence",
  );
  assert.equal(evidence.credential_policy, FORCE_FRESH_CREDENTIAL_POLICY);
  const baselineProviderIds = stringSet(baseline?.provider_credential_ids, "provider baseline");
  const baselineVaultRefs = stringSet(baseline?.vault_references, "vault baseline");
  const provider = evidence.provider_credential;
  exactKeys(provider, ["account_id", "created_at", "id", "label"], "Provider evidence");
  assert.equal(typeof provider.id, "string", "New provider credential identity missing");
  assert.ok(!baselineProviderIds.has(provider.id), "Existing provider credential cannot qualify");
  assert.equal(provider.label, run.run_label, "Provider credential label is not run-bound");
  assert.equal(
    provider.account_id,
    run.provider_account_id,
    "Provider credential belongs to the wrong account",
  );
  assert.equal(typeof provider.created_at, "number", "Provider creation time missing");
  assert.ok(
    provider.created_at >= run.started_at && provider.created_at <= now,
    "Provider credential creation time is outside this run",
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
  const probe = reviewedCredentialProbe(run.provider);
  assert.ok(
    Array.isArray(vault.allowed_hosts) &&
      vault.allowed_hosts.includes(new URL(probe.http.url).hostname),
    "Fresh vault credential does not authorize the reviewed probe host",
  );
  return {
    provider,
    vault,
    provider_name: run.provider,
    probe,
  };
}

export function validateReviewedCredentialProbeResponse(provider, response) {
  reviewedCredentialProbe(provider);
  exactKeys(response, ["body", "headers", "status", "truncated"], "Credential probe response");
  assert.equal(response.status, 200, `Authenticated ${provider} probe did not return HTTP 200`);
  assert.equal(response.truncated, false, "Credential probe response was truncated");
  assert.equal(typeof response.body, "string", "Credential probe response body missing");
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error(`Authenticated ${provider} probe did not return JSON`);
  }
  if (provider === "resend") {
    assert.equal(body?.object, "list", "Resend probe response is not a domain list");
    assert.ok(Array.isArray(body?.data), "Resend probe response data missing");
  } else if (provider === "neon") {
    assert.ok(Array.isArray(body?.projects), "Neon probe response projects missing");
  } else if (provider === "xata") {
    assert.ok(
      Array.isArray(body) || Array.isArray(body?.workspaces),
      "Xata probe response workspaces missing",
    );
  }
  return true;
}

export function qualifyCredentialCleanup({
  run,
  qualified,
  probeCompletedAt,
  cleanupEvidence,
  now = Date.now(),
}) {
  assert.equal(typeof probeCompletedAt, "number", "Probe completion time missing");
  assert.ok(
    probeCompletedAt >= qualified.provider.created_at,
    "Probe predates credential creation",
  );
  assert.ok(probeCompletedAt <= now, "Probe completion time is in the future");
  exactKeys(
    cleanupEvidence,
    ["completed_at", "policy", "provider_credential_id", "status"],
    "Cleanup evidence",
  );
  assert.equal(cleanupEvidence.policy, run.cleanup_policy, "Cleanup policy changed during the run");
  assert.equal(
    cleanupEvidence.provider_credential_id,
    qualified.provider.id,
    "Cleanup targeted a different provider credential",
  );
  assert.ok(
    cleanupEvidence.completed_at >= probeCompletedAt,
    "Credential cleanup occurred before the authenticated probe",
  );
  assert.ok(cleanupEvidence.completed_at <= now, "Cleanup completion time is in the future");
  assert.equal(
    cleanupEvidence.status,
    cleanupEvidence.policy === "retain" ? "retained" : "revoked",
    "Credential cleanup status is incomplete",
  );
  return cleanupEvidence;
}

/** Execute the one allowed ordering: exact-reference reviewed probe, response
 * validation, then retain/revoke cleanup. Keeping this sequence here makes it
 * impossible for a provider driver to move revocation ahead of qualification. */
export async function probeThenCleanupFreshCredential({
  run,
  qualified,
  callUseCredential,
  revokeCredential,
  now = Date.now,
}) {
  assert.equal(typeof callUseCredential, "function", "Credential probe executor missing");
  const probeResult = await callUseCredential({
    reference: qualified.vault.reference,
    http: qualified.probe.http,
  });
  validateReviewedCredentialProbeResponse(run.provider, probeResult.response);
  const probeCompletedAt = now();
  let cleanupEvidence;
  if (run.cleanup_policy === "retain") {
    cleanupEvidence = {
      policy: "retain",
      status: "retained",
      provider_credential_id: qualified.provider.id,
      completed_at: now(),
    };
  } else {
    assert.equal(
      typeof revokeCredential,
      "function",
      "Revoke cleanup policy requires a revoke executor",
    );
    cleanupEvidence = await revokeCredential(qualified.provider);
  }
  const cleanup = qualifyCredentialCleanup({
    run,
    qualified,
    probeCompletedAt,
    cleanupEvidence,
    now: now(),
  });
  return { probe_id: qualified.probe.id, probe_completed_at: probeCompletedAt, cleanup };
}
