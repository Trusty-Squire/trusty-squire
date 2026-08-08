-- Shared Operator Recipes — replay-serve-live-domainlock. A recipe recorded
-- by one install becomes reusable by the next install to visit the same
-- site the instant POST /recipes accepts it — no candidate/promotion tier.
-- Safety is the hard domain-lock (recipeDomainLockViolations in
-- @trusty-squire/recipe-schema), not a housekeeper-vetted gate. See
-- OperatorRecipeRecord in schema.prisma.
CREATE TABLE "OperatorRecipeRecord" (
    "key" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorRecipeRecord_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "OperatorRecipeRecord_domain_idx" ON "OperatorRecipeRecord"("domain");
