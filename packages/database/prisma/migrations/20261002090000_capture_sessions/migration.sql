-- ADR 0013: guided capture sessions.

-- CreateEnum
CREATE TYPE "CaptureSessionStatus" AS ENUM ('OPEN', 'COMPLETED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "ProvenanceEventType" ADD VALUE 'CAPTURE_COMPLETED';

-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "captureSessionId" UUID,
ADD COLUMN     "captureShot" TEXT;

-- AlterTable
ALTER TABLE "evidence_uploads" ADD COLUMN     "captureSessionId" UUID,
ADD COLUMN     "captureShot" TEXT;

-- CreateTable
CREATE TABLE "capture_sessions" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "shots" TEXT[],
    "status" "CaptureSessionStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "capture_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capture_sessions_assetId_createdAt_idx" ON "capture_sessions"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "capture_sessions_ownerId_createdAt_idx" ON "capture_sessions"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_captureSessionId_captureShot_key" ON "evidence"("captureSessionId", "captureShot");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "capture_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_uploads" ADD CONSTRAINT "evidence_uploads_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "capture_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_code_ck" CHECK ("code" ~ '^[A-HJKMNP-Z2-9]{6}$'),
  ADD CONSTRAINT "capture_sessions_shots_ck" CHECK (cardinality("shots") >= 1),
  ADD CONSTRAINT "capture_sessions_expiry_ck" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "capture_sessions_completed_ck"
    CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));

-- A shot belongs to a session; capture shots are owner photos.
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_capture_ck"
    CHECK (("captureSessionId" IS NULL) = ("captureShot" IS NULL)
      AND ("captureSessionId" IS NULL OR ("type" = 'PHOTO' AND "source" = 'OWNER')));

ALTER TABLE "evidence_uploads"
  ADD CONSTRAINT "evidence_uploads_capture_ck"
    CHECK (("captureSessionId" IS NULL) = ("captureShot" IS NULL)
      AND ("captureSessionId" IS NULL OR ("type" = 'PHOTO' AND "verificationRequestId" IS NULL)));

-- Sessions are never deleted; what they required is fixed, and a closed session stays closed.
CREATE FUNCTION wb_capture_session_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture sessions cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."ownerId", NEW."code", NEW."shots", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."ownerId", OLD."code", OLD."shots", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'capture session details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'capture session status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "capture_sessions_lock"
  BEFORE UPDATE OR DELETE ON "capture_sessions"
  FOR EACH ROW EXECUTE FUNCTION wb_capture_session_lock();

CREATE OR REPLACE FUNCTION wb_evidence_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."uploaderId", NEW."type", NEW."source", NEW."storageKey",
      NEW."sha256", NEW."mimeType", NEW."sizeBytes", NEW."originalFilename", NEW."description",
      NEW."capturedAt", NEW."duplicateOfId", NEW."verificationRequestId", NEW."captureSessionId",
      NEW."captureShot", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."uploaderId", OLD."type", OLD."source", OLD."storageKey",
      OLD."sha256", OLD."mimeType", OLD."sizeBytes", OLD."originalFilename", OLD."description",
      OLD."capturedAt", OLD."duplicateOfId", OLD."verificationRequestId", OLD."captureSessionId",
      OLD."captureShot", OLD."createdAt") THEN
    RAISE EXCEPTION 'evidence files and their details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."reviewStatus" <> 'PENDING'
     AND (NEW."reviewStatus", NEW."reviewedById", NEW."reviewedAt", NEW."reviewReason")
         IS DISTINCT FROM (OLD."reviewStatus", OLD."reviewedById", OLD."reviewedAt", OLD."reviewReason") THEN
    RAISE EXCEPTION 'an evidence review decision is final' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wb_evidence_upload_lock() RETURNS trigger
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
      NEW."capturedAt", NEW."verificationRequestId", NEW."captureSessionId", NEW."captureShot",
      NEW."stagingKey", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."uploaderId", OLD."type", OLD."mimeType", OLD."sizeBytes",
      OLD."sha256", OLD."visibility", OLD."originalFilename", OLD."description",
      OLD."capturedAt", OLD."verificationRequestId", OLD."captureSessionId", OLD."captureShot",
      OLD."stagingKey", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'evidence upload requests cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;
