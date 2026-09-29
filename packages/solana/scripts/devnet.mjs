// Devnet operator commands (not run in CI). Build first: `pnpm --filter @worthybound/solana build`.
//
//   node scripts/devnet.mjs init  <admin keypair path> <oracle keypair path>
//   node scripts/devnet.mjs smoke <oracle keypair path>
//
// `init` creates the program config once; the admin must be the program upgrade authority.
// `smoke` registers a throwaway asset, mirrors a status and a Trust Score, transfers it between
// two throwaway wallets and checks that the new owner cannot move it directly.
// Uses SOLANA_RPC_URL (default https://api.devnet.solana.com). Prints addresses and signatures only.
import {
  AccountRole,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { generateWbId } from "@worthybound/shared";
import {
  AssetStatus,
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  createConnection,
  explorerUrl,
  fetchAssetRecord,
  fetchMaybeConfig,
  findAssetRecordPda,
  findConfigPda,
  findCoreAssetPda,
  getCommitTrustScoreInstructionAsync,
  getInitializeInstructionAsync,
  getRegisterAssetInstructionAsync,
  getTransferAssetInstructionAsync,
  getUpdateStatusInstructionAsync,
  loadKeypairSigner,
  MPL_CORE_PROGRAM_ADDRESS,
  sendInstructions,
  VerificationLevel,
  WORTHYBOUND_PROGRAM_ADDRESS,
} from "../dist/index.js";

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (!/devnet/.test(rpcUrl)) throw new Error("SOLANA_RPC_URL must be a Devnet endpoint");
const connection = createConnection(rpcUrl);
const [command, ...args] = process.argv.slice(2);

async function init(adminPath, oraclePath) {
  const admin = await loadKeypairSigner(adminPath);
  const oracle = await loadKeypairSigner(oraclePath);
  const [config] = await findConfigPda();
  const existing = await fetchMaybeConfig(connection.rpc, config);
  if (existing.exists) {
    console.log(
      `config ${config} exists: admin ${existing.data.admin}, oracle ${existing.data.oracle}`,
    );
    return;
  }
  const [programData] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
    seeds: [getAddressEncoder().encode(WORTHYBOUND_PROGRAM_ADDRESS)],
  });
  const signature = await sendInstructions(connection, admin, [
    await getInitializeInstructionAsync({ admin, programData, oracle: oracle.address }),
  ]);
  console.log(`initialized config ${config}: admin ${admin.address}, oracle ${oracle.address}`);
  console.log(explorerUrl("tx", signature));
}

async function smoke(oraclePath) {
  const oracle = await loadKeypairSigner(oraclePath);
  const [seller, buyer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const wbId = generateWbId();
  const [assetRecord] = await findAssetRecordPda({ wbId });
  const [coreAsset] = await findCoreAssetPda({ wbId });
  const now = BigInt(Date.now());
  const step = async (name, instruction, extra = {}) => {
    const signature = await sendInstructions(connection, oracle, [instruction], extra);
    console.log(`${name}: ${explorerUrl("tx", signature)}`);
  };

  await step(
    "register",
    await getRegisterAssetInstructionAsync({
      oracle,
      owner: seller.address,
      wbId,
      uri: `https://worthybound.example/metadata/${wbId}.json`,
      status: AssetStatus.Active,
      statusChangedAt: now,
    }),
  );
  await step(
    "commit_trust_score",
    await getCommitTrustScoreInstructionAsync({
      oracle,
      assetRecord,
      score: 42,
      level: VerificationLevel.SelfDocumented,
      engineVersion: "1.1.0",
      weightsVersion: "weights-2026.2",
      inputsHash: new Uint8Array(32),
      snapshotAt: now + 1n,
    }),
  );
  await step(
    "update_status",
    await getUpdateStatusInstructionAsync({
      oracle,
      assetRecord,
      status: AssetStatus.TransferPending,
      changedAt: now + 2n,
    }),
  );
  await step(
    "transfer_asset",
    await getTransferAssetInstructionAsync({
      oracle,
      seller,
      buyer,
      assetRecord,
      coreAsset,
      statusAfter: AssetStatus.Active,
      changedAt: now + 3n,
    }),
  );

  const record = await fetchAssetRecord(connection.rpc, assetRecord);
  if (record.data.owner !== buyer.address || record.data.trustScore !== 42) {
    throw new Error("smoke: unexpected record after transfer");
  }

  // The buyer's own transfer must be rejected by the permanent freeze.
  const none = { address: MPL_CORE_PROGRAM_ADDRESS, role: AccountRole.READONLY };
  const direct = {
    programAddress: MPL_CORE_PROGRAM_ADDRESS,
    accounts: [
      { address: coreAsset, role: AccountRole.WRITABLE },
      none,
      { address: oracle.address, role: AccountRole.WRITABLE_SIGNER, signer: oracle },
      { address: buyer.address, role: AccountRole.READONLY_SIGNER, signer: buyer },
      { address: seller.address, role: AccountRole.READONLY },
      none,
      none,
    ],
    data: Uint8Array.from([14, 0]),
  };
  let rejected = false;
  try {
    await sendInstructions(connection, oracle, [direct]);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("smoke: a direct transfer was not rejected");

  console.log(`ok ${wbId}: record ${explorerUrl("address", assetRecord)}`);
  console.log(`   core asset ${explorerUrl("address", coreAsset)}`);
}

if (command === "init" && args.length === 2) await init(args[0], args[1]);
else if (command === "smoke" && args.length === 1) await smoke(args[0]);
else {
  console.error("usage: devnet.mjs init <admin keypair> <oracle keypair> | smoke <oracle keypair>");
  process.exit(2);
}
