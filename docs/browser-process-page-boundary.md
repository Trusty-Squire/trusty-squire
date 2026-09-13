# Exclusive browser process and page ownership

The [browser broker](browser-broker.md) is the sole production owner of Chrome.
Each session's `BrowserController` shares its process owner and has an independent
`PageDriver` and tab family. MCP servers forward commands over local IPC.

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
runs `closeProfileWithProof`: bounded page and context close first (1s each),
then, if the identity-proven local browser survives, `quitBrowserGracefully`
sends SIGINT and waits up to 10s for exit. CDP transport close has its own 2s
bound; the existing 15s overall close cap and SIGKILL/proof fallback remain.
No SIGTERM or reaper escalation precedes that graceful window. It then
releases stale process proof, checks marked orphans, untracks only proven closure,
and tears down the owned display. Cancellation and late-start reaping use the
same state machine and retain the late-context cleanup path.

`profile.ts` remains authoritative for canonical path resolution, operation leases,
birth identity, and argv checks. `owner-process-reaper.ts` and
`operator-browser-watchdog.ts` retain manifests, orphan reconciliation, and
containment. Plain login's launch and CDP boundary are unchanged. Its SIGINT quit helper now
lives in `browser-process-runtime.ts`, with the original plain-login exports
preserved by `browser.ts`, so both local owners share the same grace period.

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
- **In-band recycle at the broker layer.** `BrokerRuntime.acquire()` turns
  that sanctioned path into an automatic one for a settings change (notably a
  new `proxy` from `operate_start`): when no other session is active on the
  shared profile, it closes the live Chrome through the ordinary owner-close
  path, releases the profile lease, calls `forgetAfterShutdown()`, and
  relaunches with the requested settings — no broker-process kill. With other
  active sessions it refuses instead of yanking the shared Chrome; the
  persistent profile, enrollment, and Google login all survive the recycle.

`broker/runtime.ts` owns the identity runtime and physical profile lease.
`session/lifecycle.ts` acquires and releases session pages through broker custody;
it cannot launch Chrome. Explicit harness starts accept caller-owned pages.
`browser-close-cookie.test.ts` covers cookie persistence through physical shutdown,
and `broker-tab-family.test.ts` covers independent session pages and unrestricted egress.
