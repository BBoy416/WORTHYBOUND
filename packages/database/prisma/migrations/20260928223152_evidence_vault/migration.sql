-- Evidence Vault. See docs/adr/0010-evidence-vault.md.
-- CreateEnum
CREATE TYPE "EvidenceUploadStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "EvidenceType" ADD VALUE 'SERVICE_RECORD';
ALTER TYPE "EvidenceType" ADD VALUE 'OWNERSHIP_DOCUMENT';
ALTER TYPE "EvidenceType" ADD VALUE 'MANUFACTURER_DOCUMENT';
ALTER TYPE "EvidenceType" ADD VALUE 'VIDEO';

-- AlterEnum
ALTER TYPE "ProvenanceEventType" ADD VALUE 'EVIDENCE_VISIBILITY_CHANGED';

-- DropIndex
DROP INDEX "evidence_assetId_idx";

-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "duplicateOfId" UUID,
ADD COLUMN     "publicStorageKey" TEXT;

-- CreateTable
CREATE TABLE "evidence_uploads" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "type" "EvidenceType" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "visibility" "EvidenceVisibility" NOT NULL,
    "originalFilename" TEXT,
    "description" TEXT,
    "capturedAt" TIMESTAMPTZ(3),
    "stagingKey" TEXT NOT NULL,
    "status" "EvidenceUploadStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "evidenceId" UUID,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "evidence_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "evidence_uploads_stagingKey_key" ON "evidence_uploads"("stagingKey");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_uploads_evidenceId_key" ON "evidence_uploads"("evidenceId");

-- CreateIndex
CREATE INDEX "evidence_uploads_assetId_status_idx" ON "evidence_uploads"("assetId", "status");

-- CreateIndex
CREATE INDEX "evidence_uploads_uploaderId_createdAt_idx" ON "evidence_uploads"("uploaderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_publicStorageKey_key" ON "evidence"("publicStorageKey");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_assetId_sha256_key" ON "evidence"("assetId", "sha256");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_uploads" ADD CONSTRAINT "evidence_uploads_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_uploads" ADD CONSTRAINT "evidence_uploads_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_uploads" ADD CONSTRAINT "evidence_uploads_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Evidence ─────────────────────────────────────────────────────────────────

ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_public_storage_key_not_url_ck"
    CHECK ("publicStorageKey" !~* '^[a-z][a-z0-9+.-]*://'),
  ADD CONSTRAINT "evidence_mime_type_ck" CHECK ("mimeType" IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
    'video/mp4', 'video/quicktime')),
  ADD CONSTRAINT "evidence_size_limit_ck" CHECK (
    "sizeBytes" <= CASE WHEN "mimeType" LIKE 'video/%' THEN 524288000 ELSE 26214400 END),
  -- Only photos whose metadata can be removed may be public, and only with a public copy.
  ADD CONSTRAINT "evidence_visibility_ck" CHECK (
    ("visibility" = 'PRIVATE' AND "publicStorageKey" IS NULL)
    OR ("visibility" = 'PUBLIC' AND "publicStorageKey" IS NOT NULL AND "type" = 'PHOTO'
        AND "mimeType" IN ('image/jpeg', 'image/png', 'image/webp'))),
  ADD CONSTRAINT "evidence_not_own_duplicate_ck" CHECK ("duplicateOfId" <> "id");

-- Once accepted, a file and what it claims to be never change, and evidence is never deleted.
-- Visibility may change; the review decision is made once.
CREATE FUNCTION wb_evidence_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."uploaderId", NEW."type", NEW."source", NEW."storageKey",
      NEW."sha256", NEW."mimeType", NEW."sizeBytes", NEW."originalFilename", NEW."description",
      NEW."capturedAt", NEW."duplicateOfId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."uploaderId", OLD."type", OLD."source", OLD."storageKey",
      OLD."sha256", OLD."mimeType", OLD."sizeBytes", OLD."originalFilename", OLD."description",
      OLD."capturedAt", OLD."duplicateOfId", OLD."createdAt") THEN
    RAISE EXCEPTION 'evidence files and their details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."reviewStatus" <> 'PENDING'
     AND (NEW."reviewStatus", NEW."reviewedById", NEW."reviewedAt")
         IS DISTINCT FROM (OLD."reviewStatus", OLD."reviewedById", OLD."reviewedAt") THEN
    RAISE EXCEPTION 'an evidence review decision is final' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "evidence_lock"
  BEFORE UPDATE OR DELETE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION wb_evidence_lock();

-- ─── Uploads ──────────────────────────────────────────────────────────────────

ALTER TABLE "evidence_uploads"
  ADD CONSTRAINT "evidence_uploads_sha256_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "evidence_uploads_size_ck" CHECK ("sizeBytes" > 0),
  ADD CONSTRAINT "evidence_uploads_staging_key_not_url_ck"
    CHECK ("stagingKey" !~* '^[a-z][a-z0-9+.-]*://'),
  ADD CONSTRAINT "evidence_uploads_status_ck" CHECK (
    ("status" = 'PENDING' AND "evidenceId" IS NULL AND "completedAt" IS NULL
      AND "failureReason" IS NULL)
    OR ("status" = 'COMPLETED' AND "evidenceId" IS NOT NULL AND "completedAt" IS NOT NULL
      AND "failureReason" IS NULL)
    OR ("status" = 'FAILED' AND "evidenceId" IS NULL AND "completedAt" IS NOT NULL
      AND "failureReason" IS NOT NULL));

-- An upload is completed or failed once; what was requested never changes.
CREATE FUNCTION wb_evidence_upload_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence uploads cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'evidence upload status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."uploaderId", NEW."type", NEW."mimeType", NEW."sizeBytes",
      NEW."sha256", NEW."visibility", NEW."originalFilename", NEW."description",
      NEW."capturedAt", NEW."stagingKey", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."uploaderId", OLD."type", OLD."mimeType", OLD."sizeBytes",
      OLD."sha256", OLD."visibility", OLD."originalFilename", OLD."description",
      OLD."capturedAt", OLD."stagingKey", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'evidence upload requests cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "evidence_uploads_lock"
  BEFORE UPDATE OR DELETE ON "evidence_uploads"
  FOR EACH ROW EXECUTE FUNCTION wb_evidence_upload_lock();
