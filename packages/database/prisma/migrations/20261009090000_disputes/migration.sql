-- ADR 0017: disputes about an asset, an attestation or an evidence item, decided by administrators.

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "assetStatusBefore" "AssetStatus",
ADD COLUMN     "holdsAsset" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedById" UUID;

-- CreateIndex
CREATE INDEX "disputes_status_createdAt_idx" ON "disputes"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_review_ck"
    CHECK (("reviewedAt" IS NULL) = ("reviewedById" IS NULL)
      AND ("status" <> 'OPEN' OR "reviewedAt" IS NULL)
      AND ("status" NOT IN ('UNDER_REVIEW', 'UPHELD') OR "reviewedAt" IS NOT NULL)),
  ADD CONSTRAINT "disputes_no_self_review_ck"
    CHECK ("reviewedById" IS NULL OR "reviewedById" <> "openedById"),
  ADD CONSTRAINT "disputes_resolution_ck"
    CHECK (("status" IN ('UPHELD', 'REJECTED')
        AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolution" IS NOT NULL)
      OR ("status" = 'WITHDRAWN'
        AND "resolvedById" IS NULL AND "resolvedAt" IS NOT NULL AND "resolution" IS NULL)
      OR ("status" IN ('OPEN', 'UNDER_REVIEW')
        AND "resolvedById" IS NULL AND "resolvedAt" IS NULL AND "resolution" IS NULL)),
  ADD CONSTRAINT "disputes_hold_ck"
    CHECK (("holdsAsset" = ("assetStatusBefore" IS NOT NULL))
      AND (NOT "holdsAsset" OR "reviewedAt" IS NOT NULL)
      AND ("assetStatusBefore" IS NULL
        OR "assetStatusBefore" IN ('ACTIVE', 'VERIFIED', 'REVERIFICATION_REQUIRED', 'TRANSFER_PENDING')));

-- One open dispute per person and target (the asset itself, an attestation or an evidence item).
CREATE UNIQUE INDEX "disputes_one_open_per_opener_idx" ON "disputes" (
  "openedById", "assetId",
  COALESCE("attestationId", "evidenceId", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "status" IN ('OPEN', 'UNDER_REVIEW');

-- At most one dispute under review holds an asset.
CREATE UNIQUE INDEX "disputes_one_hold_per_asset_idx" ON "disputes" ("assetId")
  WHERE "holdsAsset" AND "status" = 'UNDER_REVIEW';

-- Disputes are never deleted; who opened one, about what and why is fixed, the target belongs to
-- the asset, and a decided or withdrawn dispute stays closed.
CREATE FUNCTION wb_dispute_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disputes cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."attestationId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "attestations" WHERE "id" = NEW."attestationId" AND "assetId" = NEW."assetId"
    ) OR NEW."evidenceId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "evidence" WHERE "id" = NEW."evidenceId" AND "assetId" = NEW."assetId"
    ) THEN
      RAISE EXCEPTION 'a dispute target must belong to the disputed asset' USING ERRCODE = 'WB002';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."assetId", NEW."attestationId", NEW."evidenceId", NEW."openedById",
      NEW."reason", NEW."details", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."attestationId", OLD."evidenceId", OLD."openedById",
      OLD."reason", OLD."details", OLD."createdAt") THEN
    RAISE EXCEPTION 'dispute details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" IN ('UPHELD', 'REJECTED', 'WITHDRAWN') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'dispute status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "disputes_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "disputes"
  FOR EACH ROW EXECUTE FUNCTION wb_dispute_lock();
