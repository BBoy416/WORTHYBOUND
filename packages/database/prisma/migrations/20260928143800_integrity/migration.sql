-- WorthyBound integrity rules that Prisma cannot express.
-- See docs/adr/0005-database-integrity.md.
-- Custom SQLSTATEs: WB001 append-only violation, WB002 immutable record, WB003 authority violation.

-- ─── Check constraints ────────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD CONSTRAINT "users_verified_identity_ck"
    CHECK ("identityStatus" <> 'VERIFIED' OR ("identityProvider" IS NOT NULL AND "identityProviderRef" IS NOT NULL));

ALTER TABLE "auth_nonces"
  ADD CONSTRAINT "auth_nonces_expiry_ck" CHECK ("expiresAt" > "issuedAt"),
  ADD CONSTRAINT "auth_nonces_used_ck" CHECK ("usedAt" IS NULL OR "usedAt" >= "issuedAt");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_ck" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "role_assignments"
  ADD CONSTRAINT "role_assignments_no_self_grant_ck" CHECK ("grantedById" IS NULL OR "grantedById" <> "userId");

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_wb_id_format_ck" CHECK ("wbId" ~ '^WB-[0-9A-F]{8}$'),
  ADD CONSTRAINT "assets_trust_score_range_ck" CHECK ("currentTrustScore" BETWEEN 0 AND 100),
  ADD CONSTRAINT "assets_tokenized_address_ck"
    CHECK ("tokenizationStatus" <> 'TOKENIZED' OR "chainAssetAddress" IS NOT NULL),
  ADD CONSTRAINT "assets_attributes_object_ck" CHECK (jsonb_typeof("attributes") = 'object');

ALTER TABLE "ownerships"
  ADD CONSTRAINT "ownerships_period_ck" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

ALTER TABLE "transfer_requests"
  ADD CONSTRAINT "transfer_requests_distinct_parties_ck" CHECK ("toUserId" IS NULL OR "toUserId" <> "fromUserId"),
  ADD CONSTRAINT "transfer_requests_expiry_ck" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_sha256_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "evidence_size_ck" CHECK ("sizeBytes" > 0),
  ADD CONSTRAINT "evidence_storage_key_not_url_ck" CHECK ("storageKey" !~* '^[a-z][a-z0-9+.-]*://'),
  ADD CONSTRAINT "evidence_no_self_review_ck" CHECK ("reviewedById" IS NULL OR "reviewedById" <> "uploaderId");

ALTER TABLE "evidence_commitments"
  ADD CONSTRAINT "evidence_commitments_root_ck" CHECK ("merkleRoot" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "evidence_commitments_count_ck" CHECK ("evidenceCount" > 0);

ALTER TABLE "evidence_commitment_items"
  ADD CONSTRAINT "evidence_commitment_items_sha256_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "evidence_commitment_items_leaf_ck" CHECK ("leafIndex" >= 0);

ALTER TABLE "verifiers"
  ADD CONSTRAINT "verifiers_no_self_approval_ck" CHECK ("approvedById" IS NULL OR "approvedById" <> "userId"),
  ADD CONSTRAINT "verifiers_approved_fields_ck"
    CHECK ("status" <> 'APPROVED' OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)),
  ADD CONSTRAINT "verifiers_counters_ck" CHECK (
    "attestationCount" >= 0 AND "disputeCount" >= 0 AND "upheldDisputeCount" >= 0 AND "revokedAttestationCount" >= 0
  );

ALTER TABLE "verifier_category_permissions"
  ADD CONSTRAINT "verifier_category_permissions_approved_fields_ck"
    CHECK ("status" <> 'APPROVED' OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));

ALTER TABLE "verification_template_versions"
  ADD CONSTRAINT "verification_template_versions_version_ck" CHECK ("version" >= 1),
  ADD CONSTRAINT "verification_template_versions_min_verifiers_ck" CHECK ("minVerifiers" >= 1),
  ADD CONSTRAINT "verification_template_versions_published_ck" CHECK ("status" = 'DRAFT' OR "publishedAt" IS NOT NULL);

