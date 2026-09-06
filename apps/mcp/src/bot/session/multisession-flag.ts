// Step 4/5 of the multi-session browser broker migration (audit slice):
// an explicit, OFF-BY-DEFAULT escape hatch for a controlled two-agent test.
// Production admits exactly one operate_start session per profile — this
// flag exists ONLY to let a second (and Nth) session join the same
// already-live IdentityRuntime browser instead of getting PROFILE_BUSY, so a
// two-agent auth-preservation spike can run. It is experimental test
// scaffolding, not a production concurrency feature: two sessions against
// the SAME site under the SAME login share cookies and can collide, and
// that is not addressed here — this flag is for different-site concurrency
// and the auth spike, not a general guarantee. The host-scope network guard
// (installHostScopeGuard in bot/browser.ts) judges every request
// unconditionally with the flag off. With it on, each session's guard hands
// a page another session's OwnedPages has definitely claimed on to that
// session's guard and judges everything else itself — so an UNCLAIMED page
// is judged by every live session's guard, which must all pass it. Every
// popup is unclaimed between its first navigation commit and its opener's
// "popup" event, so a popup's earliest XHR/fetch (an OAuth/consent page's
// first API call) must be in scope for every live session or it is aborted.
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function experimentalMultiSessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION ?? "").trim().toLowerCase());
}
