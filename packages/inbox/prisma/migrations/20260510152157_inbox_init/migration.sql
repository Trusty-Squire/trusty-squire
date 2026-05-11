-- CreateTable
CREATE TABLE "ReceivedEmail" (
    "id" VARCHAR(26) NOT NULL,
    "alias" TEXT NOT NULL,
    "associated_run_id" VARCHAR(26),
    "message_id" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "from_domain" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "s3_raw_uri" TEXT NOT NULL,
    "body_text" TEXT,
    "body_html" TEXT,
    "parsed_links" TEXT[],
    "parsed_codes" TEXT[],
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),
    "body_purged_at" TIMESTAMP(3),

    CONSTRAINT "ReceivedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAlias" (
    "alias" TEXT NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "run_id" VARCHAR(26) NOT NULL,
    "service" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "inbound_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAlias_pkey" PRIMARY KEY ("alias")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceivedEmail_message_id_key" ON "ReceivedEmail"("message_id");

-- CreateIndex
CREATE INDEX "ReceivedEmail_alias_received_at_idx" ON "ReceivedEmail"("alias", "received_at");

-- CreateIndex
CREATE INDEX "ReceivedEmail_associated_run_id_idx" ON "ReceivedEmail"("associated_run_id");

-- CreateIndex
CREATE INDEX "EmailAlias_account_id_idx" ON "EmailAlias"("account_id");

-- CreateIndex
CREATE INDEX "EmailAlias_run_id_idx" ON "EmailAlias"("run_id");
