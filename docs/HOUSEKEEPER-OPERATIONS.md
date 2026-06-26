# Housekeeper operations runbook

The housekeeper is now a **codex-driven registry verify pass** — the standalone
`@trusty-squire/housekeeper` package (`ts-housekeeper`). Its only job is keeping
the registry honest: promote skills that still work, demote ones that don't.
Design: `docs/DESIGN-housekeeper-codex-verify.md`. Install/timer:
`tools/systemd/README.md`.

> History: the pre-2026-06 housekeeper was a much larger in-mcp system (discover
> + fix-agent + a robot identity fleet + a residential-proxy egress model + a
> Gemini planner). All of that was deleted in the codex-verify refactor. If you
> are looking for the old egress / robot-pool / discover runbook, it is in git
> history, not here — it describes machinery that no longer exists.

## Mental model (read first)

- **One mode: verify.** Each pass pulls the registry's verifier queue and, per
  skill, runs `codex exec` with the `@trusty-squire/mcp@next` MCP. Codex
  reproduces the signup via the `provision_*` tools; the housekeeper relays the
  boolean outcome to the registry.
- **Promote/demote is mechanical, in the registry.** One success promotes
  pending-review → active (`VERIFIER_PROMOTION_THRESHOLD = 1`). The 3rd
  consecutive *rot* failure demotes (`VERIFIER_FAILURE_THRESHOLD = 3`). A wall
  quarantines on the first hit. **Codex makes no promote/demote decision** — it
  only signs up and reports.
- **Verify runs as the operator.** Codex+MCP use the operator's own
  connect-identity Google session (no robot fleet). A pass therefore needs that
  session live in the bot Chrome profile.
- **Fail-closed by design.** A dead operator session, a network blip, or a codex
  infra error is a *transient* outcome — the housekeeper does NOT post it, so it
  can never advance the demote counter. The worst a broken box does is verify
  nothing; it can never demote good skills.

## Run a pass

```bash
set -a; . ~/.config/trusty-squire/harvester.env; set +a   # REGISTRY_ADMIN_BEARER, registry URL
node apps/housekeeper/dist/bin.js --check                 # preflight: codex on PATH + bearer set
node apps/housekeeper/dist/bin.js --once --dry            # a full pass that posts NOTHING
node apps/housekeeper/dist/bin.js --once                  # the real pass (posts outcomes)
```

The systemd timer fires `--once` daily (`tools/systemd/`). Inspect registry
state with the admin bearer: `GET /admin/verifier/queue`, `GET /admin/needs-human`,
`GET /skills`.

## Failure taxonomy

Canonical: `apps/housekeeper/src/classify.ts` (mirrors the registry's
`failure-taxonomy.ts`). Only **rot** advances the 3-strike demote counter; the
housekeeper never even posts a transient/wall outcome that shouldn't count.

| failure_kind | class | means | effect |
|---|---|---|---|
| `login_wall` | transient | operator session dead / anti-bot interstitial | none — not posted; refresh the operator Google session |
| `nav_timeout` / `account_exists` / `brittle_probe` / `captcha_blocked` | transient | network blip, returning-user, flaky probe, uncleared captcha | none — not posted |
| `no_credentials` / `step_failed` / `other` | rot | codex reached the end with no key, or a step failed reproducibly | counts toward the 3-strike demote |
| (codex couldn't run) | infra | codex crashed / emitted no `RESULT` line | none — skipped, not posted |

## Diagnosing a pass that promotes nothing

1. **`--check` first.** Confirms codex is on PATH and the bearer is set. Most
   "nothing happened" runs are a missing codex CLI or an unset bearer.
2. **Is the operator Google session live?** If every skill comes back
   `login_wall`, the session is dead — codex+MCP can't act as you. Refresh it
   (the connect ceremony / `mcp connect`). **Do NOT `--force-relogin`
   reflexively** — a fresh automation session with no remembered consents is
   *more* likely to bounce on Google's "verify it's you". Restore the working
   session rather than wiping it.
3. **Read the digest line.** `attempted/succeeded/promoted/demoted/transient/
   infra/no_url` tells you which bucket dominated. High `transient` = session/
   infra; high `infra` = codex itself; high `no_url` = skills missing a
   signup_url.
4. **Only then look at code** (`apps/housekeeper/src/{scheduler,codex-runner,
   classify}.ts`), or the MCP's `provision_*` tools if codex reports the signup
   itself failing.
