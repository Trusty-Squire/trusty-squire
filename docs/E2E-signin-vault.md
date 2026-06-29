# E2E — Sign-in + Vault Credentials (user-owned signups)

Comprehensive end-to-end test for the whole feature (PR1–PR3). Run from your MCP
host (the agent driving `operate_*`) against the built server.

**Build first:** `cd ~/ts-trees/signin-vault-plan && pnpm -F @trusty-squire/mcp build`

Pick a real service that signs up by **email + password** and **emails a
verification code** (not OAuth-only).

---

## Phase 0 — PR1: the autonomous replay engine is gone
- `npx @trusty-squire/mcp skill --help` → there is **no `replay-test`** subcommand.
- The MCP tool list exposes **no** `provision` / `check_provision_status` (only
  `operate_*` + vault tools). 18 tools total.
- **Pass:** skills are operator *hints*, never autonomously executed.

## Phase 1 — PR3-identity: connect captures your Google email
1. `npx @trusty-squire/mcp connect` and sign into Google in the browser.
2. **Pass:** `~/.trusty-squire/<profile>/provider-emails.json` exists and contains
   `{"google":"<your-actual-gmail>"}`. (This is the capture-at-login step.)

## Phase 2 — operate_start surfaces your email
1. `operate_start { service_url: "<service signup URL>" }`.
2. **Pass:** the start observation includes `user_email: "<your gmail>"` — the
   address the host will fill (not a `@trustysquire.com` alias).

## Phase 3 — PR3c: user-owned signup with sealed credentials
1. `operate_prepare_login { session_id }`.
   - **Pass:** returns `slots.login` + `slots.password` as **masked handles**;
     `email_preview` does **not** contain your raw address. (No alias anywhere.)
2. Fill the form: `operate_act { type_secret, slot:"login", target:"<email field>" }`
   then `operate_act { type_secret, slot:"password", target:"<password field>" }`.
   - **Pass:** the real email + password reach the page; neither appears in any
     tool response or the audit log.
3. Submit the signup.

## Phase 4 — PR2 + PR3b: consent gate + JIT grant at the verification wall
1. With inbox consent **OFF** (default): `operate_await_verification { session_id }`.
   - **Pass:** returns `needs_user(verification_code)` with a "not consented"
     message; the browser does **NOT** navigate to `mail.google.com` (check the
     audit log for `await_verification refused:no_inbox_consent`).
2. Relay the consent question to yourself → on yes:
   `operate_await_verification { session_id, grant_inbox_consent: true }`.
   - **Pass:** now it reads your inbox and returns the code (or seals it with
     `into_slot`). A subsequent `operate_await_verification {}` (no flag) still
     reads — consent is remembered for the session.
3. Enter the code; finish the signup.

## Phase 5 — PR3c: vault the login credentials
1. `operate_store_login { session_id, service: "<service>", login_hosts: ["login.example.com"] }`.
   - **Pass:** returns a vault `reference`, `type: "username_password"`,
     `field_names: ["login","password"]`; **no raw password** in the response.
2. `list_credentials` → the service appears as a `username_password` credential.
3. **Pass:** you can later sign into the service yourself with your email + the
   vaulted password (the account is genuinely yours).

## Phase 6 — PR3a + PR3d: privacy — your email never lands in a shared artifact
1. `operate_remember { name, goal, postcondition }` to persist the operator recipe.
2. Inspect the saved recipe file.
   - **Pass:** it contains the slot token `${EMAIL_ALIAS}` where your email was
     typed, and **nowhere** contains your literal address — not in a `value`, not
     in any `text_match`.

## Headless variant (autonomous, no human)
- Repeat Phases 3–4 with no human present and consent OFF.
  - **Pass:** Phase 4 step 1 returns the `needs_user` pause and the run **does not
    silently fall back to an alias** and does **not** read your inbox. It waits
    for a grant. (User-owned-or-nothing; no Squire-address accounts.)

## Automated regression (already green — run anytime)
```bash
cd ~/ts-trees/signin-vault-plan
pnpm -F @trusty-squire/mcp typecheck
pnpm -F @trusty-squire/mcp test     # 820 passing
```
Covers: consent gate + JIT grant, capture parser + marker, generatePassword
policy, prepare_login/store_login (username_password, no raw values),
trace email redaction (heuristic + exact known-email scrub).
