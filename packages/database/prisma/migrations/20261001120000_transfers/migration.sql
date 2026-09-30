-- ADR 0002: controlled transfers with a durable nonce transaction signed by seller and buyer.

-- AlterTable
ALTER TABLE "transfer_requests" ADD COLUMN     "buyerSignature" TEXT,
ADD COLUMN     "closedReason" TEXT,
ADD COLUMN     "nonceAccount" TEXT,
ADD COLUMN     "sellerSignature" TEXT,
ADD COLUMN     "statusBefore" "AssetStatus",
ADD COLUMN     "statusSeq" INTEGER,
ADD COLUMN     "transaction" TEXT;

-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "transfer_requests"
  ADD CONSTRAINT "transfer_requests_status_before_ck"
    CHECK ("statusBefore" IS NULL OR "statusBefore" IN ('ACTIVE', 'VERIFIED', 'REVERIFICATION_REQUIRED')),
  ADD CONSTRAINT "transfer_requests_transaction_ck"
    CHECK (("transaction" IS NULL) = ("nonceAccount" IS NULL) AND ("transaction" IS NULL) = ("statusSeq" IS NULL)),
  ADD CONSTRAINT "transfer_requests_signatures_ck"
    CHECK ("transaction" IS NOT NULL OR ("sellerSignature" IS NULL AND "buyerSignature" IS NULL)),
  ADD CONSTRAINT "transfer_requests_completed_ck"
    CHECK ("status" <> 'COMPLETED' OR ("completedAt" IS NOT NULL AND "sellerSignature" IS NOT NULL AND "buyerSignature" IS NOT NULL));