ALTER TABLE "attestations"
  ADD CONSTRAINT "attestations_payload_hash_ck" CHECK ("signedPayloadHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "attestations_expiry_ck" CHECK ("expiresAt" IS NULL OR "expiresAt" > "issuedAt"),
  ADD CONSTRAINT "attestations_no_self_supersede_ck" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id");

ALTER TABLE "attestation_evidence"
  ADD CONSTRAINT "attestation_evidence_sha256_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_target_ck" CHECK ("attestationId" IS NULL OR "evidenceId" IS NULL),
  ADD CONSTRAINT "disputes_no_self_resolution_ck" CHECK ("resolvedById" IS NULL OR "resolvedById" <> "openedById");

ALTER TABLE "trust_score_snapshots"
  ADD CONSTRAINT "trust_score_snapshots_score_ck" CHECK ("score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "trust_score_snapshots_inputs_hash_ck" CHECK ("inputsHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "provenance_events"
  ADD CONSTRAINT "provenance_events_hash_ck" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "provenance_events_sequence_ck" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "provenance_events_payload_object_ck" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "chain_transactions"
  ADD CONSTRAINT "chain_transactions_attempts_ck" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "chain_transactions_signature_ck"
    CHECK ("status" NOT IN ('SUBMITTED', 'CONFIRMED', 'FINALIZED') OR "signature" IS NOT NULL);

-- ─── Partial unique indexes ───────────────────────────────────────────────────

CREATE UNIQUE INDEX "role_assignments_active_role_key"
  ON "role_assignments" ("userId", "role") WHERE "revokedAt" IS NULL;

CREATE UNIQUE INDEX "ownerships_open_period_key"
  ON "ownerships" ("assetId") WHERE "endedAt" IS NULL;

CREATE UNIQUE INDEX "transfer_requests_open_transfer_key"
  ON "transfer_requests" ("assetId") WHERE "status" IN ('PENDING', 'ACCEPTED');

-- ─── Append-only tables ───────────────────────────────────────────────────────

CREATE FUNCTION wb_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'WB001';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'asset_status_events',
    'verifier_status_events',
    'attestation_status_events',
    'attestation_evidence',
    'evidence_commitments',
    'evidence_commitment_items',
    'trust_score_snapshots',
    'provenance_events',
    'audit_logs'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wb_reject_mutation()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wb_reject_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END;
$$;

-- ─── Provenance hash chain ────────────────────────────────────────────────────
-- hash = sha256(preimage), preimage =
--   'wb-provenance-v1' | prevHash | assetId | sequence | type | actorId | occurredAt (epoch ms) | payload (jsonb text)

CREATE FUNCTION wb_provenance_hash(
  p_prev_hash text, p_asset_id uuid, p_sequence integer, p_type text,
  p_actor_id uuid, p_occurred_at timestamptz, p_payload jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    'wb-provenance-v1',
    coalesce(p_prev_hash, ''),
    p_asset_id::text,
    p_sequence::text,
    p_type,
    coalesce(p_actor_id::text, ''),
    (floor(extract(epoch FROM p_occurred_at) * 1000))::bigint::text,
    p_payload::text
  ), 'UTF8')), 'hex');
$$;

CREATE FUNCTION wb_provenance_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_sequence integer;
  last_hash text;
BEGIN
  -- Serialize appends per asset.
  PERFORM 1 FROM "assets" WHERE "id" = NEW."assetId" FOR UPDATE;

  SELECT "sequence", "hash" INTO last_sequence, last_hash
  FROM "provenance_events"
  WHERE "assetId" = NEW."assetId"
  ORDER BY "sequence" DESC
  LIMIT 1;

  NEW."sequence" := coalesce(last_sequence, 0) + 1;
  NEW."prevHash" := last_hash;
  NEW."hash" := wb_provenance_hash(
    NEW."prevHash", NEW."assetId", NEW."sequence", NEW."type"::text,
    NEW."actorId", NEW."occurredAt", NEW."payload");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provenance_events_chain"
  BEFORE INSERT ON "provenance_events"
  FOR EACH ROW EXECUTE FUNCTION wb_provenance_chain();

-- Returns the first sequence number whose link or hash is invalid, or NULL if the chain is intact.
CREATE FUNCTION wb_verify_provenance_chain(p_asset_id uuid) RETURNS integer
LANGUAGE plpgsql STABLE AS $$
DECLARE
  e record;
  expected_sequence integer := 1;
  previous text := NULL;
