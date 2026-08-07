-- Shared Operator Recipes — replay-registry-share. A recipe recorded by one
-- install becomes reusable by the next install to visit the same site,
-- keyed by (verb, eTLD+1). See OperatorRecipeRecord in schema.prisma.
CREATE TABLE "OperatorRecipeRecord" (
    "key" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorRecipeRecord_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "OperatorRecipeRecord_domain_idx" ON "OperatorRecipeRecord"("domain");
