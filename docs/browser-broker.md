# Cross-process identity browser broker

The broker is the sole production path for MCP operator Chrome custody.
Independent MCP servers retain their session IDs and forward commands
over authenticated local IPC. One broker owns one canonical profile, one Chrome,
and the existing operator handlers and payment state. There is no direct-server
browser launch or fallback.

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
The account must already be enrolled through `connect`; authentication reads its
existing agent session token from session storage, never command-line token
arguments. `connect` maintenance authenticates with that same enrolled token and
does not hold a separate identity.

The first client starts `node apps/mcp/dist/bin.js broker` when necessary.
Socket mode is 0600. No CDP endpoint or browser
handle crosses IPC. `TRUSTY_SQUIRE_AGENT_IDENTITY` supplies a connection's agent
label, which carries no authority.

The client wire is the frozen Contract B — `connect`, `open`, `command`,
`close` (`apps/mcp/src/bot/broker/protocol.ts`). A connect carries the
connect-only `maintain` intent. The broker closes the shared Chrome once no
session admits or owns it and answers `maintenance: "draining"` while live
sessions remain. The client then runs the existing separate plain Google login
lifecycle with no CDP, and `close{}` (the lease boundary, formerly
`client_close`) resumes the broker on the same account when the connection ends.
Resume requires that plain browser to be closed and preserves account binding.
There are no `hello`/`tool`/`cancel`/`maintenance`/`resume` operations: a
session command is `command{sessionId,name,args}` (the only place a tool name
appears), and `close` either finishes a session (the `operate_finish` payload
rides the same request) or ends the connection. Cancelling one in-flight
command is the reserved `abort{requestId}` transport control frame, not an
operation: it aborts exactly that request and leaves the connection, its lease,
and its other sessions intact.

## Ownership and contracts

- A canonical-profile election lease prevents competing broker processes even
  when clients choose different socket paths or temporary directories. It stays
  held through maintenance. A separate physical-profile lease coordinates Chrome
  and the existing plain-login path. Profile enrollment pins the account on disk.
- Default discovery is probe then unlink then bind: a socket path with no live
  listener is a dead predecessor's orphan and is removed and rebound; that orphan
  path has no owner record and no process signaling. A same-contract broker that
  still answers keeps the endpoint. Neither path replays a mutation.
- After an upgrade, a client that finds a resident prior-contract broker reclaims
  the profile before launching a new-contract daemon. Positive identification is
  required before any signal: the resident must refuse Contract B's `connect`
  with the legacy `unauthorized` refusal, still authenticate the pre-Contract-B
  `hello` handshake (sent only as this post-refusal probe, never a re-added wire
  operation), and hold this profile's election lease with a live,
  broker-argv-corroborated owner pid on this host. Reclaim is SIGTERM, then a
  bounded wait for both the election lease and the socket endpoint to clear,
  then SIGKILL; if reclaim cannot complete, the client fails with a
  `broker_unavailable` refusal naming the pid. A just-started same-contract
  lease holder that has not yet bound its socket is never a reclaim target, and
  a provably-reborn lease pid is left to the ordinary stale-owner scavenge.
  The same reclaim runs on the maintenance path before the bare-operation
  fallback.
- A same-contract resident whose credential digest no longer matches the current
  agent session token (re-enrollment, a driver/server restart, or a maintenance
  release that could not refresh) is a separate reclaim. Positive identification
  is the current-contract `connect` handshake succeeding as a protocol exchange
  and rejecting the credential (`unauthorized: Invalid broker credential`), plus
  the same election-lease and broker-argv owner pid on this host. A rejected
  credential alone cannot tell a rotated token from another account's broker —
  one profile and one socket serve every account on the box — so the profile's
  account binding must name the caller's own enrolled account; a resident on a
  profile bound elsewhere, or carrying no readable binding, is never signalled
  and the `unauthorized` refusal propagates unchanged. Reclaim uses
  the same SIGTERM → bounded wait → SIGKILL mechanics, but only when the
  resident has no attached clients. A broker with an attached client is never
  killed; the client fails with one `broker_unavailable` refusal naming the pid
  and the manual TERM reclaim step. After maintenance, a credential refresh that
  cannot complete terminates the drained broker rather than leaving it on the
  old digest. Reclaim timings are internal, never a tool parameter or config
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
  custody; it never refuses a later command or start. The existing exact
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

MCP server-instance records use the hash of
`TRUSTY_SQUIRE_SERVER_LINEAGE` (or the forwarder credential when present) to
scope predecessor cleanup to one launcher lane. During terminal shutdown the
record remains `draining` until cleanup completes or the configured
`TRUSTY_SQUIRE_SERVER_SHUTDOWN_DEADLINE_MS` expires (30 seconds by default).

Implementation entry points: `src/bot/broker/daemon.ts`, `discovery.ts`,
`authority.ts`, `runtime.ts`, `operator.ts`, `forwarder.ts`, `protocol.ts`, and
`transport.ts` under `apps/mcp`.


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
   the plain login browser before running the acceptance arm.
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
