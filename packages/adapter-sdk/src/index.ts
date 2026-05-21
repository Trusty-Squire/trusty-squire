export * from "./types.js";
export { defineAdapter } from "./define-adapter.js";

// Tier-2 Learned Skill schema (0.7.0). See ./skill.ts for the data
// model and docs/DESIGN-skill-promoter.md for rationale. Exported
// alongside the hand-authored adapter manifest types because the
// registry stores both in the same `Adapter` table (unified-schema
// decision, Challenge 2 → option A).
export {
  SKILL_SCHEMA_VERSION,
  SkillSchema,
  SkillStepSchema,
  SkillCredentialSpecSchema,
  SkillStatusSchema,
  parseSkill,
  isKnownSkillSchemaVersion,
} from "./skill.js";
export type {
  Skill,
  SkillStep,
  SkillStepProvenance,
  SkillCredentialSpec,
  SkillStatus,
} from "./skill.js";
