-- T45 — link ProvisionAttempt to ExtractFailureSnapshot via a
-- correlation id the MCP generates once per provision
-- run. Used by the admin dashboard's "recent failed attempts" view
-- to surface step trail + per-round thumbnails together.
--
-- Also adds a step_trail column on ProvisionAttempt for failures
-- that bail BEFORE the post-verify loop and therefore upload no
-- ExtractFailureSnapshot rows (captcha_blocked, oauth_required, …).

ALTER TABLE "ProvisionAttempt"
  ADD COLUMN "provision_id" TEXT,
  ADD COLUMN "step_trail"   TEXT;

ALTER TABLE "ExtractFailureSnapshot"
  ADD COLUMN "provision_id" TEXT;

-- Hot path: admin dashboard JOINs ExtractFailureSnapshot rows to a
-- ProvisionAttempt by provision_id.
CREATE INDEX "ExtractFailureSnapshot_provision_id_idx"
  ON "ExtractFailureSnapshot"("provision_id");
