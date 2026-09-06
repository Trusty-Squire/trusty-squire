// Step 4/5 of the multi-session browser broker migration (audit slice):
// an explicit, OFF-BY-DEFAULT escape hatch for a controlled two-agent test.
// Production admits exactly one operate_start session per profile — this
// flag exists ONLY to let a second (and Nth) session join the same
// already-live IdentityRuntime browser instead of getting PROFILE_BUSY, so a
// two-agent auth-preservation spike can run. It is experimental test
// scaffolding, not a production concurrency feature: two sessions against
// the SAME site under the SAME login share cookies and can collide, and
// per-session host-scope network guards are not mutually session-aware once
// a second session shares the context (see session/lifecycle.ts). Neither
// limitation is addressed here — this flag is for different-site
// concurrency and the auth spike, not a general guarantee.
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function experimentalMultiSessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION ?? "").trim().toLowerCase());
}
