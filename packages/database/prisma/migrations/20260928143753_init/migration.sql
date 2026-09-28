-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'VERIFIER', 'VERIFIER_REVIEWER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('LUXURY_WATCH', 'FINE_ART', 'JEWELRY', 'COLLECTIBLE_CAR', 'COLLECTIBLE', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('DRAFT', 'TOKENIZED', 'ACTIVE', 'VERIFIED', 'TRANSFER_PENDING', 'REVERIFICATION_REQUIRED', 'DISPUTED', 'REPORTED_LOST', 'REPORTED_STOLEN', 'REVOKED');

-- CreateEnum
CREATE TYPE "TokenizationStatus" AS ENUM ('NOT_TOKENIZED', 'PENDING', 'TOKENIZED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationLevel" AS ENUM ('UNVERIFIED', 'SELF_DOCUMENTED', 'INSPECTED', 'AUTHENTICATED', 'MULTI_VERIFIED');

-- CreateEnum
CREATE TYPE "OwnershipReason" AS ENUM ('REGISTRATION', 'TRANSFER', 'RECOVERY', 'ADMIN_CORRECTION');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProofSource" AS ENUM ('OWNER', 'THIRD_PARTY', 'VERIFIER', 'MANUFACTURER');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('PHOTO', 'RECEIPT', 'CERTIFICATE', 'PROVENANCE_DOCUMENT', 'SERIAL_NUMBER', 'INSPECTION_REPORT', 'APPRAISAL_DOCUMENT', 'CONDITION_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "EvidenceVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerifierStatus" AS ENUM ('APPLIED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "VerifierEntityType" AS ENUM ('INDIVIDUAL', 'BUSINESS', 'LABORATORY', 'MANUFACTURER');

-- CreateEnum
CREATE TYPE "CategoryPermissionStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "VerificationRequestStatus" AS ENUM ('OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('SERIAL_NUMBER', 'POSSESSION', 'CONDITION', 'INSPECTION', 'AUTHENTICATION', 'APPRAISAL', 'PROVENANCE', 'CERTIFICATE');

-- CreateEnum
CREATE TYPE "AttestationResult" AS ENUM ('CONFIRMED', 'CONTRADICTED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "AttestationMethod" AS ENUM ('IN_PERSON', 'REMOTE', 'LABORATORY', 'DOCUMENT_REVIEW');

-- CreateEnum
CREATE TYPE "AssuranceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AttestationStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUPERSEDED', 'DISPUTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'UPHELD', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ProvenanceEventType" AS ENUM ('REGISTERED', 'TOKENIZED', 'EVIDENCE_ADDED', 'EVIDENCE_COMMITTED', 'ATTESTATION_ADDED', 'ATTESTATION_REVOKED', 'TRANSFER_REQUESTED', 'TRANSFER_COMPLETED', 'STATUS_CHANGED', 'CONDITION_UPDATED', 'REVERIFICATION_REQUIRED', 'REPORTED_LOST', 'REPORTED_STOLEN', 'RECOVERED', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED');

-- CreateEnum
CREATE TYPE "SolanaCluster" AS ENUM ('LOCALNET', 'DEVNET');

-- CreateEnum
CREATE TYPE "ChainTransactionKind" AS ENUM ('REGISTER_ASSET', 'MINT_ASSET', 'COMMIT_EVIDENCE', 'APPROVE_VERIFIER', 'UPDATE_VERIFIER', 'SUBMIT_ATTESTATION', 'REVOKE_ATTESTATION', 'COMMIT_TRUST_SCORE', 'TRANSFER_ASSET', 'UPDATE_ASSET_STATUS');

-- CreateEnum
CREATE TYPE "ChainEntityType" AS ENUM ('ASSET', 'VERIFIER', 'ATTESTATION', 'EVIDENCE_COMMITMENT', 'TRUST_SCORE_SNAPSHOT', 'TRANSFER_REQUEST');

-- CreateEnum
CREATE TYPE "ChainTransactionStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "email" TEXT,
    "identityStatus" "IdentityStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "identityProvider" TEXT,
    "identityProviderRef" TEXT,
    "identityVerifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "id" UUID NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "ipHash" TEXT,
    "userAgentHash" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "grantedById" UUID,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "wbId" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "serialFingerprint" TEXT,
    "serialFingerprintKeyVersion" INTEGER,
    "description" TEXT,
    "publicDescription" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFT',
    "tokenizationStatus" "TokenizationStatus" NOT NULL DEFAULT 'NOT_TOKENIZED',
    "chainAssetAddress" TEXT,
    "chainRecordAddress" TEXT,
    "currentTrustScore" INTEGER NOT NULL DEFAULT 0,
    "verificationLevel" "VerificationLevel" NOT NULL DEFAULT 'UNVERIFIED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_status_events" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "fromStatus" "AssetStatus",
    "toStatus" "AssetStatus" NOT NULL,
    "reason" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ownerships" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "reason" "OwnershipReason" NOT NULL,
    "transferRequestId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_requests" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "fromUserId" UUID NOT NULL,
    "toUserId" UUID,
    "toWalletAddress" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transfer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "type" "EvidenceType" NOT NULL,
    "source" "ProofSource" NOT NULL DEFAULT 'OWNER',
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "visibility" "EvidenceVisibility" NOT NULL DEFAULT 'PRIVATE',
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "originalFilename" TEXT,
    "description" TEXT,
    "capturedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_commitments" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'sha256-merkle-v1',
    "evidenceCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_commitment_items" (
    "commitmentId" UUID NOT NULL,
    "leafIndex" INTEGER NOT NULL,
    "evidenceId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "evidence_commitment_items_pkey" PRIMARY KEY ("commitmentId","leafIndex")
);

-- CreateTable
CREATE TABLE "verifiers" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "VerifierStatus" NOT NULL DEFAULT 'APPLIED',
    "entityType" "VerifierEntityType" NOT NULL,
    "businessName" TEXT,
    "website" TEXT,
    "bio" TEXT,
    "credentialStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "attestationCount" INTEGER NOT NULL DEFAULT 0,
    "disputeCount" INTEGER NOT NULL DEFAULT 0,
    "upheldDisputeCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAttestationCount" INTEGER NOT NULL DEFAULT 0,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "chainVerifierAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifier_category_permissions" (
    "id" UUID NOT NULL,
    "verifierId" UUID NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "status" "CategoryPermissionStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifier_category_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifier_status_events" (
    "id" UUID NOT NULL,
    "verifierId" UUID NOT NULL,
    "fromStatus" "VerifierStatus",
    "toStatus" "VerifierStatus" NOT NULL,
    "reason" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifier_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_templates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_template_versions" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "requiredClaims" JSONB NOT NULL,
    "requiredEvidence" JSONB NOT NULL,
    "allowedMethods" JSONB NOT NULL,
    "minVerifiers" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_requests" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "templateVersionId" UUID NOT NULL,
    "assignedVerifierId" UUID,
    "status" "VerificationRequestStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attestations" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "verifierId" UUID NOT NULL,
    "verificationRequestId" UUID,
    "templateVersionId" UUID NOT NULL,
    "claimType" "ClaimType" NOT NULL,
    "result" "AttestationResult" NOT NULL,
    "method" "AttestationMethod" NOT NULL,
    "assuranceLevel" "AssuranceLevel" NOT NULL,
    "notes" TEXT,
    "nonce" TEXT NOT NULL,
    "signedPayloadHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "status" "AttestationStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesId" UUID,
    "chainAttestationAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attestations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attestation_evidence" (
    "attestationId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "attestation_evidence_pkey" PRIMARY KEY ("attestationId","evidenceId")
);

-- CreateTable
CREATE TABLE "attestation_status_events" (
    "id" UUID NOT NULL,
    "attestationId" UUID NOT NULL,
    "fromStatus" "AttestationStatus",
    "toStatus" "AttestationStatus" NOT NULL,
    "reason" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "attestationId" UUID,
    "evidenceId" UUID,
    "openedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trust_score_snapshots" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "verificationLevel" "VerificationLevel" NOT NULL,
    "factors" JSONB NOT NULL,
    "deductions" JSONB NOT NULL,
    "capsApplied" JSONB NOT NULL,
    "excludedProofs" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "weightsVersion" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trust_score_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provenance_events" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "type" "ProvenanceEventType" NOT NULL,
    "actorId" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provenance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_transactions" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" "ChainTransactionKind" NOT NULL,
    "cluster" "SolanaCluster" NOT NULL DEFAULT 'DEVNET',
    "entityType" "ChainEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "status" "ChainTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "signature" TEXT,
    "slot" BIGINT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "finalizedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chain_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_nonces_nonce_key" ON "auth_nonces"("nonce");

-- CreateIndex
CREATE INDEX "auth_nonces_walletAddress_idx" ON "auth_nonces"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "role_assignments_userId_idx" ON "role_assignments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_wbId_key" ON "assets"("wbId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_chainAssetAddress_key" ON "assets"("chainAssetAddress");

-- CreateIndex
CREATE UNIQUE INDEX "assets_chainRecordAddress_key" ON "assets"("chainRecordAddress");

-- CreateIndex
CREATE INDEX "assets_ownerId_idx" ON "assets"("ownerId");

-- CreateIndex
CREATE INDEX "assets_serialFingerprint_idx" ON "assets"("serialFingerprint");

-- CreateIndex
CREATE INDEX "assets_category_status_idx" ON "assets"("category", "status");

-- CreateIndex
CREATE INDEX "asset_status_events_assetId_createdAt_idx" ON "asset_status_events"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ownerships_transferRequestId_key" ON "ownerships"("transferRequestId");

-- CreateIndex
CREATE INDEX "ownerships_assetId_startedAt_idx" ON "ownerships"("assetId", "startedAt");

-- CreateIndex
CREATE INDEX "transfer_requests_assetId_status_idx" ON "transfer_requests"("assetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_storageKey_key" ON "evidence"("storageKey");

-- CreateIndex
CREATE INDEX "evidence_assetId_idx" ON "evidence"("assetId");

-- CreateIndex
CREATE INDEX "evidence_sha256_idx" ON "evidence"("sha256");

-- CreateIndex
CREATE INDEX "evidence_commitments_assetId_createdAt_idx" ON "evidence_commitments"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_commitment_items_commitmentId_evidenceId_key" ON "evidence_commitment_items"("commitmentId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "verifiers_userId_key" ON "verifiers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "verifiers_chainVerifierAddress_key" ON "verifiers"("chainVerifierAddress");

-- CreateIndex
CREATE INDEX "verifiers_status_idx" ON "verifiers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "verifier_category_permissions_verifierId_category_key" ON "verifier_category_permissions"("verifierId", "category");

-- CreateIndex
CREATE INDEX "verifier_status_events_verifierId_createdAt_idx" ON "verifier_status_events"("verifierId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "verification_templates_code_key" ON "verification_templates"("code");

-- CreateIndex
CREATE INDEX "verification_templates_category_idx" ON "verification_templates"("category");

-- CreateIndex
CREATE UNIQUE INDEX "verification_template_versions_templateId_version_key" ON "verification_template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "verification_requests_assetId_status_idx" ON "verification_requests"("assetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attestations_supersedesId_key" ON "attestations"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "attestations_chainAttestationAddress_key" ON "attestations"("chainAttestationAddress");

-- CreateIndex
CREATE INDEX "attestations_assetId_status_idx" ON "attestations"("assetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attestations_verifierId_nonce_key" ON "attestations"("verifierId", "nonce");

-- CreateIndex
CREATE INDEX "attestation_status_events_attestationId_createdAt_idx" ON "attestation_status_events"("attestationId", "createdAt");

-- CreateIndex
CREATE INDEX "disputes_assetId_status_idx" ON "disputes"("assetId", "status");

-- CreateIndex
CREATE INDEX "trust_score_snapshots_assetId_computedAt_idx" ON "trust_score_snapshots"("assetId", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "provenance_events_hash_key" ON "provenance_events"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "provenance_events_assetId_sequence_key" ON "provenance_events"("assetId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "chain_transactions_idempotencyKey_key" ON "chain_transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "chain_transactions_signature_key" ON "chain_transactions"("signature");

-- CreateIndex
CREATE INDEX "chain_transactions_entityType_entityId_idx" ON "chain_transactions"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "chain_transactions_status_idx" ON "chain_transactions"("status");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_status_events" ADD CONSTRAINT "asset_status_events_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_status_events" ADD CONSTRAINT "asset_status_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "transfer_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_commitments" ADD CONSTRAINT "evidence_commitments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_commitment_items" ADD CONSTRAINT "evidence_commitment_items_commitmentId_fkey" FOREIGN KEY ("commitmentId") REFERENCES "evidence_commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_commitment_items" ADD CONSTRAINT "evidence_commitment_items_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifiers" ADD CONSTRAINT "verifiers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifiers" ADD CONSTRAINT "verifiers_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_category_permissions" ADD CONSTRAINT "verifier_category_permissions_verifierId_fkey" FOREIGN KEY ("verifierId") REFERENCES "verifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_category_permissions" ADD CONSTRAINT "verifier_category_permissions_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_status_events" ADD CONSTRAINT "verifier_status_events_verifierId_fkey" FOREIGN KEY ("verifierId") REFERENCES "verifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifier_status_events" ADD CONSTRAINT "verifier_status_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_template_versions" ADD CONSTRAINT "verification_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "verification_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_template_versions" ADD CONSTRAINT "verification_template_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "verification_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_assignedVerifierId_fkey" FOREIGN KEY ("assignedVerifierId") REFERENCES "verifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_verifierId_fkey" FOREIGN KEY ("verifierId") REFERENCES "verifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_verificationRequestId_fkey" FOREIGN KEY ("verificationRequestId") REFERENCES "verification_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "verification_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "attestations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_evidence" ADD CONSTRAINT "attestation_evidence_attestationId_fkey" FOREIGN KEY ("attestationId") REFERENCES "attestations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_evidence" ADD CONSTRAINT "attestation_evidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_status_events" ADD CONSTRAINT "attestation_status_events_attestationId_fkey" FOREIGN KEY ("attestationId") REFERENCES "attestations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_status_events" ADD CONSTRAINT "attestation_status_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_attestationId_fkey" FOREIGN KEY ("attestationId") REFERENCES "attestations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trust_score_snapshots" ADD CONSTRAINT "trust_score_snapshots_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_events" ADD CONSTRAINT "provenance_events_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_events" ADD CONSTRAINT "provenance_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
