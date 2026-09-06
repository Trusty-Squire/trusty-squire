# Exclusive browser process and page ownership

`BrowserController` composes one `BrowserProcessOwner` and one `PageDriver` for
one session. It preserves the operator API. There is no broker, shared browser,
additional admission, or detach operation.

- `apps/mcp/src/bot/browser-process-owner.ts` owns launch state, the connected
  context/transport, process identity proof, cancellation, display custody, and
  bounded teardown. Page initialization is awaited at the original point after
  process ownership is established and cancellation checked.
- `apps/mcp/src/bot/browser-process-runtime.ts` holds the existing launch helpers,
  launcher singleton, process tracking, and proxy resolution. Helpers shared with
  plain login remain shared. Their existing exports are re-exported by `browser.ts`.
- `apps/mcp/src/bot/page-driver.ts` owns primary/current/OAuth page references,
  PR1's `OwnedPages` registry, document subscriptions, navigation, and adoption.
  Disposing its registrations does not terminate Chrome.
- `browser.ts` retains page initialization, interaction, payment, and observation
  behavior. Its page accessors refer to the single PageDriver's state.

## Preserved lifecycle contract

Local operator launches remain **headed** on their owned display, including the
proxy geo probe. `OPERATOR_BROWSER_HEADLESS` remains `false`; the pre-existing
headless description in AGENTS.md is not a launch-policy change. Launch flags,
self-launch selection, Patchright `connectOverCDP`, persistent fallback, and
remote attach remain the existing paths.

Close first disposes page ownership and document subscriptions. Harness teardown
only drops its references. Normal teardown marks the launch terminal, captures
identity and page/context/transport references, clears active references, and
runs `closeProfileWithProof`: identity-proven SIGTERM, page close, context close,
transport close, with the existing bounded SIGKILL/proof fallback. It then
releases stale process proof, checks marked orphans, untracks only proven closure,
and tears down the owned display. Cancellation and late-start reaping use the
same state machine and retain the late-context cleanup path.

`profile.ts` remains authoritative for canonical path resolution, operation leases,
birth identity, and argv checks. `owner-process-reaper.ts` and
`operator-browser-watchdog.ts` retain manifests, orphan reconciliation, and
containment. Plain login's launch and SIGINT graceful-quit bodies are unchanged.

`browser-process-page-boundary.test.ts` executes the facade against controlled
transports to pin close ordering, orphan failure, late attachment cancellation,
and independent page disposal. `google-login.test.ts` also drives cancellation
through the facade, with its private launch fixtures now injected into the process
owner. The existing real process, page adoption, OAuth, and payment suites remain
required; `pnpm --filter @trusty-squire/mcp test:fast` runs that tier.

## Identity runtime (Step 3 — Chrome lifetime independent of one session)

`apps/mcp/src/bot/identity-runtime.ts` adds one more layer above the
process/page split above: `IdentityRuntime` owns Chrome's lifetime for one
identity/profile, decoupled from a `BrowserController`/`BrowserProcessOwner`
launch. It is generic over the launched handle so it needs no real Chrome to
test (`identity-runtime.test.ts` exercises it against a fake handle).

- **Single-flight launch.** Concurrent `acquire()` calls for the same (or an
  in-flight) settings collapse into one `launch()`; every other caller awaits
  or reuses the result instead of double-launching.
- **Epoch.** Increments once per real (re)launch, so a caller that stashed an
  earlier `epoch` can detect via `isEpochStale()` that the runtime has since
  relaunched underneath it.
- **Tab acquire/release is a separate operation from Chrome shutdown.**
  `acquire()` returns a `releaseTabs()` closure; calling it only decrements
  the runtime's active-lease count and never closes the browser. Only
  `forgetAfterShutdown()` — called after the caller itself closes the handle —
  resets the runtime so the next `acquire()` launches fresh.
- **Incompatible settings are rejected, never silently applied.** A second
  `acquire()` against a live or in-flight identity with different settings
  (e.g. a different proxy) throws `IncompatibleIdentityRuntimeSettingsError`
  rather than mutating the shared context. The only sanctioned path to
  different settings is close → `forgetAfterShutdown()` → `acquire()` again.

`session/lifecycle.ts` wires one module-level `IdentityRuntime` into
`acquireWarmBrowser`/`releaseWarmBrowserPage`/`forceReleaseWarmBrowserPage` for
the operator profile. **Production still calls `forgetAfterShutdown()` after
closing the browser at every finish of a runtime-acquired session, and on an
acquire failure after closing whichever `BrowserController` the launch had
constructed** (so a launch that rejects after Chrome spawned still reaps the
process instead of leaving it holding the profile lock). Only browsers leased
from the runtime touch it: a harness session (`startHarnessProvisionSession`,
caller-owned browser) finishing never resets the runtime underneath a live
`operate_start` session — `operate-session-flow.test.ts` pins both. So today
this is purely single-flight/epoch bookkeeping around the exact same
construct-then-close lifecycle as before — Chrome is not yet kept warm across
sessions, and admission is still capped at exactly one session via the
existing profile lease (`acquireProfileOperationGuard`/`waitForProfileFree`),
untouched by this change. Turning on sequential reuse (skip
`forgetAfterShutdown()` at finish so the next session's `acquire()` reuses the
still-live Chrome) is the follow-up: it additionally requires resetting
`BrowserController`/`PageDriver` per-session state (page references, host-scope
guard routes, checkout/payment scratch fields) to a clean baseline before
reuse, which this PR deliberately does not attempt.
