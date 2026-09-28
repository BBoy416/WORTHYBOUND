import { isAddress } from "@solana/addresses";
import { createPrismaClient } from "@worthybound/database";
import { writeAudit } from "../audit.js";
import { loadLocalEnv } from "../env.js";

/**
 * Grants ADMIN to a wallet. Run only by the server operator: `pnpm admin:grant <wallet>`.
 * There is no API for this, so no user can make themselves an administrator.
 */
export async function grantAdmin(
  prisma: ReturnType<typeof createPrismaClient>,
  walletAddress: string,
): Promise<"granted" | "already_admin"> {
  if (!isAddress(walletAddress)) throw new Error("Invalid wallet address");
  return prisma.$transaction(async (tx) => {
    const created = await tx.user.createMany({ data: [{ walletAddress }], skipDuplicates: true });
    const user = await tx.user.findUniqueOrThrow({ where: { walletAddress } });
    if (created.count === 1) {
      await tx.roleAssignment.create({ data: { userId: user.id, role: "USER" } });
    }
    const granted = await tx.roleAssignment.createMany({
      data: [{ userId: user.id, role: "ADMIN" }],
      skipDuplicates: true,
    });
    if (granted.count === 0) return "already_admin";
    await writeAudit(
      tx,
      {
        actorId: null,
        action: "role.granted",
        targetType: "user",
        targetId: user.id,
        metadata: { role: "ADMIN", via: "cli", newUser: created.count === 1 },
      },
      null,
    );
    return "granted";
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  loadLocalEnv();
  const wallet = process.argv[2];
  if (!wallet || process.argv.length > 3) {
    console.error("Usage: pnpm admin:grant <wallet address>");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(2);
  }
  const prisma = createPrismaClient(url);
  try {
    const result = await grantAdmin(prisma, wallet);
    console.log(
      result === "granted" ? `ADMIN granted to ${wallet}` : `${wallet} is already an admin`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
