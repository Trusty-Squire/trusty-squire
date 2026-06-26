# DESIGN — Housekeeper → a codex-driven verify scheduler

Status: **proposed** (locked in design discussion 2026-06-26; not yet built).
Branch: `claude/housekeeper-refactor`. Companion thesis: this session's
"frontier-model-at-runtime is front and center; the cheap-LLM scaffolding goes."

## Thesis

The housekeeper's only real job is **keeping the skill registry healthy**:
promote skills that still work, demote ones that don't. Everything else it grew
— discover, the fix-loop, shopping, autoloop, the Gemini planner, the confidence
sampler, the robot identity fleet, its own copy of the signup bot — was
scaffolding around a *cheap model that couldn't be trusted to make the call*.

We replace all of it with:

- **A scheduler.** On a timer, loop the registry's skills.
- **`codex exec` + the @next Trusty Squire MCP as the signup driver.** Per skill,
  Codex attempts the signup through the MCP's `provision_*` tools. No bot code in
  the housekeeper at all.
- **A mechanical promote/demote rule, in the registry.** Sign-in succeeds →
  promote. Failure count > 3 → demote. **No judgment.**

The result is a small, dependency-light standalone package whose entire body is
"loop skills → ask Codex to reproduce each via the MCP → relay the outcome →
registry applies the rule."

## Why the current design is the way it is (and why it goes)

`apps/mcp/src/housekeeper/` is ~10.6k LOC across ~33 files and 3 mode families:

- **verify / fresh-verify** (KEEP, but rewrite) — replays a stored Skill's exact
  step-graph. Confirmed **LLM-free today**: `replay-skill.ts`'s `llmFallback`
  hook exists but no production caller wires it; the only `pickLLMPair` consumer
  is `discover.ts:354`.
- **discover** (DELETE) — drives `UniversalSignupBot` (the planner) at a service.
  The *only* housekeeper LLM consumer (OpenRouter/Gemini via the proxy).
- **fix / fix-\*** (DELETE) — an output-side autonomous-fix loop driving an
  external coding agent.
- **shopping, autoloop, classify-backfill** (DELETE).

Two findings from the dependency scout make the rewrite-not-extract decision:

1. **The bot substrate is not severable by keeping verify as-is.** verify imports
   only ~7 named symbols from `../bot` (`BrowserController`, `replaySkill`,
   `InboxClient`, `makeEmailCodeFetcher`, `probeAffordances`, `OAuthProviderId`,
   `CHROME_PROFILE_DIR`), but `browser.js` / `replay-skill.js` /
   `affordance-probe.js` / `email-code-fetcher.js` all transitively pull
   `bot/agent.js` → the LLM/vision client, captcha, xvfb, OAuth flows, and the
   full Playwright stack. A standalone verify package that *kept its own replay*
   would have to vendor half the bot.
2. **`robot-replenish.ts` shells out to monorepo-root `tools/*.mjs`** (the verify
   fleet provisioner) via `execFileSync` resolved through `../../../../` — a hard
   filesystem-layout coupling that breaks on a package move.

**Delegating the signup to `codex exec` + the @next MCP eliminates both.** Codex
runs the MCP in its own process; the MCP owns the browser, the replay, the vault,
the captcha handling. The housekeeper imports *none* of it. And dropping the
robot fleet (below) deletes `robot-replenish.ts` and its `tools/*.mjs` coupling.

## Locked decisions

### D1 — Verify is delegated to `codex exec` + the @next MCP

The housekeeper no longer maintains signup/replay code. Per skill it invokes
`codex exec` with a standing prompt: *"Using the Trusty Squire MCP, provision
`<service>` at `<signup_url>` (the registry route hint will be offered); report
whether you obtained a working credential."* Codex drives the `provision_*`
tools; the MCP does all browser/vault work.

