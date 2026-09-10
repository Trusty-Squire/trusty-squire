import assert from "node:assert/strict";

const ALLOWED_TOOLS = new Set([
  "operate_navigate",
  "operate_observe",
  "operate_click",
  "operate_type",
  "operate_select",
  "operate_extract",
]);

function interpolate(value, bindings, results) {
  if (typeof value === "string") {
    return value
      .replaceAll("$RUN_LABEL", bindings.run.run_label)
      .replaceAll("$SESSION_ID", bindings.sessionId);
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, bindings, results));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && value.$from) {
      const resolved = atPath(results.get(value.$from.step), value.$from.path);
      assert.notEqual(
        resolved,
        undefined,
        `Missing argument ${value.$from.step}.${value.$from.path}`,
      );
      return resolved;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, bindings, results)]),
    );
  }
  return value;
}

function atPath(value, path) {
  return path
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}

function evidenceValue(spec, results, bindings) {
  if (Object.hasOwn(spec, "literal")) return interpolate(spec.literal, bindings);
  const source = atPath(results.get(spec.step), spec.path);
  assert.notEqual(source, undefined, `Missing evidence ${spec.step}.${spec.path}`);
  if (!spec.pattern) return source;
  const match = new RegExp(spec.pattern, "u").exec(String(source));
  assert.ok(match?.groups?.value, `Observed evidence did not match ${spec.pattern}`);
  return spec.as === "timestamp" ? Date.parse(match.groups.value) : match.groups.value;
}

async function execute(stage, call, sessionId, run) {
  assert.ok(
    Array.isArray(stage.steps) && stage.steps.length <= 12,
    "Driver stage requires at most 12 bounded steps",
  );
  const results = new Map();
  for (const step of stage.steps) {
    assert.ok(ALLOWED_TOOLS.has(step.tool), `Unreviewed driver tool: ${step.tool}`);
    assert.equal(typeof step.id, "string", "Every driver step needs an id");
    assert.ok(!results.has(step.id), `Duplicate driver step id: ${step.id}`);
    if (step.when) {
      const actual = atPath(results.get(step.when.step), step.when.path);
      if (actual !== step.when.equals) continue;
    }
    const args = interpolate(
      { ...(step.arguments ?? {}), session_id: sessionId },
      { run, sessionId },
      results,
    );
    let result;
    try {
      result = await call(step.tool, args, step.timeout_ms ?? 20_000);
    } catch (error) {
      if (!step.continue_on_error || !error?.toolResult) throw error;
      result = error.toolResult;
    }
    const rendered = result.dom ?? result.text ?? JSON.stringify(result);
    if (step.require_pattern)
      assert.match(
        rendered,
        new RegExp(interpolate(step.require_pattern, { run, sessionId }, results), "u"),
      );
    results.set(step.id, result);
  }
  return { results, bindings: { run, sessionId } };
}

export async function captureCredentialBaseline({ call, sessionId, run, service }) {
  const { results, bindings } = await execute(
    service.driverEvidence.baseline,
    call,
    sessionId,
    run,
  );
  const evidence = service.driverEvidence.baseline.evidence;
  return {
    account_id: evidenceValue(evidence.account_id, results, bindings),
    provider_credential_ids: evidence.provider_credential_ids.map((item) =>
      evidenceValue(item, results, bindings),
    ),
    initial_auth_state: evidenceValue(evidence.initial_auth_state, results, bindings),
  };
}

export async function provision({ call, sessionId, run, service }) {
  const { results, bindings } = await execute(
    service.driverEvidence.provision,
    call,
    sessionId,
    run,
  );
  const evidence = service.driverEvidence.provision.evidence;
  return {
    credential_policy: "force_fresh",
    provider_credential: {
      id: evidenceValue(evidence.provider_id, results, bindings),
      label: evidenceValue(evidence.label, results, bindings),
      account_id: evidenceValue(evidence.account_id, results, bindings),
      created_at: evidenceValue(evidence.created_at, results, bindings),
    },
    vault_reference: evidenceValue(evidence.vault_reference, results, bindings),
  };
}

export async function revokeCredential({ call, sessionId, run, service }) {
  assert.ok(
    service.driverEvidence.revoke,
    "Revoke policy requires an explicit bounded revoke stage",
  );
  await execute(service.driverEvidence.revoke, call, sessionId, run);
}
