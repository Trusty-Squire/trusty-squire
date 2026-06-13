import { describe, it, expect } from "vitest";
import { validateReplayGraph } from "../replay-graph.js";
import type { Skill, SkillStep } from "../skill.js";

const provenance = { run_id: "r", round_index: 0 };

function skill(steps: SkillStep[], signup_url = "https://x.co/signup"): Skill {
  return {
    schema_version: 1,
    service: "svc",
    version: "v1",
    skill_id: "01HZX9ABCDEFGHJKMNPQRSTVWX",
    signup_url,
    oauth_provider: null,
    steps,
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "SVC_API_KEY",
        post_extract_validator: { min_length: 36, max_length: 36 },
      },
    ],
    source_run_ids: ["r"],
    status: "pending-review",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-06-11T00:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

const emailFill: SkillStep = {
  kind: "fill",
  label_hint: "email",
  value_template: "${EMAIL_ALIAS}",
  provenance,
};
const sendCode: SkillStep = { kind: "click", text_match: "Send code", provenance };
const awaitCode: SkillStep = { kind: "await_email_code", provenance };
const extract: SkillStep = { kind: "extract_via_regex", pattern_name: "uuid_token", provenance };

describe("validateReplayGraph", () => {
  it("accepts a complete email-OTP graph", () => {
    const r = validateReplayGraph(skill([emailFill, sendCode, awaitCode, extract]));
    expect(r.ok).toBe(true);
  });

  it("accepts a graph with no await_email_code (non-OTP skills unaffected)", () => {
    const r = validateReplayGraph(
      skill([{ kind: "navigate", url: "https://x.co", provenance }, extract]),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects await_email_code with no preceding ${EMAIL_ALIAS} fill", () => {
    const r = validateReplayGraph(skill([awaitCode, extract]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("await_code_without_email_dispatch");
  });

  it("rejects await_email_code when the email is filled but never submitted", () => {
    const r = validateReplayGraph(skill([emailFill, awaitCode, extract]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("await_code_without_email_dispatch");
  });

  it("rejects a signup_url carrying a per-run email param", () => {
    const r = validateReplayGraph(
      skill(
        [emailFill, sendCode, awaitCode, extract],
        "https://cloud.zilliz.com/signup/verify?email=ghall284@trustysquire.ai",
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("per_run_signup_url_param");
  });

  it("allows a benign signup_url query param", () => {
    const r = validateReplayGraph(
      skill([emailFill, sendCode, awaitCode, extract], "https://x.co/signup?plan=free"),
    );
    expect(r.ok).toBe(true);
  });
});
