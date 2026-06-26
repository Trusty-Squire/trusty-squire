# Registry verify pass — systemd user timer

Runs the standalone **`@trusty-squire/housekeeper`** package (`ts-housekeeper`)
**daily** on the operator's box. Each fire does ONE verify pass:

1. Pull the verifier queue from the registry (pending-review = promote
   candidates, freshness-due active = demote candidates).
2. For each skill, ask **codex** (holding the `@trusty-squire/mcp@next` MCP) to
   reproduce the signup via the `provision_*` tools and report a boolean outcome.
3. Relay the outcome to the registry, which applies the **mechanical rule**:
   - a success promotes pending-review → active (one success is enough),
   - the 3rd consecutive *real* failure demotes,
   - walls quarantine on the first hit; transient/infra blips (incl. a dead
     operator session → `login_wall`) never advance the demote counter.

There is no discover phase, no LLM proxy, and no fix-agent — codex is the only
intelligence, and promote/demote is a deterministic rule in the registry. See
`docs/DESIGN-housekeeper-codex-verify.md`.

**Dogfood:** keep this checkout on `staging` so the daily run executes the
latest code.

## Install (one-time, as the operator)

```bash
# Build the package in the checkout first:
pnpm -F @trusty-squire/housekeeper build

mkdir -p ~/.config/systemd/user
cp tools/systemd/trusty-squire-heal.service ~/.config/systemd/user/
cp tools/systemd/trusty-squire-heal.timer   ~/.config/systemd/user/

# Keep user timers running across logout (one-time per box):
sudo loginctl enable-linger "$USER"

systemctl --user daemon-reload
systemctl --user enable --now trusty-squire-heal.timer
```

## Prerequisites

- A source checkout at `~/proj-ts` with the package built
  (`pnpm -F @trusty-squire/housekeeper build` → `apps/housekeeper/dist`). Edit
  `WorkingDirectory=` in the `.service` if your checkout lives elsewhere.
- The **codex CLI** installed + on PATH, configured with the
  `@trusty-squire/mcp@next` MCP. Verify with
  `node apps/housekeeper/dist/bin.js --check`.
- A live **operator Google session** in the bot Chrome profile (codex+MCP act as
  the operator to sign up). A dead session makes every verify return
  `login_wall` — which is transient by design, so it can't demote anything; it
  just means nothing gets verified until you refresh the session.
- `~/.config/trusty-squire/harvester.env` with `REGISTRY_ADMIN_BEARER`
  (required) and `TRUSTY_SQUIRE_REGISTRY_URL`. Optional knobs:
  `HOUSEKEEPER_MAX_SKILLS_PER_RUN` (default 20), `HOUSEKEEPER_CODEX_CMD`
  (default `codex`), `HOUSEKEEPER_PROMOTE_MIN_SUCCESSES` (default 1).

## Operate

```bash
node apps/housekeeper/dist/bin.js --check               # preflight: codex + bearer
node apps/housekeeper/dist/bin.js --once --dry          # a pass that posts nothing
systemctl --user list-timers trusty-squire-heal.timer   # when it next fires
systemctl --user start trusty-squire-heal.service        # run one pass now
journalctl --user -u trusty-squire-heal.service -f       # watch a run + the digest line
```
