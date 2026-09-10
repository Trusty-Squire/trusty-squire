# Cross-process identity browser broker

This increment moves physical Chrome custody into a separate broker process.
Independent MCP servers retain opaque session capabilities and forward operator
commands over authenticated local IPC. The broker owns one profile, one Chrome,
and the existing operator handlers and payment state. The old
`TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION` switch is not used by this path.

The migration follows the engineering-reviewed identity-broker design in
`/home/lunchbox/firstmate/data/ts-browser-architecture-audit/report.md` §§4–6 and
its greenlight decision. Shared broker concurrency is enabled whenever a socket
is configured. Mechanical fixture success is not Google-auth qualification;
real enrolled-Google qualification remains a human-gated test run.

## Configuration and operation

Build with `pnpm --filter @trusty-squire/mcp build`. Setting a broker socket
enables shared admission for participating MCP processes. Set the same
`TRUSTY_SQUIRE_BROKER_SOCKET`, `TRUSTY_SQUIRE_PROFILE_DIR`, and pinned
`TRUSTY_SQUIRE_ACCOUNT_ID` in each participating MCP process. Each MCP client
lineage must also receive its own stable, random base64url
`TRUSTY_SQUIRE_FORWARDER_CREDENTIAL` (at least 32 random bytes), retained only
for that client's restart recovery and never shared with sibling clients. The
socket parent must already exist, belong to the current user, and have mode 0700.
Set `TRUSTY_SQUIRE_BROKER_SUPERVISED=1` for the durable service owner. In that
mode a missing broker is an error instead of permission for an MCP front end to
spawn a competitor, and zero clients never releases the profile lease. Without
supervision, `TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS` defaults to five minutes and
is clamped to a minimum of one minute.
The account must already be enrolled through `connect`; authentication reads its
existing agent session token from session storage, never command-line token
arguments. `connect` maintenance does not require an MCP lineage credential:
after validating that enrolled token, it creates a one-use local identity solely
to drain and resume maintenance. That identity cannot recover or reclaim MCP
sessions.

An unsupervised first client may start `node apps/mcp/dist/bin.js broker` if
necessary. A supervised broker must already be running as a foreground service.
Socket mode is 0600. No CDP endpoint or browser
handle crosses IPC. `TRUSTY_SQUIRE_AGENT_IDENTITY` supplies a connection's agent
label. The lineage credential proves reconnect ownership independently of that
label; a caller with only a session ID, agent label, or credential hash cannot
reclaim another client's capability. The broker admits at most three concurrent
sessions.

`connect` requests maintenance over the existing socket, prevents new admissions,
and waits for existing sessions and payment outcomes to drain. It closes Chrome
with proof, then runs the existing separate plain Google login lifecycle with no
CDP. Resume requires that plain browser to be closed and preserves account
binding. Browser epoch changes invalidate earlier capabilities.

## Ownership and recovery contracts

- A canonical-profile election lease prevents competing broker processes even
  when clients choose different socket paths or temporary directories. It stays
  held through maintenance. A separate physical-profile lease coordinates Chrome
  and the existing plain-login path. Profile enrollment pins the account on disk.
- Each session owns a target family, capability generation, serialized command
  queue, and site reservations. Public browser authority is exact-host and is
  declared at session start; recipe-resolved startup hosts reserve before page
  acquisition. Registrable-domain logic may validate recipe ownership, but it
  does not turn a sibling host into session authority. Additional or conflicting
  scope is refused rather than adopted implicitly.
- A context-level route selects the owning page's host policy. Unknown targets
  cannot issue background API traffic. Session cleanup closes only that owned
  family. At reconnect-grace expiry, a close that cannot be proven removes the
  actor from broker inventory and releases its slot rather than retaining or
  reusing it; the existing exact owner-process identity backstop remains the
  only physical-process custody.
- OAuth and live identity probes share a broker-wide lane. Clipboard-sensitive
  extract, credential fill, and payment commands use an interactive lane.
  Per-session approval, charge dispatch fences, and post-submit outcome custody
  continue in the existing handlers. Rendered observations are not masked.
- Live sockets are mutation leases, not browser-custody leases. Disconnect
  immediately fences queued commands and aborts the old connection lease, but
  retains that lineage's actors for a five-minute authenticated reconnect grace.
  Explicit client release or grace expiry closes only that client's sessions.
  An expiry close that remains unproven is never reclaimable or capacity-bearing;
  pending payment outcomes remain no-replay journal fences. The existing process
  marker watchdog and owner-death reaper remain unchanged.
- A bounded physical launch uses the existing cancellation/ownership machinery.
  A failed admission has bounded cleanup. Once its reconnect grace expires, its
  scheduler capacity is permanently released; a late port is never admitted or
  given a capability. Duplicate release calls share one operation.
- The profile-local dispatch journal fsyncs mutation entry and completion without
  recording command arguments or credentials. A lost mutation response is never
  replayed. Unsettled or malformed journal state refuses browser replacement and
  requires reconciliation against actual outcomes; there is no automatic
  erase-and-retry recovery for uncertain payments. Reconciliation keeps a
  confirmed payment submission as `done`, distinct from 3-D Secure-required and
  unknown outcomes.
