# Changelog — @trusty-squire/mcp

## 0.8.18 (2026-06-05)

Post-OAuth navigation: deterministic planner, an offline eval harness, and a
flakiness taxonomy (docs/DESIGN-planner-navigation-eval.md).

### Bot behavior (shipped)
- **Deterministic planner (temperature 0).** The post-verify navigation planner,
  the form-fill planner, and the tap-number vision read now run at temperature 0
  instead of the provider default (~0.7). Same page → same decision run-to-run,
  removing the dominant source of post-OAuth navigation flakiness. `temperature`
  is threaded through `LLMRequest`, all three LLM clients, and the `/v1/llm/chat`
  proxy.
- **Image media-type fix.** Planner image blocks now label the screenshot by its
  actual bytes (PNG vs JPEG) instead of hardcoding `image/jpeg`. Fixes an
  Anthropic premium-fallback 400 ("the image appears to be a image/png image")
  whenever the cheap model's reply failed to parse on a PNG screenshot.
- **Planner prompt:** narrow guidance so an onboarding use-case option rendered
  as an illustrative-placeholder `<input>` is clicked, not filled.
- **`SignupResult.failure_stage`** — every terminal run now carries a structured
  failure-stage label (oauth_handshake / hydration / planner_loop / extract /
  verify_email / … ), set on the result and the run-outcome sidecar.

### Dev harness (not shipped in the tarball)
- Offline navigation-planner eval: run-outcome capture sidecars, an auto-derived
  redacted regression corpus (`build-corpus`), a hand-labeled target set
  (`label-target`), and a temp-0 gated runner (`eval-gate`), plus a
  path-filtered CI workflow and a flakiness aggregator (`failure-stats`). All
  corpus cases are R3-redacted (no secrets, screenshots stripped).
