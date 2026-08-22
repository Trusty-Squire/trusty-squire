CREATE UNIQUE INDEX IF NOT EXISTS "Credential_active_account_service_label_key"
ON "Credential" ("account_id", lower("metadata"->>'service'), "label")
WHERE "deleted_at" IS NULL AND jsonb_typeof("metadata"->'service') = 'string';
