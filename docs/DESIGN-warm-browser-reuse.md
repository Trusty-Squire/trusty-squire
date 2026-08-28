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
closed with the existing connect handoff if the session is stale. It never
falls back to running an operator browser on the canonical profile.

`operate_finish` retains session call-drain, audit, and payment ordering. A
clean finish captures storage state, atomically writes it back (last completed
writer wins), uses the bounded identity-proven Chrome close, then removes the
unique directory. A session with active payment state or sealed payment fields
skips write-back and is destroyed after a proven close. If close cannot be
proven, only that unique directory is retained for inspection; it cannot block
another agent.

Card sealing, one-human approval per purchase, host-scoped egress, 3DS,
payment-audit ordering, vault restrictions, session addressing, the rc.9
watchdog, and `TRUSTY_SQUIRE_PROFILE_DIR` isolation are unchanged.
