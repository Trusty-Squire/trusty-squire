// A6 — dropSpuriousUuidExtract: when a copy-button extract co-exists,
// a uuid_token regex extract is almost always a spurious onboarding-page
// value (e.g. PostHog's project_id) captured as a redundant "credential".
// upgradeToMultiCred would make both required → verifier replay hard-fails
// on a fresh account. Drop the uuid_token regex in that case; leave
// single-cred and genuine multi-cred untouched.

import { describe, expect, it } from "vitest";
import type { SkillStep } from "@trusty-squire/skill-schema";
import { dropSpuriousUuidExtract } from "../promote-to-skill.js";

const prov = (round_index: number) => ({ run_id: "r1", round_index });
const nav = (url: string, r: number): SkillStep => ({ kind: "navigate", url, provenance: prov(r) });
const regex = (pattern_name: string, r: number): SkillStep =>
  ({ kind: "extract_via_regex", pattern_name, provenance: prov(r) } as unknown as SkillStep);
const copy = (hint: string, r: number): SkillStep =>
  ({ kind: "extract_via_copy_button", near_text_hint: hint, provenance: prov(r) });

const kinds = (steps: SkillStep[]) => steps.map((s) => s.kind);

describe("dropSpuriousUuidExtract (A6)", () => {
  it("drops a uuid_token regex extract when a copy-button extract co-exists (posthog class)", () => {
    const steps: SkillStep[] = [
      nav("https://x.example/project/440416/onboarding", 0),
      regex("uuid_token", 1),
      nav("https://x.example/settings/keys", 2),
      copy("Copy", 3),
    ];
    const out = dropSpuriousUuidExtract(steps);
    expect(kinds(out)).toEqual(["navigate", "navigate", "extract_via_copy_button"]);
  });

  it("keeps a lone uuid_token regex extract when there is NO copy-button (single-cred)", () => {
    const steps: SkillStep[] = [nav("https://x.example/keys", 0), regex("uuid_token", 1)];
    expect(dropSpuriousUuidExtract(steps)).toEqual(steps);
  });

  it("leaves genuine multi-cred with two copy-button fields untouched", () => {
    const steps: SkillStep[] = [copy("Cloud name", 0), copy("API key", 1)];
    expect(dropSpuriousUuidExtract(steps)).toEqual(steps);
  });

  it("keeps a NON-uuid_token regex extract alongside a copy-button (genuine 2-cred)", () => {
    const steps: SkillStep[] = [regex("resend", 0), copy("API key", 1)];
    expect(kinds(dropSpuriousUuidExtract(steps))).toEqual(["extract_via_regex", "extract_via_copy_button"]);
  });

  it("drops every uuid_token regex when a copy-button is present", () => {
    const steps: SkillStep[] = [regex("uuid_token", 0), regex("uuid_token", 1), copy("Copy", 2)];
    expect(kinds(dropSpuriousUuidExtract(steps))).toEqual(["extract_via_copy_button"]);
  });
});
