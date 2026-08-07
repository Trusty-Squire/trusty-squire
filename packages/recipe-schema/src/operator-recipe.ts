// operator-recipe.ts — the wire contract for an Operator Recipe: a
// (verb, eTLD+1)-keyed replay plan captured from a successful `operate_*`
// run. Shared by the mcp client (records + publishes) and the registry
// server (validates + stores), the same relationship
// @trusty-squire/skill-schema has to the Tier-2 Learned Skill flow.
//
// A recipe is a MAP, not a recording: every user-specific input must be a
// HOLE bound fresh at replay time from the replaying user's own data, never
// a baked-in literal. See isRecipeShareEligible below for the conservative
// gate that decides whether a given recipe is safe to publish to the shared
// registry at all — full detail in docs/ARCHITECTURE.md.
//
// Three invariants baked into the schema itself:
//   1. Stable-attribute targeting only. A trace stores authored DOM/semantic
//      hints, never a ref/coordinate; visible text is the unique-only last
//      fallback because operator targets are heavy SPAs whose refs churn.
//   2. Sealed secrets are stored as SLOT REFERENCES, never values. A recipe
//      built from a session that sealed a secret records `{slot, stored:false}`
//      and an `extract`/`type_secret` step; the raw value never touches disk.
//   3. A POSTCONDITION the replay verifies. Without it a "remembered" workflow
//      silently succeeds on a run that didn't actually work.

import { z } from "zod";
import { getDomain } from "tldts";

// ── Schema ──────────────────────────────────────────────────────────

export const OperatorVerbSchema = z.enum([
  "purchase",
  "get_api_key",
  "signup",
  "subscribe",
  "cancel",
  "login",
  "book",
  "reserve",
  "renew",
  "upgrade",
  "downgrade",
  "add_to_cart",
  "checkout",
  "download",
  "configure",
]);
export type OperatorVerb = z.infer<typeof OperatorVerbSchema>;

export const RecipeHoleSchema = z
  .object({
    hole: z
      .string()
      .regex(
        /^(?:address|contact|credential|card)(?:\.[a-zA-Z0-9_-]+)?$|^(?:product_query|quantity)$/,
      ),
  })
  .strict();
export type RecipeHole = z.infer<typeof RecipeHoleSchema>;

export const RecipeValueSchema = z.union([z.string().max(2000), RecipeHoleSchema]);
export type RecipeValue = z.infer<typeof RecipeValueSchema>;

export const RecipeTargetSchema = z
  .object({
    dom_hint: z
      .object({
        testid: z.string().max(200).optional(),
        id: z.string().max(200).optional(),
        name: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    role_hint: z.string().max(80).optional(),
    accessible_name: z.string().max(200).optional(),
    near_text_hint: z.string().max(200).optional(),
    href_hint: z.string().max(2000).optional(),
    css: z.string().max(2000).optional(),
    // Deliberately last-resort. Replay accepts this only when it is unique.
    visible_text: z.string().max(200).optional(),
    // Locale-stable field-role signal recorded at capture time and re-checked
    // at money-path fill. Prefer autocomplete tokens (given-name, family-name,
    // …) over visible labels so EN→JP cross-locale reuse still works. Format
    // is produced by localeStableFieldRole(); absence ⇒ no confident fill.
    field_role: z.string().max(100).optional(),
  })
  .strict();
export type RecipeTarget = z.infer<typeof RecipeTargetSchema>;

const EmailHoleSchema = RecipeHoleSchema.shape.hole;
export const EmailAliasTemplatePattern = /\$\{EMAIL_ALIAS((?:_(?:URI|CSS))*)\}/g;

function hasEmailAliasTemplate(value: string | undefined): boolean {
  return value?.includes("${EMAIL_ALIAS") === true;
}

const PostconditionUrlSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      new URL(value.replace(EmailAliasTemplatePattern, "buyer@example.com"));
      return true;
    } catch {
      return false;
    }
  }, "invalid URL");

