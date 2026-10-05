import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  type KeyPairSigner,
  verifySignature,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { ASSET_STATUSES, VERIFICATION_LEVELS } from "@worthybound/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEscrowPaymentTransaction,
  buildNonceAdvanceTransaction,
  buildTransferTransaction,
  chainAddresses,
  completeTransferTransaction,
  createNonceAccountInstructions,
  customProgramErrorCode,
  loadKeypairSigner,
  NONCE_ACCOUNT_SIZE,
  readNonceAccount,
  toChainAssetStatus,
  toChainVerificationLevel,
  transferSignature,
  withdrawNonceInstruction,
  WORTHYBOUND_PROGRAM_ADDRESS,
} from "../src/index.js";
import { walletSign } from "./svm.js";

describe("enum mapping", () => {
  it("maps every asset status to the on-chain value in the same order", () => {
    ASSET_STATUSES.forEach((status, index) => expect(toChainAssetStatus(status)).toBe(index));
  });

  it("maps every verification level to the on-chain value in the same order", () => {
    VERIFICATION_LEVELS.forEach((level, index) =>
      expect(toChainVerificationLevel(level)).toBe(index),
    );
  });
});

describe("loadKeypairSigner", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wb-keypair-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a Solana CLI keypair file", async () => {
    // RFC 8032 test vector 1: secret key, then its public key.
    const secret = Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    );
    const pub = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    );
    const path = join(dir, "ok.json");
    await writeFile(path, JSON.stringify([...secret, ...pub]));
    const signer = await loadKeypairSigner(path);
    expect(signer.address).toBe("FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
  });

  it("rejects files that are not 64-byte arrays without echoing their contents", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify([1, 2, 3]));
    await expect(loadKeypairSigner(path)).rejects.toThrow(/not a 64-byte JSON array/);
    await expect(loadKeypairSigner(join(dir, "missing.json"))).rejects.toThrow(/Cannot read/);
  });
});

describe("customProgramErrorCode", () => {
  it("finds the program error code in a preflight failure", () => {
    const custom = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
      code: 6010,
      index: 0,
    });
    const preflight = new SolanaError(
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      { cause: custom } as never,
    );
    expect(customProgramErrorCode(preflight)).toBe(6010);
    expect(customProgramErrorCode(custom)).toBe(6010);
  });

  it("returns undefined for other errors", () => {
    expect(customProgramErrorCode(new Error("network"))).toBeUndefined();
    expect(customProgramErrorCode(undefined)).toBeUndefined();
  });
});

describe("chainAddresses", () => {
  it("derives the same addresses as the program's seeds", async () => {
    const wbId = "WB-7F93A281";
    const { record, coreAsset } = await chainAddresses(wbId);
    const utf8 = new TextEncoder();
    const [expectedRecord] = await getProgramDerivedAddress({
      programAddress: WORTHYBOUND_PROGRAM_ADDRESS,
      seeds: [utf8.encode("asset"), utf8.encode(wbId)],
    });
    const [expectedCore] = await getProgramDerivedAddress({
      programAddress: WORTHYBOUND_PROGRAM_ADDRESS,
      seeds: [utf8.encode("core"), utf8.encode(wbId)],
    });
    expect(record).toBe(expectedRecord);
    expect(coreAsset).toBe(expectedCore);
  });
});

