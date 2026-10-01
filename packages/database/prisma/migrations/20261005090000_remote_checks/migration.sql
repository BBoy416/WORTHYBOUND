-- ADR 0014: checks before buying, remotely.

-- CreateEnum
CREATE TYPE "PurchaseCheckKind" AS ENUM ('IN_PERSON', 'REMOTE');

-- AlterTable
ALTER TABLE "capture_sessions" ADD COLUMN     "purchaseCheckId" UUID;

-- AlterTable
ALTER TABLE "purchase_checks" ADD COLUMN     "kind" "PurchaseCheckKind" NOT NULL DEFAULT 'IN_PERSON';

-- CreateIndex
CREATE INDEX "capture_sessions_purchaseCheckId_idx" ON "capture_sessions"("purchaseCheckId");

-- AddForeignKey
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_purchaseCheckId_fkey" FOREIGN KEY ("purchaseCheckId") REFERENCES "purchase_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ────────────────────────────────────────────────────────────────

-- A remote check is confirmed by the seller's capture session, not by a signature; its code is
-- valid for as long as the check.
ALTER TABLE "purchase_checks"
  ADD CONSTRAINT "purchase_checks_remote_ck"
    CHECK ("kind" = 'IN_PERSON'
      OR ("ownerSignature" IS NULL AND "ownerCodeExpiresAt" = "expiresAt"));

-- One session completes a remote check.
CREATE UNIQUE INDEX "capture_sessions_purchaseCheckId_completed_key"
  ON "capture_sessions"("purchaseCheckId") WHERE "status" = 'COMPLETED';

-- The video shot is a video; every other shot is a photo.
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_capture_ck";
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_capture_ck"
    CHECK (("captureSessionId" IS NULL) = ("captureShot" IS NULL)
      AND ("captureSessionId" IS NULL OR ("source" = 'OWNER'
        AND (("captureShot" = 'VIDEO' AND "type" = 'VIDEO')
          OR ("captureShot" <> 'VIDEO' AND "type" = 'PHOTO')))));

ALTER TABLE "evidence_uploads" DROP CONSTRAINT "evidence_uploads_capture_ck";
ALTER TABLE "evidence_uploads"
  ADD CONSTRAINT "evidence_uploads_capture_ck"
    CHECK (("captureSessionId" IS NULL) = ("captureShot" IS NULL)
      AND ("captureSessionId" IS NULL OR ("verificationRequestId" IS NULL
        AND (("captureShot" = 'VIDEO' AND "type" = 'VIDEO')
          OR ("captureShot" <> 'VIDEO' AND "type" = 'PHOTO')))));

CREATE OR REPLACE FUNCTION wb_capture_session_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture sessions cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."ownerId", NEW."purchaseCheckId", NEW."code", NEW."shots", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."ownerId", OLD."purchaseCheckId", OLD."code", OLD."shots", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'capture session details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'capture session status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wb_purchase_check_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase checks cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."buyerId", NEW."kind", NEW."shots", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."assetId", OLD."buyerId", OLD."kind", OLD."shots", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'purchase check details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."ownerConfirmedAt" IS NOT NULL
     AND (NEW."ownerCode", NEW."ownerCodeExpiresAt", NEW."ownerConfirmedById", NEW."ownerSignature", NEW."ownerConfirmedAt")
         IS DISTINCT FROM (OLD."ownerCode", OLD."ownerCodeExpiresAt", OLD."ownerConfirmedById", OLD."ownerSignature", OLD."ownerConfirmedAt") THEN
    RAISE EXCEPTION 'an owner confirmation is final' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."kind" = 'REMOTE' AND (NEW."ownerCode", NEW."ownerCodeExpiresAt") IS DISTINCT FROM (OLD."ownerCode", OLD."ownerCodeExpiresAt") THEN
    RAISE EXCEPTION 'a remote check code cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."photosCompletedAt" IS NOT NULL AND NEW."photosCompletedAt" IS DISTINCT FROM OLD."photosCompletedAt" THEN
    RAISE EXCEPTION 'purchase check photos are final' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" <> 'OPEN'
     AND (NEW."status", NEW."itemResult", NEW."itemReason", NEW."itemSummary", NEW."itemConfidence",
          NEW."engine", NEW."model", NEW."checkVersion", NEW."referenceEvidenceIds", NEW."itemCheckedAt")
         IS DISTINCT FROM
         (OLD."status", OLD."itemResult", OLD."itemReason", OLD."itemSummary", OLD."itemConfidence",
          OLD."engine", OLD."model", OLD."checkVersion", OLD."referenceEvidenceIds", OLD."itemCheckedAt") THEN
    RAISE EXCEPTION 'purchase check status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;
