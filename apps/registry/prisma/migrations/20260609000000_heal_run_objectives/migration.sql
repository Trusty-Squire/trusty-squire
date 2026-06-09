-- Objective functions on each heal run, for the dashboard trend + digest.
-- Additive + defaulted — safe to apply online, no backfill needed (existing
-- rows read back 0).
-- OF#2: the discovery success rate this pass saw, as the two raw counts.
ALTER TABLE "HealRun" ADD COLUMN "discover_attempted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HealRun" ADD COLUMN "discover_succeeded" INTEGER NOT NULL DEFAULT 0;
-- OF#1: snapshot of the active-skill count when this pass reported.
ALTER TABLE "HealRun" ADD COLUMN "skills_active" INTEGER NOT NULL DEFAULT 0;