describe("transfer transactions", () => {
  let oracle: KeyPairSigner;
  let seller: KeyPairSigner;
  let buyer: KeyPairSigner;
  let nonceAccount: KeyPairSigner;
  let nonce: string;
  let transaction: string;

  beforeAll(async () => {
    [oracle, seller, buyer, nonceAccount] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const svm = new LiteSVM();
    svm.airdrop(oracle.address, lamports(1_000_000_000n));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(oracle, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          createNonceAccountInstructions({
            payer: oracle,
            nonceAccount,
            authority: oracle.address,
            lamports: svm.minimumBalanceForRentExemption(NONCE_ACCOUNT_SIZE),
          }),
          m,
        ),
    );
    const result = svm.sendTransaction(await signTransactionMessageWithSigners(message));
    expect(result).not.toBeInstanceOf(FailedTransactionMetadata);
    const account = svm.getAccount(nonceAccount.address);
    if (!account.exists) throw new Error("nonce account missing");
    const read = readNonceAccount(account.data);
    expect(read.authority).toBe(oracle.address);
    nonce = read.nonce;
    transaction = await buildTransferTransaction({
      wbId: "WB-7F93A281",
      oracle: oracle.address,
      seller: seller.address,
      buyer: buyer.address,
      statusAfter: "VERIFIED",
      statusSeq: 7n,
      nonceAccount: nonceAccount.address,
      nonce,
    });
  });

  it("closes a nonce account when its whole balance is withdrawn", async () => {
    const svm = new LiteSVM();
    svm.airdrop(oracle.address, lamports(1_000_000_000n));
    const account = await generateKeyPairSigner();
    const rent = svm.minimumBalanceForRentExemption(NONCE_ACCOUNT_SIZE);
    const send = async (instructions: Parameters<typeof appendTransactionMessageInstructions>[0]) =>
      svm.sendTransaction(
        await signTransactionMessageWithSigners(
          pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(oracle, m),
            (m) =>
              setTransactionMessageLifetimeUsingBlockhash(
                { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n },
                m,
              ),
            (m) => appendTransactionMessageInstructions(instructions, m),
          ),
        ),
      );
    const created = await send(
      createNonceAccountInstructions({
        payer: oracle,
        nonceAccount: account,
        authority: oracle.address,
        lamports: rent,
      }),
    );
    expect(created).not.toBeInstanceOf(FailedTransactionMetadata);
    const before = svm.getBalance(oracle.address) ?? 0n;
    svm.expireBlockhash();
    const closed = await send([
      withdrawNonceInstruction({
        nonceAccount: account.address,
        to: oracle.address,
        authority: oracle,
        lamports: rent,
      }),
    ]);
    expect(closed).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(svm.getAccount(account.address).exists).toBe(false);
    expect((svm.getBalance(oracle.address) ?? 0n) - before).toBe(rent - 5_000n);
  });

  it("needs oracle, seller and buyer, and uses the durable nonce", () => {
    const decoded = getTransactionDecoder().decode(Buffer.from(transaction, "base64"));
    expect(Object.keys(decoded.signatures)[0]).toBe(oracle.address);
    expect(Object.keys(decoded.signatures).sort()).toEqual(
      [oracle.address, seller.address, buyer.address].sort(),
    );
    expect(Object.values(decoded.signatures).every((s) => s === null)).toBe(true);
    // Legacy message: the blockhash field (after the header and account keys) holds the nonce.
    const bytes = decoded.messageBytes;
    const keys = bytes[3] as number;
    const blockhash = bytes.slice(4 + keys * 32, 36 + keys * 32);
    expect(Buffer.from(blockhash).equals(Buffer.from(getBase58Encoder().encode(nonce)))).toBe(true);
  });

  it("puts the buyer's payment to the seller in the same transaction", async () => {
    const paid = await buildTransferTransaction({
      wbId: "WB-7F93A281",
      oracle: oracle.address,
      seller: seller.address,
      buyer: buyer.address,
      statusAfter: "VERIFIED",
      statusSeq: 7n,
      nonceAccount: nonceAccount.address,
      nonce,
      priceLamports: 1_500_000_000n,
    });
    const compiled = (wire: string) => {
      const m = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(Buffer.from(wire, "base64")).messageBytes,
      );
      if (!("instructions" in m)) throw new Error("expected a legacy message");
      return m;
    };
    const message = compiled(paid);
    const keys = message.staticAccounts;
    // Advance nonce, then the payment, then transfer_asset.
    expect(message.instructions.map((i) => keys[i.programAddressIndex])).toEqual([
      "11111111111111111111111111111111",
      "11111111111111111111111111111111",
      WORTHYBOUND_PROGRAM_ADDRESS,
    ]);
    const payment = message.instructions[1]!;
    expect(payment.accountIndices?.map((i) => keys[i])).toEqual([buyer.address, seller.address]);
    const data = Buffer.from(payment.data ?? []);
    expect([data.readUInt32LE(0), data.readBigUInt64LE(4)]).toEqual([2, 1_500_000_000n]);

    expect(compiled(transaction).instructions).toHaveLength(2);
  });

  it("accepts a wallet's signature of exactly the prepared transaction", async () => {
    const signature = await transferSignature(
      transaction,
      await walletSign(transaction, seller),
      seller.address,
    );
    const decoded = getTransactionDecoder().decode(Buffer.from(transaction, "base64"));
    expect(
      await verifySignature(
        await getPublicKeyFromAddress(seller.address),
        getBase58Encoder().encode(signature) as never,
        decoded.messageBytes,
      ),
    ).toBe(true);
  });

  it("rejects changed transactions, other wallets and missing or forged signatures", async () => {
    const problem = (signed: string, signer: string) =>
      transferSignature(transaction, signed, signer).then(
        () => "accepted",
        (e: { problem?: string }) => e.problem,
      );
    const other = await buildTransferTransaction({
      wbId: "WB-7F93A281",
      oracle: oracle.address,
      seller: seller.address,
      buyer: buyer.address,
      statusAfter: "ACTIVE",
      statusSeq: 7n,
      nonceAccount: nonceAccount.address,
      nonce,
    });
    expect(await problem(await walletSign(other, seller), seller.address)).toBe(
      "transaction_changed",
    );
    expect(await problem("not a transaction", seller.address)).toBe("invalid_transaction");
    const stranger = await generateKeyPairSigner();
    expect(await problem(await walletSign(transaction, seller), stranger.address)).toBe(
      "not_a_signer",
    );
    expect(await problem(transaction, buyer.address)).toBe("missing_signature");
    // The seller's signature presented as the buyer's.
    const signed = getTransactionDecoder().decode(
      Buffer.from(await walletSign(transaction, seller), "base64"),
    );
    const forged = getTransactionEncoder().encode({
      ...signed,
      signatures: { ...signed.signatures, [buyer.address]: signed.signatures[seller.address] },
    });
    expect(await problem(Buffer.from(forged).toString("base64"), buyer.address)).toBe(
      "invalid_signature",
    );
  });

  it("adds the oracle's signature last", async () => {
    const signatures = {
      [seller.address]: await transferSignature(
        transaction,
        await walletSign(transaction, seller),
        seller.address,
      ),
      [buyer.address]: await transferSignature(
        transaction,
        await walletSign(transaction, buyer),
        buyer.address,
      ),
    };
    const complete = await completeTransferTransaction(transaction, signatures, oracle);
    for (const signer of [oracle, seller, buyer]) {
      const signature = complete.signatures[signer.address];
      expect(signature).toBeTruthy();
      expect(
        await verifySignature(
          await getPublicKeyFromAddress(signer.address),
          signature as never,
          complete.messageBytes,
        ),
      ).toBe(true);
    }
    await expect(
      completeTransferTransaction(
        transaction,
        { [seller.address]: signatures[seller.address]! },
        oracle,
      ),
    ).rejects.toThrow();
  });
});

