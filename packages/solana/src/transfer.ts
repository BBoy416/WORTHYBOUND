import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransaction,
  verifySignature,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Nonce,
  type SignatureBytes,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import type { AssetStatus } from "@worthybound/shared";
import { getTransferAssetInstructionAsync } from "./generated/index.js";
import { chainAddresses } from "./oracle.js";
import { toChainAssetStatus } from "./status.js";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const RECENT_BLOCKHASHES_SYSVAR = address("SysvarRecentB1ockHashes11111111111111111111");
const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

/** Size of a System program nonce account. */
export const NONCE_ACCOUNT_SIZE = 80n;

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};
const concat = (...parts: ArrayLike<number>[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** System program CreateAccount and InitializeNonceAccount: a durable nonce owned by `authority`. */
export function createNonceAccountInstructions(input: {
  payer: TransactionSigner;
  nonceAccount: TransactionSigner;
  authority: Address;
  lamports: bigint;
}): Instruction[] {
  const addresses = getAddressEncoder();
  const signer = (s: TransactionSigner): AccountSignerMeta => ({
    address: s.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: s,
  });
  return [
    {
      programAddress: SYSTEM_PROGRAM,
      accounts: [signer(input.payer), signer(input.nonceAccount)],
      data: concat(
        u32(0),
        u64(input.lamports),
        u64(NONCE_ACCOUNT_SIZE),
        addresses.encode(SYSTEM_PROGRAM),
      ),
    },
    {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: input.nonceAccount.address, role: AccountRole.WRITABLE },
        { address: RECENT_BLOCKHASHES_SYSVAR, role: AccountRole.READONLY },
        { address: RENT_SYSVAR, role: AccountRole.READONLY },
      ],
      data: concat(u32(6), addresses.encode(input.authority)),
    },
  ];
}

/** System program Transfer: `lamports` from `from`, who signs, to `to`. */
export function systemTransferInstruction(input: {
  from: TransactionSigner;
  to: Address;
  lamports: bigint;
}): Instruction {
  const from: AccountSignerMeta = {
    address: input.from.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.from,
  };
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [from, { address: input.to, role: AccountRole.WRITABLE }],
    data: concat(u32(2), u64(input.lamports)),
  };
}

/** Authority and current value of an initialized nonce account. */
export function readNonceAccount(data: Uint8Array): { authority: Address; nonce: Nonce } {
  // Versions::Current (1), State::Initialized (1), authority, durable nonce, fee calculator.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length !== Number(NONCE_ACCOUNT_SIZE) || view.getUint32(4, true) !== 1) {
    throw new Error("not an initialized nonce account");
  }
  const addresses = getAddressDecoder();
  return {
    authority: addresses.decode(data.slice(8, 40)),
    nonce: addresses.decode(data.slice(40, 72)) as string as Nonce,
  };
}

/**
 * The `transfer_asset` transaction, unsigned, as base64 wire bytes. It uses a durable nonce
 * instead of a recent blockhash, so seller and buyer can sign it hours apart; the oracle pays the
 * fees, advances the nonce and signs last (ADR 0002). With a price, the buyer's payment to the
 * seller is in the same transaction, so both happen or neither does (ADR 0014).
 */
export async function buildTransferTransaction(input: {
  wbId: string;
  oracle: Address;
  seller: Address;
  buyer: Address;
  statusAfter: AssetStatus;
  statusSeq: bigint;
  nonceAccount: Address;
  nonce: string;
  /** Paid by the buyer to the seller; none when 0 or omitted. */
  priceLamports?: bigint;
}): Promise<string> {
  const { record, coreAsset } = await chainAddresses(input.wbId);
  const buyer = createNoopSigner(input.buyer);
  const price = input.priceLamports ?? 0n;
  if (price < 0n) throw new Error("price must not be negative");
  const instruction = await getTransferAssetInstructionAsync({
    oracle: createNoopSigner(input.oracle),
    seller: createNoopSigner(input.seller),
    buyer,
    assetRecord: record,
    coreAsset,
    statusAfter: toChainAssetStatus(input.statusAfter),
    statusSeq: input.statusSeq,
  });
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(input.oracle, m),
    (m) =>
      setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: input.nonce as Nonce,
          nonceAccountAddress: input.nonceAccount,
          nonceAuthorityAddress: input.oracle,
        },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        price > 0n
          ? [
              systemTransferInstruction({ from: buyer, to: input.seller, lamports: price }),
              instruction,
            ]
          : [instruction],
        m,
      ),
  );
  const bytes = getTransactionEncoder().encode(compileTransaction(message));
  return Buffer.from(bytes).toString("base64");
}

export type TransferSignatureProblem =
  | "invalid_transaction"
  | "transaction_changed"
  | "not_a_signer"
  | "missing_signature"
  | "invalid_signature";

export class TransferSignatureError extends Error {
  constructor(readonly problem: TransferSignatureProblem) {
    super(`transfer signature rejected: ${problem}`);
    this.name = "TransferSignatureError";
  }
}

function decodeTransaction(base64: string): Transaction {
  try {
    return getTransactionDecoder().decode(Buffer.from(base64, "base64")) as Transaction;
  } catch {
    throw new TransferSignatureError("invalid_transaction");
  }
}

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);

/**
 * Checks that the wallet signed exactly the prepared transaction and returns the signer's
 * signature (base58). Wallets return the whole transaction; a changed message is rejected.
 */
export async function transferSignature(
  transaction: string,
  signedTransaction: string,
  signer: string,
): Promise<string> {
  const prepared = decodeTransaction(transaction);
  const signed = decodeTransaction(signedTransaction);
  if (!sameBytes(prepared.messageBytes, signed.messageBytes)) {
    throw new TransferSignatureError("transaction_changed");
  }
  if (!(signer in prepared.signatures)) throw new TransferSignatureError("not_a_signer");
  const signature = signed.signatures[signer as Address];
  if (!signature || signature.every((b) => b === 0)) {
    throw new TransferSignatureError("missing_signature");
  }
  const key = await getPublicKeyFromAddress(signer as Address);
  if (!(await verifySignature(key, signature, prepared.messageBytes))) {
    throw new TransferSignatureError("invalid_signature");
  }
  return getBase58Decoder().decode(signature);
}

/** The prepared transaction with the parties' signatures (base58), signed last by the oracle. */
export async function completeTransferTransaction(
  transaction: string,
  signatures: Record<string, string>,
  oracle: KeyPairSigner,
): Promise<Transaction> {
  const prepared = decodeTransaction(transaction);
  const encoder = getBase58Encoder();
  const withParties: Transaction = {
    ...prepared,
    signatures: Object.freeze({
      ...prepared.signatures,
      ...Object.fromEntries(
        Object.entries(signatures).map(([signer, signature]) => [
          signer,
          encoder.encode(signature) as SignatureBytes,
        ]),
      ),
    }),
  };
  return signTransaction([oracle.keyPair], withParties);
}