const TraceActionSchema = z
  .object({
    kind: z.enum([
      "goto",
      "click",
      "js_click",
      "type",
      "press",
      "oauth_click",
      "oauth_settle",
      "allow_host",
      "type_secret",
      "select",
      "set_phone_country",
      "operate_pay",
      "scroll",
      "extract",
    ]),
    // Legacy visible-text rail. New recordings also carry `target`; this stays
    // for backwards compatibility and is the unique-only final fallback.
    text_match: z.string().max(200).optional(),
    target: RecipeTargetSchema.optional(),
    email_hole: EmailHoleSchema.optional(),
    // goto: a URL with optional ${VAR} templates for per-run identity.
    url_template: z.string().max(2000).optional(),
    // Value-bearing actions store either a non-secret literal or provenance
    // hole. Secret/card actions carry only a hole; their raw values never land
    // in the recipe.
    value: RecipeValueSchema.optional(),
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
  z
    .object({
      field_text: z.string().min(1).max(120),
      min_value_len: z.number().int().positive().max(4096),
    })
    .strict(),
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
    probe_url: PostconditionUrlSchema.optional(),
    email_hole: EmailHoleSchema.optional(),
  })
  .strict()
  .superRefine((postcondition, ctx) => {
    const urlContains =
      "url_contains" in postcondition.success_signal
        ? postcondition.success_signal.url_contains
        : undefined;
    if (
      (hasEmailAliasTemplate(postcondition.probe_url) || hasEmailAliasTemplate(urlContains)) &&
      postcondition.email_hole === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email_hole"],
        message: "known-email postcondition template lacks an attested source hole",
      });
    }
  });
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
    // Prepared-statement key. Optional only so existing local v1 recipes
    // remain readable; new keyed recordings always set both fields.
    verb: OperatorVerbSchema.optional(),
    domain: z.string().min(1).max(253).optional(),
    // The canonical replay entry — the session's START url (the service_url
    // passed to operate_start). Optional for back-compat with recipes saved
    // before this field; recipeEntryUrl falls back to the first STABLE trace
    // goto.
    entry_url: z.string().max(2000).optional(),
    entry_mode: z.literal("runtime_service_url").optional(),
    allowed_hosts: z.array(z.string().max(253)).max(20).default([]),
    trace: z.array(TraceEntrySchema).max(200),
    secrets: z.array(SecretRefSchema).max(20).default([]),
    postcondition: PostconditionSchema,
  })
  .strict()
  .superRefine((recipe, ctx) => {
    if ((recipe.verb === undefined) !== (recipe.domain === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "operator recipe verb and domain must be present together",
      });
    }
    if (recipe.entry_mode === "runtime_service_url" && recipe.entry_url !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entry_url"],
        message: "runtime-resolved operator recipes cannot persist an entry URL",
      });
    }
    recipe.trace.forEach((entry, index) => {
      const value = entry.action.value;
      if (
        entry.action.kind === "operate_pay" &&
        (value === undefined || typeof value === "string" || !/^card(?:\.|$)/.test(value.hole))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trace", index, "action", "value"],
          message: "operate_pay requires card provenance",
        });
      }
      if (value === undefined || typeof value === "string") return;
      if (/^card(?:\.|$)/.test(value.hole) && entry.action.kind !== "operate_pay") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trace", index, "action", "value"],
          message: "card provenance is only valid on operate_pay",
        });
      }
      if (/^credential(?:\.|$)/.test(value.hole) && entry.action.kind !== "type_secret") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trace", index, "action", "value"],
          message: "credential provenance is only valid on type_secret",
        });
      }
    });
  });
export type OperatorRecipe = z.infer<typeof OperatorRecipeSchema>;

export function parseOperatorRecipe(value: unknown): OperatorRecipe {
  return OperatorRecipeSchema.parse(value);
}

// ── Domain + key derivation (shared so client and registry key the same way) ──

const TENANT_HOST_SUFFIXES = ["myshopify.com", "notion.site"] as const;

/** Public-Suffix-List-backed recipe domain; registry service slugs are unrelated. */
export function operatorRecipeDomain(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  const tenantSuffix = TENANT_HOST_SUFFIXES.find(
    (suffix) => hostname !== suffix && hostname.endsWith(`.${suffix}`),
  );
  if (tenantSuffix !== undefined) return hostname;
  return getDomain(hostname, { allowPrivateDomains: false }) ?? hostname;
}

export function operatorRecipeKey(verb: OperatorVerb, url: string): string {
  return `${verb}--${operatorRecipeDomain(url)}`;
}

/** Key straight from an already-resolved (verb, domain) pair — the shape the registry stores by. */
export function operatorRecipeKeyForDomain(verb: OperatorVerb, domain: string): string {
  return `${verb}--${domain.toLowerCase()}`;
}

