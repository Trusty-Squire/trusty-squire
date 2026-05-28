// Public surface of @trusty-squire/adapter-sdk.
//
// Post-0.8: the native-provision cluster (AdapterManifest +
// defineAdapter) was sunset, so this package now exports only the
// Tier-2 Learned Skill schema. The package name stays "adapter-sdk"
// for the same reason `ADAPTER_SIGNING_PRIVATE_KEY` does — renaming
// would force a fly-secrets dance on every consumer for zero
// functional gain.

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
