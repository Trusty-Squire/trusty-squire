-- CreateTable
CREATE TABLE "AdapterManifestRecord" (
    "service" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest_json" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "signed_by" TEXT NOT NULL,
    "disabled_at" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdapterManifestRecord_pkey" PRIMARY KEY ("service","version")
);

-- CreateIndex
CREATE INDEX "AdapterManifestRecord_service_idx" ON "AdapterManifestRecord"("service");

-- CreateIndex
CREATE INDEX "AdapterManifestRecord_disabled_at_idx" ON "AdapterManifestRecord"("disabled_at");
