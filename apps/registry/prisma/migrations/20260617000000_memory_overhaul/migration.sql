-- Memory overhaul (Phases 1, 3, 4). All additive / non-destructive.
-- IF NOT EXISTS guards so a partial prior `db push` can't fail the deploy.

-- Phase 1 — ProvisionEvent firehose columns (mode + captcha summary, nullable).
ALTER TABLE "ProvisionEvent" ADD COLUMN IF NOT EXISTS "mode" TEXT;
ALTER TABLE "ProvisionEvent" ADD COLUMN IF NOT EXISTS "captcha_kind" TEXT;
ALTER TABLE "ProvisionEvent" ADD COLUMN IF NOT EXISTS "captcha_variant" TEXT;
ALTER TABLE "ProvisionEvent" ADD COLUMN IF NOT EXISTS "captcha_blocked" BOOLEAN;

-- Phase 3 — materialized per-service status (projection + heal overlay).
CREATE TABLE IF NOT EXISTS "ServiceState" (
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "successful_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_green_at" TIMESTAMP(3),
    "last_failure_kind" TEXT,
    "current_diagnosis" TEXT,
    "diagnosis_evidence" TEXT,
    "wall_classification" TEXT,
    "projection_updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceState_pkey" PRIMARY KEY ("service")
);
CREATE INDEX IF NOT EXISTS "ServiceState_status_idx" ON "ServiceState"("status");

-- Phase 4 — the drainable failure ledger.
CREATE TABLE IF NOT EXISTS "OpenIssue" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "failure_kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "first_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resolved_run" TEXT,
    "falsified" JSONB,
    "actor" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OpenIssue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OpenIssue_status_idx" ON "OpenIssue"("status");
CREATE INDEX IF NOT EXISTS "OpenIssue_service_idx" ON "OpenIssue"("service");
