// skill.ts — Zod schema for Tier-2 Learned Skills.
//
// See docs/ARCHITECTURE.md for the rationale. In short: a Skill
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
    // 0.8.3-rc.1 — same disambiguator as fill/select. Baseten-class
    // case: the modal's "Create API key" submit button shares text
    // with the listing's "Create API key" trigger (still in the DOM
    // behind the modal). Synthesizer emits this when the original
    // capture saw the same collision and a unique nearby visible
    // text identifies the modal context.
    near_text_hint: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional disambiguator when multiple elements share the same " +
          "text_match on the page (e.g. modal submit button shares text " +
          "with the listing's open-form trigger still rendered behind " +
          "the modal). The replay engine narrows text_match matches by " +
          "'has unique nearby visible text containing near_text_hint' " +
          "before failing.",
      ),
    // 2026-06-07 — href fallback for nav-link clicks. A dashboard's
    // sidebar link (axiom's "Settings", → /<org>/settings) carries a
    // STABLE href even when its accessible name renders as an icon on
    // replay, or the org slug in the URL differs between the capturing
    // account and the replaying one. text_match="Settings" then resolves
    // to zero elements and the replay dies. When the captured click
    // target is a link with an href, the synthesizer records its path
    // here; the replay engine matches a link by href-path tail
    // (slug-tolerant) after text fails, and as a last resort navigates
    // to it (rebased onto the current origin + org slug). Optional +
    // additive — only emitted for <a>/role=link targets, so non-link
    // clicks' canonical bytes don't shift.
    href_hint: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional href path of a nav-link click target (e.g. " +
          "'/acme/settings'). The replay engine matches a link by its " +
          "href-path tail (ignoring a leading workspace/org slug) when " +
          "text_match resolves to nothing, and falls back to navigating " +
          "to it directly. Only present for link targets.",
      ),
    // 2026-06-09 — stable-attribute anchor. visible text drifts ("Create" →
    // "Create token") and goes ambiguous on a fresh user's page ("Next"
    // matching two wizard buttons), which is what made the verifier-sweep
    // skills fail under a fresh identity. A `name=`/`id=` attribute is the
    // redesign-surviving anchor the schema's text hints were reaching for —
    // unlike a brittle nth-child CSS path (which Theme 1 bans), a SEMANTIC
    // name/id is stable. The replay engine prefers a UNIQUE dom_hint match
    // over text_match. Optional + additive: only emitted when the captured
    // element carried a stable (non-framework-generated) name or id, so
    // clicks without one keep their canonical bytes.
    dom_hint: z
      .object({
        name: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
        testid: z.string().min(1).optional(),
      })
      .strict()
      .optional()
      .describe(
        "Optional stable attribute anchor — the target's data-testid / name= / " +
          "id= attribute, captured only when it looks human-authored (not a " +
          "React/emotion-generated hash). testid is the strongest anchor " +
          "(authored to survive refactors + copy changes). Preferred over " +
          "text_match when it uniquely matches.",
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
    // Schema v2 (2026-05-28). Sentry-class permission grids and any
    // multi-row form where every row's input shares the same label
    // (e.g. each row's "Permission" select labeled "Permission") were
    // hard-rejecting at synthesize time as `ambiguous_text_match`.
    // near_text_hint pins the specific row via nearby unique visible
    // text (e.g. "Project", "Team", "Member"). Optional + additive —
    // the synthesizer only emits it when a sibling collision is
    // detected, so single-cred skills' canonical bytes don't shift.
    near_text_hint: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional disambiguator when multiple inputs share the same " +
          "label_hint on the page (Sentry's permission grid, settings " +
          "rows with repeated 'Permission' selects). The replay engine " +
          "filters label-hint matches by 'has unique nearby visible " +
          "text containing near_text_hint' before failing. Pick a " +
          "row-identifying word visible adjacent to the target input.",
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
    // Same rationale as FillStepSchema.near_text_hint — see above.
    // Sentry's per-row scope dropdowns are the canonical case: seven
    // rows, every row's select labeled "Permission", every row needs
    // its own option picked.
    near_text_hint: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional disambiguator when multiple selects share the same " +
          "label_hint (Sentry's permission grid: Project / Team / " +
          "Member / Issue / Event / Release / Organization rows all " +
          "ship a select labeled 'Permission'). The replay engine " +
          "filters label-hint matches by 'has unique nearby visible " +
          "text containing near_text_hint' before failing.",
      ),
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