// ── Cross-user share eligibility ───────────────────────────────────────
//
// A shared recipe is a PLAN, never a recording of one user's data. Every
// user-specific input (contact, address, chosen password, phone, …) must be
// a hole bound fresh at replay time — never a baked-in literal — and a
// credential the flow EARNS (an extracted API key) must never appear at
// all. The schema already makes some of this unrepresentable by
// construction (SecretRefSchema.stored is a `false` literal; operate_pay's
// value is required to carry card provenance). What the schema can't catch
// is a literal string that HAPPENS to hold identity data because the
// record-time provenance tagging (tagProvenanceValue in the mcp package)
// only tags values that exactly match a caller-supplied known input — a
// value typed from something else entirely (an untracked fill) stays a
// plain literal with no signal attached.
//
// This is deliberately a heuristic, PATTERN-based classifier, and
// deliberately biased toward false positives over false negatives: when in
// doubt, the recipe stays local rather than reaching the shared registry.
// A recipe that fails this check is not broken — operate_use still replays
// it from the LOCAL store exactly as before; it simply never gets
// published for other users to reuse.
export interface RecipeShareEligibility {
  eligible: boolean;
  reasons: string[];
}

const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// API-key/token shaped substrings: stripe/openai-style `sk-…`, GitHub
// `ghp_…`/`gho_…`, AWS `AKIA…`, or a JWT's `eyJ…` header segment. Defense in
// depth — the schema already forbids extract/type_secret/operate_pay from
// ever carrying a literal secret value; this catches a bug elsewhere (a
// literal baked into a goto url or a target hint) before it reaches the
// shared registry.
const SECRET_SHAPE =
  /\b(?:sk-[a-zA-Z0-9]{10,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{12,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/;
const PHONE_SHAPE = /^\+?[\d\s().-]{7,20}$/;
const PHONE_DIGIT_FLOOR = /\d{4,}/;
const NAME_SHAPE = /^[A-Z][a-zA-Z'-]{1,20}(?:\s+[A-Z][a-zA-Z'-]{1,20}){1,3}$/;
const STREET_ADDRESS_SHAPE = /^\d+\s+\S+/;
const LONG_FREEFORM_MIN_LEN = 40;

// Kinds whose `value` is data the user (or a page-provided default) typed —
// as opposed to `click`/`goto`/etc., whose text/urls are page-authored, not
// user-authored, and therefore not scanned by the name/address/phone checks.
const USER_VALUE_KINDS = new Set(["type", "select", "set_phone_country", "type_secret"]);

export function isRecipeShareEligible(recipe: OperatorRecipe): RecipeShareEligibility {
  const reasons: string[] = [];

  if (recipe.verb === undefined || recipe.domain === undefined) {
    reasons.push("recipe has no (verb, domain) key — cannot be shared by key");
  }

  // Blanket scan over the full serialized recipe: no secret- or
  // email-shaped substring anywhere, in any field (values, target hints,
  // urls, postcondition text). A legitimate site-constant is never
  // email-shaped or secret-shaped, so this has no false-positive cost.
  const serialized = JSON.stringify(recipe);
  if (SECRET_SHAPE.test(serialized)) {
    reasons.push("recipe contains a secret-shaped literal (API-key/token pattern)");
  }
  if (EMAIL_SHAPE.test(serialized)) {
    reasons.push("recipe contains a literal email address");
  }

  // Targeted scan: literal (non-hole) values on the actions that carry
  // user-typed data. A hole is provably safe — it's bound fresh from the
  // replaying user's own inputs at fill time. A literal is safe only when
  // it's a true site-constant; anything shaped like a name, address, or
  // phone number is presumed to be user data that record-time tagging
  // missed, and long freeform text is presumed to be identity/comment data
  // rather than a fixed UI label.
  recipe.trace.forEach((entry, index) => {
    const { action } = entry;
    if (!USER_VALUE_KINDS.has(action.kind)) return;
    const value = action.value;
    if (value === undefined || typeof value !== "string") return; // already a hole, or absent
    if (action.kind === "type_secret") {
      reasons.push(
        `trace[${index}] type_secret carries a literal value — secrets must be slot refs`,
      );
      return;
    }
    if (value.includes("${")) return; // provenance/alias template, already accounted for
    if (PHONE_SHAPE.test(value) && PHONE_DIGIT_FLOOR.test(value)) {
      reasons.push(`trace[${index}] literal value looks like a phone number`);
    } else if (NAME_SHAPE.test(value)) {
      reasons.push(`trace[${index}] literal value looks like a person's name`);
    } else if (STREET_ADDRESS_SHAPE.test(value)) {
      reasons.push(`trace[${index}] literal value looks like a street address`);
    } else if (value.length > LONG_FREEFORM_MIN_LEN) {
      reasons.push(`trace[${index}] literal value is long freeform text (${value.length} chars)`);
    }
  });

  return { eligible: reasons.length === 0, reasons };
}
