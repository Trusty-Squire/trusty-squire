// operator-recipe.ts — Phase A of "user-saved operator workflows as skills"
// (docs/ARCHITECTURE.md). A LOCAL artifact (deliberately NOT the
// registry Skill schema yet — that bump is Phase B) that captures a successful
// operate run so it can be replayed by name.
//
// Three invariants baked in here:
//   1. Text-based targeting only. A trace entry stores the VISIBLE text it
//      acted on, never a ref/coordinate — operator targets are heavy SPAs whose
//      refs churn every observation, so literal playback would rot. The recipe
//      is a RAIL the planner re-drives along, not a script.
//   2. Sealed secrets are stored as SLOT REFERENCES, never values. A recipe
//      built from a session that sealed a secret records `{slot, stored:false}`
//      and an `extract`/`type_secret` step; the raw value never touches disk.
//   3. A POSTCONDITION the replay verifies. Without it a "remembered" workflow
//      silently succeeds on a run that didn't actually work — the anti-false-
//      green principle (isCredentialNoise) one level up.

import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Schema ──────────────────────────────────────────────────────────

const TraceActionSchema = z
  .object({
    kind: z.enum([
      "goto", "click", "js_click", "type", "press", "oauth_click",
      "oauth_settle", "allow_host", "type_secret", "scroll", "extract",
    ]),
    // Visible text the action targeted (the rail). Never a ref/coordinate.
    text_match: z.string().max(200).optional(),
    // goto: a URL with optional ${VAR} templates for per-run identity.
    url_template: z.string().max(2000).optional(),
    // type: the NON-secret value typed (names, emails, URIs). Secrets never
    // appear here — they flow through `type_secret` + a slot.
    value: z.string().max(2000).optional(),
    host: z.string().max(253).optional(),
    slot: z.string().max(60).optional(),
    direction: z.enum(["down", "up", "bottom", "top"]).optional(),
    key: z.string().max(40).optional(),
  })
  .strict();
export type TraceAction = z.infer<typeof TraceActionSchema>;

const TraceEntrySchema = z
  .object({
    intent: z.string().max(200).optional(),
    action: TraceActionSchema,
  })
  .strict();
export type TraceEntry = z.infer<typeof TraceEntrySchema>;

// A machine-checkable success signal, verifiable from a single page snapshot.
const SuccessSignalSchema = z.union([
  // A field/input whose label≈field_text holds a value at least N chars long
  // (e.g. OAuth Playground's "Access token"). We check the LENGTH, never the
  // value — the success signal must not leak the credential it proves.
  z.object({ field_text: z.string().min(1).max(120), min_value_len: z.number().int().positive().max(4096) }).strict(),
  // Visible page text contains this phrase.
  z.object({ text_present: z.string().min(1).max(200) }).strict(),
  // The current URL contains this substring (post-login path, etc.).
  z.object({ url_contains: z.string().min(1).max(200) }).strict(),
]);
export type SuccessSignal = z.infer<typeof SuccessSignalSchema>;

export const PostconditionSchema = z
  .object({
    // execute_capability: re-run/observe the capability now (synchronous).
    // observe_artifact: navigate to probe_url, then check (Phase B paces this).
    kind: z.enum(["execute_capability", "observe_artifact"]),
    describe: z.string().min(1).max(300),
    success_signal: SuccessSignalSchema,
    probe_url: z.string().url().max(2000).optional(),
  })
  .strict();
export type Postcondition = z.infer<typeof PostconditionSchema>;

const SecretRefSchema = z
  .object({
    slot: z.string().min(1).max(60),
    sealed_from: z.string().max(120).optional(),
    // Iron invariant: a recipe NEVER stores a secret value. This literal makes
    // "the value is on disk" unrepresentable — a value-bearing field can't parse.
    stored: z.literal(false),
  })
  .strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const OperatorRecipeSchema = z
  .object({
    name: z.string().min(1).max(80),
    schema_version: z.literal(1),
    goal: z.string().min(1).max(300),
    allowed_hosts: z.array(z.string().max(253)).max(20).default([]),
    trace: z.array(TraceEntrySchema).max(200),
    secrets: z.array(SecretRefSchema).max(20).default([]),
    postcondition: PostconditionSchema,
  })
  .strict();
export type OperatorRecipe = z.infer<typeof OperatorRecipeSchema>;

// ── Local IO ────────────────────────────────────────────────────────

export function operatorRecipeDir(): string {
  const fromEnv = process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".trusty-squire", "operator-recipes");
}

function safeFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug.length > 0 ? slug : "recipe";
}

export async function writeRecipe(recipe: OperatorRecipe): Promise<string> {
  // Validate (and, crucially, re-assert the no-stored-value invariant) before
  // anything reaches disk.
  const parsed = OperatorRecipeSchema.parse(recipe);
  const dir = operatorRecipeDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(parsed.name)}.json`);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return file;
}

export async function readRecipe(name: string): Promise<OperatorRecipe> {
  const file = path.join(operatorRecipeDir(), `${safeFileName(name)}.json`);
  const raw = await fs.readFile(file, "utf8");
  return OperatorRecipeSchema.parse(JSON.parse(raw));
}

export async function listRecipes(): Promise<string[]> {
  try {
    const files = await fs.readdir(operatorRecipeDir());
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

// ── Rail render (the "MAP, not a script") ───────────────────────────

function describeAction(a: TraceAction): string {
  const t = a.text_match !== undefined ? `"${a.text_match}"` : "";
  switch (a.kind) {
    case "goto": return `go to ${a.url_template ?? ""}`;
    case "click": return `click ${t}`;
    case "js_click": return `click ${t} (JS-dispatch if a plain click doesn't register)`;
    case "type": return `type ${a.value !== undefined ? `"${a.value}" ` : ""}into ${t}`;
    case "press": return `press ${a.key ?? ""}`;
    case "oauth_click": return `click the OAuth button ${t}`;
    case "oauth_settle": return `complete the OAuth handshake`;
    case "allow_host": return `cross into ${a.host ?? ""}`;
    case "type_secret": return `type the sealed secret (slot ${a.slot ?? "?"}) into ${t}`;
    case "scroll": return `scroll ${a.direction ?? "down"}`;
    case "extract": return `reveal + seal the secret into slot ${a.slot ?? "?"}`;
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
      `- sealed steps: reveal + seal each secret YOURSELF (operate_extract ` +
        `{into_slot}) and type it from the slot (type_secret). The recipe never ` +
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
      evidence: { field: signal.field_text, value_len: field?.value_len ?? 0, required: signal.min_value_len },
    };
  }
  if ("text_present" in signal) {
    const ok = norm(snap.text).includes(norm(signal.text_present));
    return {
      confirmed: ok,
      reason: ok ? `page text contains "${signal.text_present}"` : `page text missing "${signal.text_present}"`,
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
    if (v === undefined) { missing.push(name); return `\${${name}}`; }
    return v;
  });
  return { url, missing };
}

export function recipeEntryUrl(recipe: OperatorRecipe): string | null {
  const firstGoto = recipe.trace.find((t) => t.action.kind === "goto");
  return firstGoto?.action.url_template ?? null;
}
