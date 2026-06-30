-- Tier-2 Learned Skills (0.7.0): SkillRecord + SkillReplayRecord.
-- See packages/skill-schema/src/skill.ts for the payload_json schema
-- and docs/ARCHITECTURE.md for the design rationale.

-- CreateTable
CREATE TABLE "SkillRecord" (
    "skill_id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "signed_by" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "replays_succeeded" INTEGER NOT NULL DEFAULT 0,
    "replays_failed" INTEGER NOT NULL DEFAULT 0,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_replayed_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "SkillRecord_pkey" PRIMARY KEY ("skill_id")
);

-- Hot path: router lookups for "active skill for this service".
CREATE INDEX "SkillRecord_service_status_idx" ON "SkillRecord"("service", "status");
CREATE INDEX "SkillRecord_service_idx" ON "SkillRecord"("service");
CREATE INDEX "SkillRecord_status_idx" ON "SkillRecord"("status");
CREATE INDEX "SkillRecord_deleted_at_idx" ON "SkillRecord"("deleted_at");

-- CreateTable
CREATE TABLE "SkillReplayRecord" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "step_index" INTEGER,
    "replayed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillReplayRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SkillReplayRecord_skill_id_idx" ON "SkillReplayRecord"("skill_id");
CREATE INDEX "SkillReplayRecord_skill_id_replayed_at_idx" ON "SkillReplayRecord"("skill_id", "replayed_at");
CREATE INDEX "SkillReplayRecord_account_id_replayed_at_idx" ON "SkillReplayRecord"("account_id", "replayed_at");

-- AddForeignKey
ALTER TABLE "SkillReplayRecord" ADD CONSTRAINT "SkillReplayRecord_skill_id_fkey"
  FOREIGN KEY ("skill_id") REFERENCES "SkillRecord"("skill_id") ON DELETE CASCADE ON UPDATE CASCADE;
