// skill.ts — Zod schema for Tier-2 Learned Skills.
//
// See docs/DESIGN-skill-promoter.md for the rationale. In short: a Skill
// is a structured replay graph promoted from one or more successful
// universal-bot runs. The registry stores Skills in the same `Adapter`
// table that hosts hand-authored Tier-3 manifests (Challenge 2 →
// option A: unified table with `tier` discriminator), but the data
// shape is its own thing — captured here.
//
// Three design choices baked into this schema:
//
//   1. **Zod, with .describe() on every field.** Adapter manifest types
//      today live as bare TypeScript interfaces; reading a stored skill
//      from the database and understanding what every field means
//      currently requires reading the source. The Skill schema is
//      mutable (lifecycle counters, demotion status), so its long
//      half-life matters. .describe() lets us auto-generate
//      docs/skill-schema.md (DX D4) and gives Zod parse errors
//      human-readable field hints.
//
//   2. **`credentials: SkillCredentialSpec[]` from day one.** Singular
//      `credential` would force a schema migration when multi-credential
//      services (Stripe-class) ship in 0.8.0 (C8 / E7). Array with one
//      element by default costs nothing and avoids the future break.
//
//   3. **Text-based step targeting only.** Every SkillStep selects DOM
//      elements via `text_match`, `label_hint`, `near_text_hint`, or
//      `role_hint` — never raw CSS selectors. The bet (Theme 1 of the
//      autoplan review): visible vocabulary is what humans navigate by
//      and what designers preserve across redesigns. Selectors break
//      on every Tailwind migration; "Create Token" survives.
//
// Exports both the Zod schemas (for parsing/validation at boundaries)
// and the inferred TypeScript types (for compile-time use everywhere
// else). Callers should `import type` the latter where possible.

import { z } from "zod";

// ── Step graph ──────────────────────────────────────────────────────
//
// Every step in a replay graph is one of seven kinds. The kinds are a
// closed discriminated union; adding a new kind is a major schema
// version bump (handled via `schema_version` below). The kinds map
// 1:1 to the universal bot's PostVerifyStep vocabulary — see
// apps/mcp/src/bot/agent.ts — but with text-based hints replacing
// raw selectors. The synthesizer (Phase 2 / promote-to-skill.ts) is
// the bridge: it reads the bot's selector-based PostVerifyStep
// captures and emits the text-based SkillStep below.

const ProvenanceSchema = z
  .object({
    run_id: z
      .string()
      .min(1)
      .describe(
        "The universal-bot run ID that contributed this step. " +
          "Source-map back to corpus/onboarding/<service>/<run_id>/.",
      ),
    round_index: z
      .number()
      .int()
      .min(0)
      .describe(
        "Which post-verify round in that run produced this step. " +
          "0 is the first post-OAuth navigation; later indices are " +
          "subsequent planner decisions.",
      ),
  })
  .describe(
    "Per-step provenance (D5). Lets a debugger trace any step in a " +
      "published skill back to the exact capture round that produced " +
      "it. Critical for forensics when a replay starts failing in " +
      "production.",
  );

export type SkillStepProvenance = z.infer<typeof ProvenanceSchema>;

