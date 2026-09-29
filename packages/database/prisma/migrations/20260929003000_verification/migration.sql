-- Verification templates, requests and signed attestations. See docs/adr/0012-verification.md.

-- AlterEnum
ALTER TYPE "ProvenanceEventType" ADD VALUE 'EVIDENCE_REVIEWED';

-- AlterTable
ALTER TABLE "attestations" ADD COLUMN     "signedMessage" TEXT NOT NULL,
ALTER COLUMN "verificationRequestId" SET NOT NULL;

-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "verificationRequestId" UUID;

-- AlterTable
ALTER TABLE "evidence_uploads" ADD COLUMN     "verificationRequestId" UUID;

-- AlterTable
ALTER TABLE "verification_requests" ADD COLUMN     "assignedAt" TIMESTAMPTZ(3),
ADD COLUMN     "closedReason" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMPTZ(3) NOT NULL;

-- AlterTable
ALTER TABLE "verification_template_versions" ADD COLUMN     "publishedById" UUID,
ADD COLUMN     "validityMonths" INTEGER NOT NULL DEFAULT 60;

-- CreateTable
CREATE TABLE "verification_request_status_events" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fromStatus" "VerificationRequestStatus",
    "toStatus" "VerificationRequestStatus" NOT NULL,
    "verifierId" UUID,
    "reason" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_request_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_request_status_events_requestId_createdAt_idx" ON "verification_request_status_events"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "verification_requests_status_createdAt_idx" ON "verification_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "verification_requests_assignedVerifierId_status_idx" ON "verification_requests"("assignedVerifierId", "status");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_verificationRequestId_fkey" FOREIGN KEY ("verificationRequestId") REFERENCES "verification_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_uploads" ADD CONSTRAINT "evidence_uploads_verificationRequestId_fkey" FOREIGN KEY ("verificationRequestId") REFERENCES "verification_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_template_versions" ADD CONSTRAINT "verification_template_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_request_status_events" ADD CONSTRAINT "verification_request_status_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "verification_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_request_status_events" ADD CONSTRAINT "verification_request_status_events_verifierId_fkey" FOREIGN KEY ("verifierId") REFERENCES "verifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_request_status_events" ADD CONSTRAINT "verification_request_status_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Templates ────────────────────────────────────────────────────────────────

-- A template's code and category give its published versions their meaning; they never change.
CREATE FUNCTION wb_template_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."code", NEW."category", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."code", OLD."category", OLD."createdAt") THEN
    RAISE EXCEPTION 'a template''s code and category cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verification_templates_lock"
  BEFORE UPDATE ON "verification_templates"
  FOR EACH ROW EXECUTE FUNCTION wb_template_lock();

-- Published versions name their creator and publisher (four-eyes rule, checked on publication
-- below). Attestations are valid for at most `validityMonths` (1-120).
ALTER TABLE "verification_template_versions"
  DROP CONSTRAINT "verification_template_versions_published_ck",
  ADD CONSTRAINT "verification_template_versions_published_ck" CHECK (
    "status" = 'DRAFT'
    OR ("publishedAt" IS NOT NULL AND "createdById" IS NOT NULL AND "publishedById" IS NOT NULL)),
  ADD CONSTRAINT "verification_template_versions_max_verifiers_ck" CHECK ("minVerifiers" <= 5),
  ADD CONSTRAINT "verification_template_versions_validity_ck"
    CHECK ("validityMonths" BETWEEN 1 AND 120);

CREATE UNIQUE INDEX "verification_template_versions_published_key"
  ON "verification_template_versions" ("templateId") WHERE "status" = 'PUBLISHED';

