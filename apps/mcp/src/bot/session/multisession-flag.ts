// Step 4/5 of the multi-session browser broker migration (audit slice):
// an explicit, OFF-BY-DEFAULT escape hatch for a controlled two-agent test.
// Production admits exactly one operate_start session per profile — this
// flag exists ONLY to let a second (and Nth) session join the same
// already-live IdentityRuntime browser instead of getting PROFILE_BUSY, so a
// two-agent auth-preservation spike can run. It is experimental test
// scaffolding, not a production concurrency feature: two sessions against
// the SAME site under the SAME login share cookies and can collide, and
// that is not addressed here — this flag is for different-site concurrency
// and the auth spike, not a general guarantee. Each session's host-scope
// network guard IS page-aware: it judges only requests from pages its own
// OwnedPages claims and hands a page another session has claimed on to that
// session's guard (see installHostScopeGuard in bot/browser.ts). Only a page
// no session has claimed, or a frameless service-worker request, is still
// judged by every guard on the shared context.
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function experimentalMultiSessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION ?? "").trim().toLowerCase());
}