- After a restarted MCP process loses an operator reply, its retry must set MCP
  request metadata `"trusty-squire/recover": true`. This explicitly asks the
  broker to reconcile its authenticated lineage's newest matching durable
  operation, input, and capability outcome; the retry may use a new JSON-RPC
  request ID. Ordinary reset IDs without that metadata are fresh calls. A
  recovered start returns its existing session capability without retaining page
  observations while its broker remains alive. Broker receipt alone does not
  prove stdio delivery: an acknowledged start remains same-lineage recoverable
  until a later capability-bearing command confirms caller control, for up to
  five minutes. After broker loss, that same recovery returns only the durable,
  scrubbed reconciliation record with `recovery.session_unavailable`; it never
  invents a capability, restarts work, or replays an uncertain payment. The
  record gives the caller a reconciliation next step and remains a no-replay
  fence until that retention window expires.
- A code-proven `operate_login` stale-ref failure is recorded as
  `status: not_dispatched, error: stale_ref`: stale-ref resolution precedes the
  sole OAuth dispatch boundary. Older retained `entered` records may be
  reconciled only from independently preserved exact failure evidence by using
  object metadata instead of the ordinary boolean:
  `"trusty-squire/recover": {"request_id":"...","error":"stale_ref","dispatch":"not_dispatched"}`.
  The broker accepts only the server-authorized retained Xata session/request
  tuple and reconciliation-only argument locator, from its original
  authenticated forwarder lineage. Before serving recovery, broker startup
  snapshots the complete matching `entered` record as the one-record
  authorization, including its stored forwarder and input hash. Settlement
  requires that same complete record identity and preserves its input hash
  verbatim; the caller's replacement arguments and error label are not
  evidence. The broker fsyncs a `settled` lineage-preserving record and returns
  the same result on an exact repeat without replaying the tool. Other records,
  exceptions, operations, lineages, arguments, and ambiguous post-dispatch
  failures stay fenced. A broker with retained startup custody serves this
  recovery endpoint without launching a browser; all ordinary work remains
  fenced until recovery. After settlement, broker restart snapshots that same
  exact settled identity; repeating the command returns the recorded
  reconciliation without appending to or changing the journal.

  For the retained Xata record from the 2026-09-08 concurrency acceptance, do
  not edit the canonical journal. After this change is merged and the MCP binary
  running the broker contains it, with no canonical-profile Chrome/broker alive
  and the journal still containing exactly that `entered` record with its
  original forwarder and input hash, start the broker once so it snapshots that
  identity, then issue exactly from the original forwarder lineage:

  ```js
  client.callTool({
    name: "operate_login",
    arguments: {
      session_id: "546b6f5a-930e-4473-8aec-43fc355fd108",
      provider: "google",
      ref: "reconciliation-only:no-dispatch",
    },
    _meta: {
      "trusty-squire/recover": {
        request_id:
          "4ae34aeb-e1b8-4457-a99b-72ac418600ca:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
        error: "stale_ref",
        dispatch: "not_dispatched",
      },
    },
  });
  ```

  The required response is a reconciliation with `status: not_dispatched` and
  `error: stale_ref`. Before starting another canonical browser, independently
  run the journal checker and require `DispatchJournal.assertReconciled()` to
  return normally. These preconditions rely on the acceptance report's retained
  tool output as the failure evidence; without it, leave the record fenced.
- Unsupervised idle shutdown requires zero connected clients and zero active,
  admitting, or quarantined sessions for the configured minutes-scale bound.
  Supervised brokers stop only on their supervisor signal or an explicit drain.
  Graceful Chrome closure precedes lease release. Socket recovery requires
  process birth, endpoint inode, and old-profile-free evidence.

MCP server-instance records use the hash of
`TRUSTY_SQUIRE_SERVER_LINEAGE` (or the forwarder credential when present) to
scope predecessor cleanup to one launcher lane. During terminal shutdown the
record remains `draining` until cleanup completes or the configured
`TRUSTY_SQUIRE_SERVER_SHUTDOWN_DEADLINE_MS` expires (30 seconds by default).

Implementation entry points: `src/bot/broker/daemon.ts`, `discovery.ts`,
`authority.ts`, `runtime.ts`, `operator.ts`, and `transport.ts` under `apps/mcp`.

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

## Human setup for real-service qualification

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
2. Supply exactly three overlapping sessions across Resend and Neon, with both
   providers represented. Reusing a provider, URL, account, and driver is
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

   Credential creation uses core's existing mutation capture grammar:
   `capture: {store, source: {role, name?, container?}, write_id?}`. If the
   initial capture returns a `write_id` with an uncertain storage result, the
   driver may pass that identity only to `operate_extract` for extraction/storage
   recovery. It must never replay the click/type/select/press or recipe mutation.
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
   provider ID and whose final call revokes that ID; it runs only after the new
   credential probe succeeds.
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
   `GET /domains` and Neon `GET /api/v2/projects`. The policy library retains
   an optional Xata probe, but the final manifest neither needs nor accepts a
   Xata session.

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

The concurrency arm launches three independent MCP stdio servers and the
production broker, requires actual Google admission, validates old and new keys
with provider-specific read-only probes, checks overlap/isolation, and records
every closure receipt. Preserve its evidence file and run the broader reviewed
auth matrix. A fully successful run writes an inert profile-local evidence record
bound to that account and the three tested service hosts. The record is evidence
of that run only; it neither enables concurrency nor substitutes for the reviewed
real-auth matrix. A failed or interrupted run removes its in-progress record;
never create or copy this record manually.
