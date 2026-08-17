// operator-recipe.ts — Phase A of "user-saved operator workflows as skills"
// (docs/ARCHITECTURE.md). Local read/write/render/bind/resolve logic for
// Operator Recipes. The wire schema itself (the part the registry also
// needs to validate/store shared recipes) lives in the shared
// @trusty-squire/recipe-schema package and is re-exported below so existing
// importers of this module are unaffected.
//
// Three invariants baked into the schema:
//   1. Stable-attribute targeting only. A trace stores authored DOM/semantic
//      hints, never a ref/coordinate; visible text is the unique-only last
//      fallback because operator targets are heavy SPAs whose refs churn.
//   2. Sealed secrets are stored as SLOT REFERENCES, never values. A recipe
//      built from a session that sealed a secret records `{slot, stored:false}`
//      and an `extract`/`type_secret` step; the raw value never touches disk.
//   3. A POSTCONDITION the replay verifies. Without it a "remembered" workflow
//      silently succeeds on a run that didn't actually work — the anti-false-
//      green principle (isCredentialNoise) one level up.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  OperatorVerbSchema,
  RecipeHoleSchema,
  RecipeValueSchema,
  RecipeTargetSchema,
  PostconditionSchema,
  OperatorRecipeSchema,
  operatorRecipeDomain,
  operatorRecipeKey,
  operatorRecipeKeyForDomain,
  canonicalVerb,
  extractActionPath,
  operatorRecipeKeyWithActionPath,
  operatorRecipeKeyForDomainAndActionPath,
  checkoutFieldSetSignature,
  isCheckoutShapeKey,
  checkoutShapeKey,
  operatorRecipeKeyForCheckoutShape,
  isRecipeShareEligible,
  isSameRecipeDomain,
  recipeDomainLockViolations,
  isRecipeDomainLocked,
  EmailAliasTemplatePattern,
  type OperatorVerb,
  type RecipeHole,
  type RecipeValue,
  type RecipeTarget,
  type TraceAction,
  type TraceEntry,
  type SuccessSignal,
  type Postcondition,
  type SecretRef,
  type OperatorRecipe,
  type RecipeShareEligibility,
  type RecipeDomainLockViolation,
} from "@trusty-squire/recipe-schema";
import { filterByNearTextHint } from "./near-text-hint.js";

// ── Schema (re-exported from @trusty-squire/recipe-schema; see there) ──

export {
  OperatorVerbSchema,
  RecipeHoleSchema,
  RecipeValueSchema,
  RecipeTargetSchema,
  PostconditionSchema,
  OperatorRecipeSchema,
  operatorRecipeDomain,
  operatorRecipeKey,
  operatorRecipeKeyForDomain,
  canonicalVerb,
  extractActionPath,
  operatorRecipeKeyWithActionPath,
  operatorRecipeKeyForDomainAndActionPath,
  checkoutFieldSetSignature,
  isCheckoutShapeKey,
  checkoutShapeKey,
  operatorRecipeKeyForCheckoutShape,
  isRecipeShareEligible,
  isSameRecipeDomain,
  recipeDomainLockViolations,
  isRecipeDomainLocked,
  EmailAliasTemplatePattern,
};
export type {
  OperatorVerb,
  RecipeHole,
  RecipeValue,
  RecipeTarget,
  TraceAction,
  TraceEntry,
  SuccessSignal,
  Postcondition,
  SecretRef,
  OperatorRecipe,
  RecipeShareEligibility,
  RecipeDomainLockViolation,
};

// ── Local IO ────────────────────────────────────────────────────────

export function operatorRecipeDir(): string {
  const fromEnv = process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".trusty-squire", "operator-recipes");
}

function safeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "recipe";
  if (slug.length <= 80) return slug;
  // DNS names may exceed the legacy 80-char recipe-name cap. Preserve the
  // readable prefix but hash the tail so two long tenant/domain keys cannot
  // silently overwrite one another.
  const digest = createHash("sha256").update(slug).digest("hex").slice(0, 16);
  return `${slug.slice(0, 63)}-${digest}`;
}

