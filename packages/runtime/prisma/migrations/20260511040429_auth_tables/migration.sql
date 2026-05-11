-- CreateTable
CREATE TABLE "Session" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "jwt_id" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "agent_identity" TEXT,
    "agent_version" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" TEXT,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalToken" (
    "token" VARCHAR(64) NOT NULL,
    "run_id" VARCHAR(26) NOT NULL,
    "account_id" VARCHAR(26) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalToken_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_jwt_id_key" ON "Session"("jwt_id");

-- CreateIndex
CREATE INDEX "Session_account_id_revoked_at_idx" ON "Session"("account_id", "revoked_at");

-- CreateIndex
CREATE INDEX "Session_jwt_id_idx" ON "Session"("jwt_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_token_hash_key" ON "AgentSession"("token_hash");

-- CreateIndex
CREATE INDEX "AgentSession_account_id_revoked_at_idx" ON "AgentSession"("account_id", "revoked_at");

-- CreateIndex
CREATE INDEX "AgentSession_token_hash_idx" ON "AgentSession"("token_hash");

-- CreateIndex
CREATE INDEX "ApprovalToken_run_id_idx" ON "ApprovalToken"("run_id");

-- CreateIndex
CREATE INDEX "ApprovalToken_expires_at_idx" ON "ApprovalToken"("expires_at");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalToken" ADD CONSTRAINT "ApprovalToken_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
