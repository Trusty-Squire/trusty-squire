-- Closed-loop remediation T10: heal-pass heartbeat for the admin status panel.
CREATE TABLE "HealRun" (
    "id" TEXT NOT NULL,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified" INTEGER NOT NULL,
    "demoted" INTEGER NOT NULL,
    "quarantined" INTEGER NOT NULL,
    "reskilled" INTEGER NOT NULL,
    "needs_human" INTEGER NOT NULL,
    "mcp_version" TEXT,
    CONSTRAINT "HealRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HealRun_ran_at_idx" ON "HealRun"("ran_at" DESC);
