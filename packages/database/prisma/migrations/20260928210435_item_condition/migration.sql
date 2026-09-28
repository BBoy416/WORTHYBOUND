-- Item condition: owner-stated on the asset, assessed on CONDITION attestations.
-- See docs/adr/0007-item-condition.md.

-- CreateEnum
CREATE TYPE "ItemCondition" AS ENUM ('NEW', 'EXCELLENT', 'VERY_GOOD', 'GOOD', 'FAIR', 'POOR', 'FOR_PARTS');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "condition" "ItemCondition";

-- AlterTable
ALTER TABLE "attestations" ADD COLUMN     "conditionGrade" "ItemCondition";

-- A condition grade belongs only to CONDITION claims and is required when one is confirmed.
ALTER TABLE "attestations"
  ADD CONSTRAINT "attestations_condition_grade_ck" CHECK (
    ("conditionGrade" IS NULL OR "claimType" = 'CONDITION')
    AND ("claimType" <> 'CONDITION' OR "result" <> 'CONFIRMED' OR "conditionGrade" IS NOT NULL)
  );

-- The assessed grade is part of the signed claim and is immutable like the other claim fields.
CREATE OR REPLACE FUNCTION wb_attestation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attestations cannot be deleted; revoke them instead' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."assetId", NEW."verifierId", NEW."verificationRequestId", NEW."templateVersionId", NEW."claimType",
      NEW."result", NEW."method", NEW."assuranceLevel", NEW."conditionGrade", NEW."notes", NEW."nonce",
      NEW."signedPayloadHash", NEW."signature", NEW."issuedAt", NEW."expiresAt", NEW."supersedesId",
      NEW."createdAt")
     IS DISTINCT FROM
     (OLD."assetId", OLD."verifierId", OLD."verificationRequestId", OLD."templateVersionId", OLD."claimType",
      OLD."result", OLD."method", OLD."assuranceLevel", OLD."conditionGrade", OLD."notes", OLD."nonce",
      OLD."signedPayloadHash", OLD."signature", OLD."issuedAt", OLD."expiresAt", OLD."supersedesId",
      OLD."createdAt") THEN
    RAISE EXCEPTION 'attestation claims are immutable; only status may change' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."chainAttestationAddress" IS NOT NULL
     AND NEW."chainAttestationAddress" IS DISTINCT FROM OLD."chainAttestationAddress" THEN
    RAISE EXCEPTION 'chain attestation address cannot be changed once set' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" IN ('REVOKED', 'SUPERSEDED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'attestation status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;
