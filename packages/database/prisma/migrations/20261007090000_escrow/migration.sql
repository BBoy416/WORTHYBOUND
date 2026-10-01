-- ADR 0014: escrowed transfers of shipped items.

-- CreateEnum
CREATE TYPE "TransferDelivery" AS ENUM ('IN_PERSON', 'SHIPPED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('AWAITING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'RELEASING', 'RELEASED', 'REFUNDING', 'REFUNDED');

-- AlterEnum
ALTER TYPE "ChainTransactionKind" ADD VALUE 'ESCROW_PAYMENT';
ALTER TYPE "ChainTransactionKind" ADD VALUE 'ESCROW_REFUND';

-- AlterEnum
ALTER TYPE "PurchaseCheckKind" ADD VALUE 'RECEIPT';

-- AlterTable
ALTER TABLE "capture_sessions" ADD COLUMN     "transferRequestId" UUID;

-- AlterTable
ALTER TABLE "purchase_checks" ADD COLUMN     "transferRequestId" UUID;

-- AlterTable
ALTER TABLE "transfer_requests" ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMPTZ(3),
ADD COLUMN     "delivery" "TransferDelivery" NOT NULL DEFAULT 'IN_PERSON',
ADD COLUMN     "deliveryDueAt" TIMESTAMPTZ(3),
ADD COLUMN     "deliveryExtensions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "disputedAt" TIMESTAMPTZ(3),
ADD COLUMN     "escrowStatus" "EscrowStatus",
ADD COLUMN     "paidAt" TIMESTAMPTZ(3),
ADD COLUMN     "paymentNonceAccount" TEXT,
ADD COLUMN     "paymentSignature" TEXT,
ADD COLUMN     "paymentTransaction" TEXT,
ADD COLUMN     "releaseAt" TIMESTAMPTZ(3),
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMPTZ(3),
ADD COLUMN     "resolvedById" UUID,
ADD COLUMN     "shipBy" TIMESTAMPTZ(3),
ADD COLUMN     "shippedAt" TIMESTAMPTZ(3),
ADD COLUMN     "trackingNumber" TEXT;