-- Requirements of published and retired versions must be well formed (validation schema
-- `templateRequirementsSchema`): distinct known claims and methods, at least one of each, and
-- distinct known evidence types with a minimum count of 1-20.
CREATE FUNCTION wb_template_requirements_valid(claims jsonb, evidence jsonb, methods jsonb)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT
    jsonb_typeof(claims) = 'array' AND jsonb_array_length(claims) > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(claims) e
      WHERE jsonb_typeof(e) <> 'string' OR NOT ((e #>> '{}') = ANY (enum_range(NULL::"ClaimType")::text[])))
    AND (SELECT count(DISTINCT e) = count(*) FROM jsonb_array_elements(claims) e)
    AND jsonb_typeof(methods) = 'array' AND jsonb_array_length(methods) > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(methods) e
      WHERE jsonb_typeof(e) <> 'string'
        OR NOT ((e #>> '{}') = ANY (enum_range(NULL::"AttestationMethod")::text[])))
    AND (SELECT count(DISTINCT e) = count(*) FROM jsonb_array_elements(methods) e)
    AND jsonb_typeof(evidence) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(evidence) e
      WHERE jsonb_typeof(e) <> 'object'
        OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) <> ARRAY['minCount', 'type']
        OR jsonb_typeof(e -> 'type') <> 'string'
        OR NOT ((e ->> 'type') = ANY (enum_range(NULL::"EvidenceType")::text[]))
        OR jsonb_typeof(e -> 'minCount') <> 'number'
        OR (e ->> 'minCount') !~ '^[0-9]{1,2}$'
        OR (e ->> 'minCount')::int NOT BETWEEN 1 AND 20)
    AND (SELECT count(DISTINCT e ->> 'type') = count(*) FROM jsonb_array_elements(evidence) e);
$$;

-- A version is published by an administrator other than its creator, unless the creator is
-- the only active administrator.
CREATE FUNCTION wb_template_version_valid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' AND NOT wb_template_requirements_valid(
    NEW."requiredClaims", NEW."requiredEvidence", NEW."allowedMethods"
  ) THEN
    RAISE EXCEPTION 'template version requirements are malformed' USING ERRCODE = 'WB003';
  END IF;
  IF NEW."status" = 'PUBLISHED' AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT')
     AND NEW."publishedById" = NEW."createdById"
     AND (SELECT array_agg("userId") FROM "role_assignments"
          WHERE "role" = 'ADMIN' AND "revokedAt" IS NULL) IS DISTINCT FROM ARRAY[NEW."createdById"]
  THEN
    RAISE EXCEPTION 'template versions are published by an administrator other than their creator'
      USING ERRCODE = 'WB003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verification_template_versions_valid"
  BEFORE INSERT OR UPDATE ON "verification_template_versions"
  FOR EACH ROW EXECUTE FUNCTION wb_template_version_valid();

-- As in the integrity migration, plus the publisher.
CREATE OR REPLACE FUNCTION wb_template_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published template versions cannot be deleted' USING ERRCODE = 'WB002';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired template versions are immutable' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND (
    NEW."status" <> 'RETIRED'
    OR (NEW."templateId", NEW."version", NEW."requiredClaims", NEW."requiredEvidence", NEW."allowedMethods",
        NEW."minVerifiers", NEW."validityMonths", NEW."createdById", NEW."publishedById", NEW."publishedAt",
        NEW."createdAt")
       IS DISTINCT FROM
       (OLD."templateId", OLD."version", OLD."requiredClaims", OLD."requiredEvidence", OLD."allowedMethods",
        OLD."minVerifiers", OLD."validityMonths", OLD."createdById", OLD."publishedById", OLD."publishedAt",
        OLD."createdAt")
  ) THEN
    RAISE EXCEPTION 'published template versions are immutable; only retirement is allowed' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── Verification requests ────────────────────────────────────────────────────

ALTER TABLE "verification_requests"
  ADD CONSTRAINT "verification_requests_expiry_ck" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "verification_requests_status_ck" CHECK (
    ("status" = 'OPEN' AND "assignedVerifierId" IS NULL AND "assignedAt" IS NULL
      AND "completedAt" IS NULL)
    OR ("status" = 'ASSIGNED' AND "assignedVerifierId" IS NOT NULL AND "assignedAt" IS NOT NULL
      AND "completedAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "assignedVerifierId" IS NOT NULL AND "completedAt" IS NOT NULL)
    OR ("status" IN ('CANCELLED', 'EXPIRED') AND "completedAt" IS NULL)),
  ADD CONSTRAINT "verification_requests_closed_reason_ck"
    CHECK ("closedReason" IS NULL OR "status" IN ('CANCELLED', 'EXPIRED'));

CREATE UNIQUE INDEX "verification_requests_open_key"
  ON "verification_requests" ("assetId", "templateVersionId") WHERE "status" IN ('OPEN', 'ASSIGNED');

-- Only the owner requests verification, against a published version for the asset's category.
-- A request is assigned only to an approved verifier with a verified identity and permission for
-- the category who does not own the asset. Requests are never deleted, never moved to another
-- asset, requester or template version, and COMPLETED, CANCELLED and EXPIRED are final.
CREATE FUNCTION wb_verification_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
  tv record;
  v record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification requests cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" IN ('COMPLETED', 'CANCELLED', 'EXPIRED') THEN
      RAISE EXCEPTION 'verification request status % is final', OLD."status" USING ERRCODE = 'WB002';
    END IF;
    IF (NEW."id", NEW."assetId", NEW."requesterId", NEW."templateVersionId", NEW."expiresAt", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."assetId", OLD."requesterId", OLD."templateVersionId", OLD."expiresAt", OLD."createdAt") THEN
      RAISE EXCEPTION 'a verification request''s asset, requester and template cannot be changed'
        USING ERRCODE = 'WB002';
    END IF;
  END IF;

  SELECT "ownerId", "category" INTO a FROM "assets" WHERE "id" = NEW."assetId";
  IF NOT FOUND THEN
    RETURN NEW; -- foreign keys report the missing reference
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."requesterId" <> a."ownerId" THEN
      RAISE EXCEPTION 'only the asset owner can request verification' USING ERRCODE = 'WB003';
    END IF;
    SELECT tv2."status", t."category" INTO tv
      FROM "verification_template_versions" tv2
      JOIN "verification_templates" t ON t."id" = tv2."templateId"
      WHERE tv2."id" = NEW."templateVersionId";
    IF FOUND AND (tv."status" <> 'PUBLISHED' OR tv."category" <> a."category") THEN
      RAISE EXCEPTION 'verification requires a published template version for category %', a."category"
        USING ERRCODE = 'WB003';
    END IF;
  END IF;

  IF NEW."status" = 'ASSIGNED' AND (
    TG_OP = 'INSERT' OR OLD."status" <> 'ASSIGNED'
    OR NEW."assignedVerifierId" IS DISTINCT FROM OLD."assignedVerifierId"
  ) THEN
    SELECT ver."userId", ver."status", u."identityStatus" INTO v
      FROM "verifiers" ver
      JOIN "users" u ON u."id" = ver."userId"
      WHERE ver."id" = NEW."assignedVerifierId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF v."status" <> 'APPROVED' THEN
      RAISE EXCEPTION 'verifier % is not approved', NEW."assignedVerifierId" USING ERRCODE = 'WB003';
    END IF;
    IF v."identityStatus" <> 'VERIFIED' THEN
      RAISE EXCEPTION 'verifier % does not have a verified identity', NEW."assignedVerifierId"
        USING ERRCODE = 'WB003';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "verifier_category_permissions"
      WHERE "verifierId" = NEW."assignedVerifierId" AND "category" = a."category" AND "status" = 'APPROVED'
    ) THEN
      RAISE EXCEPTION 'verifier % has no approved permission for category %', NEW."assignedVerifierId",
        a."category" USING ERRCODE = 'WB003';
    END IF;
    IF v."userId" = a."ownerId" OR v."userId" = NEW."requesterId" THEN
      RAISE EXCEPTION 'verifiers cannot take verification requests for their own assets'
        USING ERRCODE = 'WB003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verification_requests_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "verification_requests"
  FOR EACH ROW EXECUTE FUNCTION wb_verification_request_guard();

CREATE TRIGGER "verification_request_status_events_append_only"
  BEFORE UPDATE OR DELETE ON "verification_request_status_events"
  FOR EACH ROW EXECUTE FUNCTION wb_reject_mutation();

CREATE TRIGGER "verification_request_status_events_no_truncate"
  BEFORE TRUNCATE ON "verification_request_status_events"
  FOR EACH STATEMENT EXECUTE FUNCTION wb_reject_mutation();

-- ─── Attestations ─────────────────────────────────────────────────────────────

-- The stored hash is the SHA-256 of the exact signed text.
ALTER TABLE "attestations"
  ADD CONSTRAINT "attestations_signed_message_hash_ck"
    CHECK ("signedPayloadHash" = encode(sha256(convert_to("signedMessage", 'UTF8')), 'hex'));

-- One current (ACTIVE or DISPUTED) attestation per verifier, asset and claim; a new one must
-- supersede the previous one.
CREATE UNIQUE INDEX "attestations_current_claim_key"
  ON "attestations" ("assetId", "verifierId", "claimType") WHERE "status" IN ('ACTIVE', 'DISPUTED');

-- As in the verifier system migration, plus: the attestation belongs to a request assigned to
-- the verifier for the same asset and template version, the asset accepts attestations, the claim
-- is required by the template and the method allowed, the attestation expires within the
-- template's validity (months counted in UTC), and a superseded attestation is the same
-- verifier's attestation of the same claim on the same asset, already marked SUPERSEDED.
CREATE OR REPLACE FUNCTION wb_attestation_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
  a record;
  tv record;
  r record;
  s record;
BEGIN
  SELECT ver."userId", ver."status", u."identityStatus" INTO v
    FROM "verifiers" ver
    JOIN "users" u ON u."id" = ver."userId"
    WHERE ver."id" = NEW."verifierId";
  SELECT "ownerId", "category", "status" INTO a FROM "assets" WHERE "id" = NEW."assetId";
  SELECT tv2."status", t."category", tv2."requiredClaims", tv2."allowedMethods", tv2."validityMonths" INTO tv
    FROM "verification_template_versions" tv2
    JOIN "verification_templates" t ON t."id" = tv2."templateId"
    WHERE tv2."id" = NEW."templateVersionId";
  SELECT "status", "assignedVerifierId", "assetId", "templateVersionId" INTO r
    FROM "verification_requests" WHERE "id" = NEW."verificationRequestId";

  IF v IS NULL OR a IS NULL OR tv IS NULL OR NOT FOUND THEN
    RETURN NEW; -- foreign keys report the missing reference
  END IF;
  IF v."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'verifier % is not approved', NEW."verifierId" USING ERRCODE = 'WB003';
  END IF;
  IF v."identityStatus" <> 'VERIFIED' THEN
    RAISE EXCEPTION 'verifier % does not have a verified identity', NEW."verifierId"
      USING ERRCODE = 'WB003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "verifier_category_permissions"
    WHERE "verifierId" = NEW."verifierId" AND "category" = a."category" AND "status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'verifier % has no approved permission for category %', NEW."verifierId", a."category"
      USING ERRCODE = 'WB003';
  END IF;
  IF v."userId" = a."ownerId" THEN
    RAISE EXCEPTION 'verifiers cannot attest to their own assets' USING ERRCODE = 'WB003';
  END IF;
  IF a."status" NOT IN ('TOKENIZED', 'ACTIVE', 'VERIFIED', 'REVERIFICATION_REQUIRED') THEN
    RAISE EXCEPTION 'asset status % does not accept attestations', a."status" USING ERRCODE = 'WB003';
  END IF;
  IF tv."status" <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'attestations require a published template version' USING ERRCODE = 'WB003';
  END IF;
  IF tv."category" <> a."category" THEN
    RAISE EXCEPTION 'template category % does not match asset category %', tv."category", a."category"
      USING ERRCODE = 'WB003';
  END IF;
  IF r."status" <> 'ASSIGNED' OR r."assignedVerifierId" IS DISTINCT FROM NEW."verifierId"
     OR r."assetId" <> NEW."assetId" OR r."templateVersionId" <> NEW."templateVersionId" THEN
    RAISE EXCEPTION 'attestations require a verification request assigned to the verifier'
      USING ERRCODE = 'WB003';
  END IF;
  IF NOT (tv."requiredClaims" ? NEW."claimType"::text) THEN
    RAISE EXCEPTION 'claim % is not part of the template', NEW."claimType" USING ERRCODE = 'WB003';
  END IF;
  IF NOT (tv."allowedMethods" ? NEW."method"::text) THEN
    RAISE EXCEPTION 'method % is not allowed by the template', NEW."method" USING ERRCODE = 'WB003';
  END IF;
  IF NEW."expiresAt" IS NULL OR NEW."expiresAt" <= NEW."issuedAt"
     OR NEW."expiresAt" > ((NEW."issuedAt" AT TIME ZONE 'UTC')
                           + make_interval(months => tv."validityMonths")) AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'attestations expire within the template validity of % months', tv."validityMonths"
      USING ERRCODE = 'WB003';
  END IF;
  IF NEW."supersedesId" IS NOT NULL THEN
    SELECT "verifierId", "assetId", "claimType", "status" INTO s
      FROM "attestations" WHERE "id" = NEW."supersedesId";
    IF FOUND AND (s."verifierId" <> NEW."verifierId" OR s."assetId" <> NEW."assetId"
                  OR s."claimType" <> NEW."claimType" OR s."status" <> 'SUPERSEDED') THEN
      RAISE EXCEPTION 'an attestation only supersedes the same verifier''s superseded attestation of the same claim'
        USING ERRCODE = 'WB003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- As in the item condition migration, plus the signed message.
CREATE OR REPLACE FUNCTION wb_attestation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attestations cannot be deleted; revoke them instead' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."assetId", NEW."verifierId", NEW."verificationRequestId", NEW."templateVersionId", NEW."claimType",
      NEW."result", NEW."method", NEW."assuranceLevel", NEW."conditionGrade", NEW."notes", NEW."nonce",
      NEW."signedMessage", NEW."signedPayloadHash", NEW."signature", NEW."issuedAt", NEW."expiresAt",
      NEW."supersedesId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."assetId", OLD."verifierId", OLD."verificationRequestId", OLD."templateVersionId", OLD."claimType",
      OLD."result", OLD."method", OLD."assuranceLevel", OLD."conditionGrade", OLD."notes", OLD."nonce",
      OLD."signedMessage", OLD."signedPayloadHash", OLD."signature", OLD."issuedAt", OLD."expiresAt",
      OLD."supersedesId", OLD."createdAt") THEN
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

