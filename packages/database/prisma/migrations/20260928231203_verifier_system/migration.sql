-- Verifier system. See docs/adr/0011-verifier-system.md.
-- DropIndex
DROP INDEX "verifier_category_permissions_verifierId_category_key";

-- CreateTable
CREATE TABLE "verifier_category_permission_events" (
    "id" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "fromStatus" "CategoryPermissionStatus",
    "toStatus" "CategoryPermissionStatus" NOT NULL,
    "reason" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifier_category_permission_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verifier_category_permission_events_permissionId_createdAt_idx" ON "verifier_category_permission_events"("permissionId", "createdAt");

-- CreateIndex
CREATE INDEX "verifier_category_permissions_verifierId_category_idx" ON "verifier_category_permissions"("verifierId", "category");

-- AddForeignKey
ALTER TABLE "verifier_category_permission_events" ADD CONSTRAINT "verifier_category_permission_events_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "verifier_category_permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_category_permission_events" ADD CONSTRAINT "verifier_category_permission_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Category permissions ─────────────────────────────────────────────────────

-- One open permission per verifier and category. Revoked permissions stay as history, so a
-- category can be requested again with a new row.
CREATE UNIQUE INDEX "verifier_category_permissions_open_key"
  ON "verifier_category_permissions" ("verifierId", "category") WHERE "status" <> 'REVOKED';

-- Permissions are never deleted and never move to another verifier or category; REVOKED is
-- final. A category is approved only for an approved (or suspended) verifier.
CREATE FUNCTION wb_permission_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  verifier_status "VerifierStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifier category permissions cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."verifierId", NEW."category", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."verifierId", OLD."category", OLD."createdAt") THEN
      RAISE EXCEPTION 'the verifier and category of a permission cannot be changed' USING ERRCODE = 'WB002';
    END IF;
    IF OLD."status" = 'REVOKED' AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION 'category permission status REVOKED is final' USING ERRCODE = 'WB002';
    END IF;
  END IF;
  IF NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED') THEN
    SELECT "status" INTO verifier_status FROM "verifiers" WHERE "id" = NEW."verifierId";
    IF verifier_status NOT IN ('APPROVED', 'SUSPENDED') THEN
      RAISE EXCEPTION 'categories can only be approved for an approved verifier' USING ERRCODE = 'WB003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verifier_category_permissions_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "verifier_category_permissions"
  FOR EACH ROW EXECUTE FUNCTION wb_permission_lock();

CREATE TRIGGER "verifier_category_permission_events_append_only"
  BEFORE UPDATE OR DELETE ON "verifier_category_permission_events"
  FOR EACH ROW EXECUTE FUNCTION wb_reject_mutation();

CREATE TRIGGER "verifier_category_permission_events_no_truncate"
  BEFORE TRUNCATE ON "verifier_category_permission_events"
  FOR EACH STATEMENT EXECUTE FUNCTION wb_reject_mutation();

-- ─── Verifiers ────────────────────────────────────────────────────────────────

-- Verifiers are never deleted and never move to another user; REVOKED is final. The first
-- approval (approver and date) is kept, and the entity type is locked once approved.
-- Approval requires a verified identity (ADR 0004).
CREATE FUNCTION wb_verifier_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifiers cannot be deleted' USING ERRCODE = 'WB002';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."userId", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."userId", OLD."createdAt") THEN
      RAISE EXCEPTION 'a verifier cannot be moved to another user' USING ERRCODE = 'WB002';
    END IF;
    IF OLD."status" = 'REVOKED' AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION 'verifier status REVOKED is final' USING ERRCODE = 'WB002';
    END IF;
    IF OLD."approvedAt" IS NOT NULL AND (
      (NEW."approvedAt", NEW."approvedById", NEW."entityType")
      IS DISTINCT FROM (OLD."approvedAt", OLD."approvedById", OLD."entityType")
    ) THEN
      RAISE EXCEPTION 'the approval and entity type of an approved verifier cannot be changed'
        USING ERRCODE = 'WB002';
    END IF;
  END IF;
  IF NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED')
     AND NOT EXISTS (
       SELECT 1 FROM "users" WHERE "id" = NEW."userId" AND "identityStatus" = 'VERIFIED'
     ) THEN
    RAISE EXCEPTION 'verifier % cannot be approved without a verified identity', NEW."id"
      USING ERRCODE = 'WB003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verifiers_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "verifiers"
  FOR EACH ROW EXECUTE FUNCTION wb_verifier_lock();

-- ─── Attestations ─────────────────────────────────────────────────────────────

-- As in the integrity migration, plus: the verifier's identity must still be verified.
CREATE OR REPLACE FUNCTION wb_attestation_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
  a record;
  tv record;
BEGIN
  SELECT ver."userId", ver."status", u."identityStatus" INTO v
    FROM "verifiers" ver
    JOIN "users" u ON u."id" = ver."userId"
    WHERE ver."id" = NEW."verifierId";
  SELECT "ownerId", "category" INTO a FROM "assets" WHERE "id" = NEW."assetId";
  SELECT tv2."status", t."category" INTO tv
    FROM "verification_template_versions" tv2
    JOIN "verification_templates" t ON t."id" = tv2."templateId"
    WHERE tv2."id" = NEW."templateVersionId";

  IF v IS NULL OR a IS NULL OR tv IS NULL THEN
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
  IF tv."status" <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'attestations require a published template version' USING ERRCODE = 'WB003';
  END IF;
  IF tv."category" <> a."category" THEN
    RAISE EXCEPTION 'template category % does not match asset category %', tv."category", a."category"
      USING ERRCODE = 'WB003';
  END IF;
  RETURN NEW;
END;
$$;
