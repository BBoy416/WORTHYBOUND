import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Address,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import type { AssetStatus, VerificationLevel } from "@worthybound/shared";
import { customProgramErrorCode, StaleChainUpdateError } from "./errors.js";
import {
  fetchMaybeAssetRecord,
  findAssetRecordPda,
  findCoreAssetPda,
  getCommitTrustScoreInstructionAsync,
  getRegisterAssetInstructionAsync,
  getUpdateStatusInstructionAsync,
  WORTHYBOUND_ERROR__STALE_UPDATE,
} from "./generated/index.js";
import { sendInstructions, type SolanaConnection } from "./rpc.js";
import { toChainAssetStatus, toChainVerificationLevel } from "./status.js";
import {
  buildEscrowPaymentTransaction,
  buildEscrowRefundTransaction,
  buildNonceAdvanceTransaction,
  buildTransferTransaction,
  completeTransferTransaction,
  createNonceAccountInstructions,
  NONCE_ACCOUNT_SIZE,
  readNonceAccount,
} from "./transfer.js";

/** How long `sendTransfer` waits for confirmation before the caller retries. */
const TRANSFER_CONFIRM_ATTEMPTS = 30;
const TRANSFER_CONFIRM_INTERVAL_MS = 2_000;

/** A transfer transaction landed but failed; its nonce has moved on, so it cannot be resent. */
export class TransferFailedError extends Error {
  constructor(detail: string) {
    super(`transfer transaction failed: ${detail}`);
    this.name = "TransferFailedError";
  }
}

export interface ChainAddresses {
  record: Address;
  coreAsset: Address;
}

export interface ChainRecordState {
  owner: Address;
  statusSeq: bigint;
  trustSeq: bigint;
}

/** Deterministic addresses of an asset's record and Core asset. */
export async function chainAddresses(wbId: string): Promise<ChainAddresses> {
  const [[record], [coreAsset]] = await Promise.all([
    findAssetRecordPda({ wbId }),
    findCoreAssetPda({ wbId }),
  ]);
  return { record, coreAsset };
}

/** What the backend needs from the chain; the API depends on this interface only. */
export interface WorthyBoundOracle {
  readonly oracleAddress: Address;
  fetchRecord(wbId: string): Promise<ChainRecordState | null>;
  /**
   * Registers and mints the frozen token. If the record already exists for this owner (an
   * earlier attempt landed), returns the signature that created it instead of failing.
   */
  registerAsset(input: {
    wbId: string;
    owner: string;
    uri: string;
    status: AssetStatus;
    statusSeq: bigint;
  }): Promise<Signature>;
  /** Throws StaleChainUpdateError if the chain holds this sequence number or a newer one. */
  updateStatus(input: { wbId: string; status: AssetStatus; statusSeq: bigint }): Promise<Signature>;
  /** Throws StaleChainUpdateError if the chain holds this sequence number or a newer one. */
  commitTrustScore(input: {
    wbId: string;
    score: number;
    level: VerificationLevel;
    engineVersion: string;
    weightsVersion: string;
    /** SHA-256 as 64 hex characters. */
    inputsHash: string;
    trustSeq: bigint;
  }): Promise<Signature>;
  /**
   * Creates a durable nonce account for one transfer and returns the unsigned `transfer_asset`
   * transaction (base64 wire bytes) for seller and buyer to sign. In escrow (ADR 0014), the nonce
   * account also holds the buyer's payment until the transaction pays the seller from it, and a
   * second nonce account is created for the payment, with a price.
   */
  prepareTransfer(input: {
    wbId: string;
    seller: string;
    buyer: string;
    statusAfter: AssetStatus;
    statusSeq: bigint;
    /** Paid by the buyer to the seller in the same transaction, or from escrow; 0 for none. */
    priceLamports: bigint;
    escrow?: boolean;
  }): Promise<{ transaction: string; nonceAccount: string; paymentNonceAccount: string | null }>;
  /**
   * The buyer's unsigned payment of the price into the escrow nonce account, with the payment
   * nonce account's current nonce. Rebuilt after a payment that failed.
   */
  prepareEscrowPayment(input: {
    buyer: string;
    escrowAccount: string;
    paymentNonceAccount: string;
    priceLamports: bigint;
  }): Promise<string>;
  /**
   * Gives up on a payment into escrow that was signed but not seen to land: advances the payment
   * nonce, so it can no longer land, then tells whether the escrow holds the price. If not, returns
   * a new unsigned payment for the buyer to sign.
   */
  resetEscrowPayment(input: {
    buyer: string;
    escrowAccount: string;
    paymentNonceAccount: string;
    priceLamports: bigint;
  }): Promise<{ held: true } | { held: false; transaction: string }>;
  /**
   * Returns the escrowed price to the buyer and advances the escrow nonce, so the prepared
   * transfer can no longer run. Null if the escrow no longer holds the price (already refunded).
   */
  refundEscrow(input: {
    escrowAccount: string;
    buyer: string;
    priceLamports: bigint;
  }): Promise<Signature | null>;
  /** Lamports held by the account, 0 if it does not exist. */
  getBalance(address: string): Promise<bigint>;
  /**
   * Adds the oracle's signature to the prepared transaction and sends it, or returns its
   * signature if it already landed. Throws TransferFailedError if it landed and failed.
   */
  sendTransfer(input: {
    transaction: string;
    /** Base58 signatures of seller and buyer, by address. */
    signatures: Record<string, string>;
  }): Promise<Signature>;
}

