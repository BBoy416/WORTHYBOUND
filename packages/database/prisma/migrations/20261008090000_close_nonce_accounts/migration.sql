-- Recovers the rent of ended transfers' durable nonce accounts.

-- AlterEnum
ALTER TYPE "ChainTransactionKind" ADD VALUE 'CLOSE_NONCE_ACCOUNTS';