export async function writeRecipe(recipe: OperatorRecipe): Promise<string> {
  // Validate (and, crucially, re-assert the no-stored-value invariant) before
  // anything reaches disk.
  const parsed = OperatorRecipeSchema.parse(recipe);
  const canonical =
    parsed.verb !== undefined && parsed.domain !== undefined
      ? {
          ...parsed,
          verb: canonicalVerb(parsed.verb),
          domain: parsed.domain.toLowerCase(),
        }
      : parsed;
  const dir = operatorRecipeDir();
  await fs.mkdir(dir, { recursive: true });
  const fileStem =
    canonical.verb !== undefined && canonical.domain !== undefined
      ? operatorRecipeKeyForDomainAndActionPath(
          canonical.verb,
          canonical.domain,
          canonical.action_path ?? "",
        )
      : canonical.name;
  const file = path.join(dir, `${safeFileName(fileStem)}.json`);
  await fs.writeFile(file, `${JSON.stringify(canonical, null, 2)}\n`, "utf8");
  return file;
}

export async function readRecipe(name: string): Promise<OperatorRecipe> {
  const file = path.join(operatorRecipeDir(), `${safeFileName(name)}.json`);
  return await readRecipeFromFile(file);
}

/** Read + parse a recipe from an exact file path (the shape `writeRecipe` returns). */
export async function readRecipeFromFile(file: string): Promise<OperatorRecipe> {
  const raw = await fs.readFile(file, "utf8");
  return OperatorRecipeSchema.parse(JSON.parse(raw));
}