This **crosses the old trust boundary on purpose.** Old fresh-verify could only
promote by replaying the *exact stored step-graph* (never the planner), so the
registry learned "this recipe replays," not "the service is solvable." Under D1,
promotion means **"a fresh signup, driven by the frontier agent + the registry
hint, reproduces a working credential."** That is this session's thesis: the
stored skill graph is an optimization, not the source of truth; the frontier
agent is.

Consequence: fresh signups now run under the **operator's own connect-identity
Google session** (the MCP acts as the operator), not N independent robots — see
D3.

### D2 — Promote/demote is a mechanical rule in the registry (no judgment)

- **Sign-in succeeds → promote** (pending-review → active). **One success is
  enough** — no confidence floor.
- **Failure count > 3 → demote.**

Codex makes **no** promote/demote decision and needs **no** curation verbs. Its
output is a single structured outcome (`success` | `failure` + a `failure_kind`).
The mechanical rule lives in the **registry**, which already does outcome →
transition (`registry-client.ts:170` POSTs `/admin/skills/{id}/verifier-outcome`
→ `transition ∈ promoted|demoted|…`) and the 3-strike demotion server-side. The
only registry change is **deleting the confidence sampler** (the Beta/Wilson
`evaluateConfidence` / `wilsonInterval` / `DEFAULT_PROMOTE_FLOOR` machinery in
`fresh-verify.ts`) so a single success promotes.

**A "failure" must mean a genuine reproducible failure, not a network blip.** The
existing deterministic classification stays: nav-timeout, account-exists, and
brittle-probe outcomes do **not** advance the demote counter
(`failureCountsTowardDemotion`; `verify.ts` transient guards). This is a rule,
not a model — it fits "no judgment." Without it, three unlucky connections demote
a perfectly good skill.

### D3 — The robot identity fleet is dropped

Old fresh-verify ran N independent Cloud-Identity robot Googles through the
sampler to estimate "replayable by *anyone*." Under D1 the signup runs as the
operator's own session, so identity-independence is gone by construction. We
accept that: verify now means **"reproducible by my frontier agent as me,"** not
"replayable by a cold independent identity." This deletes `identity-pool.ts`,
`robot-replenish.ts` (and its `tools/*.mjs` shell-out), `verify-passwords.ts`,
and the fleet provisioning runbook.

### D4 — The housekeeper relays the outcome (Codex stays a pure signup driver)

After `codex exec` returns, the **housekeeper** reads Codex's structured outcome
and POSTs it to the registry (`registry-client.postOutcome`). Codex never holds
the `REGISTRY_ADMIN_BEARER` and never makes the curation call — it only signs up
and reports success/fail. Keeps the admin token server-side and Codex's prompt
free of credentials.

The codex→housekeeper contract is minimal: Codex emits a final structured line
(or writes a known result file) of shape `{ ok: boolean, failure_kind?: string,
detail?: string }`. The housekeeper maps that to a registry outcome. (This is not
the "verdict for judgment" we rejected earlier — it's a boolean for a mechanical
rule.)

### D5 — Extract to its own package: `apps/housekeeper`

A standalone operator app (sibling to `apps/api`, `apps/registry`). Because D1
removes the bot dependency, its deps shrink to:

- `@trusty-squire/skill-schema` (workspace:\*) — `Skill`, `parseSkill`,
  `canonicalizeServiceSlug`, the failure-kind helpers (`isNavNetworkFailure`,
  `NAV_TIMEOUT_KIND`, `failureCountsTowardDemotion`, …).
- `yaml` (the curated services queue).
- The **codex CLI** (external, shelled out) + the @next MCP configured for it.

**No** `../bot`, **no** Playwright, **no** LLM client, **no** captcha/xvfb.

Shared helpers it still needs (`operator-env.ts`, `session.ts`, `version.ts`,
and the `CAPABILITY_WALL_STAGES` constant mirrored in `provision-gate.ts`) are
small — copy them into the package, or factor a tiny shared lib. `version.ts`
must be re-pointed at the new package's `package.json`.

## What deletes / what stays

