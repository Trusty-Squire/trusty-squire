// Publish-time manifest validation.
//
// Runs in two passes:
//   1. Zod schema check — catches shape errors (missing fields, wrong
//      types, malformed enums) with structured paths.
//   2. Structural rules — covers things Zod can't natively express:
//      step-id uniqueness across each flow, network capability covers
//      every URL host, vault-write coverage of every extracted credential,
//      semver validity.

import { valid as semverValid } from "semver";
import { z } from "zod";
import type {
  AdapterManifest,
  StepDef,
  VaultWriteKind,
} from "@trusty-squire/adapter-sdk";

export class ManifestValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`manifest validation failed: ${issues.join("; ")}`);
    this.name = "ManifestValidationError";
  }
}

// ── Zod schemas ──────────────────────────────────────────────

const recurrenceSchema = z.enum(["none", "one_time", "monthly", "yearly"]);
const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const reverseAuthSchema = z.object({
  source: z.enum(["vault", "context"]),
  reference_template: z.string(),
  scheme: z.enum(["bearer", "basic", "header"]).optional(),
  header_name: z.string().optional(),
});

const reverseActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http_request"),
    method: httpMethodSchema,
    url_template: z.string(),
    auth: reverseAuthSchema.optional(),
  }),
  z.object({ kind: z.literal("stripe_refund"), charge_id_template: z.string() }),
  z.object({ kind: z.literal("vault_delete"), reference_template: z.string() }),
  z.object({ kind: z.literal("noop"), reason: z.string() }),
]);

const sideEffectEmissionSchema = z.object({
  type: z.enum([
    "saas_account",
    "stripe_charge",
    "email_alias_consumed",
    "vault_entry",
    "totp_seed_stored",
  ]),
  reference_template: z.string(),
  reversible: z.boolean(),
  reverse_action: reverseActionSchema,
});

const stepBaseSchema = {
  id: z.string().min(1),
  description: z.string().optional(),
  emit_side_effect: sideEffectEmissionSchema.optional(),
};

const httpRequestStepSchema = z.object({
  ...stepBaseSchema,
  type: z.literal("http_request"),
  request: z.object({
    method: httpMethodSchema,
    url_template: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    body_template: z.unknown().optional(),
    auth: reverseAuthSchema.optional(),
    timeout_ms: z.number().optional(),
  }),
  expect: z.object({
    status: z.union([z.number(), z.array(z.number())]),
    extract: z.record(z.string(), z.string()).optional(),
    body_includes: z.array(z.string()).optional(),
  }),
});

const emailMatchSchema = z.object({
  from: z.union([z.string(), z.array(z.string())]).optional(),
  subject_pattern: z.string().optional(),
  body_pattern: z.string().optional(),
});

