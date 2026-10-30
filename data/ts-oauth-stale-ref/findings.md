# Reproduction R1: valid OAuth ref reported stale

## Evidence ledger (2026-10-29, America/New_York)

- 20:22, mounted Squire `operate_start` on ElevenLabs signup returned canonical
  ref `@e:StfgWgx8HoOLiqiGnPe9T3`. `operate_login(action:oauth,
  provider:google, ref)` returned `action_failed: stale_ref`. `operate_click`
  accepted the same ref. A fresh query and another OAuth attempt reproduced the
  same error. A drive-owned ref reached Google's account chooser instead.
- 20:36, isolated built-app harness with the installed Patchright driver,
  `BrowserController.attachSessionPage`, and the actual ElevenLabs signup page
  reproduced `ProvenPreDispatchMutationError: stale_ref`. Temporary internal
  diagnostics showed its cause: `elementHandle.click: Timeout 1000ms exceeded`,
  while waiting for the element to be visible, enabled and stable. The ref had
  already resolved and passed the target checks. Diagnostics were confined to
  generated local dist and are absent from the source change.
- 20:38, a real-browser regression modeled a brief disabled/render state after
  the prepared target check. Both the canonical ref and label alias failed on
  unchanged production code with `ProvenPreDispatchMutationError: stale_ref`,
  caused by the final native click's one-second timeout.
- 20:46, the final regression passed both unchanged targets with the ordinary
  eight-second click budget, capped by remaining OAuth time. A third case
  changed the button to “Delete account” during that wait: the existing
  click-time intent guard refused it and no provider popup opened.
- 20:47, the rebuilt real-site harness reached
  `accounts.google.com/v3/signin/identifier` from the actual ElevenLabs signup
  through `operateLoginTool.handler(action:oauth, provider:google, ref)` and the
  broker's prepared-target wrapper. It returned `oauth.state: awaiting_human`.
  The session was closed there; no account or consent was completed.

## Scope of the live-site proof

The running shared broker was not replaced with unreviewed code. The isolated
harness used the built app and real ElevenLabs/Google pages, but routed only
Google's admission probe to the suite's synthetic identity fixture. Its browser
had no copied profile or cookies and reached Google's signed-out sign-in page.
This proves the built tool's real-site navigation path, not a patched shared
broker/account-chooser run with the owner's existing Google identity.

The committed browser regression uses synthetic pages and identity, with the
same observed ref, prepared broker target, public login handler, native click,
provider popup and return path. A transient actionability delay is its stand-in
for the live signup's timing. Foreground-only changes were investigated but did
not establish a sufficient fix and are not part of the change.

## Change

The prepared native click now gets the ordinary bounded actionability allowance,
limited by the existing OAuth deadline. It retains the observed ElementHandle,
revalidation before dispatch, and capture listener that blocks changed intent.
No ref resolver, provider selection, OAuth identity policy or account flow changed.

## Repeat the isolated real-site proof

```sh
pnpm --filter @trusty-squire/mcp build
node apps/mcp/scripts/oauth-stale-ref-live.mjs
```

If the driver's bundled browser is unavailable, set `R1_BROWSER_EXECUTABLE` to
an installed Chromium executable. This script isolates configuration and browser
state itself; it never reads the operator's profile or saved credentials.

Observed output from the committed script with the rebuilt app:

```json
{"reproduction":"R1","admission":"synthetic Google identity; isolated unsigned-in browser","destination":"https://accounts.google.com/v3/signin/identifier","oauth":"awaiting_human"}
```

Validation: the complete `oauth-login.test.ts` file passed (94 tests), including
both delayed targets and the changed-intent refusal. MCP build, typecheck and
Prettier checks passed. The repository's session-hub validation plan also runs
fast tests plus `operate-session-flow` and `session-characterization`; its final
result is recorded in the pull request.

The session-hub gate returned nonzero: fast core passed (1,436 tests), required
payment safety passed (96 tests), and required behavior had three browser
teardown assertion failures. Running `browser-process-page-boundary.test.ts`
and `google-login.test.ts` with `oauth-login.ts` restored byte-for-byte from
unchanged HEAD reproduced those same three failures. That baseline run also
ran the final R1 regression cases via a temporary whole-file fixture: both
unchanged targets failed with `ProvenPreDispatchMutationError: stale_ref`;
the changed-intent refusal passed. The temporary file was removed and the fix
restored before delivery. These unrelated teardown failures were not changed.

The session-hub extras passed separately (205 tests across
`operate-session-flow.test.ts` and `session-characterization.test.ts`), because
the planner stops before extras when the baseline-required behavior gate fails.
