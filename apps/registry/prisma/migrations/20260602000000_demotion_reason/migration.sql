-- Closed-loop remediation T4: persist WHY a skill left `active`.
-- Additive + nullable — safe to apply online, no backfill needed.
-- Set to rot:<failure_kind> on demote, wall:<failure_kind> on quarantine,
-- or an operator reason on manual demote. Read by /admin/needs-human.
ALTER TABLE "SkillRecord" ADD COLUMN "demotion_reason" TEXT;
