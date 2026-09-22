# Cross-process identity browser broker

The broker is the sole production path for MCP operator Chrome custody.
Independent MCP servers retain their session IDs and forward commands
over local IPC. One broker owns one canonical profile, one Chrome,
and the existing operator handlers and payment state. There is no direct-server
browser launch and no fallback anywhere in the product: the broker performs the
Turnstile-safe self-launch itself, once, and hands every tab out from it.

## Configuration and operation

Build with `pnpm --filter @trusty-squire/mcp build`, then run
`node apps/mcp/dist/bin.js server` with the enrolled profile and account.
No broker-specific environment is required. Discovery derives a private local
socket from the canonical profile path and user ID, independent of cwd and TMPDIR,
and starts or attaches the elected broker. `TRUSTY_SQUIRE_BROKER_SOCKET` optionally
overrides that endpoint; its parent must exist, belong to the current user, and
have mode 0700. The default private parent is created automatically.

Endpoint election is bind-exclusive against a live incumbent. When the socket
path exists but no listener answers it (a broker killed with SIGKILL cannot run
its graceful close, so it orphans `broker.sock`), the starting broker probes the
endpoint with a client connect, then unlinks the stale socket and binds
normally. A live listener keeps winning election: the probe succeeds and the
`EADDRINUSE` refusal is preserved.

`operate_start` accepts `proxy` as an HTTP or HTTPS URL (optional credentials)
or an unauthenticated SOCKS5 URL. It configures the shared browser at launch,
not an individual tab family. Concurrent sessions must request compatible proxy
settings; incompatible settings are never applied to the live browser. When no
other session is active on the profile, a different proxy recycles the shared
Chrome in-band (close, release the lease, relaunch) without restarting the
broker; with other active sessions it is refused with `incompatible_runtime`
until they finish. The recycle mechanics live in
[`browser-process-page-boundary.md`](browser-process-page-boundary.md). Omitting
it requests direct egress. The value is sensitive and is not returned in
session status, action traces, or saved recipes.

`TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS` defaults to five minutes, clamped to a
minimum of one minute. Idle shutdown never
changes the fact that the next operator call must attach or start a broker.
**The broker requires no enrollment.** It is the machine's shared browser, and
the moment a machine most needs it is the moment it is being enrolled: the
ceremony has to run somewhere, and an account is exactly what it does not have
yet. Account identity is named by the calls that act as an account
(`open`/`command`/`close` carry an optional `account`); connecting takes
nothing, and getting a tab and driving it takes nothing. `connect` is an
ordinary broker client and holds no separate identity.

The first client starts `node apps/mcp/dist/bin.js broker` when necessary.
Socket mode is 0600. No CDP endpoint or browser
handle crosses IPC. `TRUSTY_SQUIRE_AGENT_IDENTITY` supplies a connection's agent
label, which carries no authority.

The client wire is the frozen Contract B — `connect`, `open`, `command`,
`close` (`apps/mcp/src/bot/broker/protocol.ts`). A connection ends with
`close{}` (the lease boundary, formerly `client_close`), which releases that
connection's claim without draining or restarting the shared browser.

### Account identity is named by the call, never by the connection

The socket lives in a directory only its owner can reach, so reaching it
already proves the caller is that user; a credential on the wire protects
nothing there, and a machine being enrolled has none to present. `connect`
therefore takes nothing and the broker admits every local caller. An account is
named by the calls that act as one — `open`, `command`, and `close` each carry
an optional `account { accountId, agentSessionToken, apiBaseUrl }` — and the
broker builds (and caches per connection) the API client for it at that call.
Driving a tab names none. A ceremony open names none: enrollment CREATES an
account rather than acting as one, so it passes through.

The account is re-read per call by the forwarder, never cached on the
connection: a session that outlives a re-enrollment acts as the freshly
enrolled account on its next account-acting call. The profile's on-disk account
binding is written and checked from the account an open names (the first one
that acts as an account), so a profile can serve the enrollment ceremony before
any account exists and still refuse a second account afterwards.
`broker-only-path-acceptance.test.ts` proves both behaviours against a real
broker, real Chrome, and real MCP stdio servers.