const NavigateStepSchema = z
  .object({
    kind: z.literal("navigate"),
    url: z
      .string()
      .url()
      .describe(
        "Target URL. May be the signup landing page (step 0) or any " +
          "later same-origin navigation. The replay engine treats this " +
          "as a hard navigation — no SPA-style soft navigation handling.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const ClickOAuthButtonStepSchema = z
  .object({
    kind: z.literal("click_oauth_button"),
    provider: z
      .enum(["google", "github"])
      .describe(
        "Which OAuth provider's affordance to click. The replay engine " +
          "checks loggedInProviders() first; if the provider has no " +
          "session, the step falls through to a needs_login outcome " +
          "rather than continuing.",
      ),
    text_match: z
      .string()
      .min(1)
      .describe(
        "Visible text or aria-label substring to match (e.g. " +
          "'Continue with GitHub'). Case-insensitive. Provider-typed " +
          "buttons usually carry the provider name in either field; " +
          "the bot's findFirstOAuthButton ranker is the reference " +
          "implementation.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const ClickStepSchema = z
  .object({
    kind: z.literal("click"),
    text_match: z
      .string()
      .min(1)
      .describe(
        "Visible text or aria-label to match for the click target. " +
          "Two-match-disambiguation algorithm (C3): exact > startsWith > " +
          "substring; then nearest-ancestor-section-heading; then DOM " +
          "order. Falls back to LLM if multiple candidates survive.",
      ),
    role_hint: z
      .enum(["button", "link", "tab", "menuitem"])
      .optional()
      .describe(
        "Optional ARIA role to narrow the match. Resolves the " +
          "'Create Token' button vs. 'Create Token' help-text-link " +
          "ambiguity. Omitting it means accept any clickable element.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const FillStepSchema = z
  .object({
    kind: z.literal("fill"),
    label_hint: z
      .string()
      .min(1)
      .describe(
        "<label> text, placeholder, or aria-label that identifies the " +
          "input. Resolution order: matching <label for=>, then " +
          "placeholder, then aria-label, then visibleText of nearest " +
          "preceding text node.",
      ),
    value_template: z
      .string()
      .min(1)
      .describe(
        "What to type. Plain literal, or template like ${TOKEN_NAME} " +
          "resolved at replay time from runtime context. Reserved " +
          "templates: ${TOKEN_NAME}, ${USER_DISPLAY_NAME}, " +
          "${EMAIL_ALIAS}, ${PROJECT_NAME}.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const SelectStepSchema = z
  .object({
    kind: z.literal("select"),
    label_hint: z
      .string()
      .min(1)
      .describe("Same resolution rules as `fill`."),
    option_text: z
      .string()
      .min(1)
      .describe(
        "Visible text of the option to select. The replay engine drives " +
          "this via the same selectOption path the bot uses; that path " +
          "already handles native <select>, Radix, Headless UI, and " +
          "custom React comboboxes.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const ExtractViaCopyButtonStepSchema = z
  .object({
    kind: z.literal("extract_via_copy_button"),
    near_text_hint: z
      .string()
      .min(1)
      .describe(
        "Visible text near the Copy button that disambiguates it from " +
          "other Copy buttons on the page. For multi-credential pages " +
          "(Stripe-class, 0.8.0), this is what distinguishes 'Copy " +
          "publishable key' from 'Copy secret key'. The Copy-button " +
          "selector itself is resolved by walking outward from the " +
          "nearest element whose text matches this hint.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const ExtractViaRegexStepSchema = z
  .object({
    kind: z.literal("extract_via_regex"),
    pattern_name: z
      .enum([
        "stripe_secret",
        "stripe_publishable",
        "resend",
        "sendgrid",
        "mailgun",
        "render",
        "sentry_token",
        "openrouter",
        "anthropic",
        "openai_legacy",
        "openai_project",
        "uuid_token",
      ])
      .describe(
        "Named regex from the credential pattern library in " +
          "apps/mcp/src/bot/agent.ts. Named (not raw regex) so the " +
          "library is the single source of truth and skills can't " +
          "drift from it. New patterns require both a pattern-library " +
          "addition and a schema version bump.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

export const SkillStepSchema = z
  .discriminatedUnion("kind", [
    NavigateStepSchema,
    ClickOAuthButtonStepSchema,
    ClickStepSchema,
    FillStepSchema,
    SelectStepSchema,
    ExtractViaCopyButtonStepSchema,
    ExtractViaRegexStepSchema,
  ])
  .describe(
    "One step in a Skill's replay graph. Steps execute in order. A " +
      "failed step's pre-validation triggers per-step LLM fallback " +
      "(T11) rather than aborting the whole replay.",
  );

export type SkillStep = z.infer<typeof SkillStepSchema>;

// ── Credential spec ─────────────────────────────────────────────────

const CredentialShapeSchema = z
  .enum([
    "uuid",
    "prefix:re_",
    "prefix:sk_live",
    "prefix:sk_test",
    "prefix:sk-",
    "prefix:sk-or-v1-",
    "prefix:sk-ant-",
    "prefix:key-",
    "prefix:rnd_",
    "prefix:SG.",
    "prefix:sntry",
    "opaque",
    "username_password",
  ])
  .describe(
    "Coarse shape descriptor for the credential. NOT the primary " +
      "extraction mechanism — that's the step graph. This is a " +
      "sanity-check applied to the extracted value before vault " +
      "write. 'opaque' is the catch-all for services with no " +
      "recognizable shape; it leans entirely on the validator's " +
      "length range + (optionally) the sentinel HTTP test (C5).",
  );

export const SkillCredentialSpecSchema = z
  .object({
    type: z
      .enum([
        "api_key",
        "oauth_token",
        "username_password",
        "secret",
        "session_cookie",
        "totp_seed",
      ])
      .describe(
        "Matches packages/runtime CredentialType, minus sso_metadata " +
          "(not extractable from a signup flow). Drives how the vault " +
          "stores the value and what env_var suggestions surface to " +
          "the user.",
      ),
    shape_hint: CredentialShapeSchema,
    env_var_suggestion: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be UPPER_SNAKE_CASE")
      .describe(
        "What env var the user should export (e.g. RAILWAY_API_KEY). " +
          "Surfaces in the vault UI and in the post-signup CLI output.",
      ),
    post_extract_validator: z
      .object({
        min_length: z
          .number()
          .int()
          .min(1)
          .describe("Minimum acceptable credential length."),
        max_length: z
          .number()
          .int()
          .min(1)
          .describe(
            "Maximum acceptable length. Catches captcha tokens (always " +
              "long) being mistaken for credentials.",
          ),
        shape_regex: z
          .string()
          .optional()
          .describe(
            "Optional additional regex the value must match. Use when " +
              "shape_hint is too broad for the service.",
          ),
        sentinel_http_check: z
          .object({
            url: z
              .string()
              .url()
              .describe(
                "Service's /whoami-equivalent endpoint. Must return 200 " +
                  "when the extracted credential is presented as a " +
                  "Bearer token (or whatever auth scheme is in " +
                  "auth_scheme below).",
              ),
            auth_scheme: z
              .enum(["bearer", "basic", "header_x_api_key", "query_param"])
              .describe("How to present the credential in the request."),
            timeout_ms: z
              .number()
              .int()
              .min(500)
              .max(10_000)
              .default(3000)
              .describe(
                "Network timeout for the sentinel check. Bounded so a " +
                  "slow service doesn't gate publish indefinitely.",
              ),
          })
          .optional()
          .describe(
            "Optional sentinel: makes a live HTTP call to the service " +
              "to confirm the extracted value is the RIGHT credential, " +
              "not just a value of the right shape (C5). Strongly " +
              "recommended for `opaque` and `uuid` shape_hints, where " +
              "the regex can't disambiguate.",
          ),
      })
      .describe(
        "What 'a valid credential' means. Applied BEFORE vault write; " +
          "a failing validator aborts the replay with " +
          "credentials_extracted: false. Required precisely because " +
          "the step graph can succeed mechanically (clicks land, " +
          "navigation works) while extracting the wrong value " +
          "(Railway 0.6.13 class bug).",
      ),
  })
  .strict()
  .describe(
    "Specification for one credential the Skill is expected to " +
      "produce. Skills carry an array of these (forward-compat with " +
      "multi-credential services in 0.8.0, e.g. Stripe's publishable + " +
      "secret keys).",
  );

export type SkillCredentialSpec = z.infer<typeof SkillCredentialSpecSchema>;

// ── Lifecycle ───────────────────────────────────────────────────────

export const SkillStatusSchema = z
  .enum(["active", "demoted", "superseded", "pending-review"])
  .describe(
    "active   = router uses this skill; default state on publish.\n" +
      "demoted  = router skips; reached >=3 consecutive replay failures " +
      "or operator manually demoted.\n" +
      "superseded = a newer version is now active; this version is " +
      "kept around for diff/rollback during the 90-day grace " +
      "(per Decision 6, delete-on-successor-publish).\n" +
      "pending-review = changes to signup_url or oauth_provider " +
      "require operator approval (C11); router doesn't serve this " +
      "until skill:approve-review runs.",
  );

export type SkillStatus = z.infer<typeof SkillStatusSchema>;

// ── The Skill itself ────────────────────────────────────────────────

export const SKILL_SCHEMA_VERSION = 1 as const;

export const SkillSchema = z
  .object({
    schema_version: z
      .literal(SKILL_SCHEMA_VERSION)
      .describe(
        "Major schema version. Bumped when SkillStep kinds change or " +
          "credential spec gains/loses fields. Registry rejects skills " +
          "with an unknown major version (E2). Same-major minor " +
          "changes are forward-compatible (new optional fields OK).",
      ),

    // Identity
    service: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase-with-dashes")
      .describe(
        "Canonical service slug. Matches the slug agents use in " +
          "provision_any_service. Examples: railway, openrouter, " +
          "stripe. The registry enforces (service, version) " +
          "uniqueness.",
      ),
    version: z
      .string()
      .regex(/^v\d+$/, "must be vN (e.g. v1, v2)")
      .describe(
        "Skill version, monotonically increasing per service. Each " +
          "promote bumps to the next vN. NOT semver — skills don't " +
          "have public APIs, just success/failure outcomes.",
      ),
    skill_id: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID")
      .describe(
        "Unique per skill row, ULID-shaped. Used in /replay-outcome " +
          "callbacks and skill:show CLI. Distinct from (service, " +
          "version) because the same logical version may be republished " +
          "(via skill:edit) and we want a stable ID per row.",
      ),

    // Routing
    signup_url: z
      .string()
      .url()
      .describe(
        "Where to start. Verified by Stage 3 replay-test (the URL must " +
          "produce a recognizable page). If wrong, replay's step 0 " +
          "falls back to KNOWN_DOMAINS + guessSignupUrl + Google " +
          "search (C7). Edits to this field trigger pending-review " +
          "(C11).",
      ),
    oauth_provider: z
      .enum(["google", "github"])
      .nullable()
      .describe(
        "Forced OAuth provider, or null for email/password signup. " +
          "When set, the replay engine assumes loggedInProviders() " +
          "includes this; failure surfaces as needs_login. Edits to " +
          "this field trigger pending-review (C11).",
      ),

    // The replay graph
    steps: z
      .array(SkillStepSchema)
      .min(1, "skill must have at least one step")
      .describe(
        "Ordered list of replay steps. Walked top-to-bottom. A failed " +
          "step's pre-validation triggers per-step LLM fallback (T11); " +
          "only if fallback also fails does the whole replay abort.",
      ),

    // What we expect to produce
    credentials: z
      .array(SkillCredentialSpecSchema)
      .min(1, "skill must produce at least one credential")
      .describe(
        "What this skill extracts. One element for most services; " +
          "multiple for Stripe-class multi-credential services in " +
          "0.8.0. The replay engine fills these in order from the " +
          "extract_* steps.",
      ),

    // Lineage
    source_run_ids: z
      .array(z.string().min(1))
      .min(1, "must reference at least one source run")
      .describe(
        "Universal-bot run IDs whose captures contributed to this " +
          "skill. Source-map for forensic debugging. When captures are " +
          "uploaded as sidecars (D1), these IDs resolve to the actual " +
          "JSONL files in the registry.",
      ),

    // Health counters (mutable post-publish)
    status: SkillStatusSchema,
    replays_succeeded: z
      .number()
      .int()
      .min(0)
      .describe("Lifetime count of successful end-to-end replays."),
    replays_failed: z
      .number()
      .int()
      .min(0)
      .describe("Lifetime count of failed replays."),
    consecutive_failures: z
      .number()
      .int()
      .min(0)
      .describe(
        "Resets on each successful replay. >=3 triggers auto-demotion " +
          "via /replay-outcome. Atomic-increment in the store layer " +
          "(E3) — concurrent failures don't lose updates.",
      ),

    // Timestamps
    created_at: z
      .string()
      .datetime()
      .describe("ISO-8601 UTC timestamp of first publish."),
    last_replayed_at: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "Most recent replay attempt, success or fail. null until the " +
          "first call hits this skill.",
      ),
    superseded_at: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "When a newer version became active. Drives the 90-day grace " +
          "window (per Decision 6 GC policy).",
      ),
    deleted_at: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "Soft-delete timestamp set by the nightly GC cron once a " +
          "superseded skill is past its grace window. Hard-delete cron " +
          "removes the row 7 days later (grace-after-grace).",
      ),
  })
  .strict()
  .describe(
    "A Tier-2 Learned Skill — the unit of institutional memory in the " +
      "skill promoter system. Promoted from one or more universal-bot " +
      "runs, replayed by the router on subsequent signups, demoted " +
      "automatically when the underlying page changes enough to break " +
      "the replay graph.",
  );

export type Skill = z.infer<typeof SkillSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse + validate a Skill from arbitrary input. Throws ZodError on
 * failure; the registry routes use `.safeParse()` for graceful 400s
 * with structured field-error output.
 */
export function parseSkill(input: unknown): Skill {
  return SkillSchema.parse(input);
}

/**
 * Quick check whether a value is a recognised skill schema version
 * without parsing the whole thing. Used at the registry boundary to
 * return a useful "unknown schema version" error before deeper Zod
 * parsing produces a 200-line stack trace (E2).
 */
export function isKnownSkillSchemaVersion(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = (value as { schema_version?: unknown }).schema_version;
  return v === SKILL_SCHEMA_VERSION;
}
