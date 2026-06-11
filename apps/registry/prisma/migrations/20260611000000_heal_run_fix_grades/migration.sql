-- Output-loop (#1) fix-grading snapshot columns on HealRun. Non-destructive:
-- all default 0 so existing rows + older heartbeats stay valid.
ALTER TABLE "HealRun" ADD COLUMN "fixes_graded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HealRun" ADD COLUMN "fixes_improved" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HealRun" ADD COLUMN "fixes_regressed" INTEGER NOT NULL DEFAULT 0;