export function createWorthyBoundOracle(
  connection: SolanaConnection,
  oracle: KeyPairSigner,
): WorthyBoundOracle {
  const send = async (instruction: Parameters<typeof sendInstructions>[2][number]) => {
    try {
      return await sendInstructions(connection, oracle, [instruction]);
    } catch (error) {
      if (customProgramErrorCode(error) === WORTHYBOUND_ERROR__STALE_UPDATE) {
        throw new StaleChainUpdateError();
      }
      throw error;
    }
  };

  const fetchRecord = async (wbId: string): Promise<ChainRecordState | null> => {
    const { record } = await chainAddresses(wbId);
    const account = await fetchMaybeAssetRecord(connection.rpc, record);
    if (!account.exists) return null;
    return {
      owner: account.data.owner,
      statusSeq: account.data.statusSeq,
      trustSeq: account.data.trustSeq,
    };
  };

  const rentExempt = async () =>
    connection.rpc.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_SIZE).send();

  const readNonce = async (account: Address) => {
    const info = await connection.rpc
      .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
      .send();
    if (!info.value) throw new Error(`nonce account ${account} not found`);
    return readNonceAccount(Buffer.from(info.value.data[0], "base64"));
  };

  const client: WorthyBoundOracle = {
    oracleAddress: oracle.address,
    fetchRecord,

    async registerAsset({ wbId, owner, uri, status, statusSeq }) {
      const existing = await fetchRecord(wbId);
      if (existing) {
        if (existing.owner !== owner) throw new Error(`${wbId} is registered to another wallet`);
        const { record } = await chainAddresses(wbId);
        const history = await connection.rpc
          .getSignaturesForAddress(record, { commitment: "confirmed" })
          .send();
        const first = history.at(-1);
        if (!first) throw new Error(`${wbId}: record exists but has no transaction history`);
        return first.signature;
      }
      return send(
        await getRegisterAssetInstructionAsync({
          oracle,
          owner: owner as Address,
          wbId,
          uri,
          status: toChainAssetStatus(status),
          statusSeq,
        }),
      );
    },

    async updateStatus({ wbId, status, statusSeq }) {
      const { record } = await chainAddresses(wbId);
      return send(
        await getUpdateStatusInstructionAsync({
          oracle,
          assetRecord: record,
          status: toChainAssetStatus(status),
          statusSeq,
        }),
      );
    },

    async commitTrustScore(input) {
      if (!/^[0-9a-f]{64}$/.test(input.inputsHash)) throw new Error("inputsHash must be hex");
      const { record } = await chainAddresses(input.wbId);
      return send(
        await getCommitTrustScoreInstructionAsync({
          oracle,
          assetRecord: record,
          score: input.score,
          level: toChainVerificationLevel(input.level),
          engineVersion: input.engineVersion,
          weightsVersion: input.weightsVersion,
          inputsHash: Buffer.from(input.inputsHash, "hex"),
          trustSeq: input.trustSeq,
        }),
      );
    },

    async prepareTransfer(input) {
      const { wbId, seller, buyer, statusAfter, statusSeq, priceLamports } = input;
      const escrow = input.escrow === true;
      const nonceAccount = await generateKeyPairSigner();
      const paymentNonce = escrow && priceLamports > 0n ? await generateKeyPairSigner() : null;
      const lamports = await rentExempt();
      await sendInstructions(
        connection,
        oracle,
        [nonceAccount, ...(paymentNonce ? [paymentNonce] : [])].flatMap((account) =>
          createNonceAccountInstructions({
            payer: oracle,
            nonceAccount: account,
            authority: oracle.address,
            lamports,
          }),
        ),
      );
      const { nonce } = await readNonce(nonceAccount.address);
      const transaction = await buildTransferTransaction({
        wbId,
        oracle: oracle.address,
        seller: seller as Address,
        buyer: buyer as Address,
        statusAfter,
        statusSeq,
        nonceAccount: nonceAccount.address,
        nonce,
        priceLamports,
        escrow,
      });
      return {
        transaction,
        nonceAccount: nonceAccount.address,
        paymentNonceAccount: paymentNonce?.address ?? null,
      };
    },

    async prepareEscrowPayment({ buyer, escrowAccount, paymentNonceAccount, priceLamports }) {
      const { nonce } = await readNonce(paymentNonceAccount as Address);
      return buildEscrowPaymentTransaction({
        oracle: oracle.address,
        buyer: buyer as Address,
        escrowAccount: escrowAccount as Address,
        paymentNonceAccount: paymentNonceAccount as Address,
        nonce,
        priceLamports,
      });
    },

    async resetEscrowPayment(input) {
      const paymentNonce = input.paymentNonceAccount as Address;
      const { nonce } = await readNonce(paymentNonce);
      await client.sendTransfer({
        transaction: buildNonceAdvanceTransaction({
          oracle: oracle.address,
          nonceAccount: paymentNonce,
          nonce,
        }),
        signatures: {},
      });
      const [{ value: balance }, rent] = await Promise.all([
        connection.rpc
          .getBalance(input.escrowAccount as Address, { commitment: "confirmed" })
          .send(),
        rentExempt(),
      ]);
      if (BigInt(balance) >= rent + input.priceLamports) return { held: true };
      return { held: false, transaction: await client.prepareEscrowPayment(input) };
    },

    async refundEscrow({ escrowAccount, buyer, priceLamports }) {
      const [{ nonce }, { value: balance }, rent] = await Promise.all([
        readNonce(escrowAccount as Address),
        connection.rpc.getBalance(escrowAccount as Address, { commitment: "confirmed" }).send(),
        rentExempt(),
      ]);
      if (BigInt(balance) < rent + priceLamports) return null;
      const transaction = buildEscrowRefundTransaction({
        oracle: oracle.address,
        buyer: buyer as Address,
        escrowAccount: escrowAccount as Address,
        nonce,
        priceLamports,
      });
      return client.sendTransfer({ transaction, signatures: {} });
    },

    async getBalance(account) {
      const { value } = await connection.rpc
        .getBalance(account as Address, { commitment: "confirmed" })
        .send();
      return BigInt(value);
    },

    async sendTransfer({ transaction, signatures }) {
      const signed = await completeTransferTransaction(transaction, signatures, oracle);
      const signature = getSignatureFromTransaction(signed);
      const landed = async () => {
        const { value } = await connection.rpc
          .getSignatureStatuses([signature], { searchTransactionHistory: true })
          .send();
        const status = value[0];
        if (status?.err) throw new TransferFailedError(JSON.stringify(status.err));
        return status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized"
          ? signature
          : null;
      };
      if (await landed()) return signature;
      await connection.rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: "base64",
          preflightCommitment: "confirmed",
        })
        .send();
      for (let i = 0; i < TRANSFER_CONFIRM_ATTEMPTS; i++) {
        await new Promise((resolve) => setTimeout(resolve, TRANSFER_CONFIRM_INTERVAL_MS));
        if (await landed()) return signature;
      }
      throw new Error("transfer transaction not confirmed yet");
    },
  };
  return client;
}
