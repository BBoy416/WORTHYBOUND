-- ADR 0009: the profile photo, chosen by the owner, is shown first on the passport and as the
-- token's image. Publishing requires one; the API enforces that, since earlier passports have none.

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "profileEvidenceId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "assets_profileEvidenceId_key" ON "assets"("profileEvidenceId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_profileEvidenceId_fkey" FOREIGN KEY ("profileEvidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ────────────────────────────────────────────────────────────────

-- The profile photo is a public photo of the same asset.
CREATE FUNCTION wb_asset_profile_photo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."profileEvidenceId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "evidence"
    WHERE "id" = NEW."profileEvidenceId" AND "assetId" = NEW."id" AND "visibility" = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'the profile photo must be a public photo of the asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assets_profile_photo"
  BEFORE INSERT OR UPDATE OF "profileEvidenceId" ON "assets"
  FOR EACH ROW EXECUTE FUNCTION wb_asset_profile_photo();

-- A profile photo stays public.
CREATE FUNCTION wb_evidence_profile_public() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."visibility" <> 'PUBLIC'
     AND EXISTS (SELECT 1 FROM "assets" WHERE "profileEvidenceId" = NEW."id") THEN
    RAISE EXCEPTION 'a profile photo cannot be made private' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "evidence_profile_public"
  BEFORE UPDATE OF "visibility" ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION wb_evidence_profile_public();