// Layer-1 lookup: try the specific (verb, domain, action_path) file first,
// then fall through to today's degenerate (verb, domain) file on a miss (or
// when action_path is empty to begin with). The fallback is mandatory, not
// optional — an old recipe recorded before action_path existed sits only at
// the degenerate slot, and a replaying URL that now happens to extract a
// non-empty action_path must still find it.
export async function readRecipeForTask(
  verb: OperatorVerb,
  serviceUrl: string,
): Promise<OperatorRecipe> {
  const actionPath = extractActionPath(serviceUrl);
  if (actionPath.length > 0) {
    try {
      return await readRecipe(operatorRecipeKeyWithActionPath(verb, serviceUrl, actionPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return await readRecipe(operatorRecipeKey(verb, serviceUrl));
}

/** replay-per-leg-signature — local read of a checkout-leg recipe, keyed by field-set signature. */
export async function readRecipeForCheckoutShape(
  verb: OperatorVerb,
  signature: string,
): Promise<OperatorRecipe> {
  return await readRecipe(operatorRecipeKeyForCheckoutShape(verb, signature));
}

export async function listRecipes(): Promise<string[]> {
  try {
    const files = await fs.readdir(operatorRecipeDir());
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

// ── Rail render (the "MAP, not a script") ───────────────────────────

function describeAction(a: TraceAction): string {
  const t = a.text_match !== undefined ? `"${a.text_match}"` : "";
  const v =
    typeof a.value === "string"
      ? `"${a.value}"`
      : a.value !== undefined
        ? `{${a.value.hole}}`
        : undefined;
  switch (a.kind) {
    case "goto":
      return `go to ${a.url_template ?? ""}`;
    case "click":
      return `click ${t}`;
    case "js_click":
      return `click ${t} (JS-dispatch if a plain click doesn't register)`;
    case "type":
      return `type ${v !== undefined ? `${v} ` : ""}into ${t}`;
    case "press":
      return `press ${a.key ?? ""}`;
    case "oauth_click":
      return `click the OAuth button ${t}`;
    case "oauth_settle":
      return `complete the OAuth handshake`;
    case "allow_host":
      return `cross into ${a.host ?? ""}`;
    case "type_secret":
      return `type the sealed secret (slot ${a.slot ?? "?"}) into ${t}`;
    case "select":
      return `select ${v ?? ""} in ${t}`;
    case "set_phone_country":
      return `set the phone country to ${v ?? ""}`;
    case "operate_pay":
      return `pay with ${v ?? "{card}"}`;
    case "scroll":
      return `scroll ${a.direction ?? "down"}`;
    case "extract":
      return `reveal + seal the secret into slot ${a.slot ?? "?"}`;
  }
}

export function renderOperatorRecipeHint(recipe: OperatorRecipe): string {
  const lines: string[] = [
    `Saved operator recipe "${recipe.name}" — a MAP, not a script. Drive toward ` +
      `the goal; fall back to your own judgment if the live page diverges.`,
    `- goal: ${recipe.goal}`,
  ];
  if (recipe.allowed_hosts.length > 0) {
    lines.push(`- spans hosts: ${recipe.allowed_hosts.join(", ")}`);
  }
  if (recipe.trace.length > 0) {
    lines.push(`- route:`);
    recipe.trace.forEach((t, i) => {
      lines.push(`  ${i + 1}. ${t.intent ?? describeAction(t.action)}`);
    });
  }
  if (recipe.secrets.length > 0) {
    lines.push(
      `- sealed steps: reveal + seal each secret YOURSELF (operate_act { kind: "extract", ` +
        `into_slot }) and type it from the slot (type_secret). The recipe never ` +
        `holds the value.`,
    );
  }
  lines.push(`- success when: ${recipe.postcondition.describe}`);
  return lines.join("\n");
}

// ── Postcondition check (pure over a single page snapshot) ───────────

export interface PostconditionSnapshot {
  url: string;
  text: string;
  // label + value LENGTH only — never the value, so a token/secret success
  // signal can't leak the thing it proves.
  fields: Array<{ label: string; value_len: number }>;
}

export interface PostconditionResult {
  confirmed: boolean;
  reason: string;
  evidence: Record<string, string | number | boolean>;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

export function checkSuccessSignal(
  signal: SuccessSignal,
  snap: PostconditionSnapshot,
): PostconditionResult {
  if ("field_text" in signal) {
    const want = norm(signal.field_text);
    const field = snap.fields.find((f) => norm(f.label).includes(want));
    const ok = field !== undefined && field.value_len >= signal.min_value_len;
    return {
      confirmed: ok,
      reason: ok
        ? `field "${signal.field_text}" holds a value of ${field?.value_len} chars (>= ${signal.min_value_len})`
        : field === undefined
          ? `no field matching "${signal.field_text}"`
          : `field "${signal.field_text}" value too short (${field.value_len} < ${signal.min_value_len})`,
      evidence: {
        field: signal.field_text,
        value_len: field?.value_len ?? 0,
        required: signal.min_value_len,
      },
    };
  }
  if ("text_present" in signal) {
    const ok = norm(snap.text).includes(norm(signal.text_present));
    return {
      confirmed: ok,
      reason: ok
        ? `page text contains "${signal.text_present}"`
        : `page text missing "${signal.text_present}"`,
      evidence: { text_present: signal.text_present },
    };
  }
  const ok = snap.url.toLowerCase().includes(signal.url_contains.toLowerCase());
  return {
    confirmed: ok,
    reason: ok ? `url contains "${signal.url_contains}"` : `url missing "${signal.url_contains}"`,
    evidence: { url_contains: signal.url_contains, url: snap.url },
  };
}

// Fill ${VAR} templates in a trace's goto url with caller-supplied params.
// Returns the unresolved var names so the tool can ask for them.
export function fillTemplate(
  template: string,
  params: Record<string, string>,
): { url: string; missing: string[] } {
  const missing: string[] = [];
  const url = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) {
      missing.push(name);
      return `\${${name}}`;
    }
    return v;
  });
  return { url, missing };
}

export interface KnownRecipeInputs {
  address?: Readonly<Record<string, string>> | undefined;
  contact?: Readonly<Record<string, string>> | undefined;
  product_query?: string | undefined;
  credential?: string | Readonly<Record<string, string>> | undefined;
  card?: string | Readonly<Record<string, string>> | undefined;
  quantity?: string | number | undefined;
}

function flattenKnownInputs(inputs: KnownRecipeInputs): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const addGroup = (
    prefix: "address" | "contact" | "credential" | "card",
    value: string | Readonly<Record<string, string>> | undefined,
  ): void => {
    if (typeof value === "string") {
      out.push([prefix, value]);
      return;
    }
    if (value === undefined) return;
    for (const [field, fieldValue] of Object.entries(value)) {
      out.push([`${prefix}.${field}`, fieldValue]);
    }
  };
  addGroup("address", inputs.address);
  addGroup("contact", inputs.contact);
  if (inputs.product_query !== undefined) out.push(["product_query", inputs.product_query]);
  addGroup("credential", inputs.credential);
  addGroup("card", inputs.card);
  if (inputs.quantity !== undefined) out.push(["quantity", String(inputs.quantity)]);
  return out;
}

export function knownRecipeInputValue(inputs: KnownRecipeInputs, hole: string): string | undefined {
  return flattenKnownInputs(inputs).find(([candidate]) => candidate === hole)?.[1];
}

export function knownRecipeInputHolesForValue(inputs: KnownRecipeInputs, value: string): string[] {
  return flattenKnownInputs(inputs)
    .filter(([, known]) => known === value)
    .map(([hole]) => hole);
}

/** Tag only exact, caller-proven values. Unknown literals deliberately remain literals. */
export function tagProvenanceValue(value: string, inputs: KnownRecipeInputs): RecipeValue {
  const knownInputs = flattenKnownInputs(inputs);
  const matches = knownInputs.filter(([, known]) => known === value);
  if (matches.length === 0 && value === "${EMAIL_ALIAS}") {
    matches.push(
      ...knownInputs.filter(
        ([hole, known]) =>
          /^(?:address|contact|credential)(?:\.|$)/.test(hole) &&
          /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(known),
      ),
    );
  }
  const holes = [...new Set(matches.map(([hole]) => hole))];
  if (holes.length > 1) {
    throw new Error(`ambiguous recipe provenance across holes: ${holes.join(", ")}`);
  }
  return holes[0] === undefined ? value : { hole: holes[0] };
}

export function tagTraceProvenance(
  trace: readonly TraceEntry[],
  inputs: KnownRecipeInputs,
): TraceEntry[] {
  return trace.map((entry) => {
    const value = entry.action.value;
    if (typeof value !== "string") return entry;
    return {
      ...entry,
      action: { ...entry.action, value: tagProvenanceValue(value, inputs) },
    };
  });
}

export function bindRecipeValue(
  value: RecipeValue,
  bindings: Readonly<Record<string, string>>,
): string {
  if (typeof value === "string") {
    const filled = fillTemplate(value, bindings as Record<string, string>);
    if (filled.missing.length > 0) {
      throw new Error(`missing recipe binding: ${filled.missing.join(", ")}`);
    }
    return filled.url;
  }
  const bound = bindings[value.hole];
  if (bound === undefined) throw new Error(`missing recipe binding: ${value.hole}`);
  return bound;
}

export function bindRecipeTarget(
  target: RecipeTarget,
  bindings: Readonly<Record<string, string>>,
  emailHole?: string,
): RecipeTarget {
  const bind = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : bindKnownEmailTemplate(value, bindings, emailHole);
  const domHint = target.dom_hint;
  return {
    ...(domHint !== undefined
      ? {
          dom_hint: {
            ...(bind(domHint.testid) !== undefined ? { testid: bind(domHint.testid)! } : {}),
            ...(bind(domHint.id) !== undefined ? { id: bind(domHint.id)! } : {}),
            ...(bind(domHint.name) !== undefined ? { name: bind(domHint.name)! } : {}),
          },
        }
      : {}),
    ...(bind(target.role_hint) !== undefined ? { role_hint: bind(target.role_hint)! } : {}),
    ...(bind(target.accessible_name) !== undefined
      ? { accessible_name: bind(target.accessible_name)! }
      : {}),
    ...(bind(target.near_text_hint) !== undefined
      ? { near_text_hint: bind(target.near_text_hint)! }
      : {}),
    ...(bind(target.href_hint) !== undefined ? { href_hint: bind(target.href_hint)! } : {}),
    ...(bind(target.css) !== undefined ? { css: bind(target.css)! } : {}),
    ...(bind(target.visible_text) !== undefined
      ? { visible_text: bind(target.visible_text)! }
      : {}),
    // field_role is a locale-stable token (not email-templated); pass through.
    ...(target.field_role !== undefined ? { field_role: target.field_role } : {}),
    ...(target.frame_origin !== undefined ? { frame_origin: target.frame_origin } : {}),
    ...(target.frame_path !== undefined ? { frame_path: target.frame_path } : {}),
  };
}

export function bindKnownEmailTemplate(
  value: string,
  bindings: Readonly<Record<string, string>>,
  emailHole?: string,
): string {
  if (!value.includes("${EMAIL_ALIAS")) return value;
  if (emailHole === undefined) {
    throw new Error("email template lacks an attested source hole");
  }
  const email = bindings[emailHole];
  if (email === undefined) throw new Error(`missing recipe binding: ${emailHole}`);
  return value.replace(EmailAliasTemplatePattern, (_token, suffix: string) =>
    suffix
      .split("_")
      .filter(Boolean)
      .reduce(
        (bound, operation) =>
          operation === "URI" ? encodeURIComponent(bound) : cssEscapeRecipeValue(bound),
        email,
      ),
  );
}

export function bindRecipePostcondition(
  postcondition: Postcondition,
  bindings: Readonly<Record<string, string>>,
): Postcondition {
  const bind = (value: string | undefined): string | undefined =>
    value === undefined
      ? undefined
      : bindKnownEmailTemplate(value, bindings, postcondition.email_hole);
  const successSignal = postcondition.success_signal;
  const probeUrl = bind(postcondition.probe_url);
  return {
    ...postcondition,
    ...(probeUrl !== undefined ? { probe_url: probeUrl } : {}),
    success_signal:
      "url_contains" in successSignal
        ? { url_contains: bind(successSignal.url_contains)! }
        : successSignal,
  };
}

export function cssEscapeRecipeValue(value: string): string {
  const chars = [...value];
  return chars
    .map((char, index) => {
      const code = char.codePointAt(0)!;
      if (code === 0) return "�";
      if (
        (code >= 1 && code <= 31) ||
        code === 127 ||
        (index === 0 && code >= 48 && code <= 57) ||
        (index === 1 && code >= 48 && code <= 57 && chars[0] === "-")
      ) {
        return `\\${code.toString(16)} `;
      }
      if (index === 0 && char === "-" && chars.length === 1) return "\\-";
      if (
        code >= 128 ||
        char === "-" ||
        char === "_" ||
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
      ) {
        return char;
      }
      return `\\${char}`;
    })
    .join("");
}

export interface RecipeTargetElement {
  tag?: string;
  testId?: string | null;
  id?: string | null;
  name?: string | null;
  role?: string | null;
  ariaLabel?: string | null;
  labelText?: string | null;
  visibleText?: string | null;
  iconLabel?: string | null;
  placeholder?: string | null;
  title?: string | null;
  href?: string | null;
  selector: string;
  value?: string | null;
  selectedOptionText?: string | null;
  /** HTML autocomplete attribute (may be space-separated tokens). */
  autocomplete?: string | null;
  /** HTML input type (or null for non-inputs). */
  type?: string | null;
  /** Optional site-authored stable role attribute (data-role / data-field-role). */
  dataRole?: string | null;
  frameOrigin?: string | null;
  framePath?: string | null;
}

export type RecipeTargetResolution<T extends RecipeTargetElement> = {
  element: T;
  via: "testid" | "id" | "name" | "role+accessible-name" | "href" | "css" | "visible-text";
};

const targetNorm = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function accessibleName(element: RecipeTargetElement): string {
  return targetNorm(
    element.ariaLabel ??
      element.labelText ??
      element.visibleText ??
      element.iconLabel ??
      element.placeholder ??
      element.title ??
      element.name,
  );
}

function semanticRole(element: RecipeTargetElement): string {
  if (element.role !== null && element.role !== undefined) return targetNorm(element.role);
  if (element.tag === "button") return "button";
  if (element.tag === "a") return "link";
  if (element.tag === "input" || element.tag === "textarea") return "textbox";
  return targetNorm(element.tag);
}

// Input types too generic to prove field identity on their own.
const GENERIC_INPUT_TYPES = new Set([
  "text",
  "search",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "checkbox",
  "radio",
  "file",
  "",
]);

// Autocomplete tokens that do not identify a field role (browser hints only).
const NON_ROLE_AUTOCOMPLETE = new Set(["on", "off", "webauthn"]);

/**
 * Locale-stable field-role signal for money-path fill safety.
 *
 * Priority (never visible label text — that breaks EN→JP cross-locale reuse):
 *  1. autocomplete token (given-name, family-name, postal-code, …)
 *  2. data-role / data-field-role attribute
 *  3. distinguishing input type (email, tel, number, …) — not plain "text"
 *
 * Returns null when nothing stable is available. Callers must treat null as a
 * miss: absence of proof is not proof of identity.
 */
export function localeStableFieldRole(
  element: Pick<RecipeTargetElement, "autocomplete" | "type" | "dataRole">,
): string | null {
  const rawAc = (element.autocomplete ?? "").trim().toLowerCase();
  if (rawAc.length > 0) {
    // HTML autocomplete may be space-separated ("shipping given-name"). Prefer
    // the rightmost non-section token — section prefixes (shipping/billing)
    // are useful but the field kind is the last token.
    const tokens = rawAc.split(/\s+/).filter((t) => t.length > 0);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i]!;
      if (token.startsWith("section-")) continue;
      if (token === "shipping" || token === "billing") continue;
      if (NON_ROLE_AUTOCOMPLETE.has(token)) continue;
      return `ac:${token}`;
    }
  }
  const dataRole = (element.dataRole ?? "").trim().toLowerCase();
  if (dataRole.length > 0) return `data:${dataRole.slice(0, 80)}`;
  const inputType = (element.type ?? "").trim().toLowerCase();
  if (!GENERIC_INPUT_TYPES.has(inputType)) return `type:${inputType}`;
  return null;
}

/** True only when both sides have a role signal and they agree exactly. */
export function fieldRoleMatches(
  recorded: string | undefined,
  element: Pick<RecipeTargetElement, "autocomplete" | "type" | "dataRole">,
): boolean {
  if (recorded === undefined || recorded.length === 0) return false;
  const live = localeStableFieldRole(element);
  return live !== null && live === recorded;
}

/** Ordered fallback. It is intentionally not a weighted/scored matcher. */
export function resolveRecipeTarget<T extends RecipeTargetElement>(
  elements: readonly T[],
  target: RecipeTarget,
): RecipeTargetResolution<T> | null {
  const scopedElements = elements.filter(
    (candidate) =>
      (target.frame_origin === undefined || candidate.frameOrigin === target.frame_origin) &&
      (target.frame_path === undefined || candidate.framePath === target.frame_path),
  );
  const first = (matches: T[]): T | undefined => {
    if (matches.length === 1) return matches[0];
    if (target.near_text_hint === undefined || matches.length === 0) return undefined;
    const narrowed = filterByNearTextHint(matches, target.near_text_hint, scopedElements);
    return narrowed.length === 1 ? narrowed[0] : undefined;
  };
  if (target.dom_hint?.testid !== undefined) {
    const element = first(
      scopedElements.filter((candidate) => candidate.testId === target.dom_hint?.testid),
    );
    if (element !== undefined) return { element, via: "testid" };
  }
  if (target.dom_hint?.id !== undefined) {
    const element = first(
      scopedElements.filter((candidate) => candidate.id === target.dom_hint?.id),
    );
    if (element !== undefined) return { element, via: "id" };
  }
  if (target.dom_hint?.name !== undefined) {
    const element = first(
      scopedElements.filter((candidate) => candidate.name === target.dom_hint?.name),
    );
    if (element !== undefined) return { element, via: "name" };
  }
  if (target.role_hint !== undefined && target.accessible_name !== undefined) {
    const wantedRole = targetNorm(target.role_hint);
    const wantedName = targetNorm(target.accessible_name);
    const element = first(
      scopedElements.filter(
        (candidate) =>
          semanticRole(candidate) === wantedRole && accessibleName(candidate) === wantedName,
      ),
    );
    if (element !== undefined) return { element, via: "role+accessible-name" };
  }
  if (target.href_hint !== undefined) {
    const hrefPath = (value: string): string => {
      try {
        return new URL(value, "https://recipe.invalid").pathname;
      } catch {
        return value;
      }
    };
    const wantedHref = hrefPath(target.href_hint);
    const element = first(
      scopedElements.filter(
        (candidate) =>
          candidate.href !== null &&
          candidate.href !== undefined &&
          hrefPath(candidate.href) === wantedHref,
      ),
    );
    if (element !== undefined) return { element, via: "href" };
  }
  if (target.css !== undefined) {
    const element = first(scopedElements.filter((candidate) => candidate.selector === target.css));
    if (element !== undefined) return { element, via: "css" };
  }
  if (target.visible_text !== undefined) {
    const wanted = targetNorm(target.visible_text);
    const matches = scopedElements.filter(
      (candidate) => targetNorm(candidate.visibleText) === wanted,
    );
    if (matches.length === 1) return { element: matches[0] as T, via: "visible-text" };
  }
  return null;
}

export function resolveRecipeFieldTarget<T extends RecipeTargetElement>(
  elements: readonly T[],
  target: RecipeTarget,
): RecipeTargetResolution<T> | null {
  const resolution = resolveRecipeTarget(elements, target);
  if (resolution === null) return null;
  // Money fields resolve by id/testid only (no fuzzy name/label) so an id
  // drift cannot smuggle a value via a looser match. Then require a
  // locale-stable role match so a page whose labels (or worse, role tokens)
  // have moved under the same id cannot receive a confident wrong fill.
  if (resolution.via !== "testid" && resolution.via !== "id") return null;
  if (!fieldRoleMatches(target.field_role, resolution.element)) return null;
  return resolution;
}

export function hasRecipeTargetCandidate<T extends RecipeTargetElement>(
  elements: readonly T[],
  target: RecipeTarget,
): boolean {
  const wantedAccessibleName = targetNorm(target.accessible_name);
  const wantedVisibleText = targetNorm(target.visible_text);
  return elements.some((candidate) => {
    if (target.frame_origin !== undefined && candidate.frameOrigin !== target.frame_origin)
      return false;
    if (target.frame_path !== undefined && candidate.framePath !== target.frame_path) return false;
    if (target.dom_hint?.testid !== undefined && candidate.testId === target.dom_hint.testid) {
      return true;
    }
    if (target.dom_hint?.id !== undefined && candidate.id === target.dom_hint.id) return true;
    if (target.dom_hint?.name !== undefined && candidate.name === target.dom_hint.name) return true;
    if (
      target.role_hint !== undefined &&
      target.accessible_name !== undefined &&
      semanticRole(candidate) === targetNorm(target.role_hint) &&
      accessibleName(candidate) === wantedAccessibleName
    ) {
      return true;
    }
    if (target.href_hint !== undefined && candidate.href === target.href_hint) return true;
    if (target.css !== undefined && candidate.selector === target.css) return true;
    return (
      target.visible_text !== undefined && targetNorm(candidate.visibleText) === wantedVisibleText
    );
  });
}

export function resolveRecipeRepairTarget<T extends RecipeTargetElement>(
  elements: readonly T[],
  target: RecipeTarget,
): T | null {
  let candidates = [...elements];
  if (target.frame_origin !== undefined) {
    candidates = candidates.filter((candidate) => candidate.frameOrigin === target.frame_origin);
  }
  if (target.frame_path !== undefined) {
    candidates = candidates.filter((candidate) => candidate.framePath === target.frame_path);
  }
  let constrained = false;
  if (target.dom_hint?.name !== undefined) {
    candidates = candidates.filter((candidate) => candidate.name === target.dom_hint?.name);
    constrained = true;
  }
  if (target.role_hint !== undefined) {
    const wantedRole = targetNorm(target.role_hint);
    candidates = candidates.filter((candidate) => semanticRole(candidate) === wantedRole);
    constrained = true;
  }
  if (target.accessible_name !== undefined) {
    const wantedName = targetNorm(target.accessible_name);
    candidates = candidates.filter((candidate) => accessibleName(candidate) === wantedName);
    constrained = true;
  }
  if (target.visible_text !== undefined) {
    const wantedText = targetNorm(target.visible_text);
    candidates = candidates.filter((candidate) => targetNorm(candidate.visibleText) === wantedText);
    constrained = true;
  }
  if (target.near_text_hint !== undefined) {
    candidates = filterByNearTextHint(candidates, target.near_text_hint, elements);
    constrained = true;
  }
  return constrained && candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export interface FilledFieldExpectation {
  target: RecipeTarget;
  expected: string;
  hole?: string;
  kind?: "type" | "select";
}

export type FieldValueVerification =
  | { ok: true }
  | { ok: false; reason: "field_missing" | "field_value_mismatch"; field: string };

/** Money-path guard: exact live values must equal every value Squire injected. */
export function verifyFilledFieldValues(
  elements: readonly RecipeTargetElement[],
  expectedFields: readonly FilledFieldExpectation[],
): FieldValueVerification {
  for (const expected of expectedFields) {
    const resolved = resolveRecipeFieldTarget(elements, expected.target);
    const field =
      expected.hole ?? expected.target.accessible_name ?? expected.target.dom_hint?.name ?? "field";
    if (resolved === null) return { ok: false, reason: "field_missing", field };
    const actual =
      expected.kind === "select"
        ? (resolved.element.selectedOptionText ??
          resolved.element.value ??
          resolved.element.visibleText ??
          "")
        : (resolved.element.value ?? "");
    if (actual !== expected.expected) {
      return { ok: false, reason: "field_value_mismatch", field };
    }
  }
  return { ok: true };
}

// A URL that carries a ONE-TIME credential in its path/query — email
// verification links, magic links, password-reset links, signup-confirm
// tokens. These are single-use: freezing one into a recipe makes the replay
// open on a dead "invalid or expired token" page (the plunk-recipe bug, where
// `/auth/verify-email?token=<64-hex>` was captured as a goto AND became the
// entry). The detector pairs a verification-intent hint with a long opaque
// token, so stable app URLs (which carry no such token) are never matched.
const SINGLE_USE_HINT =
  /(verif|confirm|activate|activation|magic|passwordless|password[-_]?reset|reset[-_]?password|invitation|\binvite\b|one[-_]?time|\boob\b)/i;
const SINGLE_USE_TOKEN_PARAM =
  /[?&](?:token|code|key|oobcode|confirmation_token|reset_token|auth|secret|signature|sig|otp|t)=([A-Za-z0-9._-]{16,})/i;

// A long, token-shaped string: not a human word — long, token charset, and
// mixes letters+digits (so "verify-email" or "confirmation" don't qualify).
function looksOpaqueToken(s: string): boolean {
  return s.length >= 16 && /^[A-Za-z0-9._-]+$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s);
}

export function isSingleUseUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    // A captured href is often relative; the placeholder base lets the same
    // token transform cover both href hints and absolute goto URLs.
    u = new URL(rawUrl, "https://recipe.invalid");
  } catch {
    return false;
  }
  const hay = `${u.pathname}${u.search}`;
  if (!SINGLE_USE_HINT.test(hay)) return false;
  const tok = hay.match(SINGLE_USE_TOKEN_PARAM)?.[1];
  if (tok !== undefined && looksOpaqueToken(tok)) return true; // token in the query
  return u.pathname.split("/").some(looksOpaqueToken); // or in a path segment
}

export function recipeEntryUrl(recipe: OperatorRecipe, runtimeServiceUrl?: string): string | null {
  if (recipe.entry_mode === "runtime_service_url") {
    if (runtimeServiceUrl === undefined) return null;
    if (recipe.domain === undefined || operatorRecipeDomain(runtimeServiceUrl) !== recipe.domain) {
      throw new Error(`runtime service URL domain does not match operator-recipe "${recipe.name}"`);
    }
    return runtimeServiceUrl;
  }
  // Prefer the recipe's canonical entry (the session's start URL). Recipes
  // synthesized before entry_url existed fall back to the first STABLE trace
  // goto — skipping single-use verification/magic links, which must never be a
  // replay entry (opening one lands on an expired-token dead page).
  if (
    recipe.entry_url !== undefined &&
    recipe.entry_url.length > 0 &&
    !isSingleUseUrl(recipe.entry_url)
  ) {
    return recipe.entry_url;
  }
  const firstStableGoto = recipe.trace.find((t) => {
    const url = t.action.url_template;
    return t.action.kind === "goto" && url !== undefined && url.length > 0 && !isSingleUseUrl(url);
  });
  return firstStableGoto?.action.url_template ?? null;
}
