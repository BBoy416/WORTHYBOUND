-- Claim types from the product specification that were missing from the initial schema.
-- See docs/adr/0006-core-domain-model.md.

ALTER TYPE "ClaimType" ADD VALUE 'PHYSICAL_EXISTENCE';
ALTER TYPE "ClaimType" ADD VALUE 'IDENTITY_OF_PRESENTER';
ALTER TYPE "ClaimType" ADD VALUE 'DOCUMENTATION';
ALTER TYPE "ClaimType" ADD VALUE 'OWNERSHIP_CLAIM';
