-- SkillCaptureRecord — content-hashed sidecar storage for the capture
-- JSONL files that contributed to a published skill (T19, D1).

CREATE TABLE "SkillCaptureRecord" (
    "content_hash" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "round_index" INTEGER NOT NULL,
    "payload_json" JSONB NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" TEXT NOT NULL,

    CONSTRAINT "SkillCaptureRecord_pkey" PRIMARY KEY ("content_hash")
);

CREATE INDEX "SkillCaptureRecord_skill_id_idx" ON "SkillCaptureRecord"("skill_id");
CREATE INDEX "SkillCaptureRecord_skill_id_round_index_idx" ON "SkillCaptureRecord"("skill_id", "round_index");
CREATE INDEX "SkillCaptureRecord_run_id_idx" ON "SkillCaptureRecord"("run_id");
