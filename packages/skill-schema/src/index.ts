// Public surface of @trusty-squire/skill-schema.
//
// The Tier-2 Learned Skill wire contract — the single Zod schema that
// the mcp client (synthesize/sign/POST) and the registry server
// (validate/store) both validate against. Lives in packages/ because
// it's shared across two separately-deployed artifacts.
//
// Formerly @trusty-squire/adapter-sdk: it also held the native-provision
// AdapterManifest + defineAdapter types, which were sunset in 0.8. With
// only the skill schema left, it was renamed to match its role.

export {
  SKILL_SCHEMA_VERSION,
  isIdentityFieldLabel,
  orderedOAuthProviders,
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
export { validateReplayGraph } from "./replay-graph.js";
export type { ReplayGraphCheck, ReplayGraphErrorCode } from "./replay-graph.js";
export {
  WALL_FAILURE_KINDS,
  INFRA_FAILURE_KINDS,
  ROT_FAILURE_KINDS,
  classifyFailure,
  failureCountsTowardDemotion,
  isWallFailure,
  isNavNetworkFailure,
  NAV_TIMEOUT_KIND,
  isReturningUserDivergence,
  ACCOUNT_EXISTS_KIND,
} from "./failure-taxonomy.js";
export type { FailureClass } from "./failure-taxonomy.js";
export {
  canonicalizeServiceSlug,
  serviceSlugFromHost,
  equivalentServiceSlugs,
  serviceSlugLookupOrder,
} from "./service-slugs.js";
