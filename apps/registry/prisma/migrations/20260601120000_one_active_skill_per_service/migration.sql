-- One active skill per service.
--
-- The direct publish path (insert()) used to create a new `active`
-- SkillRecord without superseding the prior active row for the same
-- service, so re-publishing a service (auto-promote re-running it)
-- accumulated duplicate active rows. The code now supersedes in-tx; this
-- migration cleans up the existing duplicates and adds a partial unique
-- index so a future missed supersede fails loud instead of duplicating.

-- 1. Collapse duplicates to one active row per service. Keep the most
--    recently created (matches findActiveByService's ORDER BY created_at
--    DESC); supersede the rest.
UPDATE "SkillRecord"
SET status = 'superseded', superseded_at = NOW()
WHERE status = 'active'
  AND deleted_at IS NULL
  AND skill_id NOT IN (
    SELECT DISTINCT ON (service) skill_id
    FROM "SkillRecord"
    WHERE status = 'active' AND deleted_at IS NULL
    ORDER BY service, created_at DESC
  );

-- 2. Enforce it at the DB level. Partial unique index: at most one
--    non-deleted active row per service. Expressed as raw SQL because
--    Prisma's schema language can't represent a filtered unique index.
CREATE UNIQUE INDEX "SkillRecord_one_active_per_service"
  ON "SkillRecord" (service)
  WHERE status = 'active' AND deleted_at IS NULL;
