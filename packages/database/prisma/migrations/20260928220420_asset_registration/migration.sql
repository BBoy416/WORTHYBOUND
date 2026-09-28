-- Asset registration and passports. See docs/adr/0009-asset-registration.md.

-- AlterEnum
ALTER TYPE "ProvenanceEventType" ADD VALUE 'DETAILS_UPDATED';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "publishedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_userId_scope_key_key" ON "idempotency_keys"("userId", "scope", "key");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Serial numbers ───────────────────────────────────────────────────────────

-- A serial number is always stored with its fingerprint and key version, and never without.
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_serial_fingerprint_ck" CHECK (
    ("serialNumber" IS NULL AND "serialFingerprint" IS NULL AND "serialFingerprintKeyVersion" IS NULL)
    OR ("serialNumber" IS NOT NULL AND "serialFingerprint" IS NOT NULL
        AND "serialFingerprintKeyVersion" IS NOT NULL
        AND "serialFingerprint" ~ '^[0-9a-f]{64}$' AND "serialFingerprintKeyVersion" >= 1)
  );

-- The same item cannot be registered twice. REVOKED assets release their serial.
CREATE UNIQUE INDEX "assets_serial_fingerprint_active_key"
  ON "assets" ("serialFingerprint") WHERE "serialFingerprint" IS NOT NULL AND "status" <> 'REVOKED';

-- ─── Publication ──────────────────────────────────────────────────────────────

-- Every status past DRAFT/TOKENIZED is a published passport; REVOKED may be a discarded draft.
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_published_ck"
    CHECK ("status" IN ('DRAFT', 'TOKENIZED', 'REVOKED') OR "publishedAt" IS NOT NULL);

-- Once published, the fields that identify the physical item cannot change, so one item's
-- record cannot be moved onto another. The WorthyBound ID never changes; REVOKED is final.
CREATE FUNCTION wb_asset_identity_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assets cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF NEW."wbId" IS DISTINCT FROM OLD."wbId" THEN
    RAISE EXCEPTION 'the WorthyBound ID cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" = 'REVOKED' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'asset status REVOKED is final' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."publishedAt" IS NOT NULL THEN
    IF NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
      RAISE EXCEPTION 'publishedAt cannot be changed once set' USING ERRCODE = 'WB002';
    END IF;
    IF (NEW."category", NEW."brand", NEW."model", NEW."serialNumber")
       IS DISTINCT FROM (OLD."category", OLD."brand", OLD."model", OLD."serialNumber") THEN
      RAISE EXCEPTION 'identity fields of a published asset are locked' USING ERRCODE = 'WB002';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "assets_identity_lock"
  BEFORE UPDATE OR DELETE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION wb_asset_identity_lock();

-- ─── Idempotency keys ─────────────────────────────────────────────────────────

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_key_ck" CHECK ("key" ~ '^[A-Za-z0-9_-]{8,128}$'),
  ADD CONSTRAINT "idempotency_keys_request_hash_ck" CHECK ("requestHash" ~ '^[0-9a-f]{64}$');
