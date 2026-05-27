# Harvester systemd install — run as user `lunchbox` on chloro

Five units total (one timer + service for the harvester, plus two
service+timer pairs for the daily summary). All run as user services
under lunchbox — no root needed.

## Prerequisites

1. The harvester's chrome profile has methoxine's Google session seeded
   (one-time `mcp login --provider=google`, see top-level
   `tools/harvester/README.md`).
2. `~/.config/trusty-squire/session.json` exists and points at
   `https://trusty-squire-api.fly.dev` (lunchboxfortwo's session).
3. `gh` CLI is logged in for lunchbox.
4. SSH SOCKS tunnel is up: `ss -tnlp | grep 127.0.0.1:1080`. (The
   harvester pre-flight will catch a missing tunnel, but the bot needs
   it to egress, so keep it warm.)
5. The repo is checked out at `/home/lunchbox/trusty-squire/`. The
   units reference that path explicitly. If the checkout lives
   elsewhere, edit the `WorkingDirectory=` and `ExecStart=` paths.

## Install

```bash
# As lunchbox.
mkdir -p ~/.config/systemd/user
cp tools/harvester/systemd/*.service ~/.config/systemd/user/
cp tools/harvester/systemd/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload

# Enable the daily-summary timers right away — they don't run signups,
# only mutate GitHub issues. Safe to start.
systemctl --user enable --now harvester-daily-open.timer
systemctl --user enable --now harvester-daily-close.timer

# DON'T enable the harvester timer yet. Eyeball one manual --once
# attempt first, see it produce a GitHub issue, then enable.
```

## First manual run (eyeball before the timer)

```bash
cd ~/trusty-squire/tools/harvester
node run.mjs --dry-run    # confirm pre-flight green
node run.mjs --once       # actually run one attempt
```

Watch the GitHub repo's Issues tab. Expect:
- `[skill-harvester] ipinfo — IPInfo` opens, labels `skill-harvester`,
  `service:ipinfo`, `status:running` → `status:promotion-only` (or
  `status:replay-ok` if a Railway-style fast-path applies).

If the issue looks right and the bot succeeded, enable the timer:

```bash
systemctl --user enable --now trusty-squire-harvester.timer
```

(Note: the unit's filename is `harvester.timer` — `systemctl` accepts
either a filename match or a description match.)

## Verify it's running

```bash
# Timer status
systemctl --user list-timers --all | grep harvester

# Live log of the most recent attempt
journalctl --user -u harvester.service -n 200 -f

# Daily summary status
gh issue list --label daily-summary --repo Trusty-Squire/trusty-squire
```

## Stop / disable

```bash
# Pause harvester (timer keeps firing, but ConditionPathExists short-circuits)
touch ~/.trusty-squire/harvester-halted

# OR fully stop
systemctl --user disable --now harvester.timer
```

The halt sentinel is the gentler option — the timer keeps firing
(so the daily summary can still close at end of day), but each
service-run tick exits cleanly without invoking the bot. Delete the
sentinel to resume.
