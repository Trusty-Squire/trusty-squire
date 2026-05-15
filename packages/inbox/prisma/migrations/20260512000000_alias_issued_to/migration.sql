-- Add the owning-principal column for alias ownership enforcement.
-- Nullable: existing rows predate the column and have no owner recorded;
-- the inbox API treats a null owner as "unowned" (permissive) so legacy
-- aliases keep working.
ALTER TABLE "EmailAlias" ADD COLUMN "issued_to" TEXT;