-- ─── Evidence added and reviewed by verifiers ─────────────────────────────────

ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_verifier_source_ck"
    CHECK (("source" = 'VERIFIER') = ("verificationRequestId" IS NOT NULL)),
  ADD CONSTRAINT "evidence_review_ck" CHECK (
    ("reviewStatus" = 'PENDING' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL
      AND "reviewReason" IS NULL)
    OR ("reviewStatus" = 'ACCEPTED' AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)
    OR ("reviewStatus" = 'REJECTED' AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL
      AND "reviewReason" IS NOT NULL));

-- Verifier evidence comes from the verifier assigned to the request, for the request's asset.
-- A review is made by the verifier assigned to the asset (approved, identity verified) or an
-- administrator, never by the asset's owner.
CREATE FUNCTION wb_evidence_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."verificationRequestId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "verification_requests" r
    JOIN "verifiers" ver ON ver."id" = r."assignedVerifierId"
    WHERE r."id" = NEW."verificationRequestId" AND r."status" = 'ASSIGNED'
      AND r."assetId" = NEW."assetId" AND ver."userId" = NEW."uploaderId"
  ) THEN
    RAISE EXCEPTION 'verifier evidence requires a verification request assigned to the uploader'
      USING ERRCODE = 'WB003';
  END IF;

  IF NEW."reviewStatus" <> 'PENDING' AND (TG_OP = 'INSERT' OR OLD."reviewStatus" = 'PENDING') THEN
    IF NEW."reviewedById" = (SELECT "ownerId" FROM "assets" WHERE "id" = NEW."assetId") THEN
      RAISE EXCEPTION 'owners cannot review evidence of their own assets' USING ERRCODE = 'WB003';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "role_assignments"
      WHERE "userId" = NEW."reviewedById" AND "role" = 'ADMIN' AND "revokedAt" IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM "verification_requests" r
      JOIN "verifiers" ver ON ver."id" = r."assignedVerifierId"
      JOIN "users" u ON u."id" = ver."userId"
      WHERE r."assetId" = NEW."assetId" AND r."status" = 'ASSIGNED'
        AND ver."userId" = NEW."reviewedById" AND ver."status" = 'APPROVED'
        AND u."identityStatus" = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'evidence is reviewed only by the verifier assigned to the asset or an administrator'
        USING ERRCODE = 'WB003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "evidence_authority"
  BEFORE INSERT OR UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION wb_evidence_authority();