const stepSchema = z.discriminatedUnion("type", [
  httpRequestStepSchema,
  z.object({ ...stepBaseSchema, type: z.literal("wait_for_email"), match: emailMatchSchema, timeout_seconds: z.number() }),
  z.object({
    ...stepBaseSchema,
    type: z.literal("wait_for_email_with_code"),
    match: emailMatchSchema,
    code_pattern: z.string(),
    extract_to: z.string(),
    timeout_seconds: z.number(),
  }),
  z.object({
    ...stepBaseSchema,
    type: z.literal("click_link_in_email"),
    match: emailMatchSchema,
    link_pattern: z.string(),
    follow_redirects: z.boolean(),
    timeout_seconds: z.number(),
  }),
  z.object({
    ...stepBaseSchema,
    type: z.literal("wait_for_webhook"),
    match_event: z.string(),
    timeout_seconds: z.number(),
  }),
  z.object({
    ...stepBaseSchema,
    type: z.literal("totp_generate"),
    seed_reference: z.string(),
    extract_to: z.string(),
  }),
  z.object({ ...stepBaseSchema, type: z.literal("delay"), seconds: z.number() }),
  z.object({
    ...stepBaseSchema,
    type: z.literal("branch"),
    condition: z.unknown(),
    on_true: z.string(),
    on_false: z.string(),
  }),
  z.object({
    ...stepBaseSchema,
    type: z.literal("custom_hook"),
    hook: z.string(),
    capabilities_required: z.array(z.string()),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const flowSchema = z.object({
  steps: z.array(stepSchema),
  entry: z.string().optional(),
});

const planSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  monthly_cents: z.number(),
  yearly_cents: z.number().optional(),
  recurrence: recurrenceSchema,
  description: z.string().optional(),
});

const vaultWriteSchema = z.object({
  kind: z.enum(["api_key", "oauth_token", "session_cookie", "totp_seed", "sso_metadata"]),
  reference_template: z.string(),
  rotation_required: z.boolean(),
});

const capabilitiesSchema = z.object({
  payment: z.object({ max_authorize_cents: z.number(), recurrence: recurrenceSchema }),
  email: z.object({ receive_from: z.array(z.string()) }),
  network: z.object({ allowed_domains: z.array(z.string()) }),
  vault_writes: z.array(vaultWriteSchema),
  identity_release: z
    .object({
      release_to_user_on: z.array(z.enum(["complete", "request"])),
      redact_on_release: z.array(z.string()),
    })
    .optional(),
  otp: z
    .object({
      delivery: z.array(z.enum(["email", "sms", "totp"])),
      max_attempts: z.number(),
    })
    .optional(),
});

export const adapterManifestSchema = z.object({
  service: z.string().min(1),
  version: z.string(),
  schema_version: z.literal(1),
  authored_by: z.object({
    org: z.string(),
    contact: z.string(),
    homepage: z.string().optional(),
  }),
  audit: z.object({
    reviewer: z.string(),
    reviewed_at: z.string(),
    report_url: z.string().optional(),
  }),
  signature: z.string(),
  metadata: z.object({
    display_name: z.string(),
    category: z.string(),
    homepage: z.string(),
    privacy_policy: z.string().optional(),
    terms_of_service: z.string().optional(),
    description: z.string().optional(),
  }),
  plans: z.array(planSchema),
  default_plan: z.string(),
  capabilities: capabilitiesSchema,
  signup: flowSchema,
  cancel: flowSchema,
  rotate: flowSchema,
  post_signup: z.unknown().optional(),
  tier_2_overrides: z.unknown().optional(),
  migrations: z.unknown().optional(),
  reliability: z.unknown().optional(),
});

// ── Validator entry point ────────────────────────────────────

export function validateManifest(manifest: unknown): asserts manifest is AdapterManifest {
  const issues: string[] = [];

  const parsed = adapterManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      issues.push(`${err.path.join(".")}: ${err.message}`);
    }
    throw new ManifestValidationError(issues);
  }
  const m = parsed.data;

  if (semverValid(m.version) === null) {
    issues.push(`version: '${m.version}' is not valid semver`);
  }

  // Step IDs unique within each flow.
  for (const flowName of ["signup", "cancel", "rotate"] as const) {
    const flow = m[flowName];
    const seen = new Set<string>();
    for (const step of flow.steps) {
      if (seen.has(step.id)) issues.push(`${flowName}: duplicate step id '${step.id}'`);
      seen.add(step.id);
    }
  }

  // payment.max_authorize_cents covers the most expensive recurring plan.
  const maxRecurringPlan = Math.max(
    0,
    ...m.plans.filter((p) => p.recurrence !== "none").map((p) => p.monthly_cents),
  );
  if (maxRecurringPlan > m.capabilities.payment.max_authorize_cents) {
    issues.push(
      `capabilities.payment.max_authorize_cents (${m.capabilities.payment.max_authorize_cents}) < ` +
        `most expensive plan (${maxRecurringPlan})`,
    );
  }

  // Network capability covers every HTTP step + http_request reverse target.
  const allowed = m.capabilities.network.allowed_domains;
  for (const flowName of ["signup", "cancel", "rotate"] as const) {
    const flow = m[flowName];
    for (const step of flow.steps) {
      if (step.type === "http_request") {
        const host = extractStaticHost(step.request.url_template);
        if (host !== null && !hostInAllowed(host, allowed)) {
          issues.push(
            `${flowName}.${step.id}: url host '${host}' not in network.allowed_domains`,
          );
        }
        if (step.emit_side_effect?.reverse_action.kind === "http_request") {
          const reverseHost = extractStaticHost(step.emit_side_effect.reverse_action.url_template);
          if (reverseHost !== null && !hostInAllowed(reverseHost, allowed)) {
            issues.push(
              `${flowName}.${step.id}.emit_side_effect.reverse_action: host '${reverseHost}' not allowed`,
            );
          }
        }
      }
    }
  }

  // vault_writes covers every extracted credential. Convention from
  // chunk-8: extract name === vault_write.kind. We catch declared
  // VaultWriteKinds in any HTTP step's expect.extract that aren't
  // matched by a vault_writes entry.
  const declaredKinds = new Set<VaultWriteKind>(m.capabilities.vault_writes.map((w) => w.kind));
  const credentialKindNames: VaultWriteKind[] = [
    "api_key",
    "oauth_token",
    "session_cookie",
    "totp_seed",
    "sso_metadata",
  ];
  for (const flowName of ["signup", "cancel", "rotate"] as const) {
    const flow = m[flowName];
    for (const step of flow.steps) {
      if (step.type !== "http_request") continue;
      const extract = step.expect.extract;
      if (extract === undefined) continue;
      for (const name of Object.keys(extract)) {
        if (
          (credentialKindNames as string[]).includes(name) &&
          !declaredKinds.has(name as VaultWriteKind)
        ) {
          issues.push(
            `${flowName}.${step.id}.expect.extract.${name}: credential type extracted but not in capabilities.vault_writes`,
          );
        }
      }
    }
  }

  if (!m.plans.some((p) => p.id === m.default_plan)) {
    issues.push(`default_plan: '${m.default_plan}' is not in plans`);
  }

  if (issues.length > 0) {
    throw new ManifestValidationError(issues);
  }
}

// Strip ${...} placeholders, then parse out the hostname. Returns null
// when the resulting URL is unparseable (e.g. the entire host was a
// placeholder) — those skip the host check; the runtime's per-call
// capability gate will catch interpolated URLs at execute time.
export function extractStaticHost(urlTemplate: string): string | null {
  const stripped = urlTemplate.replace(/\$\{[^}]+\}/g, "");
  try {
    return new URL(stripped).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostInAllowed(host: string, allowed: string[]): boolean {
  for (const pat of allowed) {
    const p = pat.toLowerCase();
    if (p === host) return true;
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      if (host !== base && host.endsWith("." + base)) return true;
    }
  }
  return false;
}

// Re-export StepDef for callers that need to introspect manifests.
export type { StepDef };
