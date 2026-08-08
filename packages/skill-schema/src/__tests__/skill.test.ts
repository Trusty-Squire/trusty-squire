// Covers the Skill Zod schema — what passes, what rejects, and the
// forward-compatibility properties the design relies on.

import { describe, expect, it } from "vitest";
import {
  SKILL_SCHEMA_VERSION,
  SkillSchema,
  SkillCredentialSpecSchema,
  SkillStepSchema,
  isKnownSkillSchemaVersion,
  parseSkill,
  type Skill,
  type SkillStep,
} from "../skill.js";

// Helpers ─────────────────────────────────────────────────────────────

const provenance = (round_index = 0) => ({
  run_id: "run-abc123",
  round_index,
});

const navigateStep = (round_index = 0): SkillStep => ({
  kind: "navigate",
  url: "https://railway.com/login",
  provenance: provenance(round_index),
});

const clickStep = (round_index = 1): SkillStep => ({
  kind: "click",
  text_match: "Create Token",
  role_hint: "button",
  provenance: provenance(round_index),
});

const extractStep = (round_index = 2): SkillStep => ({
  kind: "extract_via_copy_button",
  near_text_hint: "New Token",
  provenance: provenance(round_index),
});

const credentialSpec = () => ({
  type: "api_key" as const,
  shape_hint: "uuid" as const,
  env_var_suggestion: "RAILWAY_API_KEY",
  post_extract_validator: {
    min_length: 36,
    max_length: 36,
  },
});

const minimalSkill = (): unknown => ({
  schema_version: SKILL_SCHEMA_VERSION,
  service: "railway",
  version: "v1",
  skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
  signup_url: "https://railway.com/login",
  oauth_provider: "github",
  steps: [navigateStep(0), clickStep(1), extractStep(2)],
  credentials: [credentialSpec()],
  source_run_ids: ["run-abc123"],
  status: "active",
  replays_succeeded: 0,
  replays_failed: 0,
  consecutive_failures: 0,
  created_at: "2026-05-21T04:00:00.000Z",
  last_replayed_at: null,
  superseded_at: null,
  deleted_at: null,
});

// SkillStep ───────────────────────────────────────────────────────────

describe("SkillStepSchema — discriminated union", () => {
  it("accepts every valid step kind", () => {
    expect(SkillStepSchema.parse(navigateStep())).toBeTruthy();
    expect(SkillStepSchema.parse(clickStep())).toBeTruthy();
    expect(SkillStepSchema.parse(extractStep())).toBeTruthy();
    expect(
      SkillStepSchema.parse({
        kind: "click_oauth_button",
        provider: "github",
        text_match: "Continue with GitHub",
        provenance: provenance(),
      }),
    ).toBeTruthy();
    expect(
      SkillStepSchema.parse({
        kind: "fill",
        label_hint: "Token name",
        value_template: "${TOKEN_NAME}",
        provenance: provenance(),
      }),
    ).toBeTruthy();
    expect(
      SkillStepSchema.parse({
        kind: "select",
        label_hint: "Region",
        option_text: "us-east-1",
        provenance: provenance(),
      }),
    ).toBeTruthy();
    expect(
      SkillStepSchema.parse({
        kind: "extract_via_regex",
        pattern_name: "uuid_token",
        provenance: provenance(),
      }),
    ).toBeTruthy();
    // await_email_code — label_hint optional (OTP boxes are often unlabeled).
    expect(
      SkillStepSchema.parse({ kind: "await_email_code", provenance: provenance() }),
    ).toBeTruthy();
    expect(
      SkillStepSchema.parse({
        kind: "await_email_code",
        label_hint: "Verification code",
        provenance: provenance(),
      }),
    ).toBeTruthy();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      SkillStepSchema.parse({
        kind: "teleport",
        url: "https://railway.com",
        provenance: provenance(),
      }),
    ).toThrow();
  });

  it("rejects a navigate step with a non-URL value", () => {
    expect(() =>
      SkillStepSchema.parse({
        kind: "navigate",
        url: "not-a-url",
        provenance: provenance(),
      }),
    ).toThrow();
  });

  it("rejects a click_oauth_button step with unknown provider", () => {
    expect(() =>
      SkillStepSchema.parse({
        kind: "click_oauth_button",
        provider: "facebook",
        text_match: "Continue with Facebook",
        provenance: provenance(),
      }),
    ).toThrow();
  });

  it("rejects extra fields (.strict)", () => {
    expect(() =>
      SkillStepSchema.parse({
        kind: "navigate",
        url: "https://railway.com",
        provenance: provenance(),
        // Extra field — strict mode catches this so a hand-edited
        // skill can't smuggle in unexpected behavior.
        extra_field: "phishing",
      }),
    ).toThrow();
  });

  it("requires provenance on every step", () => {
    expect(() =>
      SkillStepSchema.parse({
        kind: "navigate",
        url: "https://railway.com",
        // No provenance.
      }),
    ).toThrow();
  });

  it("rejects negative round_index", () => {
    expect(() =>
      SkillStepSchema.parse({
        kind: "navigate",
        url: "https://railway.com",
        provenance: { run_id: "x", round_index: -1 },
      }),
    ).toThrow();
  });
});