// Multi-credential step kinds (Phase B per docs/ARCHITECTURE.md).
// These are NEW kinds, not new fields on the existing extract steps — the
// side-by-side dispatch principle keeps single-credential skills byte-
// identical (canonical bytes unchanged → signatures still verify).
//
// `produces` names the credential this step yields and MUST reference an
// entry in the parent Skill's `credentials[].name`. The schema can't
// cross-validate that link statically (Zod can't look up a sibling array
// from a step), so the synthesizer + replay engine enforce it at higher
// layers (synthesizer at build time, replay engine on dispatch).
const ExtractViaCopyButtonNamedStepSchema = z
  .object({
    kind: z.literal("extract_via_copy_button_named"),
    near_text_hint: z
      .string()
      .min(1)
      .describe(
        "Same semantics as extract_via_copy_button: visible text near " +
          "the Copy button that disambiguates it on a multi-credential " +
          "page. For Twitter, distinguishes 'Copy API Key' from 'Copy " +
          "API Key Secret'.",
      ),
    produces: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase_snake_case")
      .describe(
        "References an entry in the parent Skill's credentials[].name. " +
          "Lowercase snake_case (e.g. 'api_key_secret', 'bearer_token').",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

const ExtractViaRegexNamedStepSchema = z
  .object({
    kind: z.literal("extract_via_regex_named"),
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
        "Same pattern library as extract_via_regex. The synthesizer " +
          "writes this kind when one credential on a multi-cred page " +
          "matches a known prefix pattern (e.g. Stripe publishable + " +
          "secret keys: both regex-recognizable, both on one page).",
      ),
    produces: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase_snake_case")
      .describe(
        "References an entry in the parent Skill's credentials[].name.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

// Label-scoped multi-credential extract (2026-06-07). The canonical
// multi-cred primitive for dashboards that show N credentials in a table
// (Cloudinary cloud_name/api_key/api_secret, Algolia application_id/
// search_api_key/admin_api_key). The named copy_button/regex kinds can't
// disambiguate two same-shaped keys (Algolia's search + admin keys are
// both 32-char hex), so this step finds the value by its on-page LABEL:
// the replay engine matches `label_hint` against the labeled-credential
// candidates the bot harvests (value + adjacent label), revealing a
// masked value if a Reveal button sits in the row.
const ExtractLabeledStepSchema = z
  .object({
    kind: z.literal("extract_labeled"),
    label_hint: z
      .string()
      .min(1)
      .describe(
        "The on-page label adjacent to this credential's value (e.g. " +
          "'Application ID', 'Admin API Key', 'API Secret'). Replay " +
          "resolves the value by matching this against labeled-credential " +
          "candidates harvested from the dashboard, not by regex shape — " +
          "so two same-shaped keys on one page stay distinct.",
      ),
    produces: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase_snake_case")
      .describe(
        "References an entry in the parent Skill's credentials[].name.",
      ),
    provenance: ProvenanceSchema,
  })
  .strict();

// Email-verification (OTP) gate. Many signups email a 4-8 digit code that
// must be entered before the account is created (zilliz, deepseek, axiom).
// The code is DYNAMIC — a recorded value is useless on replay — and the OTP
// input frequently has no stable label/name (single-digit boxes, headless
// inputs), so a `fill` step can't represent it. This step tells replay:
// read the verification email from the user's own inbox, extract the
// code, and type it into the page's code input (found heuristically, or via
// the optional label_hint when the field is labeled). The subsequent
// Verify/Continue click is a separate `click` step.
const AwaitEmailCodeStepSchema = z
  .object({
    kind: z.literal("await_email_code"),
    label_hint: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional label/placeholder/aria-label of the code input. Usually " +
          "ABSENT — OTP boxes are commonly unlabeled single-digit inputs — " +
          "so the replay engine falls back to a heuristic (a visible, short " +
          "code-shaped input near verification copy). Present only when the " +
          "captured field carried a stable label.",
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
    AwaitEmailCodeStepSchema,
    ExtractViaCopyButtonStepSchema,
    ExtractViaRegexStepSchema,
    // Multi-credential extract steps. Single-credential skills never
    // contain these; they're additive at the union level.
    ExtractViaCopyButtonNamedStepSchema,
    ExtractViaRegexNamedStepSchema,
    ExtractLabeledStepSchema,
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
    // Multi-credential identifier (Phase B per docs/ARCHITECTURE.md).
    // Optional for backward-compat: existing single-credential skills
    // omit it (their canonical bytes don't change → signatures remain
    // valid). Multi-credential skills MUST set it; the synthesizer
    // rejects when two credentials share a name.
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase_snake_case")
      .optional()
      .describe(
        "Stable identifier for this credential within the skill. " +
          "References by extract_via_*_named steps' `produces` field. " +
          "Lowercase snake_case (e.g. 'api_key', 'api_key_secret'). " +
          "Single-credential skills omit this — defaults to the " +
          "implicit name 'api_key' for backward compatibility.",
      ),
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
    // Replay-strategy hint (post-Phase-E iteration). Services like
    // Cloudinary, Twilio, Stripe show the api_secret ONLY ONCE — at
    // the moment the key is created. Subsequent visits to the
    // dashboard show the value masked permanently. The router uses
    // this flag to decide between two replay strategies:
    //
    //   - "always_visible" (default, backwards-compatible) → the
    //     standard replay path. Sign in to the existing account,
    //     navigate to the dashboard, re-extract the values via the
    //     captured steps. Works for ~80% of dev SaaS.
    //
    //   - "show_once_at_creation" → bypass replay entirely; treat
    //     every provision as a fresh signup (new account →
    //     capture the secret while it's visible).
    //     Avoids accumulating-N-failed-rotation-attempts and email-
    //     OTP gates that gate rotation.
    //
    // The synthesizer auto-marks this from the planner's prose ("the
    // secret will not be shown again", "shown only once at creation",
    // "you cannot retrieve this later"). Operators can override the
    // synthesizer's call via `mcp skill edit`.
    visibility: z
      .enum(["always_visible", "show_once_at_creation"])
      .optional()
      .describe(
        "When the credential is readable from the dashboard. " +
          "Optional for backward-compat: absence is equivalent to " +
          "always_visible. Multi-cred-aware code (the replay router, " +
          "the synthesizer) treats undefined === always_visible. " +
          "show_once_at_creation → router skips replay and routes " +
          "to fresh-signup-each-time (Cloudinary api_secret class). " +
          "Synthesizer only emits this field when it detects the " +
          "show-once phrasing — keeps canonical bytes unchanged for " +
          "legacy skills.",
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
  .enum(["active", "demoted", "quarantined", "superseded", "pending-review"])
  .describe(
    "active   = router uses this skill; default state on publish.\n" +
      "demoted  = router skips; reached >=3 consecutive replay failures " +
      "that classified as genuine skill ROT (step/validator/extraction), " +
      "or operator manually demoted. Eligible for auto-rediscovery.\n" +
      "quarantined = router skips; the verifier hit a terminal WALL " +
      "(captcha/anti-bot) or gave up after bounded rediscovery. Needs a " +
      "human (manual signup / harder anti-bot work) — NOT auto-rediscovered. " +
      "Non-destructive: the skill body + capture sidecar are kept.\n" +
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
          "provision. Examples: railway, openrouter, " +
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

    // Which provision STATE this recipe was discovered/replays in. Additive +
    // optional (omitted on pre-existing skills → canonical bytes unchanged).
    // Lets the host-driven loop pick the right recipe for a detected entry
    // state and lets verify assert it replays in that state. Transient runtime
    // conditions (email_pending / rate_limited) are NOT recipe entry points,
    // so only the two real entry states are allowed here.
    entry_state: z
      .enum(["virgin", "authenticated"])
      .optional()
      .describe(
        "Provision entry state this recipe covers. Defaults to 'virgin' " +
          "when omitted (the dominant case: a fresh signup). 'authenticated' " +
          "marks a recipe captured against an existing operator session.",
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

    // Multi-credential bundle validator (Phase B per docs/ARCHITECTURE.md).
    // Optional. Single-credential skills omit it. When set, the replay
    // engine signs ONE HTTP request with the named credentials and
    // calls the configured URL — catches "right shape, wrong values"
    // bugs that per-credential validators miss (the Twitter case:
    // five tokens that are only useful as a set, none independently
    // validatable). The first auth_scheme is documented; more land per
    // service (oauth1_signed → Twitter; sigv4 → AWS; oauth2_bearer →
    // most modern APIs).
    bundle_sentinel: z
      .object({
        url: z
          .string()
          .url()
          .describe(
            "Service endpoint that returns 200 when the bundle is " +
              "valid (e.g. https://api.twitter.com/2/users/me).",
          ),
        auth_scheme: z
          .enum(["oauth1_signed", "oauth2_bearer", "bearer_plus_secret"])
          .describe(
            "How to present the credential bundle. oauth1_signed: HMAC-" +
              "SHA1 signature over (consumer_key, consumer_secret, " +
              "access_token, access_token_secret) — Twitter. " +
              "oauth2_bearer: Authorization: Bearer <bearer_token>. " +
              "bearer_plus_secret: Bearer + a secondary header (Stripe-" +
              "class publishable+secret).",
          ),
        required_credentials: z
          .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
          .min(1)
          .describe(
            "Names (credentials[].name values) that the bundle " +
              "request must include. All listed names must be " +
              "extracted before the sentinel fires.",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(500)
          .max(10_000)
          .default(3000)
          .describe(
            "Network timeout — bounded so a slow service can't gate " +
              "replay indefinitely.",
          ),
      })
      .optional()
      .describe(
        "Per-Skill bundle validator. Replaces per-credential sentinel " +
          "HTTP checks for multi-credential services where credentials " +
          "are only useful together. Per-credential post_extract_" +
          "validator shape/regex checks still run.",
      ),

    // Token cleanup (closed-loop strategy, Phase 4).
    // Optional. When the verifier worker (and any future operator-run
    // freshness sweep) successfully extracts a credential, it can call
    // back into the service to delete that token so accounts don't
    // accumulate verifier-tokens indefinitely. Cleanup is best-effort:
    // a cleanup failure is logged but doesn't invalidate the verifier
    // success — the skill itself worked, the housekeeping didn't.
    //
    // Two strategies for now:
    //   - api_delete: DELETE / POST to a URL with the extracted token
    //     as Bearer auth (works for services like OpenRouter, Pinecone,
    //     Anthropic where the token authenticates its own deletion).
    //   - dashboard_steps: additional SkillStep[] walked after extract
    //     to drive the dashboard's "delete token" button. The bot
    //     reuses the existing replay engine — same selectors, same
    //     pre-validation — so the LLM fallback works here too.
    //
    // Skills with no cleanup hook leave their tokens behind. The
    // accumulated verifier-tokens are the operator's problem to
    // garbage-collect; this is acceptable while accounts are tied to
    // operator infra and not to end users.
    token_cleanup: z
      .union([
        z.object({
          strategy: z.literal("none"),
        }),
        z.object({
          strategy: z.literal("api_delete"),
          // URL template — supports ${TOKEN_ID} and ${ACCOUNT} keys.
          // The verifier looks up the just-extracted token's id (the
          // service's own id, NOT the token value) and substitutes.
          url_template: z
            .string()
            .url()
            .describe(
              "HTTP URL to call to delete the token. Supports " +
                "${TOKEN_ID} / ${ACCOUNT} substitution. The token value " +
                "itself is sent as Authorization: Bearer.",
            ),
          method: z
            .enum(["DELETE", "POST", "PUT"])
            .default("DELETE")
            .describe("HTTP method. Most services use DELETE; some use POST /tokens/revoke."),
          auth_scheme: z
            .enum(["bearer_self", "api_key_header"])
            .default("bearer_self")
            .describe(
              "How to authenticate the cleanup request. bearer_self: " +
                "Authorization: Bearer <the extracted token>. " +
                "api_key_header: X-API-Key: <the extracted token>.",
            ),
          // Some services (Anthropic, OpenAI) return the token id in
          // the create response so future deletes can target it. The
          // synthesizer captures this when present.
          token_id_extractor: z
            .object({
              from: z
                .enum(["response_json", "page_text"])
                .describe(
                  "Where to find the token's id. response_json: " +
                    "available when extract step captured a creation " +
                    "response. page_text: scrape the masked id off the " +
                    "dashboard after creation.",
                ),
              regex: z.string().describe("Pattern to extract the id."),
            })
            .optional(),
        }),
        z.object({
          strategy: z.literal("dashboard_steps"),
          // Reuses SkillStepSchema — the verifier walks these the same
          // way replay walks the main steps array.
          steps: z
            .array(SkillStepSchema)
            .min(1)
            .describe(
              "Steps the verifier walks after a successful extract to " +
                "delete the token via the dashboard. Pre-validation + " +
                "LLM fallback rules apply.",
            ),
        }),
      ])
      .optional()
      .describe(
        "How the verifier worker cleans up after extracting a " +
          "credential. Optional; defaults to no cleanup. Skills " +
          "without this leave verifier-tokens behind.",
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
