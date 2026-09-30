-- ADR 0014: checks before buying, in person.

-- CreateEnum
CREATE TYPE "PurchaseCheckStatus" AS ENUM ('OPEN', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ItemMatchResult" AS ENUM ('MATCH', 'NO_MATCH', 'INCONCLUSIVE');

-- AlterEnum
ALTER TYPE "AutomatedJobKind" ADD VALUE 'ITEM_MATCH';

-- CreateTable
CREATE TABLE "purchase_checks" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "ownerCode" TEXT NOT NULL,
    "ownerCodeExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "ownerConfirmedById" UUID,
    "ownerSignature" TEXT,
    "ownerConfirmedAt" TIMESTAMPTZ(3),
    "shots" TEXT[],
    "status" "PurchaseCheckStatus" NOT NULL DEFAULT 'OPEN',
    "photosCompletedAt" TIMESTAMPTZ(3),
    "itemResult" "ItemMatchResult",
    "itemReason" TEXT,
    "itemSummary" TEXT,
    "itemConfidence" DOUBLE PRECISION,
    "engine" TEXT,
    "model" TEXT,
    "checkVersion" TEXT,
    "referenceEvidenceIds" TEXT[],
    "itemCheckedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_check_photos" (
    "id" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "shot" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_check_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_checks_assetId_createdAt_idx" ON "purchase_checks"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "purchase_checks_buyerId_createdAt_idx" ON "purchase_checks"("buyerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_check_photos_storageKey_key" ON "purchase_check_photos"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_check_photos_checkId_shot_key" ON "purchase_check_photos"("checkId", "shot");

-- AddForeignKey
ALTER TABLE "purchase_checks" ADD CONSTRAINT "purchase_checks_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_checks" ADD CONSTRAINT "purchase_checks_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_checks" ADD CONSTRAINT "purchase_checks_ownerConfirmedById_fkey" FOREIGN KEY ("ownerConfirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_check_photos" ADD CONSTRAINT "purchase_check_photos_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "purchase_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "purchase_checks"
  ADD CONSTRAINT "purchase_checks_owner_code_ck" CHECK ("ownerCode" ~ '^[A-HJKMNP-Z2-9]{6}$'),
  ADD CONSTRAINT "purchase_checks_shots_ck" CHECK (cardinality("shots") >= 1),
  ADD CONSTRAINT "purchase_checks_expiry_ck"
    CHECK ("expiresAt" > "createdAt" AND "ownerCodeExpiresAt" > "createdAt"),
  ADD CONSTRAINT "purchase_checks_owner_confirmed_ck"
    CHECK (("ownerConfirmedById" IS NULL) = ("ownerSignature" IS NULL)
      AND ("ownerConfirmedById" IS NULL) = ("ownerConfirmedAt" IS NULL)),
  ADD CONSTRAINT "purchase_checks_buyer_not_owner_ck"
    CHECK ("ownerConfirmedById" IS NULL OR "ownerConfirmedById" <> "buyerId"),
  ADD CONSTRAINT "purchase_checks_result_ck"
    CHECK (("status" = 'COMPLETED') = ("itemResult" IS NOT NULL)
      AND ("itemResult" IS NULL) = ("itemCheckedAt" IS NULL)
      AND ("itemResult" IS NULL OR "photosCompletedAt" IS NOT NULL)),
  ADD CONSTRAINT "purchase_checks_reason_ck"
    CHECK ("itemReason" IS NULL OR "itemResult" = 'INCONCLUSIVE'),
  ADD CONSTRAINT "purchase_checks_confidence_ck"
    CHECK ("itemConfidence" IS NULL OR ("itemConfidence" >= 0 AND "itemConfidence" <= 1));

-- Checks are never deleted. What was asked is fixed; the owner's confirmation and the item
-- result are recorded once, and a closed check stays closed.
CREATE FUNCTION wb_purchase_check_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase checks cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."buyerId", NEW."shots", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."assetId", OLD."buyerId", OLD."shots", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'purchase check details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."ownerConfirmedAt" IS NOT NULL
     AND (NEW."ownerCode", NEW."ownerCodeExpiresAt", NEW."ownerConfirmedById", NEW."ownerSignature", NEW."ownerConfirmedAt")
         IS DISTINCT FROM (OLD."ownerCode", OLD."ownerCodeExpiresAt", OLD."ownerConfirmedById", OLD."ownerSignature", OLD."ownerConfirmedAt") THEN
    RAISE EXCEPTION 'an owner confirmation is final' USING ERRCODE = 'WB002';
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

CREATE TRIGGER "purchase_checks_lock"
  BEFORE UPDATE OR DELETE ON "purchase_checks"
  FOR EACH ROW EXECUTE FUNCTION wb_purchase_check_lock();

ALTER TABLE "purchase_check_photos"
  ADD CONSTRAINT "purchase_check_photos_sha256_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "purchase_check_photos_size_ck" CHECK ("sizeBytes" > 0);

CREATE FUNCTION wb_purchase_check_photo_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'purchase check photos cannot be changed or deleted' USING ERRCODE = 'WB002';
END;
$$;

CREATE TRIGGER "purchase_check_photos_lock"
  BEFORE UPDATE OR DELETE ON "purchase_check_photos"
  FOR EACH ROW EXECUTE FUNCTION wb_purchase_check_photo_lock();
