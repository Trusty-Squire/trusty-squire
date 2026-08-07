-- Shared Operator Recipes — replay-registry-share. A recipe recorded by one
-- install becomes reusable by the next install to visit the same site,
-- keyed by (verb, eTLD+1). Two tables, not one: unauthenticated writes land
-- in the candidate table (never replayed, so last-write-wins is safe);
-- only an admin-bearer-gated promotion moves a candidate into the live
-- table that operate_use / GET /recipes actually reads. See
-- OperatorRecipeCandidateRecord + OperatorRecipeRecord in schema.prisma.
CREATE TABLE "OperatorRecipeCandidateRecord" (
    "key" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorRecipeCandidateRecord_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "OperatorRecipeCandidateRecord_domain_idx" ON "OperatorRecipeCandidateRecord"("domain");

CREATE TABLE "OperatorRecipeRecord" (
    "key" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "promoted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promoted_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorRecipeRecord_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "OperatorRecipeRecord_domain_idx" ON "OperatorRecipeRecord"("domain");
