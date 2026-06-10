-- OF#3 (registry hit rate) snapshot columns on HealRun. Non-destructive:
-- both default 0 so existing rows + older heartbeats stay valid.
ALTER TABLE "HealRun" ADD COLUMN "hit_served" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HealRun" ADD COLUMN "hit_total" INTEGER NOT NULL DEFAULT 0;
