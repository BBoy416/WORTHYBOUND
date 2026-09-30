-- ADR 0014: the buyer pays the seller in SOL in the transfer transaction.

-- AlterTable
ALTER TABLE "transfer_requests" ADD COLUMN     "priceLamports" BIGINT NOT NULL DEFAULT 0;

-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "transfer_requests"
  ADD CONSTRAINT "transfer_requests_price_ck" CHECK ("priceLamports" >= 0);

-- The price is agreed when the transfer starts; the buyer accepts and signs that price.
CREATE FUNCTION "transfer_requests_price_fixed"() RETURNS trigger AS $$
BEGIN
  IF NEW."priceLamports" IS DISTINCT FROM OLD."priceLamports" THEN
    RAISE EXCEPTION 'transfer price cannot change' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transfer_requests_price_fixed"
  BEFORE UPDATE ON "transfer_requests"
  FOR EACH ROW EXECUTE FUNCTION "transfer_requests_price_fixed"();
