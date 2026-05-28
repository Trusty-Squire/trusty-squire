-- T44 — ProvisionAttempt: one row per universal-bot signup outcome.
-- Source of truth for the per-service compatibility score that
-- /v1/services/:slug/health derives (successes vs failures with
-- time decay). UniversalBotFailureRecord stays — its failure-class
-- telemetry feeds the discovery worker; this is the broader signal.

CREATE TABLE "ProvisionAttempt" (
  "id"            TEXT          NOT NULL,
  "service"       TEXT          NOT NULL,
  "status"        TEXT          NOT NULL,
  "failure_kind"  TEXT,
  "signup_url"    TEXT,
  "artifacts_uri" TEXT,
  "account_id"    TEXT          NOT NULL,
  "mcp_version"   TEXT          NOT NULL,
  "occurred_at"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProvisionAttempt_pkey" PRIMARY KEY ("id")
);

-- Score derivation queries by (service, time): scan recent rows
-- for ONE service and weight by age. This index is hot.
CREATE INDEX "ProvisionAttempt_service_occurred_at_idx"
  ON "ProvisionAttempt"("service", "occurred_at" DESC);

-- Admin dashboard recent-list view.
CREATE INDEX "ProvisionAttempt_occurred_at_idx"
  ON "ProvisionAttempt"("occurred_at" DESC);
