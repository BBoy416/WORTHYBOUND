-- ADR 0013: deterministic checks (near-identical photos, reused document numbers).

-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "perceptualHash" BIGINT;

-- AlterTable
ALTER TABLE "automated_checks" ADD COLUMN     "documentNumberHash" TEXT;

-- CreateIndex
CREATE INDEX "automated_checks_documentNumberHash_idx" ON "automated_checks"("documentNumberHash");

-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "automated_checks" ADD CONSTRAINT "automated_checks_document_number_hash_ck"
  CHECK ("documentNumberHash" IS NULL OR "documentNumberHash" ~ '^[0-9a-f]{64}$');