-- As in the evidence vault migration, plus the request and the review reason.
CREATE OR REPLACE FUNCTION wb_evidence_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."uploaderId", NEW."type", NEW."source", NEW."storageKey",
      NEW."sha256", NEW."mimeType", NEW."sizeBytes", NEW."originalFilename", NEW."description",
      NEW."capturedAt", NEW."duplicateOfId", NEW."verificationRequestId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."uploaderId", OLD."type", OLD."source", OLD."storageKey",
      OLD."sha256", OLD."mimeType", OLD."sizeBytes", OLD."originalFilename", OLD."description",
      OLD."capturedAt", OLD."duplicateOfId", OLD."verificationRequestId", OLD."createdAt") THEN
    RAISE EXCEPTION 'evidence files and their details cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."reviewStatus" <> 'PENDING'
     AND (NEW."reviewStatus", NEW."reviewedById", NEW."reviewedAt", NEW."reviewReason")
         IS DISTINCT FROM (OLD."reviewStatus", OLD."reviewedById", OLD."reviewedAt", OLD."reviewReason") THEN
    RAISE EXCEPTION 'an evidence review decision is final' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

-- An upload for a request comes from the verifier assigned to it, for the request's asset.
CREATE FUNCTION wb_evidence_upload_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."verificationRequestId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "verification_requests" r
    JOIN "verifiers" ver ON ver."id" = r."assignedVerifierId"
    WHERE r."id" = NEW."verificationRequestId" AND r."status" = 'ASSIGNED'
      AND r."assetId" = NEW."assetId" AND ver."userId" = NEW."uploaderId"
  ) THEN
    RAISE EXCEPTION 'verifier uploads require a verification request assigned to the uploader'
      USING ERRCODE = 'WB003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "evidence_uploads_authority"
  BEFORE INSERT ON "evidence_uploads"
  FOR EACH ROW EXECUTE FUNCTION wb_evidence_upload_authority();

-- As in the evidence vault migration, plus the request.
CREATE OR REPLACE FUNCTION wb_evidence_upload_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence uploads cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'evidence upload status % is final', OLD."status" USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."id", NEW."assetId", NEW."uploaderId", NEW."type", NEW."mimeType", NEW."sizeBytes",
      NEW."sha256", NEW."visibility", NEW."originalFilename", NEW."description",
      NEW."capturedAt", NEW."verificationRequestId", NEW."stagingKey", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."assetId", OLD."uploaderId", OLD."type", OLD."mimeType", OLD."sizeBytes",
      OLD."sha256", OLD."visibility", OLD."originalFilename", OLD."description",
      OLD."capturedAt", OLD."verificationRequestId", OLD."stagingKey", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'evidence upload requests cannot be changed' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;