BEGIN
  FOR e IN
    SELECT * FROM "provenance_events" WHERE "assetId" = p_asset_id ORDER BY "sequence"
  LOOP
    IF e."sequence" <> expected_sequence
      OR e."prevHash" IS DISTINCT FROM previous
      OR e."hash" <> wb_provenance_hash(
        e."prevHash", e."assetId", e."sequence", e."type"::text, e."actorId", e."occurredAt", e."payload")
    THEN
      RETURN expected_sequence;
    END IF;
    previous := e."hash";
    expected_sequence := expected_sequence + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ─── Single-use login nonces ──────────────────────────────────────────────────

CREATE FUNCTION wb_auth_nonce_single_use() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'auth nonce % has already been used', OLD."id" USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."walletAddress", NEW."nonce", NEW."domain", NEW."issuedAt", NEW."expiresAt")
     IS DISTINCT FROM (OLD."walletAddress", OLD."nonce", OLD."domain", OLD."issuedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'auth nonce fields are immutable; only usedAt may be set' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "auth_nonces_single_use"
  BEFORE UPDATE ON "auth_nonces"
  FOR EACH ROW EXECUTE FUNCTION wb_auth_nonce_single_use();

-- ─── Immutable published templates ────────────────────────────────────────────

CREATE FUNCTION wb_template_version_immutable() RETURNS trigger
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
        NEW."minVerifiers", NEW."createdById", NEW."publishedAt", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."templateId", OLD."version", OLD."requiredClaims", OLD."requiredEvidence", OLD."allowedMethods",
        OLD."minVerifiers", OLD."createdById", OLD."publishedAt", OLD."createdAt")
  ) THEN
    RAISE EXCEPTION 'published template versions are immutable; only retirement is allowed' USING ERRCODE = 'WB002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verification_template_versions_immutable"
  BEFORE UPDATE OR DELETE ON "verification_template_versions"
  FOR EACH ROW EXECUTE FUNCTION wb_template_version_immutable();

-- ─── Attestations: authority checks and immutability ─────────────────────────

CREATE FUNCTION wb_attestation_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
  a record;
  tv record;
BEGIN
  SELECT "userId", "status" INTO v FROM "verifiers" WHERE "id" = NEW."verifierId";
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

CREATE TRIGGER "attestations_authority"
  BEFORE INSERT ON "attestations"
  FOR EACH ROW EXECUTE FUNCTION wb_attestation_authority();

CREATE FUNCTION wb_attestation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attestations cannot be deleted; revoke them instead' USING ERRCODE = 'WB002';
  END IF;
  IF (NEW."assetId", NEW."verifierId", NEW."verificationRequestId", NEW."templateVersionId", NEW."claimType",
      NEW."result", NEW."method", NEW."assuranceLevel", NEW."notes", NEW."nonce", NEW."signedPayloadHash",
      NEW."signature", NEW."issuedAt", NEW."expiresAt", NEW."supersedesId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."assetId", OLD."verifierId", OLD."verificationRequestId", OLD."templateVersionId", OLD."claimType",
      OLD."result", OLD."method", OLD."assuranceLevel", OLD."notes", OLD."nonce", OLD."signedPayloadHash",
      OLD."signature", OLD."issuedAt", OLD."expiresAt", OLD."supersedesId", OLD."createdAt") THEN
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

CREATE TRIGGER "attestations_immutable"
  BEFORE UPDATE OR DELETE ON "attestations"
  FOR EACH ROW EXECUTE FUNCTION wb_attestation_immutable();

-- ─── Verifier category permissions: no self-approval ─────────────────────────

CREATE FUNCTION wb_permission_no_self_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."approvedById" IS NOT NULL AND NEW."approvedById" = (
    SELECT "userId" FROM "verifiers" WHERE "id" = NEW."verifierId"
  ) THEN
    RAISE EXCEPTION 'verifiers cannot approve their own category permissions' USING ERRCODE = 'WB003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "verifier_category_permissions_no_self_approval"
  BEFORE INSERT OR UPDATE ON "verifier_category_permissions"
  FOR EACH ROW EXECUTE FUNCTION wb_permission_no_self_approval();
