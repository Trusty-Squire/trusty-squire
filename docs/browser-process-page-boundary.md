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
