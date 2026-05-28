-- Two-tier registry (closed-loop strategy pivot):
-- Skills can now exist in pending-review (staging) state until a
-- verifier worker confirms N=2 fresh signups pass against the
-- captured selectors, at which point the worker flips status='active'
-- (visible to end-users). Counters here track verifier outcomes
-- separately from user-driven replay stats so the freshness sweep
-- doesn't contaminate user-facing replay-success-rate metrics.
--
-- Existing rows backfill as if they've already been verified:
--   - verifier_succeeded = 2 (already past the promotion threshold)
--   - last_verified_at   = created_at (treat as just-verified)
--   - next_freshness_due_at = created_at + 7 days (joins the weekly
--                            sweep at the same cadence as new skills)

ALTER TABLE "SkillRecord"
  ADD COLUMN "verifier_succeeded"            INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "verifier_failed"               INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "consecutive_verifier_failures" INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "last_verified_at"              TIMESTAMP(3),
  ADD COLUMN "next_freshness_due_at"         TIMESTAMP(3),
  ADD COLUMN "freshness_budget_cents"        INTEGER       NOT NULL DEFAULT 100;

-- Backfill: anything currently active counts as verified through
-- the legacy hand-promotion process. Two synthetic successes,
-- last_verified_at = created_at, freshness sweep scheduled at
-- GREATEST(now, created_at) + 7d to prevent a thundering-herd of
-- legacy skills landing in the verifier queue all at once on first
-- deploy. The stagger keeps the inaugural sweep load identical to a
-- steady-state one — even a 100-skill registry runs cleanly.
UPDATE "SkillRecord"
SET "verifier_succeeded"    = 2,
    "last_verified_at"      = "created_at",
    "next_freshness_due_at" = GREATEST(NOW(), "created_at") + INTERVAL '7 days'
WHERE "status" = 'active';

-- Indexed for the verifier's "what's due?" query: pull all skills
-- whose next sweep has passed, in due-date order.
CREATE INDEX "SkillRecord_next_freshness_due_at_idx"
  ON "SkillRecord"("next_freshness_due_at")
  WHERE "next_freshness_due_at" IS NOT NULL;