Connect approaches the browser only when it needs it. The already-provisioned
preflight — stored session, account-bound plumbing, and a byte-copy read of the
profile's cookie store (`detectProviderSessionsFromProfile`) — runs BEFORE any
broker or browser work, takes no profile lease, waits for nothing, and opens no
browser. An install that is already connected therefore completes while the
broker keeps both its lease and its Chrome. An absent profile or cookie store
requires the ceremony; a failed preflight probe is reported as `unverified`
instead of forcing re-pairing.

Ordering it the other way round, or answering it with a probe that opens the
profile, both fail the same way: the machines that are already connected are
exactly the machines whose browser is busy, so the question contends with the
browser it is about and connect reports the profile as busy. Cookie presence is
all that read proves; a cookie can outlive its server-side session. After the
ceremony, `probeProviderSessionsAfterCeremony` first tries the live probe. If the
profile is still busy, it polls committed-cookie snapshots for up to 45 seconds,
awaiting Google and any explicitly requested provider before accepting early.
Unreadable snapshots are unknown, not proof of sign-out; no provider list is
persisted in the account session file. Ceremony completion itself remains the
install claim alone, never a cookie read; the browser's nonce-scoped Finish
callback is a courtesy that closes the page early, never a completion gate.

When an install does need the login ceremony, the ceremony opens the confirm
page as a TAB in the shared broker browser — an ordinary `open` on a
`connectOrLaunchBroker` connection, no drain, no second Chrome, and no touch of
the profile lease. **There is no fallback browser.** The broker is the only
thing in the product that launches one: with no resident broker the ordinary
connect-or-launch path spawns the daemon (which requires no enrollment), whose
browser hosts the tab (and keeps the reclaim contracts below). A host with a screen (`hasDisplay()` in
`apps/mcp/src/bot/display-env.ts`) launches that Chrome on the machine
display — no Xvfb, no noVNC. That decision is the daemon's, taken when it
launches its Chrome: a broker spawned without DISPLAY (over SSH, or from a
user service) cannot see the GUI session's display and parks its Chrome on a
private Xvfb. A later connect from a screened terminal keeps the noVNC
exposure for that Chrome rather than refusing — nothing here can move a live
Chrome between X displays, and the profile that Chrome holds is the one the
ceremony needs. Headless hosts likewise use the broker's private Xvfb and
connect exposes it over noVNC for the ceremony (same x11vnc + websockify +
tunnel stack as the standalone remote login, reaped at the ceremony's lease
boundary) — a tab no human can see is a tab no human can complete.
The ceremony lands where the PERSON RUNNING CONNECT can see it, and the
broker's own environment never decides that: its Chrome may sit on the
machine's screen while connect runs over SSH, or on a private Xvfb while
connect runs at the desk. The tab counts as already visible only when the
holder is on the machine's own screen AND this connect has one (`hasDisplay()`
in `apps/mcp/src/bot/display-env.ts`); every other named display — the
broker's Xvfb, or the host's screen seen from a screenless connect — is
exposed over noVNC. The noVNC URL therefore shows whatever that display is
carrying, the machine's own desktop included; the disclosure label says so.
Display discovery first reads the holder profile's tracked launch display from
the owner-reaper manifest, then falls back to the holder's process tree: Chrome
can erase its main process environment while children retain DISPLAY/XAUTHORITY.
The holder's own evidence classifies its display: every rig this repo starts
sets DISPLAY and XAUTHORITY together, so a holder carrying DISPLAY without
XAUTHORITY is provably on the machine's screen (startx/xinit, WSLg and several
display managers do not export it). A display no evidence can name is
unshowable and stops the ceremony immediately — except where windows are drawn
natively (macOS, Windows), which has no X display to discover and no rig it
could be hiding on. A failed noVNC exposure stops it immediately too.
Cleanup removes the ceremony's helpers and tab, preserving the broker's browser
and display even on setup failure.
`shared-ceremony-exposure.test.ts` and `broker-connect-attach.test.ts` pin these
contracts.

The ceremony adopts the browser's current proxy identity instead of requesting
a conflicting bare browser. Its `ceremony` open enters the scoped admission
exception in `session/lifecycle.ts`: sign-in must be able to create the Google
session it otherwise requires. Ordinary agent-facing `operate_start` admission
is unchanged.

