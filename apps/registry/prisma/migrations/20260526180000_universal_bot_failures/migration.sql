-- Closed-loop strategy Phase 5: UniversalBotFailure telemetry.
-- Drives Phase 6 (discovery worker) — when ≥3 DISTINCT users fail
-- at the same service in 14 days and the registry has no active
-- skill yet, the worker treats it as a candidate to iterate against.

CREATE TABLE "UniversalBotFailureRecord" (
  "id"           TEXT          NOT NULL,
  "service"      TEXT          NOT NULL,
  "error_kind"   TEXT          NOT NULL,
  "reason"       TEXT          NOT NULL,
  "account_id"   TEXT          NOT NULL,
  "mcp_version"  TEXT          NOT NULL,
  "reported_at"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UniversalBotFailureRecord_pkey" PRIMARY KEY ("id")
);

-- The discovery aggregation: scan recent rows by service.
CREATE INDEX "UniversalBotFailureRecord_service_reported_at_idx"
  ON "UniversalBotFailureRecord"("service", "reported_at" DESC);

-- Per-account rate-limit lookup.
CREATE INDEX "UniversalBotFailureRecord_account_id_reported_at_idx"
  ON "UniversalBotFailureRecord"("account_id", "reported_at" DESC);

-- Whole-table sweep for retention pruner.
CREATE INDEX "UniversalBotFailureRecord_reported_at_idx"
  ON "UniversalBotFailureRecord"("reported_at");
