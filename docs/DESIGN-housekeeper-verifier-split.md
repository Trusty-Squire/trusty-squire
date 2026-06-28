# Housekeeper to Registry Verifier Split

## Goal

Reduce the current housekeeper to a light verifier loop, remove autonomous
discovery and Gemini-backed guessing, and extract that loop into a separate
repository once the registry API contract is stable.

The MCP package remains responsible for user-driven provisioning, signup
capture, skill synthesis, replay primitives, vault writes, and registry client
integration. The verifier owns only pending skill replay and registry state
transitions.

## Current Problems

- Discovery and verification are coupled, so a background worker can create new
  external state while it is supposed to validate registry quality.
- Gemini-backed search hides stale registry data instead of making stale
  signup URLs, parked domains, and dead services visible.
- Verifier outcomes are hard to compare because replay, discovery, fallback
  signup, email handling, and credential extraction can all run in one loop.
- The housekeeper is too tightly coupled to this monorepo to deploy, audit, or
  roll back independently.

## Target Components

### `@trusty-squire/mcp`

- Owns interactive provisioning and operator-driven dogfooding.
- Owns deterministic skill synthesis and signing.
- Exposes replay primitives that can run in a strict verifier mode.
- Does not run unattended discovery.

### Registry API

- Owns skill state: `pending-review`, `active`, `demoted`, and terminal failure
  metadata.
- Provides lease and result endpoints for verifier workers.
- Stores redacted evidence and failure taxonomy.

### `trusty-squire-registry-verifier`

- Separate repository and deployable worker.
- Polls or leases `pending-review` skills.
- Runs deterministic replay only.
- Submits verification results to the registry.
- Never performs service discovery, Gemini search, or fallback signup creation.

## Verifier Loop

1. Lease a pending skill with a short TTL and worker identity.
2. Start an isolated browser profile for the replay.
3. Run skill replay in `verify_replay` mode.
4. Disable fallback signup, discovery search, Gemini calls, and skill synthesis.
5. Validate the observed result against the skill credential spec.
6. Submit a result with redacted evidence, failure taxonomy, and replay metadata.
7. Registry promotes passing skills to `active`, keeps blocked skills pending
   with backoff, or demotes repeat failures.

## Required API Contract

The verifier should use a small contract that can be stabilized before repo
extraction:

- `POST /skills/:id/lease`
- `POST /skills/:id/verification-runs`
- `GET /skills?status=pending-review&limit=N`

Each verification run should include:

- `skill_id`
- `worker_id`
- `status`: `passed`, `failed`, or `blocked`
- `failure_reason`
- `failure_stage`
- `redacted_evidence`
- `browser_profile_kind`
- `runtime_version`
- `schema_version`

## Failure Taxonomy

The verifier should distinguish:

- `skill_replay_failed`
- `site_changed`
- `service_dead_domain`
- `parked_domain`
- `verification_email_parser_failed`
- `operator_session_expired`
- `oauth_account_link_verification`
- `captcha_or_antibot`
- `payment_or_phone_wall`
- `masked_existing_credential`
- `credential_surface_404`

## Migration Plan

1. Add lease/result endpoints to the registry API if they are missing.
2. Add strict replay mode to the MCP runtime and ensure it disables discovery
   and signup fallback paths.
3. Move the current verifier behavior behind the new contract while it still
   lives in this repo.
4. Run the new verifier in shadow mode against pending-review skills and compare
   outcomes with current registry state changes.
5. Turn off housekeeper discovery and Gemini-backed service guessing.
6. Extract the verifier worker into a new repository with its own CI, container,
   deployment config, and runbook.
7. Delete the old housekeeper discovery paths from this repo after the extracted
   worker has processed a representative pending-review queue.

## Engineering Review

### P1: Replay Mode Must Be Enforced by Runtime, Not Convention

The extracted worker cannot rely on call-site discipline to avoid discovery.
Strict replay mode should be a typed runtime policy that rejects attempts to
invoke fallback signup, Gemini search, skill synthesis, registry publication, or
vault writes outside the verifier result channel.

### P1: Registry Leases Need Idempotent Result Handling

Multiple workers, deploy restarts, and slow browser runs can overlap. Result
submission must be idempotent by `verification_run_id`, and stale leases must
not overwrite newer successful evidence.

### P1: Live Email Parsing Is Part of Verification Fidelity

Recent dogfooding showed Resend payloads can contain only metadata. The verifier
must run against the same inbox body-fetch path used by provisioning, otherwise
skills will be marked broken for infrastructure reasons.

### P2: Stale Registry Data Should Fail Loudly

Parked domains, DNS failures, and credential-surface 404s should not be hidden
by search fallback. They should produce explicit registry-health failures so
the service row or skill can be refreshed.

### P2: OAuth Session State Needs a Dedicated Failure Class

Provider login expiry and account-link verification should not be reported as
skill replay failures. The verifier should classify them separately so operator
session maintenance does not pollute skill quality metrics.

### P2: Extraction Should Wait Until the Contract Is Stable

Moving the worker before the lease/result schema settles will duplicate client
code and make the split harder to audit. Keep the first strict verifier inside
the monorepo, then extract once API compatibility is proven.

## Test Plan

- Unit tests for lease expiry, duplicate result submission, and promotion rules.
- Unit tests for strict replay policy rejecting discovery and publish actions.
- Replay fixtures for pass, parked domain, credential 404, masked credential,
  expired OAuth, and email-parser failure.
- Integration test against a local registry API with two concurrent workers.
- Canary run against one stable pending-review fixture before every deploy.

