-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ios', 'android', 'web');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'cancelled', 'paused', 'failed');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('CREATED', 'MANDATE_VALIDATED', 'PENDING_APPROVAL', 'PROVISIONING', 'ADAPTER_EXECUTING', 'CRED_EXTRACTED', 'VAULT_WRITTEN', 'TIER_ESCALATING', 'COMPENSATING', 'COMPLETE', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "Account" (
    "id" VARCHAR(26) NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "default_vault" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "role" "MemberRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "vouchflow_token" TEXT,
    "webauthn_credential_id" TEXT,
    "attestation_chain" JSONB,
    "public_key" TEXT NOT NULL,
    "display_name" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandate" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "monthly_budget_cents" INTEGER NOT NULL,
    "daily_silent_max_cents" INTEGER NOT NULL,
    "per_action_silent_max_cents" INTEGER NOT NULL,
    "per_subscription_max_cents" INTEGER NOT NULL,
    "allowed_categories" TEXT[],
    "allowed_services" TEXT[],
    "blocked_services" TEXT[],
    "step_up_triggers" JSONB NOT NULL,
    "silently_approved_services" JSONB NOT NULL,
    "confidence_requirements" JSONB NOT NULL,
    "signing_devices" JSONB NOT NULL,
    "not_before" TIMESTAMP(3) NOT NULL,
    "not_after" TIMESTAMP(3) NOT NULL,
    "signature" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "signing_device_id" VARCHAR(26) NOT NULL,
    "superseded_by" VARCHAR(26),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "service" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "monthly_cents" INTEGER NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),
    "next_renewal" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "project_name" TEXT NOT NULL,
    "user_facing_purpose" TEXT,
    "state" "RunState" NOT NULL,
    "state_entered_at" TIMESTAMP(3) NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "mandate_id" VARCHAR(26) NOT NULL,
    "delta_mandate_id" VARCHAR(26),
    "adapter_id" TEXT NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "current_tier" INTEGER NOT NULL DEFAULT 1,
    "steps" JSONB NOT NULL,
    "side_effects" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "credentials" JSONB,
    "subscription_id" VARCHAR(26),
    "failure_reason" TEXT,
    "failure_detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" VARCHAR(26) NOT NULL,
    "run_id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "type" TEXT NOT NULL,
    "from_state" "RunState" NOT NULL,
    "to_state" "RunState" NOT NULL,
    "payload" JSONB NOT NULL,
    "emitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAlias" (
    "id" VARCHAR(26) NOT NULL,
    "alias" TEXT NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "run_id" VARCHAR(26),
    "service" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsedNonce" (
    "nonce" TEXT NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "context" TEXT NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsedNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");

-- CreateIndex
CREATE INDEX "Member_account_id_idx" ON "Member"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Member_account_id_email_key" ON "Member"("account_id", "email");

-- CreateIndex
CREATE INDEX "Device_account_id_idx" ON "Device"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Device_account_id_webauthn_credential_id_key" ON "Device"("account_id", "webauthn_credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "Device_account_id_vouchflow_token_key" ON "Device"("account_id", "vouchflow_token");

-- CreateIndex
CREATE INDEX "Mandate_account_id_not_after_idx" ON "Mandate"("account_id", "not_after");

-- CreateIndex
CREATE INDEX "Subscription_account_id_service_idx" ON "Subscription"("account_id", "service");

-- CreateIndex
CREATE INDEX "Subscription_account_id_status_idx" ON "Subscription"("account_id", "status");

-- CreateIndex
CREATE INDEX "Run_state_state_entered_at_idx" ON "Run"("state", "state_entered_at");

-- CreateIndex
CREATE INDEX "Run_account_id_created_at_idx" ON "Run"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Run_account_id_idempotency_key_key" ON "Run"("account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "RunEvent_run_id_emitted_at_idx" ON "RunEvent"("run_id", "emitted_at");

-- CreateIndex
CREATE INDEX "RunEvent_account_id_emitted_at_idx" ON "RunEvent"("account_id", "emitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAlias_alias_key" ON "EmailAlias"("alias");

-- CreateIndex
CREATE INDEX "EmailAlias_account_id_service_idx" ON "EmailAlias"("account_id", "service");

-- CreateIndex
CREATE INDEX "EmailAlias_active_expires_at_idx" ON "EmailAlias"("active", "expires_at");

-- CreateIndex
CREATE INDEX "UsedNonce_expires_at_idx" ON "UsedNonce"("expires_at");

-- CreateIndex
CREATE INDEX "UsedNonce_account_id_used_at_idx" ON "UsedNonce"("account_id", "used_at");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_mandate_id_fkey" FOREIGN KEY ("mandate_id") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAlias" ADD CONSTRAINT "EmailAlias_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
