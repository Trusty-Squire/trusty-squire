// Auto-probe-before-retire guard — the mcp-only half of the verifier's
// demotion taxonomy. These three symbols used to live in
// packages/skill-schema's failure-taxonomy, but ONLY the mcp housekeeper
// (verify.ts) consumes them: the registry's classifyFailure defaults
// unknown kinds to "transient" (non-demoting), so the BRITTLE_PROBE_KIND
// downgrade works regardless of the registry's deployed version. Keeping
// them in skill-schema diverged its source from its published npm version
// (skill-schema is bundled into the mcp tarball via workspace:*), so they
// were relocated here to kill that skew. The genuinely-shared taxonomy
// (classifyFailure, the kind unions) stays in skill-schema.
//
// A replay step/validator/extraction failure (the rot kinds) can mean
// genuine skill rot OR replay brittleness against a service that is STILL
// servable — a synthesized step matched a gloss-text element that the
// planner happened to re-render, the page selector drifted, etc. The bug
// this guards against (MEASURED 2026-06-13, fly.io): the verifier retired a
// servable skill because one step failed on a brittle text_match ("Tokens
// matched 2 elements") — the service had not rotted; the recipe was brittle.
// Retiring on brittleness throws away a working skill.
//
// The guard: before a rot failure counts toward demotion, the verifier
// probes the live signup page (affordance-probe). If the page still shows
// the service's expected affordances — an OAuth provider button OR an
// email-signup form — AND nothing that would itself explain a real wall (a
// card-gate-only page, an anti-bot interstitial), the failure is
// brittleness, not rot: downgrade it to this transient kind so it records
// the stat WITHOUT advancing the 3-strike demote counter, and flag it for
// re-synthesis instead of retiring it.
export const BRITTLE_PROBE_KIND = "brittle_replay_servable";

// The affordance shape the probe reports back, kept browser-free here so
// the guard stays a pure, unit-testable predicate. The live PageAffordances
// (apps/mcp/src/bot/affordance-probe) structurally satisfies this — it has
// these four fields plus browser-only extras.
export interface ProbedAffordances {
  providers: readonly string[];
  has_email_signup: boolean;
  card_gate: boolean;
  interstitial: boolean;
}

// True when a probe of the signup page CLEARLY shows the service is still
// servable: a real entry affordance is present (an OAuth provider OR an
// email-signup form) and nothing on the page itself explains a real wall (an
// anti-bot interstitial). Conservative by design — it gates a DOWNGRADE (rot →
// non-demoting), so it must err toward false: an ambiguous or empty probe leaves
// the original demoting classification intact. Never upgrades.
export function probeShowsServable(
  affordances: ProbedAffordances | null | undefined,
): boolean {
  if (affordances === null || affordances === undefined) return false;
  // A real wall on the page itself explains the replay failure — not brittleness.
  if (affordances.interstitial) return false;
  const hasEntryAffordance =
    affordances.providers.length > 0 || affordances.has_email_signup;
  // A card-gate with no real entry affordance is a payment wall, not a servable
  // signup; a card-gate ALONGSIDE an OAuth/email entry is just an upsell and is
  // accepted because hasEntryAffordance is satisfied independently.
  return hasEntryAffordance;
}
