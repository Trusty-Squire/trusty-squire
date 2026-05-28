-- Drop AdapterManifestRecord with the 0.8 native-provision sunset.
--
-- The table held hand-authored adapter manifests for the legacy
-- `provision` cluster (mandate engine + manifest executor). It was
-- never populated in production — every Trusty Squire signup that
-- ever ran went through the universal browser bot, which writes to
-- SkillRecord. The supporting Fastify route, Prisma store, validator,
-- and CLI publisher were deleted in the same change.
--
-- IF EXISTS so the rollout is safe in environments where the table
-- was never created (every staging / preview env that started after
-- 0.8) and idempotent on retry.

DROP TABLE IF EXISTS "AdapterManifestRecord";