Known property of that exposure, decided with the connect-browser-claim work:
the noVNC URL shows the WHOLE shared display, not just the ceremony tab. While
the ceremony runs (bounded by its deadline), anyone holding the URL can see —
and, x11vnc not being view-only, drive — every tab the shared browser is
running, including sibling operator sessions' tabs. The window is the
ceremony deadline, and the URL is single-use: a fresh VNC password is minted
per ceremony and the quick tunnel is torn down at the lease boundary. That
window is held by the exposure helpers themselves, not by whoever is waiting
on the sign-in: `registerRemoteLoginRigCleanup` arms a rig-owned lifetime —
`LOGIN_RIG_OWNED_LIFETIME_MS` in `apps/mcp/src/pairing-ttl.ts`, the
pairing-token window plus a short grace, a constant rather than an
environment knob — when the rig is registered, so a connect that stops
polling, wedges, or loses the process that spawned it cannot leave the display
published past that bound. The
`isOwnedLoginRigXauthority` check keeps real user desktops out of scope —
this paragraph covers the broker's own rig only. This is a decision, not an
oversight: do not narrow it without the maintainer's word.

The exposure is warned about only where it is a real disclosure. The ceremony
prints the shared-browser warning only when the tab lands on a real
human-facing screen in the browser the person running connect is already using
— the same browser later Trusty Squire sessions keep opening tabs in, so agent
work then shares a browser with their own browsing. The headless noVNC
ceremony prints no warning at all: its tabs all belong to the same owner,
acting for the same account, on a link handed to themselves, so nothing is
disclosed. The noVNC banner still carries the URL and password.
`sharedBrowserDisclosureWarning` in `apps/mcp/src/bot/google-login.ts` is the
single place that decides it.

A deferred
`--force-relogin` cookie clear rides the same tab as ordinary logout navigation.

The ceremony's broker endpoint is derived from the profile the caller is about
to use, not from the launch-time default. `connect` resolves its target's
recorded profile and re-points `TRUSTY_SQUIRE_PROFILE_DIR` before any broker or
browser work, so every runtime resolution of "the profile" — the broker
endpoint, the election root, the profile lock — reads the environment live
(`currentProfileDir`). Resolving any of them from the frozen
`CHROME_PROFILE_DIR` addresses a different profile's broker and then collides
with the live broker that owns the real profile.

