-- Phase 10 (ADR 0016): chain jobs that a newer on-chain update made unnecessary.
ALTER TYPE "ChainTransactionStatus" ADD VALUE 'SUPERSEDED';