-- CreateIndex
CREATE INDEX "capture_sessions_transferRequestId_idx" ON "capture_sessions"("transferRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_checks_transferRequestId_key" ON "purchase_checks"("transferRequestId");

-- CreateIndex
CREATE INDEX "transfer_requests_escrowStatus_idx" ON "transfer_requests"("escrowStatus");

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "transfer_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_checks" ADD CONSTRAINT "purchase_checks_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "transfer_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ────────────────────────────────────────────────────────────────
-- Values added to existing enums above cannot be used in this transaction, so they are compared
-- as text.

ALTER TABLE "transfer_requests"
  ADD CONSTRAINT "transfer_requests_escrow_delivery_ck"
    CHECK ("delivery" = 'SHIPPED'
      OR ("escrowStatus" IS NULL AND "paymentNonceAccount" IS NULL AND "paidAt" IS NULL
        AND "shippedAt" IS NULL AND "deliveredAt" IS NULL)),
  ADD CONSTRAINT "transfer_requests_escrow_accepted_ck"
    CHECK ("delivery" = 'IN_PERSON' OR ("escrowStatus" IS NULL) = ("acceptedAt" IS NULL)),
  ADD CONSTRAINT "transfer_requests_escrow_paid_ck"
    CHECK ("escrowStatus" IS NULL OR "escrowStatus" = 'AWAITING_PAYMENT'
      OR ("paidAt" IS NOT NULL AND "shipBy" IS NOT NULL)),
  ADD CONSTRAINT "transfer_requests_escrow_shipped_ck"
    CHECK ("escrowStatus" IS NULL OR "escrowStatus" NOT IN ('SHIPPED', 'DELIVERED')
      OR ("shippedAt" IS NOT NULL AND "carrier" IS NOT NULL AND "trackingNumber" IS NOT NULL
        AND "deliveryDueAt" IS NOT NULL)),
  ADD CONSTRAINT "transfer_requests_escrow_delivered_ck"
    CHECK ("escrowStatus" IS DISTINCT FROM 'DELIVERED'
      OR ("deliveredAt" IS NOT NULL AND "releaseAt" IS NOT NULL)),
  ADD CONSTRAINT "transfer_requests_escrow_disputed_ck"
    CHECK ("escrowStatus" IS DISTINCT FROM 'DISPUTED'
      OR ("disputedAt" IS NOT NULL AND "disputeReason" IS NOT NULL)),
  ADD CONSTRAINT "transfer_requests_escrow_released_ck"
    CHECK ("delivery" = 'IN_PERSON' OR "escrowStatus" IS NULL
      OR ("status" = 'COMPLETED') = ("escrowStatus" = 'RELEASED')),
  ADD CONSTRAINT "transfer_requests_escrow_refunded_ck"
    CHECK ("escrowStatus" IS DISTINCT FROM 'REFUNDED' OR "status" = 'CANCELLED'),
  ADD CONSTRAINT "transfer_requests_delivery_extensions_ck"
    CHECK ("deliveryExtensions" BETWEEN 0 AND 3),
  ADD CONSTRAINT "transfer_requests_resolution_ck"
    CHECK (("resolvedById" IS NULL) = ("resolvedAt" IS NULL)
      AND ("resolvedById" IS NULL) = ("resolution" IS NULL));

-- The delivery is agreed when the transfer starts; a released or refunded escrow is final.
CREATE FUNCTION "transfer_requests_escrow_lock"() RETURNS trigger AS $$
BEGIN
  IF NEW."delivery" IS DISTINCT FROM OLD."delivery" THEN
    RAISE EXCEPTION 'transfer delivery cannot change' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."escrowStatus" IN ('RELEASED', 'REFUNDED')
     AND NEW."escrowStatus" IS DISTINCT FROM OLD."escrowStatus" THEN
    RAISE EXCEPTION 'escrow status % is final', OLD."escrowStatus" USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transfer_requests_escrow_lock"
  BEFORE UPDATE ON "transfer_requests"
  FOR EACH ROW EXECUTE FUNCTION "transfer_requests_escrow_lock"();

-- A session is filmed for a remote check, for a shipment, or for the owner.
ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_purpose_ck"
    CHECK ("purchaseCheckId" IS NULL OR "transferRequestId" IS NULL);

-- Receipt checks, and only they, belong to a transfer.
ALTER TABLE "purchase_checks"
  ADD CONSTRAINT "purchase_checks_receipt_ck"
    CHECK (("kind"::text = 'RECEIPT') = ("transferRequestId" IS NOT NULL));

CREATE OR REPLACE FUNCTION wb_capture_session_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture sessions cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."ownerId", NEW."purchaseCheckId", NEW."transferRequestId", NEW."code", NEW."shots", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."ownerId", OLD."purchaseCheckId", OLD."transferRequestId", OLD."code", OLD."shots", OLD."expiresAt", OLD."createdAt") THEN
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
  IF (NEW."id", NEW."assetId", NEW."buyerId", NEW."kind", NEW."shots", NEW."transferRequestId", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."assetId", OLD."buyerId", OLD."kind", OLD."shots", OLD."transferRequestId", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'purchase check details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."ownerConfirmedAt" IS NOT NULL
     AND (NEW."ownerCode", NEW."ownerCodeExpiresAt", NEW."ownerConfirmedById", NEW."ownerSignature", NEW."ownerConfirmedAt")
         IS DISTINCT FROM (OLD."ownerCode", OLD."ownerCodeExpiresAt", OLD."ownerConfirmedById", OLD."ownerSignature", OLD."ownerConfirmedAt") THEN
    RAISE EXCEPTION 'an owner confirmation is final' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."kind"::text IN ('REMOTE', 'RECEIPT')
     AND (NEW."ownerCode", NEW."ownerCodeExpiresAt") IS DISTINCT FROM (OLD."ownerCode", OLD."ownerCodeExpiresAt") THEN
    RAISE EXCEPTION 'a remote or receipt check code cannot be changed' USING ERRCODE = 'WB002';
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