// SkillCredentialSpec ─────────────────────────────────────────────────

describe("SkillCredentialSpecSchema", () => {
  it("accepts a minimal valid spec", () => {
    expect(SkillCredentialSpecSchema.parse(credentialSpec())).toBeTruthy();
  });

  it("accepts a spec with a sentinel HTTP check", () => {
    expect(
      SkillCredentialSpecSchema.parse({
        ...credentialSpec(),
        post_extract_validator: {
          min_length: 36,
          max_length: 36,
          sentinel_http_check: {
            url: "https://api.railway.app/v1/me",
            auth_scheme: "bearer",
            timeout_ms: 3000,
          },
        },
      }),
    ).toBeTruthy();
  });

  it("rejects env_var_suggestion that isn't UPPER_SNAKE_CASE", () => {
    expect(() =>
      SkillCredentialSpecSchema.parse({
        ...credentialSpec(),
        env_var_suggestion: "railwayApiKey",
      }),
    ).toThrow(/UPPER_SNAKE_CASE/);
  });

  it("rejects negative min_length", () => {
    expect(() =>
      SkillCredentialSpecSchema.parse({
        ...credentialSpec(),
        post_extract_validator: { min_length: 0, max_length: 36 },
      }),
    ).toThrow();
  });

  it("rejects sentinel_http_check.timeout_ms above the upper bound", () => {
    expect(() =>
      SkillCredentialSpecSchema.parse({
        ...credentialSpec(),
        post_extract_validator: {
          min_length: 36,
          max_length: 36,
          sentinel_http_check: {
            url: "https://api.railway.app/v1/me",
            auth_scheme: "bearer",
            timeout_ms: 99_999,
          },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown auth_scheme", () => {
    expect(() =>
      SkillCredentialSpecSchema.parse({
        ...credentialSpec(),
        post_extract_validator: {
          min_length: 36,
          max_length: 36,
          sentinel_http_check: {
            url: "https://api.railway.app/v1/me",
            auth_scheme: "oauth2",
            timeout_ms: 3000,
          },
        },
      }),
    ).toThrow();
  });
});

// Full Skill ──────────────────────────────────────────────────────────

describe("SkillSchema — full skill record", () => {
  it("accepts a minimal-but-complete Railway skill", () => {
    const skill = SkillSchema.parse(minimalSkill()) as Skill;
    expect(skill.service).toBe("railway");
    expect(skill.steps).toHaveLength(3);
    expect(skill.credentials).toHaveLength(1);
    expect(skill.status).toBe("active");
  });

  it("requires at least one step", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() => SkillSchema.parse({ ...base, steps: [] })).toThrow();
  });

  it("requires at least one credential", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() => SkillSchema.parse({ ...base, credentials: [] })).toThrow();
  });

  it("requires at least one source_run_id", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() => SkillSchema.parse({ ...base, source_run_ids: [] })).toThrow();
  });

  it("rejects a service slug with uppercase letters", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() => SkillSchema.parse({ ...base, service: "Railway" })).toThrow();
  });

  it("rejects a version that isn't vN-shaped", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() => SkillSchema.parse({ ...base, version: "1.0.0" })).toThrow();
  });

  it("rejects a skill_id that isn't ULID-shaped", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() => SkillSchema.parse({ ...base, skill_id: "not-a-ulid" })).toThrow();
  });

  it("accepts oauth_provider: null (email/password signup)", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(
      SkillSchema.parse({ ...base, oauth_provider: null }),
    ).toBeTruthy();
  });

  it("rejects an unknown status", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() =>
      SkillSchema.parse({ ...base, status: "forgotten" }),
    ).toThrow();
  });

  it("accepts multiple credentials (forward-compat with Stripe-class)", () => {
    const base = minimalSkill() as Record<string, unknown>;
    const multi = {
      ...base,
      credentials: [
        {
          ...credentialSpec(),
          env_var_suggestion: "STRIPE_PUBLISHABLE_KEY",
        },
        {
          ...credentialSpec(),
          env_var_suggestion: "STRIPE_SECRET_KEY",
        },
      ],
    };
    const skill = SkillSchema.parse(multi) as Skill;
    expect(skill.credentials).toHaveLength(2);
  });

  it("rejects an unknown schema_version (E2 guard)", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() =>
      SkillSchema.parse({ ...base, schema_version: 99 }),
    ).toThrow();
  });

  it("rejects extra top-level fields (.strict)", () => {
    const base = minimalSkill() as Record<string, unknown>;
    expect(() =>
      SkillSchema.parse({ ...base, malicious_extra_field: true }),
    ).toThrow();
  });

  it("preserves status: pending-review (C11 gate)", () => {
    const base = minimalSkill() as Record<string, unknown>;
    const skill = SkillSchema.parse({
      ...base,
      status: "pending-review",
    }) as Skill;
    expect(skill.status).toBe("pending-review");
  });

  it("preserves status: superseded with timestamp (Decision 6 GC)", () => {
    const base = minimalSkill() as Record<string, unknown>;
    const skill = SkillSchema.parse({
      ...base,
      status: "superseded",
      superseded_at: "2026-05-22T04:00:00.000Z",
    }) as Skill;
    expect(skill.status).toBe("superseded");
    expect(skill.superseded_at).toBe("2026-05-22T04:00:00.000Z");
  });
});

// Helpers ─────────────────────────────────────────────────────────────

describe("parseSkill", () => {
  it("returns the parsed skill on valid input", () => {
    const skill = parseSkill(minimalSkill());
    expect(skill.service).toBe("railway");
  });

  it("throws on invalid input", () => {
    expect(() => parseSkill({ schema_version: 1 })).toThrow();
  });
});

describe("isKnownSkillSchemaVersion", () => {
  it("returns true for the current version", () => {
    expect(isKnownSkillSchemaVersion({ schema_version: SKILL_SCHEMA_VERSION })).toBe(true);
  });

  it("returns false for unknown versions", () => {
    expect(isKnownSkillSchemaVersion({ schema_version: 99 })).toBe(false);
    expect(isKnownSkillSchemaVersion({ schema_version: "1" })).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isKnownSkillSchemaVersion(null)).toBe(false);
    expect(isKnownSkillSchemaVersion("not an object")).toBe(false);
    expect(isKnownSkillSchemaVersion(123)).toBe(false);
  });

  it("returns false when schema_version is missing", () => {
    expect(isKnownSkillSchemaVersion({})).toBe(false);
  });
});
