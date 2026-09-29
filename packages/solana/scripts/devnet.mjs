// Devnet operator commands (not run in CI). Build first: `pnpm --filter @worthybound/solana build`.
//
//   node scripts/devnet.mjs init  <admin keypair path> <oracle keypair path>
//   node scripts/devnet.mjs smoke <oracle keypair path>
//
// `init` creates the program config once; the admin must be the program upgrade authority.
// `smoke` registers a throwaway asset through the oracle client (twice, to check retries),
// mirrors a Trust Score and a status (and a stale repeat), transfers it between two throwaway
// wallets and checks that the new owner cannot move it directly.
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
  chainAddresses,
  createConnection,
  createWorthyBoundOracle,
  explorerUrl,
  fetchAssetRecord,
  fetchMaybeConfig,
  findConfigPda,
  getInitializeInstructionAsync,
  getTransferAssetInstructionAsync,
  loadKeypairSigner,
  MPL_CORE_PROGRAM_ADDRESS,
  sendInstructions,
  StaleChainUpdateError,
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
  const oracleSigner = await loadKeypairSigner(oraclePath);
  const oracle = createWorthyBoundOracle(connection, oracleSigner);
  const [seller, buyer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const wbId = generateWbId();
  const { record: assetRecord, coreAsset } = await chainAddresses(wbId);
  const log = (name, signature) => console.log(`${name}: ${explorerUrl("tx", signature)}`);

  const registration = {
    wbId,
    owner: seller.address,
    uri: `https://worthybound.example/metadata/${wbId}`,
    status: "ACTIVE",
    statusSeq: 1n,
  };
  const registered = await oracle.registerAsset(registration);
  log("register", registered);
  if ((await oracle.registerAsset(registration)) !== registered) {
    throw new Error("smoke: a repeated registration did not return the original signature");
  }
  log(
    "commit_trust_score",
    await oracle.commitTrustScore({
      wbId,
      score: 42,
      level: "SELF_DOCUMENTED",
      engineVersion: "1.1.0",
      weightsVersion: "weights-2026.2",
      inputsHash: "00".repeat(32),
      trustSeq: 1n,
    }),
  );
  log(
    "update_status",
    await oracle.updateStatus({ wbId, status: "TRANSFER_PENDING", statusSeq: 2n }),
  );
  try {
    await oracle.updateStatus({ wbId, status: "ACTIVE", statusSeq: 2n });
    throw new Error("smoke: a repeated status update was accepted");
  } catch (error) {
    if (!(error instanceof StaleChainUpdateError)) throw error;
  }
  log(
    "transfer_asset",
    await sendInstructions(connection, oracleSigner, [
      await getTransferAssetInstructionAsync({
        oracle: oracleSigner,
        seller,
        buyer,
        assetRecord,
        coreAsset,
        statusAfter: AssetStatus.Active,
        statusSeq: 3n,
      }),
    ]),
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
      { address: oracleSigner.address, role: AccountRole.WRITABLE_SIGNER, signer: oracleSigner },
      { address: buyer.address, role: AccountRole.READONLY_SIGNER, signer: buyer },
      { address: seller.address, role: AccountRole.READONLY },
      none,
      none,
    ],
    data: Uint8Array.from([14, 0]),
  };
  let rejected = false;
  try {
    await sendInstructions(connection, oracleSigner, [direct]);
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
