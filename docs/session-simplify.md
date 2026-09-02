# Real-profile operator sessions

Operate uses the user's real `CHROME_PROFILE_DIR` directly. A single
liveness-based profile lease covers the entire operate session: dead holders are
reaped; live or indeterminate holders return `PROFILE_BUSY_MESSAGE`.

There is no portable identity state, snapshot metadata, seed, clone, profile
pool, cookie reinjection, or OAuth browser replacement. Google admission reads
`detectSessionProviders()` from the opened live browser context and passes that
result to `googleSessionGate`.

Interactive login/forced relogin also uses the real profile. The plain browser's
completion is the install claim and explicit Finish callback, so identity flow
never reads Chrome's on-disk cookie database.

The serialized OAuth boundary, compact-observation-v2 serializer, vault
extraction, credential-egress host seeding, and host-scope guards remain.
