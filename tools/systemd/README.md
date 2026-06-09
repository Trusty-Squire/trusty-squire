# Autonomous heal pass — systemd user timer (T9)

Runs `mcp housekeeper --mode=heal --once --from=tools/housekeeper-services.yaml
--limit=100` **daily** on the operator's headless dev box — the autonomous
engine that drives the project's two objective functions. Each fire does ONE
pass:

1. **verify** — replay active + freshness-due skills. Rot (step/validator/
   extraction failures ×3) → demoted; a wall (captcha/anti-bot) →
   quarantined on the first hit. Transient/infra blips never demote.
2. **discover** — run a virgin provision against the curated ~100-service
   queue (`tools/housekeeper-services.yaml`); each success auto-promotes a new
   skill. (Drop `--from` to fall back to on-demand telemetry-candidate +
   freshly-demoted discovery instead of the curated sweep.)
3. **digest** — one notification carrying both **objective functions**:
   `verified N · demoted M · quarantined Q · re-skilled K · needs human ~X ·
   discover P% (s/a) · skills T` — OF#1 = skills in the registry, OF#2 =
   discovery success rate this pass (Telegram if `TELEGRAM_BOT_TOKEN` is set,
   always to the journal). The same two metrics land on the registry admin
   dashboard's **Objective functions** panel with a run-over-run trend.

See `docs/AUTONOMOUS-LOOP.md` for the loop + objective functions and
`docs/DESIGN-closed-loop-remediation.md` for the closed-loop design.

## Install (one-time, as the operator)

```bash
mkdir -p ~/.config/systemd/user
cp tools/systemd/trusty-squire-heal.service ~/.config/systemd/user/
cp tools/systemd/trusty-squire-heal.timer   ~/.config/systemd/user/

# Keep user timers running across logout (one-time per box):
sudo loginctl enable-linger "$USER"

systemctl --user daemon-reload
systemctl --user enable --now trusty-squire-heal.timer
```

## Prerequisites

- A source checkout at `~/proj-ts` with `apps/mcp/dist` built
  (`pnpm -F @trusty-squire/mcp build`). Edit `WorkingDirectory=` in the
  `.service` if your checkout lives elsewhere.
- `~/.config/trusty-squire/harvester.env` with at least
  `REGISTRY_ADMIN_BEARER` and `TRUSTY_SQUIRE_REGISTRY_URL`; add
  `TRUSTY_SQUIRE_MACHINE_TOKEN` + `TRUSTY_SQUIRE_ACCOUNT_ID` +
  `UNIVERSAL_BOT_LLM_TIER=free` for the discover phase, and
  `TELEGRAM_BOT_TOKEN` for the digest.
- A logged-in bot Chrome profile (`mcp login`) — the discover phase drives
  real OAuth signups. (A stale Google/GitHub session is the usual cause of
  a needs_login-heavy run; refresh with `mcp login --force-relogin`.)

## Operate

```bash
systemctl --user list-timers trusty-squire-heal.timer   # when it next fires
systemctl --user start trusty-squire-heal.service        # run one pass now
journalctl --user -u trusty-squire-heal.service -f       # watch a run (incl. [heal] digest)
mcp skill needs-human                                    # the worklist of what still needs you
```