**Delete (from `apps/mcp`):**
- Modes: `discover.ts`, `fix.ts` + all `fix-*` (`fix-agent`, `fix-agent-runtime`,
  `fix-batch`, `fix-ledger`, `fix-router`, `fix-router-input`), `shopping.ts`,
  `autoloop.ts`, `classify-backfill.ts`, `ledger-cli.ts`.
- Fleet: `identity-pool.ts`, `robot-replenish.ts`, `verify-passwords.ts`.
- The confidence sampler in `fresh-verify.ts` (and the root/mode split collapses).
- LLM wiring reachable only via discover: confirm `bot/llm-client.ts`
  (`pickLLMPair`/`ProxyLLMClient`/`OpenRouterClient`/`UNIVERSAL_BOT_LLM_TIER`) has
  no *other* importer (the live-provision router re-exports it via
  `bot/index.ts:40-49`) before deleting; if the provision path still needs it,
  leave the module, just drop the housekeeper's use.
- `bin.ts:58` housekeeper dispatch branch; the `files`/tsconfig housekeeper
  entries in `apps/mcp/package.json`.

**Keep (re-homed into `apps/housekeeper`, rewritten):**
- A thin `registry-client` (pure `fetch`: list skills, `postOutcome`).
- The verify **scheduler** (loop + pacing + queues + cleanup + unknown-state).
- A new **codex-exec runner** (build prompt, spawn `codex exec`, parse outcome).
- The deterministic failure-kind classifier (transient/brittle guards).
- Notifiers (`telegram-notifier`, `github-issue-notifier`, `notifier`).

**Registry change (`apps/registry`):**
- Delete the confidence-sampler decision path; promote on first success.
- Keep `verifier-outcome` → transition + the 3-strike demotion (now the whole
  rule).

## Phased plan

0. **Registry:** simplify the promote rule (sampler → one-success); keep 3-strike
   + transition. Tests for the mechanical rule.
1. **Scaffold `apps/housekeeper`:** package.json (deps: skill-schema, yaml),
   tsconfig, bin entry. Copy/relocate `operator-env`/`session`/`version`.
2. **Codex-exec runner:** the prompt template + spawn + outcome parse, with the
   `{ ok, failure_kind }` contract. Unit-test the parse + the failure
   classification.
3. **Verify scheduler:** loop registry skills (pending-review → promote
   candidates; active → freshness/demote), pace, invoke the runner, relay the
   outcome via `postOutcome`. Notifications + digest.
4. **Delete the old housekeeper** from `apps/mcp` (modes, fleet, sampler, bin
   dispatch, package.json/tsconfig entries). Verify `bot/llm-client.ts` has no
   stranded importer.
5. **Ops:** update the systemd timer (`tools/systemd/`) to run the new package;
   prerequisite check that `codex` + the @next MCP are configured on the box.
6. **Docs:** rewrite `docs/HOUSEKEEPER-OPERATIONS.md` (egress/robot-pool sections
   are now obsolete), update `CLAUDE.md` (the housekeeper env table, the modes
   description, the npm-tarball note).

## Open questions

1. **The codex-exec outcome contract** (D4): final-line JSON vs a result file.
   Lean: instruct Codex to end with a single `RESULT: {json}` line the
   housekeeper greps — simplest, no temp-file lifecycle. Confirm at build.
2. **Skill selection cadence:** which active skills to re-verify per pass (all?
   oldest-checked-first? a budget per run?), and how often pending-review is
   swept. Inherit the current pacing/queue model; tune later.
3. **Codex availability/cost:** `codex exec` per skill across the ~100-service
   queue is real wall-clock + token cost on the operator box. Pacing + a
   per-run budget cap (N skills/pass) is the control. Define the default.
4. **Operator identity prerequisite:** verify runs as the operator's
   connect-identity Google session (D1/D3). A dead session → every verify fails →
   spurious demotions. The runner must **fail-closed**: if the MCP reports a
   login wall / no session, classify as transient (does NOT count toward demote),
   not as a skill failure.
