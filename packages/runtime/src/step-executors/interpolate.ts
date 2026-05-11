// Strict variable interpolation for step templates.
//
// Supports `${context.foo}`, `${generated.foo}`, `${steps.step_id.field}`,
// `${vault.foo}`, plus a request-time `${response.body.x}` scope when
// interpolating reverse_action templates after a response is in hand.
//
// Strict: any undefined reference throws InterpolationError. Strictness
// is the security boundary — silently substituting empty strings for
// missing values would let an adapter run requests against unintended
// hosts ("https://${vault.endpoint}/things" with empty endpoint →
// "https:///things" → resolved against attacker-controlled DNS).

import type { Run } from "../types.js";

export class InterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterpolationError";
  }
}

export type Scope = Record<string, unknown>;

export function buildScope(run: Run, response?: unknown): Scope {
  // run.context.steps is the explicit override map (rare). The common
  // path is reading from successful StepRecords' response objects —
  // an HTTP step's response carries `{ status, body, extracted }`,
  // which is exactly what manifests reference as
  // `${steps.create_account.body.id}` or similar. We build the
  // namespace from successful steps first, then let context.steps
  // overrides win.
  const stepsScope: Record<string, unknown> = {};
  for (const step of run.steps) {
    if (step.status === "success" && step.response !== null) {
      stepsScope[step.step_id] = step.response;
    }
  }
  for (const [k, v] of Object.entries(run.context.steps)) {
    stepsScope[k] = v;
  }

  const scope: Scope = {
    context: {
      email_alias: run.context.email_alias,
      project_name: run.context.project_name,
      user_display_name: run.context.user_display_name,
    },
    generated: run.context.generated,
    steps: stepsScope,
    vault: run.context.vault,
  };
  if (response !== undefined) scope.response = response;
  return scope;
}

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

export function interpolateString(template: string, scope: Scope): string {
  return template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const value = resolve(path.trim(), scope);
    if (value === undefined || value === null) {
      throw new InterpolationError(`undefined reference: \${${path}}`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

// Walk a structured value (object / array / scalar) and interpolate
// every string leaf. Used for HTTP body templates.
export function interpolateDeep(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return interpolateString(value, scope);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, scope));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateDeep(v, scope);
    }
    return out;
  }
  return value;
}

// Resolve a dot-path like "body.user.id" against a scope. Throws on
// undefined; throws on traversing a non-object intermediate.
export function resolve(path: string, scope: Scope): unknown {
  const parts = path.split(".");
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur === null || cur === undefined) {
      throw new InterpolationError(`undefined reference: \${${path}}`);
    }
    if (typeof cur !== "object") {
      throw new InterpolationError(
        `cannot traverse '${p}' through non-object in path \${${path}}`,
      );
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined) {
    throw new InterpolationError(`undefined reference: \${${path}}`);
  }
  return cur;
}

// JSONPath-flavoured extract: supports leading '$.' (or no prefix) plus
// dot-paths. Bracketed indices intentionally unsupported until we hit a
// real adapter that needs them; throwing keeps surprises out of audits.
export function extractByPath(data: unknown, jsonPath: string): unknown {
  const cleaned = jsonPath.startsWith("$.") ? jsonPath.slice(2) : jsonPath;
  if (cleaned.includes("[") || cleaned.includes("]")) {
    throw new InterpolationError(`unsupported JSONPath syntax: '${jsonPath}'`);
  }
  return resolve(cleaned, data as Scope);
}
