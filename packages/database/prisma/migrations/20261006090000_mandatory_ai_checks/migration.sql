-- ADR 0013: AI checks run on every owner upload; owners no longer turn them on per asset.

-- AlterTable
ALTER TABLE "assets" DROP CONSTRAINT "assets_automated_checks_consent_complete";

-- DropForeignKey
ALTER TABLE "assets" DROP CONSTRAINT "assets_automatedChecksConsentById_fkey";

-- AlterTable
ALTER TABLE "assets" DROP COLUMN "automatedChecksConsentAt",
DROP COLUMN "automatedChecksConsentById";

-- Queue a check of each owner file not yet checked with the current check version
-- (evidence-check-v3), on assets that are not revoked. Checkable files as in
-- isCheckable (@worthybound/shared).
INSERT INTO "automated_jobs" ("id", "kind", "entityId", "updatedAt")
SELECT gen_random_uuid(), 'EVIDENCE_CHECK', e."id", CURRENT_TIMESTAMP
FROM "evidence" e
JOIN "assets" a ON a."id" = e."assetId"
WHERE a."status" <> 'REVOKED'
  AND e."source" = 'OWNER'
  AND e."type" <> 'OTHER'
  AND e."mimeType" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  AND NOT EXISTS (
    SELECT 1 FROM "automated_checks" c
    WHERE c."evidenceId" = e."id" AND c."checkVersion" = 'evidence-check-v3'
  )
ON CONFLICT ("kind", "entityId") WHERE "status" = 'PENDING' DO NOTHING;
