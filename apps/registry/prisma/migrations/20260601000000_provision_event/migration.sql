-- Rename ProvisionAttempt -> ProvisionEvent. The model widened from
-- "one row per universal-bot signup outcome" to "one row per provision
-- request across all dispatch paths" (replay-served / fell-back /
-- no-skill-bot). See docs/ARCHITECTURE.md.
--
-- Additive, non-destructive: the table + data are renamed in place and
-- new nullable columns are appended. Existing rows keep working; the
-- preserved `status` column keeps the compat-score derivation untouched.

-- RenameTable (data preserved)
ALTER TABLE "ProvisionAttempt" RENAME TO "ProvisionEvent";

-- Postgres keeps the old object names on a table rename; rename the
-- primary key + indexes so `prisma migrate` sees no drift against the
-- renamed model.
ALTER TABLE "ProvisionEvent" RENAME CONSTRAINT "ProvisionAttempt_pkey" TO "ProvisionEvent_pkey";
ALTER INDEX "ProvisionAttempt_service_occurred_at_idx" RENAME TO "ProvisionEvent_service_occurred_at_idx";
ALTER INDEX "ProvisionAttempt_occurred_at_idx" RENAME TO "ProvisionEvent_occurred_at_idx";

-- AddColumn — dispatch model (strategy + outcome) + cost telemetry.
-- All nullable: old MCP clients post none (sink blind-defaults to bot),
-- and replay rows carry cost 0 (known-zero) rather than measured values.
ALTER TABLE "ProvisionEvent"
  ADD COLUMN "initial_strategy" TEXT,
  ADD COLUMN "final_strategy"   TEXT,
  ADD COLUMN "replay_outcome"   TEXT,
  ADD COLUMN "final_outcome"    TEXT,
  ADD COLUMN "llm_cost"         DOUBLE PRECISION,
  ADD COLUMN "captcha_cost"     DOUBLE PRECISION,
  ADD COLUMN "duration_ms"      INTEGER;

-- Idempotency (Decision 11): a retried fire-and-forget emit upserts on
-- provision_id instead of double-counting. NULL provision_ids
-- (legacy / no-id posts) are distinct in Postgres, so they never collide.
CREATE UNIQUE INDEX "ProvisionEvent_provision_id_key" ON "ProvisionEvent"("provision_id");
