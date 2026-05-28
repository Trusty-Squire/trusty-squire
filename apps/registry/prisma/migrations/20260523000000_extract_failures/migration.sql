-- ExtractFailureSnapshot — DOM + screenshot capture from a universal-bot
-- run where `extractCredentials()` returned null despite the planner
-- asserting a credential was visible. Auto-uploaded by the MCP so we
-- can diagnose UI-shape regressions without users having to fiddle
-- with env vars and tail debug dirs.
--
-- Retention: 7 days from upload (snapshots may contain rendered PII —
-- the bot's email alias, freshly-created session cookies serialized
-- into the HTML, etc.). A daily pruner deletes rows past `expires_at`.
--
-- Storage: HTML is gzipped before insert (typical signup modals are
-- 80-300KB raw → 8-30KB gzipped). The screenshot is the JPEG bytes
-- the planner saw — already small (~200-400KB) so stored as-is.

CREATE TABLE "ExtractFailureSnapshot" (
    "id"              TEXT NOT NULL,
    "account_id"      TEXT NOT NULL,
    "service"         TEXT NOT NULL,
    "mcp_version"     TEXT NOT NULL,
    "uploaded_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"      TIMESTAMP(3) NOT NULL,
    "url"             TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "step_label"      TEXT NOT NULL,
    "extract_reason"  TEXT NOT NULL,
    "candidates_json" JSONB,
    "html_gzip"       BYTEA NOT NULL,
    "screenshot_jpeg" BYTEA,
    "html_bytes"      INTEGER NOT NULL,
    "screenshot_bytes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExtractFailureSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExtractFailureSnapshot_account_id_uploaded_at_idx"
    ON "ExtractFailureSnapshot"("account_id", "uploaded_at" DESC);

CREATE INDEX "ExtractFailureSnapshot_expires_at_idx"
    ON "ExtractFailureSnapshot"("expires_at");

CREATE INDEX "ExtractFailureSnapshot_service_idx"
    ON "ExtractFailureSnapshot"("service");
