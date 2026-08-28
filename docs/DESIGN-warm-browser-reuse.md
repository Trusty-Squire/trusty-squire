# DESIGN — operator profile lifecycle

`operate_start` creates a unique `0700` Chrome profile in the system temporary
directory. The profile belongs to exactly one session and one browser; repeated
observe/act calls address that same browser until `operate_finish`.

The canonical `CHROME_PROFILE_DIR` remains the interactive `connect`/`login`
authoring profile. Operator browsers never open it. A successful context-backed
interactive login captures Playwright `storageState({ indexedDB: true })` and
writes `<CHROME_PROFILE_DIR>/trusty-squire-session-state.json` atomically with
mode `0600`. Each fresh operator browser restores that snapshot before its first
target navigation. This persists all cookies, local storage, and IndexedDB;
there is no Chrome-cookie SQLite copy, profile pool, seed lock, lease, slot,
broker, daemon, or feature flag.

The existing live-provider detector remains the guardrail for restored state.
`require_live_identity` evaluates it against the fresh seeded browser and fails
closed with a context-backed login handoff if the session is stale. It never
falls back to running an operator browser on the canonical profile.

`operate_finish` retains session call-drain, audit, and payment ordering. An
explicit successful outcome captures storage state, then uses the rc.9 bounded
terminal owner to prove the identity-scoped Chrome close. Only after that proof
does it asynchronously write the snapshot back, checking terminal ownership
immediately before the atomic rename (last completed writer wins), and
asynchronously remove the unique directory. No-outcome and failed finishes
preserve the prior snapshot. A session with active payment state, sealed payment
fields, or pending 3DS skips write-back and is destroyed after a proven close.
If close cannot be proven, the unique directory and prior canonical snapshot
are retained; the directory cannot block another agent.

Card sealing, one-human approval per purchase, host-scoped egress, 3DS,
payment-audit ordering, vault restrictions, session addressing, the rc.9
watchdog, and `TRUSTY_SQUIRE_PROFILE_DIR` isolation are unchanged.