describe("escrow payments", () => {
  it("can no longer land once the payment nonce is advanced", async () => {
    const [oracle, buyer, escrow, paymentNonce] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const svm = new LiteSVM();
    svm.airdrop(oracle.address, lamports(1_000_000_000n));
    svm.airdrop(buyer.address, lamports(5_000_000_000n));
    const rent = svm.minimumBalanceForRentExemption(NONCE_ACCOUNT_SIZE);
    const created = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(oracle, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [escrow, paymentNonce].flatMap((nonceAccount) =>
            createNonceAccountInstructions({
              payer: oracle,
              nonceAccount,
              authority: oracle.address,
              lamports: rent,
            }),
          ),
          m,
        ),
    );
    expect(
      svm.sendTransaction(await signTransactionMessageWithSigners(created)),
    ).not.toBeInstanceOf(FailedTransactionMetadata);
    const nonceOf = () => {
      const account = svm.getAccount(paymentNonce.address);
      if (!account.exists) throw new Error("nonce account missing");
      return readNonceAccount(account.data).nonce;
    };
    const payment = (nonce: string) =>
      buildEscrowPaymentTransaction({
        oracle: oracle.address,
        buyer: buyer.address,
        escrowAccount: escrow.address,
        paymentNonceAccount: paymentNonce.address,
        nonce,
        priceLamports: 2_000_000_000n,
      });
    const signedPayment = async (wire: string) =>
      completeTransferTransaction(
        wire,
        {
          [buyer.address]: await transferSignature(
            wire,
            await walletSign(wire, buyer),
            buyer.address,
          ),
        },
        oracle,
      );
    const lost = await signedPayment(payment(nonceOf()));

    svm.expireBlockhash();
    const advance = await completeTransferTransaction(
      buildNonceAdvanceTransaction({
        oracle: oracle.address,
        nonceAccount: paymentNonce.address,
        nonce: nonceOf(),
      }),
      {},
      oracle,
    );
    expect(svm.sendTransaction(advance)).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(svm.sendTransaction(lost)).toBeInstanceOf(FailedTransactionMetadata);
    expect(svm.getBalance(escrow.address)).toBe(rent);

    // A payment signed with the new nonce lands once.
    const again = await signedPayment(payment(nonceOf()));
    expect(svm.sendTransaction(again)).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(svm.getBalance(escrow.address)).toBe(rent + 2_000_000_000n);
  });
});
