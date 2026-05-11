-- CreateTable
CREATE TABLE "Credential" (
    "id" VARCHAR(26) NOT NULL,
    "reference" TEXT NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "subscription_id" VARCHAR(26) NOT NULL,
    "type" TEXT NOT NULL,
    "env_var_suggestion" TEXT,
    "ciphertext" BYTEA NOT NULL,
    "encrypted_dek" BYTEA NOT NULL,
    "account_kek_blob" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "rotated_at" TIMESTAMP(3),
    "retrieval_count" INTEGER NOT NULL DEFAULT 0,
    "last_retrieved_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultAuditEvent" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "emitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Credential_reference_key" ON "Credential"("reference");

-- CreateIndex
CREATE INDEX "Credential_account_id_idx" ON "Credential"("account_id");

-- CreateIndex
CREATE INDEX "Credential_subscription_id_idx" ON "Credential"("subscription_id");

-- CreateIndex
CREATE INDEX "Credential_deleted_at_idx" ON "Credential"("deleted_at");

-- CreateIndex
CREATE INDEX "VaultAuditEvent_account_id_emitted_at_idx" ON "VaultAuditEvent"("account_id", "emitted_at");

-- CreateIndex
CREATE INDEX "VaultAuditEvent_type_emitted_at_idx" ON "VaultAuditEvent"("type", "emitted_at");
