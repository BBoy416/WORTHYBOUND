import { isAddress } from "@solana/addresses";
import { createPrismaClient, type IdentityStatus } from "@worthybound/database";
import { writeAudit } from "../audit.js";
import { recordTrustForAssets } from "../trust/record.js";
import { releaseVerifierRequests } from "../verification/requests.js";
import { loadLocalEnv } from "../env.js";

export const KYC_RECORD_STATUSES = ["VERIFIED", "REJECTED", "EXPIRED"] as const;
export type KycRecordStatus = (typeof KYC_RECORD_STATUSES)[number];

export interface KycRecordInput {
  walletAddress: string;
  provider: string;
  reference: string;
  status: KycRecordStatus;
}

/**
 * Records the result of an identity check made by a KYC provider, until a provider integration
 * exists. Run only by the server operator: `pnpm kyc:record <wallet> <provider> <reference>`.
 * Only the status and the provider reference are stored, never identity documents (ADR 0004).
 */
export async function recordKyc(
  prisma: ReturnType<typeof createPrismaClient>,
  input: KycRecordInput,
  now: () => Date = () => new Date(),
): Promise<{ fromStatus: IdentityStatus; status: KycRecordStatus }> {
  if (!isAddress(input.walletAddress)) throw new Error("Invalid wallet address");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.provider)) throw new Error("Invalid provider name");
  if (!/^[\x21-\x7e]{1,200}$/.test(input.reference)) throw new Error("Invalid provider reference");
  if (!(KYC_RECORD_STATUSES as readonly string[]).includes(input.status)) {
    throw new Error(`Status must be one of ${KYC_RECORD_STATUSES.join(", ")}`);
  }
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { walletAddress: input.walletAddress } });
    if (!user) throw new Error("No user with this wallet address; they must sign in first");
    const at = now();
    await tx.user.update({
      where: { id: user.id },
      data: {
        identityStatus: input.status,
        identityProvider: input.provider,
        identityProviderRef: input.reference,
        ...(input.status === "VERIFIED" ? { identityVerifiedAt: at } : {}),
        updatedAt: at,
      },
    });
    await writeAudit(
      tx,
      {
        actorId: null,
        action: "identity.recorded",
        targetType: "user",
        targetId: user.id,
        metadata: {
          fromStatus: user.identityStatus,
          status: input.status,
          provider: input.provider,
          via: "cli",
        },
      },
      null,
    );
    if (input.status !== "VERIFIED") {
      await tx.$queryRaw`SELECT 1 FROM "verifiers" WHERE "userId" = ${user.id}::uuid FOR UPDATE`;
      const verifier = await tx.verifier.findUnique({ where: { userId: user.id } });
      if (verifier) {
        await releaseVerifierRequests(tx, verifier.id, "verifier_identity_not_verified", at);
      }
    }
    const owned = await tx.asset.findMany({
      where: { ownerId: user.id, NOT: { status: "REVOKED", publishedAt: null } },
      select: { id: true },
    });
    await recordTrustForAssets(
      tx,
      owned.map((a) => a.id),
      at,
    );
    return { fromStatus: user.identityStatus, status: input.status };
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  loadLocalEnv();
  const [wallet, provider, reference, status = "VERIFIED"] = process.argv.slice(2);
  if (!wallet || !provider || !reference || process.argv.length > 6) {
    console.error(
      `Usage: pnpm kyc:record <wallet address> <provider> <reference> [${KYC_RECORD_STATUSES.join("|")}]`,
    );
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(2);
  }
  const prisma = createPrismaClient(url);
  try {
    const result = await recordKyc(prisma, {
      walletAddress: wallet,
      provider,
      reference,
      status: status as KycRecordStatus,
    });
    console.log(`Identity of ${wallet}: ${result.fromStatus} -> ${result.status}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
