-- ADR 0013: AI checks of owner evidence and advisory reports on verifier applications.

-- CreateEnum
CREATE TYPE "AutomatedCheckResult" AS ENUM ('PASSED', 'FAILED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "AutomatedJobKind" AS ENUM ('EVIDENCE_CHECK', 'VERIFIER_REPORT');

-- CreateEnum
CREATE TYPE "AutomatedJobStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerifierReportRecommendation" AS ENUM ('APPROVE', 'REJECT', 'NEEDS_MORE_INFORMATION');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "automatedChecksConsentAt" TIMESTAMPTZ(3),
ADD COLUMN     "automatedChecksConsentById" UUID;

-- CreateTable
CREATE TABLE "automated_checks" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "result" "AutomatedCheckResult" NOT NULL,
    "problems" TEXT[],
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "engine" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "checkVersion" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automated_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifier_application_reports" (
    "id" UUID NOT NULL,
    "verifierId" UUID NOT NULL,
    "recommendation" "VerifierReportRecommendation" NOT NULL,
    "summary" TEXT NOT NULL,
    "strengths" TEXT[],
    "concerns" TEXT[],
    "questions" TEXT[],
    "sources" TEXT[],
    "inputHash" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reportVersion" TEXT NOT NULL,
    "requestedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifier_application_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automated_jobs" (
    "id" UUID NOT NULL,
    "kind" "AutomatedJobKind" NOT NULL,
    "entityId" UUID NOT NULL,
    "status" "AutomatedJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "requestedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automated_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automated_checks_assetId_idx" ON "automated_checks"("assetId");

-- CreateIndex
CREATE INDEX "automated_checks_evidenceId_createdAt_idx" ON "automated_checks"("evidenceId", "createdAt");

-- CreateIndex
CREATE INDEX "verifier_application_reports_verifierId_createdAt_idx" ON "verifier_application_reports"("verifierId", "createdAt");

-- CreateIndex
CREATE INDEX "automated_jobs_status_runAfter_idx" ON "automated_jobs"("status", "runAfter");

-- CreateIndex
CREATE INDEX "automated_jobs_kind_entityId_idx" ON "automated_jobs"("kind", "entityId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_automatedChecksConsentById_fkey" FOREIGN KEY ("automatedChecksConsentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automated_checks" ADD CONSTRAINT "automated_checks_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automated_checks" ADD CONSTRAINT "automated_checks_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_application_reports" ADD CONSTRAINT "verifier_application_reports_verifierId_fkey" FOREIGN KEY ("verifierId") REFERENCES "verifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_application_reports" ADD CONSTRAINT "verifier_application_reports_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automated_jobs" ADD CONSTRAINT "automated_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ────────────────────────────────────────────────────────────────

ALTER TABLE "assets" ADD CONSTRAINT "assets_automated_checks_consent_complete"
  CHECK (("automatedChecksConsentById" IS NULL) = ("automatedChecksConsentAt" IS NULL));

ALTER TABLE "automated_checks" ADD CONSTRAINT "automated_checks_passed_without_problems"
  CHECK ("result" <> 'PASSED' OR cardinality("problems") = 0);

ALTER TABLE "automated_checks" ADD CONSTRAINT "automated_checks_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "automated_jobs" ADD CONSTRAINT "automated_jobs_attempts_non_negative"
  CHECK ("attempts" >= 0);

CREATE UNIQUE INDEX "automated_jobs_pending_key"
  ON "automated_jobs" ("kind", "entityId") WHERE "status" = 'PENDING';

-- A check records the file it examined: the evidence of the same asset, with its sealed hash.
CREATE FUNCTION wb_automated_check_matches_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "evidence"
    WHERE "id" = NEW."evidenceId" AND "assetId" = NEW."assetId" AND "sha256" = NEW."sha256"
  ) THEN
    RAISE EXCEPTION 'automated check does not match its evidence' USING ERRCODE = 'WB003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "automated_checks_match_evidence"
  BEFORE INSERT ON "automated_checks"
  FOR EACH ROW EXECUTE FUNCTION wb_automated_check_matches_evidence();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automated_checks', 'verifier_application_reports'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wb_reject_mutation()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wb_reject_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END;
$$;
