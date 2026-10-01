// Devnet operator commands (not run in CI). Build first: `pnpm --filter @worthybound/solana build`.
//
//   node scripts/devnet.mjs init  <admin keypair path> <oracle keypair path>
//   node scripts/devnet.mjs smoke <oracle keypair path>
//   node scripts/devnet.mjs escrow <oracle keypair path> [release|refund]
//
// `init` creates the program config once; the admin must be the program upgrade authority.
// `smoke` registers a throwaway asset through the oracle client (twice, to check retries),
// mirrors a Trust Score and a status (and a stale repeat), then sells it between two throwaway
// wallets as the API does (ADR 0002, 0014): a durable nonce transaction that pays the price in SOL
// and transfers the token. It checks that a sale the buyer cannot pay moves nothing, that the
// buyer and seller can sign after the blockhash has expired, that the payment and the token move
// together, that the transaction cannot run twice and that the new owner cannot move the token
// directly. The oracle pays the fees and funds the buyer (about 0.02 SOL per run).
// `escrow` sells two throwaway assets in escrow (ADR 0014): the parties sign the transfer, a first
// payment is abandoned and reset so it can no longer land, the buyer pays into the escrow nonce
// account, then the first sale is released (the seller is paid from escrow and the token moves in
// one transaction) and the second is refunded, after which its prepared transfer can no longer run. The oracle pays the fees and funds the buyer (about
// 0.05 SOL per run, including four nonce accounts that stay open).
// Uses SOLANA_RPC_URL (default https://api.devnet.solana.com). Prints addresses and signatures only.
import {
  AccountRole,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { generateWbId } from "@worthybound/shared";
import {
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  chainAddresses,
  createConnection,
  createWorthyBoundOracle,
  explorerUrl,
  fetchAssetRecord,
  fetchMaybeConfig,
  findConfigPda,
  getInitializeInstructionAsync,
  loadKeypairSigner,
  MPL_CORE_PROGRAM_ADDRESS,
  NONCE_ACCOUNT_SIZE,
  sendInstructions,
  StaleChainUpdateError,
  systemTransferInstruction,
  transferSignature,
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

const PRICE = 10_000_000n;

/** Signs the prepared transaction as a wallet does and returns the signature WorthyBound keeps. */
async function walletSignature(transaction, signer) {
  const decoded = getTransactionDecoder().decode(Buffer.from(transaction, "base64"));
  const signed = await partiallySignTransaction([signer.keyPair], decoded);
  const wire = Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
  return transferSignature(transaction, wire, signer.address);
}

/** Waits until a blockhash fetched now can no longer be used. */
async function outliveBlockhash() {
  const { value } = await connection.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const height = await connection.rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > value.lastValidBlockHeight) return;
  }
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
  const sale = (priceLamports) =>
    oracle.prepareTransfer({
      wbId,
      seller: seller.address,
      buyer: buyer.address,
      statusAfter: "ACTIVE",
      statusSeq: 3n,
      priceLamports,
    });
  const sign = async (transaction) => ({
    [buyer.address]: await walletSignature(transaction, buyer),
    [seller.address]: await walletSignature(transaction, seller),
  });
  log(
    "fund_buyer",
    await sendInstructions(connection, oracleSigner, [
      systemTransferInstruction({ from: oracleSigner, to: buyer.address, lamports: PRICE }),
    ]),
  );

  // A sale the buyer cannot pay must move neither the SOL nor the token.
  const unpaid = await sale(PRICE * 2n);
  let failed = false;
  try {
    await oracle.sendTransfer({
      transaction: unpaid.transaction,
      signatures: await sign(unpaid.transaction),
    });
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("smoke: a sale the buyer cannot pay was accepted");
  if ((await fetchAssetRecord(connection.rpc, assetRecord)).data.owner !== seller.address) {
    throw new Error("smoke: the token moved without payment");
  }
  console.log("unpaid sale rejected; token and SOL did not move");

  // The buyer signs first; the seller signs after the blockhash has expired.
  const { transaction, nonceAccount } = await sale(PRICE);
  console.log(`nonce account: ${explorerUrl("address", nonceAccount)}`);
  const buyerSignature = await walletSignature(transaction, buyer);
  console.log("buyer signed; waiting for the blockhash to expire (about a minute)");
  await outliveBlockhash();
  const sellerSignature = await walletSignature(transaction, seller);
  const signatures = { [buyer.address]: buyerSignature, [seller.address]: sellerSignature };
  const sold = await oracle.sendTransfer({ transaction, signatures });
  log("transfer_asset with payment", sold);
  const [sellerBalance, buyerBalance] = await Promise.all([
    oracle.getBalance(seller.address),
    oracle.getBalance(buyer.address),
  ]);
  if (sellerBalance !== PRICE || buyerBalance !== 0n) {
    throw new Error(`smoke: unexpected balances seller ${sellerBalance}, buyer ${buyerBalance}`);
  }
  console.log(`seller received ${Number(PRICE) / 1e9} SOL from the buyer`);
  if ((await oracle.sendTransfer({ transaction, signatures })) !== sold) {
    throw new Error("smoke: a repeated send did not return the original signature");
  }

  const record = await fetchAssetRecord(connection.rpc, assetRecord);
  if (
    record.data.owner !== buyer.address ||
    record.data.trustScore !== 42 ||
    record.data.statusSeq !== 3n
  ) {
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

/** Retries a call the public RPC rate-limited (HTTP 429). */
async function patiently(call) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 6 || !String(error?.message).includes("429")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

async function escrow(oraclePath, only) {
  const oracleSigner = await loadKeypairSigner(oraclePath);
  const oracle = createWorthyBoundOracle(connection, oracleSigner);
  const [seller, buyer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const log = (name, signature) => console.log(`${name}: ${explorerUrl("tx", signature)}`);
  const balance = (address) => patiently(() => oracle.getBalance(address));
  const rent = await connection.rpc.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_SIZE).send();

  /** A registered asset of the seller with a transfer in escrow that the buyer paid. */
  async function paidSale(name) {
    const wbId = generateWbId();
    log(
      `${name} register`,
      await oracle.registerAsset({
        wbId,
        owner: seller.address,
        uri: `https://worthybound.example/metadata/${wbId}`,
        status: "ACTIVE",
        statusSeq: 1n,
      }),
    );
    log(
      `${name} update_status`,
      await oracle.updateStatus({ wbId, status: "TRANSFER_PENDING", statusSeq: 2n }),
    );
    const prepared = await oracle.prepareTransfer({
      wbId,
      seller: seller.address,
      buyer: buyer.address,
      statusAfter: "ACTIVE",
      statusSeq: 3n,
      priceLamports: PRICE,
      escrow: true,
    });
    console.log(`${name} escrow account: ${explorerUrl("address", prepared.nonceAccount)}`);
    const signatures = {
      [buyer.address]: await walletSignature(prepared.transaction, buyer),
      [seller.address]: await walletSignature(prepared.transaction, seller),
    };
    log(
      `${name} fund_buyer`,
      await sendInstructions(connection, oracleSigner, [
        systemTransferInstruction({ from: oracleSigner, to: buyer.address, lamports: PRICE }),
      ]),
    );
    const escrowPayment = {
      buyer: buyer.address,
      escrowAccount: prepared.nonceAccount,
      paymentNonceAccount: prepared.paymentNonceAccount,
      priceLamports: PRICE,
    };
    // A payment the worker gives up on can no longer land once its nonce is advanced.
    const abandoned = await oracle.prepareEscrowPayment(escrowPayment);
    const abandonedSignatures = { [buyer.address]: await walletSignature(abandoned, buyer) };
    const reset = await patiently(() => oracle.resetEscrowPayment(escrowPayment));
    if (reset.held) throw new Error("escrow: reset found a payment that was never sent");
    const late = await oracle
      .sendTransfer({ transaction: abandoned, signatures: abandonedSignatures })
      .then(
        () => true,
        () => false,
      );
    if (late) throw new Error("escrow: a payment landed after its nonce was advanced");
    console.log(`${name}: the abandoned payment was rejected after the reset`);
    const payment = reset.transaction;
    const paymentSignatures = { [buyer.address]: await walletSignature(payment, buyer) };
    const paid = await oracle.sendTransfer({ transaction: payment, signatures: paymentSignatures });
    log(`${name} payment into escrow`, paid);
    if (
      (await oracle.sendTransfer({ transaction: payment, signatures: paymentSignatures })) !== paid
    ) {
      throw new Error("escrow: a repeated payment did not return the original signature");
    }
    // A payment that landed unseen is found by the reset.
    if (!(await patiently(() => oracle.resetEscrowPayment(escrowPayment))).held) {
      throw new Error("escrow: reset did not find the payment in escrow");
    }
    const [held, left] = await Promise.all([
      balance(prepared.nonceAccount),
      balance(buyer.address),
    ]);
    if (held !== rent + PRICE || left !== 0n) {
      throw new Error(`escrow: unexpected balances escrow ${held}, buyer ${left}`);
    }
    return { wbId, ...prepared, signatures };
  }

  if (only !== "refund") await releaseSale();
  if (only !== "release") await refundSale();

  async function releaseSale() {
    const released = await paidSale("release");
    const { record } = await chainAddresses(released.wbId);
    log(
      "release transfer_asset from escrow",
      await oracle.sendTransfer({
        transaction: released.transaction,
        signatures: released.signatures,
      }),
    );
    const [sellerBalance, escrowAfter] = await Promise.all([
      balance(seller.address),
      balance(released.nonceAccount),
    ]);
    if (sellerBalance !== PRICE || escrowAfter !== rent) {
      throw new Error(`escrow: unexpected balances seller ${sellerBalance}, escrow ${escrowAfter}`);
    }
    if ((await fetchAssetRecord(connection.rpc, record)).data.owner !== buyer.address) {
      throw new Error("escrow: the token did not move to the buyer");
    }
    console.log("released: the seller was paid from escrow and the token moved to the buyer");
    console.log(`ok ${released.wbId} released`);
  }

  async function refundSale() {
    const refunded = await paidSale("refund");
    const refund = await oracle.refundEscrow({
      escrowAccount: refunded.nonceAccount,
      buyer: buyer.address,
      priceLamports: PRICE,
    });
    log("refund", refund);
    if (
      (await balance(buyer.address)) !== PRICE ||
      (await balance(refunded.nonceAccount)) !== rent
    ) {
      throw new Error("escrow: the refund did not return the price to the buyer");
    }
    const again = await patiently(() =>
      oracle.refundEscrow({
        escrowAccount: refunded.nonceAccount,
        buyer: buyer.address,
        priceLamports: PRICE,
      }),
    );
    if (again !== null) throw new Error("escrow: a second refund was sent");
    let stale = false;
    try {
      await patiently(() =>
        oracle.sendTransfer({
          transaction: refunded.transaction,
          signatures: refunded.signatures,
        }),
      );
    } catch {
      stale = true;
    }
    if (!stale) throw new Error("escrow: the transfer ran after the refund");
    const { record: refundRecord } = await chainAddresses(refunded.wbId);
    if ((await fetchAssetRecord(connection.rpc, refundRecord)).data.owner !== seller.address) {
      throw new Error("escrow: the refunded token moved");
    }
    console.log("refunded: the buyer got the price back and the prepared transfer cannot run");
    console.log(`ok ${refunded.wbId} refunded`);
  }
}

if (command === "init" && args.length === 2) await init(args[0], args[1]);
else if (command === "smoke" && args.length === 1) await smoke(args[0]);
else if (command === "escrow" && [1, 2].includes(args.length)) await escrow(args[0], args[1]);
else {
  console.error(
    "usage: devnet.mjs init <admin keypair> <oracle keypair> | smoke | escrow <oracle keypair>",
  );
  process.exit(2);
}