The Google OAuth hypothesis and live-validation evidence are owned by
[STATE.md](../STATE.md#connect-ceremony-on-the-shared-broker-browser--new-hypothesis-falsification-pending-2026-09-06-fmsquire-connect-browser-claim).
Do not infer live sign-in success from fixture acceptance.

There are no `hello`/`tool`/`cancel`/`resume` operations: a
session command is `command{sessionId,name,args}` (the only place a tool name
appears), and `close` either finishes a session (the `operate_finish` payload
rides the same request) or ends the connection. Cancelling one in-flight
command is the reserved `abort{requestId}` transport control frame, not an
operation: it aborts exactly that request and leaves the connection, its lease,
and its other sessions intact.

## Ownership and contracts

- A canonical-profile election lease prevents competing broker processes even
  when clients choose different socket paths or temporary directories. A
  separate physical-profile lease coordinates Chrome custody, including the
  ceremony browser's. The first account-acting open pins the account on disk;
  a ceremony open names none and touches no binding.
- Default discovery is probe then unlink then bind: a socket path with no live
  listener is a dead predecessor's orphan and is removed and rebound; that orphan
  path has no owner record and no process signaling. A same-contract broker that
  still answers keeps the endpoint. Neither path replays a mutation.
- After an upgrade, a client that finds a resident prior-contract broker reclaims
  the profile before launching a new-contract daemon. Positive identification is
  required before any signal: the resident must refuse this release's token-less
  `connect` with the legacy `unauthorized` refusal, still authenticate the
  pre-Contract-B `hello` handshake (sent only as this post-refusal probe, never
  a re-added wire operation, and only when the caller has an enrolled agent
  session token to authenticate it with), and hold this profile's election lease
  with a live, broker-argv-corroborated owner pid on this host. Reclaim is
  SIGTERM, then a bounded wait for both the election lease and the socket
  endpoint to clear, then SIGKILL; if reclaim cannot complete, the client fails
  with a `broker_unavailable` refusal naming the pid. A just-started
  same-contract lease holder that has not yet bound its socket is never a
  reclaim target, and a provably-reborn lease pid is left to the ordinary
  stale-owner scavenge. The same reclaim runs whenever a client
  connects-or-launches — the connect ceremony included.
- A resident from an earlier release that gated `connect` on a credential —
  every release before the token-less handshake, so this covers an immediate
  upgrade as well as a rotation that left a broker holding a stale digest — is a
  separate reclaim. Its refusal of the token-less handshake is the whole upgrade
  signal; positive identification is the same election-lease and
  broker-argv-corroborated owner pid on this host plus the profile's account
  binding naming the caller's own enrolled account. The refusal alone cannot
  tell an older release from another account's broker — one profile and one
  socket serve every account on the box — so a resident on a profile bound
  elsewhere, or carrying no readable binding, is never signalled and the
  `unauthorized` refusal propagates unchanged. Reclaim uses the same SIGTERM →
  bounded wait → SIGKILL mechanics, but only when the resident has no attached
  clients. A broker with an attached client is never killed; the client fails
  with one `broker_unavailable` refusal naming the pid and the manual TERM
  reclaim step. Reclaim timings are internal, never a tool parameter or config
  knob. `broker-prior-contract-reclaim.test.ts` pins both reclaim paths with
  real child processes, signals, lease files, and sockets.
- Each session owns a target family and a serialized command queue. A service
  URL does not reserve a site; one authenticated client drives the shared profile.
  Several connections to the same profile attach at once, one per client process,
  and each connection owns the sessions it opened. The opaque session id is the
  only capability: a connection presenting another connection's session id is
  refused with `stale_lease`, and a dropped connection's sessions close after a
  five-second grace. A reconnecting client starts fresh and does not adopt them.
- A start refused by a wall (`needs_user`, such as `google_session`) still reports
  a `session_id`, but that id was never owned by any connection. The client
  remembers it and answers locally without dispatching: a follow-up operate call
  replays the same wall, and `operate_finish` returns the closed,
  `mutation: "not_dispatched"` receipt and forgets the id. So `stale_lease` keeps
  one meaning — another connection owns a live session — and never stands in for
  a session that was never created. `broker-forwarder.test.ts` pins the replay.
- Browser egress is unrestricted for all targets. Session cleanup closes only that owned
  family. A close that cannot be proven leaves the broker alive holding physical
  custody. A failed close restores the prior closing state: it must neither latch
  a new refusal nor clear a pre-existing custody-unproven latch. The existing exact
  owner-process identity backstop remains the only physical-process custody.
- Per-session approval, charge dispatch fences, and post-submit outcome custody
  continue in the existing handlers. Approval notifications travel over the
  originating request's IPC connection to its MCP client before the tool completes;
  clients without notification support receive the approval link in the result.
  Observation output follows the [narrow released-card mask policy](observation-model.md#45-narrow-released-card-output-mask-final-owners-order-2026-09-12).
- A live socket is the connection lease: dropping it aborts that connection's
  in-flight starting sessions and queues no further work. There is no journal, no
  reconnect grace for sessions, and no `recover`/`reclaim`/`acknowledge` RPC. A
  lost connection surfaces `broker_lost` with an explicit do-not-replay warning;
  an in-flight request whose outcome is unknown is reported in that call's own
  error and blocks nothing later.
- Each connection retains a bounded in-memory map (the most recent 512 request
  ids) of request id to delivered result. A client that retries a request id it
  already sent on that connection receives the stored result instead of a
  re-execution, so a dispatched mutation is never replayed. Eviction past the
  bound drops only the oldest result and never refuses a call.
- A code-proven pre-dispatch stale-ref failure on a mutating command
  (`operate_login`, `operate_click` including its `js_click` fallback,
  `operate_type` including slot-based secret typing, and `operate_select`)
  is delivered as a retryable `stale_ref` not-dispatched failure: ref resolution
  precedes the dispatch boundary. Anything after the attempt stays unknown and
  is never replayed. `broker-operator.test.ts` and `broker-forwarder.test.ts`
  pin both paths.
- When the shared Chrome dies, the next `operate_start` proves the old process
  closed, releases the profile lease, and relaunches on the same persistent
  profile. Live sessions end with it; cookies and enrollment survive on disk.
- Idle shutdown requires zero connected clients, zero live sessions, zero
  in-flight admissions, and zero pending graceful session closes for the
  configured minutes-scale bound. Graceful Chrome closure precedes lease release.
  A connection that declared itself a `status` probe is not a connected client
  for this purpose — see [Busy façade](#busy-façade).

MCP server-instance records use the hash of
`TRUSTY_SQUIRE_SERVER_LINEAGE` (or the forwarder credential when present) to
scope predecessor cleanup to one launcher lane. During terminal shutdown the
record remains `draining` until cleanup completes or the configured
`TRUSTY_SQUIRE_SERVER_SHUTDOWN_DEADLINE_MS` expires (30 seconds by default).
Errors on the MCP server's stdout or stderr (including `EPIPE` after its caller
exits) trigger this same bounded shutdown as stdin EOF or transport closure.
An output error during startup is retained until the shutdown handler is ready.
It must not recurse through the uncaught-exception logger on broken stderr and
starve the idle timer. The Linux dead-caller regression in
`apps/mcp/src/__tests__/bin-smoke.test.ts` covers this process-exit boundary.

Implementation entry points: `src/bot/broker/daemon.ts`, `discovery.ts`,
`authority.ts`, `runtime.ts`, `operator.ts`, `forwarder.ts`, `protocol.ts`, and
`transport.ts` under `apps/mcp`.

## Busy façade

Browser availability depends on the profile election / SingletonLock lease
(`profile.ts`) and custody (`custody.ts`); live tab families (`runtime.ts`)
share the browser. Connect holds an ordinary tab family, not a maintenance
window. A second consumer imports one fold from
`@trusty-squire/mcp/browser` (`apps/mcp/src/browser-busy.ts`):

```ts
import { openTab, browserBusy, BrowserBusy } from "@trusty-squire/mcp/browser";
```

`openTab({ profile, purpose })` is a broker client: it connects over the local
socket exactly as the operator forwarder does, `open`s a session, navigates
through `command`, and `close`s on `release()`. It reaches the browser from any
process, holds no in-process lease of its own, and throws `BrowserBusy` with
`.action()` when a layer genuinely refuses.

**The façade invents no deadline of its own — every instruction is the
caller's to cancel.** The acquire and `tab.page.goto` each take an optional
`signal` and dispatch under a request id that Contract B's reserved `abort`
control frame can reach, so cancelling one cancels exactly that broker request
and leaves the connection, its lease, and its other sessions untouched.
Nothing here sleeps.

Each layer already owns its own budget and says so in its own code, and a
façade bound below one of those budgets is worse than none: it fails healthy
work and then invites a retry the layer is not ready for. The acquire is
bounded by the broker (connect, Chrome start, the first observation, up to
`BOT_START_TIMEOUT_MS`) which raises `launch_timeout` itself. A navigate gets
60 s per attempt over three attempts in `PageDriver.goto`; aborting it cancels
the broker request but does **not** stop the navigate already in flight, and
the cancelled call keeps the session lease until it returns — so a caller who
wants a bound should pass `AbortSignal.timeout(ms)` knowing that, rather than
receive one it never asked for.

**The broker answers the busy question from its custody and profile state.**
`status` is a read-only Contract B operation returning `StatusResult`;
`brokerBusyStatus` (`broker/status.ts`) uses custody's drain state, the profile
lock holder, and whether the Chrome holding that lock is the broker's own.
The daemon supplies `maintenanceOwned: false`; the retained `maintenance`
refusal code still describes an identity cell that is draining.
Live tab families are not an input: the broker multiplexes them on one shared
Chrome, so no number of them can produce a busy answer. `browserBusy()` is a
thin client of that call. A client cannot fold this from outside — a live
socket says nothing about whose Chrome holds the lease or whether custody is
draining, so a listener alone cannot establish availability.

The result carries the refusal `code` the same condition would produce on
`open`, and the client maps code to layer; the wire deliberately carries no
second copy of that mapping to drift from. Only when **no** broker is resident
does the client read the profile lock itself, because then there is nothing
brokered to hold it. A resident broker is always askable: the probe presents no
credential, so a machine that is still being enrolled gets the broker's own
answer instead of a refusal about the account it does not have yet.

A status connection sets `probe: true` on `connect` and is kept out of the
broker's idle accounting (`BrokerClientRegistry` in `daemon.ts`). Probing is a
read, and a consumer following the probe-before-act pattern on any cadence
under the idle bound would otherwise pin the shared Chrome resident forever.

The profile layer reaches the client under `profile_busy` in all of its senses.
`BrokerRuntime.acquire` converts the `ProfileBusyError` that Chrome's
SingletonLock and a launch collision raise, because the wire would otherwise
flatten a plain `Error` to `broker_execution_failed`. The profile-operation
lease — the one `connect` holds for a whole interactive login — is claimed in
daemon startup *before* the socket listens, so a held lease kills the daemon
rather than refusing a request; `connectOrLaunchBroker` therefore reads that
lease's owner when a spawned daemon dies before attachment and refuses
`profile_busy` naming the holder, instead of reporting a broker that merely
failed to start.

A start the broker hands back (no live provider session in the bot profile —
the likeliest first run) is not a busy layer either: `openTab` throws
`BrowserNeedsUser`, whose `.action()` names reconnect.

Two permanent configuration failures are deliberately **not** busy layers,
because no retry can clear either and a busy `.action()` would be a lie. Each
still gets its own typed façade error carrying the action that IS true, so the
per-layer wire vocabulary never reaches the consumer:

- The broker serves exactly one physical profile. Naming another gets
  `UnservableProfileError`, which names the profile this installation serves.
- A broker pointed at an external Chrome (`BOT_CDP_ENDPOINT` set) refuses with
  the wire code `external_browser`, which the façade raises as
  `ExternalBrowserError` naming that variable. This is deliberately a separate
  code from `incompatible_runtime` — that one means "finish the sessions
  pinning this browser identity, then retry", which is a genuine not-now.

`browserBusy()` is the read-only fold over that one served profile, and
read-only is load-bearing: it probes for a live broker listener and reads the
profile's SingletonLock holder. It never reclaims a lock, sweeps owner
processes, signals anything, or sleeps. A live broker owns the profile lease
and multiplexes tab families on one shared Chrome, so its own Chrome is
reported free rather than as a foreign process to close.

**Tab families are the layer that is never an answer.** A running session does
not make the browser unavailable — that is precisely the wrong-layer conclusion
this fold exists to prevent. `stale_lease` means "not yours, or gone": a
permanent failure a retry can never clear, so it stays unmapped beside
`cancelled` and `unauthorized`.

Wire codes stay unchanged — this is a mapping at the package boundary:

| Wire code              | Layer / reason |
| ---------------------- | -------------- |
| `profile_busy`         | profile        |
| `maintenance`          | maintenance    |
| `broker_unavailable`   | custody        |
| `incompatible_runtime` | custody        |
| `launch_timeout`       | custody        |

Other refusal codes are not "not now" and are not mapped onto a busy layer.
`external_browser` becomes `ExternalBrowserError`; the rest — `stale_lease`,
`cancelled`, `unauthorized` — propagate unchanged.

## Executed mechanical acceptance

Run the isolated Node/SDK harness from the worktree after building:

```bash
node --input-type=module <<'JS'
const { runFixtureAcceptance } = await import(process.cwd() + '/apps/mcp/scripts/broker-acceptance.mjs');
await runFixtureAcceptance(process.cwd(), true);
JS
```

The harness creates an isolated HOME, profile, caches, temporary directory, and
reaper inventory inside `.broker-acceptance/`. It starts a broker and three
separate OS client processes. Three loopback origins require persistent HTTP-only
authentication cookies and a successful provisioning POST. It asserts distinct
session and target IDs, overlapping activity, exactly one physical Chrome root,
sibling authentication after one client's SIGKILL, cookie persistence after
browser close/reopen, and process inventory returning to baseline. It does not
bypass Google in production: its explicit `startHarnessProvisionSession` fixture
arm does not exercise Google admission at all.

The process inventory reads actual NUL-delimited `/proc` argv and also recognizes
Chrome's rewritten single-entry process title. It matches whole profile arguments,
excludes `--type` children from the root count, and includes both profile-bearing
processes and processes with the fixture's inherited environment in teardown
inventory. Parser behavior is covered in the required test tier.

Evidence and limitations are recorded in [the evidence ledger](evidence/browser-broker/ledger.md).

## Optional real-service acceptance

Real Google-auth acceptance is optional validation, never a runtime or release gate.
The shared evidence contract, including fresh-credential negative controls and
native-transport distinctions, is in
[operator-acceptance-runbook.md](operator-acceptance-runbook.md). This section
adds the broker-specific setup; it does not make a fixture-only run a real
qualification.

No enrolled real test Google profile or three authorized service drivers were
provided for this worktree. Existing harness profiles contain fixture cookies;
they are not real Google identities. Do not clone a live operator profile or copy
its cookies into the harness.

1. Create a dedicated test HOME, config directory, and profile **inside this
   worktree**. Run the normal `connect` flow with those HOME, XDG_CONFIG_HOME,
   TRUSTY_SQUIRE_PROFILE_DIR, and pinned TRUSTY_SQUIRE_ACCOUNT_ID values. A human
   must complete the account/passkey and real Google sign-in. Finish and close
   the ceremony browser before running the acceptance arm.
2. Supply three sessions across Resend and Neon: one of each runs concurrently
   with a duplicate provider. Reusing a provider, URL, account, and driver is
   expected; Xata is not a required live resource. Each driver exports
   `captureCredentialBaseline({ call, sessionId, initial, run })` and
   `provision({ call, sessionId, initial, run })`, using only MCP tool calls.
   The baseline returns `account_id`, `provider_credential_ids`, and an
   `initial_auth_state` of `authenticated`, `unauthenticated`, or `unknown`.
   `provision` returns only the run-bound provider credential identity and exact
   vault reference; it does not choose the probe or perform cleanup. For a
   `revoke` manifest, the driver additionally exports
   `revokeCredential({ call, sessionId, initial, run, providerCredential })`.
   The harness selects the reviewed provider GET, probes the old valid control,
   creates and probes the fresh exact vault reference, and only then invokes
   optional revocation. The checked-in
   `apps/mcp/scripts/bounded-credential-driver.mjs` is the supported reusable
   driver for all three sessions, so no per-session JavaScript module is needed.
   Specify evidence for the intended account, provider-side creation, and the
   exact vault identity. A dashboard title or an old valid credential is
   insufficient. Choose flows without unapproved purchases or destructive
   account changes.

   Credential creation follows the core
   [capture and extraction-only recovery contract](operator-tool-surface.md#credential-capture-and-retrieval).
   The final `operate_finish` result is validated against core's lifecycle-owned
   additive receipt; the acceptance harness does not persist separate closure
   truth.
   Its `driverEvidence.baseline` and `driverEvidence.provision` stages contain
   at most 12 ordered MCP calls. Allowed calls are `operate_navigate`,
   `operate_observe`, `operate_click`, `operate_type`, `operate_select`, and
   `operate_extract`; every call has an `id`, `tool`, and `arguments`, and may
   have `require_pattern` and `timeout_ms`. `$RUN_LABEL` and `$SESSION_ID` are
   substituted in arguments. Use `format:"full"` for provider-rendered evidence
   read from `dom`; control queries intentionally omit non-control page text. A capture step may set `continue_on_error: true`
   to retain core's metadata-only error result. A following `operate_extract`
   recovery step uses `{ "$from": { "step": "capture-step", "path":
   "write_id" } }` in its arguments and may be gated with `{ "when": {
   "step": "capture-step", "path": "storage", "equals": "unknown"
   } }`. This is extraction/storage recovery only; the scaffold never loops or
   repeats a mutation step. Evidence fields are either `{ "literal": ... }`
   or `{ "step": "step-id", "path": "result.path" }`; string evidence may
   additionally use a named `(?<value>...)` `pattern` (`as: "timestamp"`
   converts an observed ISO time).

   Before filling a live manifest, observe and record these facts from each
   provider page: the authenticated account identifier; the complete pre-run
   credential IDs including the old-control ID; the unique create-key control,
   name field, and final create control refs; the result path containing core's
   captured vault reference; and provider-rendered new key ID, exact run label,
   account ID, and creation timestamp. If any fact is absent or ambiguous, stop:
   a guessed selector, harness timestamp, or old key is not qualifying evidence.
   For `revoke`, add a bounded stage whose first calls re-observe the exact new
   provider ID, revokes that ID, and reads the resulting confirmation. Set
   `driverEvidence.revoke.evidence.provider_credential_id` and `.status` to
   observed step/path evidence (not literals); status must resolve to `revoked`
   and the ID must equal the supplied fresh credential. `$CREDENTIAL_ID` binds
   that credential in revoke-stage arguments and patterns. The driver returns
   the bound cleanup receipt only after confirmation; it runs after the probe.
   `apps/mcp/scripts/bounded-driver-evidence.example.json` is the copyable,
   executable schema; replace its `observed-*` refs and evidence patterns only
   after those values have been read from the live page. Use unique stable
   `@label` aliases for a reusable driver; `@e:` IDs belong to one session and
   must never be copied from a preparatory session into a fresh harness session.
   Alternatively, add a current-session query step and bind its returned ref
   through `$from`; verify uniqueness before authorizing the mutation.
   The manifest may inline that object as `driverEvidence` or point
   `driverEvidenceFile` at a per-session JSON copy beside the manifest, as the
   manifest example does.

3. Copy `apps/mcp/scripts/broker-live-acceptance.example.json` to an ignored
   worktree-local file. Fill in the exact release/native command, isolated
   profile and config paths, expected provider account identities, DOM evidence,
   and old valid provider/vault controls. An old credential proves the negative
   control works but cannot satisfy the fresh result.

   Add the `driverEvidence` object described above to each service. Provider probes are reviewed in
   `apps/mcp/scripts/fresh-credential-policy.mjs`; drivers cannot substitute an
   arbitrary request or self-assert harmlessness. The current probes are Resend
   `GET /domains` and Neon `GET /api/v2/projects`. The final manifest and probe
   catalog accept only these two providers.

   Installed-command initialization is only a packaging/stdio diagnostic. It
   does not prove that the configured native host selected or connected to that
   command. From the actual configured native host connection, record the
   initialize server version, host connection/session ID, a tools/list result
   containing `operate_start`, and one completed read-only `list_credentials`
   call in the shape shown by
   `apps/mcp/scripts/configured-native-evidence.example.json`. Save it beside
   the ignored manifest and set `configuredNativeEvidence` to its relative
   path. The combined harness rejects installed-command evidence in this slot.
4. Build and run the hermetic qualification tests before live acceptance:

```bash
pnpm --filter @trusty-squire/mcp build
pnpm --filter @trusty-squire/mcp exec vitest run \
  scripts/fresh-credential-policy.test.mjs \
  scripts/native-launch-diagnostics.test.mjs \
  scripts/bounded-credential-driver.test.mjs \
  scripts/broker-live-acceptance.test.mjs \
  src/__tests__/install-targets-e2e.test.ts \
  src/bot/__tests__/broker-stdio-restart.test.ts
```

5. Firstmate runs the SDK concurrency arm directly in Node, after recording
   actual configured-host evidence through that host's native MCP tools. This
   command may use the enrolled isolated profile and perform the manifest's
   authorized fresh provider mutations; it is not a native-host invocation.

```bash
node --input-type=module <<'JS'
import { runNativeAndConcurrencyAcceptance } from './apps/mcp/scripts/broker-live-acceptance.mjs';
console.log(await runNativeAndConcurrencyAcceptance('./.broker-acceptance/manifest.json'));
JS
```

`chrome-devtools-axi run` executes scripts against its browser `page` object;
it is not a Node module runner for the SDK harness. Obtain configured native MCP
proof from the actual host connection. Use `operate_screenshot` on the relevant
Squire session to record visual transitions. Preserve missing provider account,
key ID, creation-time, and native-host evidence as missing; do not fill templates
with inferred success.

The installed-command arm performs only MCP initialization and records the
selected command, expected and initialized versions, connection epoch, bounded
exit, and sanitized stderr classification. It must report `ready`. The separate
configured-host evidence must also validate; neither installed-command nor SDK
concurrency substitutes for the actual configured native host connection.

The concurrency arm launches three independent MCP stdio servers against one
production broker and one enrolled profile. All three sessions run concurrently
with distinct mutable page ownership.
The harness requires actual Google admission, validates old and new keys
with provider-specific read-only probes, checks overlap/isolation, and records
every closure receipt. Preserve its evidence file and run the broader reviewed
auth matrix. A fully successful run writes an inert profile-local evidence record
bound to that account and the three tested service hosts. The record is evidence
of that run only; it neither enables concurrency nor substitutes for the reviewed
real-auth matrix. A failed or interrupted run removes its in-progress record;
never create or copy this record manually.
