import {
  AccountRole,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AssetStatus,
  buildTransferTransaction,
  completeTransferTransaction,
  createNonceAccountInstructions,
  decodeAssetRecord,
  decodeConfig,
  findAssetRecordPda,
  findConfigPda,
  findCoreAssetPda,
  getCommitTrustScoreInstructionAsync,
  getInitializeInstructionAsync,
  getRegisterAssetInstructionAsync,
  getSetOracleInstructionAsync,
  getSetPausedInstructionAsync,
  getTransferAssetInstructionAsync,
  getUpdateStatusInstructionAsync,
  MPL_CORE_PROGRAM_ADDRESS,
  NONCE_ACCOUNT_SIZE,
  readNonceAccount,
  transferSignature,
  VerificationLevel,
} from "../src/index.js";
import {
  anchorError,
  coreAssetOwner,
  createHarness,
  programBuilt,
  programDataAddress,
  rejectedByPermanentFreeze,
  send,
  walletSign,
  type Harness,
} from "./svm.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const URI = "https://api.worthybound.example/metadata/WB-7F93A281.json";
const HASH = new Uint8Array(32).fill(7);

// Raw Metaplex Core instructions (mpl-core 0.12 layouts); absent optional accounts are the
// Core program address.
const none: AccountMeta = { address: MPL_CORE_PROGRAM_ADDRESS, role: AccountRole.READONLY };
const signerMeta = (
  s: KeyPairSigner,
  role: AccountRole.READONLY_SIGNER | AccountRole.WRITABLE_SIGNER,
): AccountSignerMeta => ({ address: s.address, role, signer: s });
const coreIx = (data: number[], accounts: (AccountMeta | AccountSignerMeta)[]): Instruction => ({
  programAddress: MPL_CORE_PROGRAM_ADDRESS,
  accounts,
  data: Uint8Array.from(data),
});
/** TransferV1 signed by `authority` as payer and authority. */
const coreTransfer = (asset: Address, authority: KeyPairSigner, newOwner: Address) =>
  coreIx(
    [14, 0],
    [
      { address: asset, role: AccountRole.WRITABLE },
      none,
      signerMeta(authority, AccountRole.WRITABLE_SIGNER),
      signerMeta(authority, AccountRole.READONLY_SIGNER),
      { address: newOwner, role: AccountRole.READONLY },
      none,
      none,
    ],
  );

describe.skipIf(!programBuilt)("worthybound program", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  async function initialize(admin: KeyPairSigner = h.admin) {
    return send(h.svm, admin, [
      await getInitializeInstructionAsync({
        admin,
        programData: programDataAddress(h.svm),
        oracle: h.oracle.address,
      }),
    ]);
  }

  async function register(
    wbId: string,
    opts: { signer?: KeyPairSigner; status?: AssetStatus; uri?: string; owner?: Address } = {},
  ) {
    const signer = opts.signer ?? h.oracle;
    return send(h.svm, signer, [
      await getRegisterAssetInstructionAsync({
        oracle: signer,
        owner: opts.owner ?? h.owner.address,
        wbId,
        uri: opts.uri ?? URI,
        status: opts.status ?? AssetStatus.Active,
        statusSeq: 1n,
      }),
    ]);
  }

  async function recordAddress(wbId: string) {
    return (await findAssetRecordPda({ wbId }))[0];
  }

  async function coreAddress(wbId: string) {
    return (await findCoreAssetPda({ wbId }))[0];
  }

  async function record(wbId: string) {
    const address = await recordAddress(wbId);
    const account = h.svm.getAccount(address);
    if (!account.exists) throw new Error("record missing");
    return decodeAssetRecord(account).data;
  }

  async function setStatus(
    wbId: string,
    status: AssetStatus,
    statusSeq: bigint,
    signer = h.oracle,
  ) {
    return send(h.svm, signer, [
      await getUpdateStatusInstructionAsync({
        oracle: signer,
        assetRecord: await recordAddress(wbId),
        status,
        statusSeq,
      }),
    ]);
  }

  async function transfer(
    wbId: string,
    opts: {
      seller?: KeyPairSigner;
      buyer?: KeyPairSigner;
      oracle?: KeyPairSigner;
      statusAfter?: AssetStatus;
      statusSeq?: bigint;
      coreAsset?: Address;
    } = {},
  ) {
    const oracle = opts.oracle ?? h.oracle;
    return send(h.svm, oracle, [
      await getTransferAssetInstructionAsync({
        oracle,
        seller: opts.seller ?? h.owner,
        buyer: opts.buyer ?? h.buyer,
        assetRecord: await recordAddress(wbId),
        coreAsset: opts.coreAsset ?? (await coreAddress(wbId)),
        statusAfter: opts.statusAfter ?? AssetStatus.Active,
        statusSeq: opts.statusSeq ?? 3n,
      }),
    ]);
  }

  describe("initialize", () => {
    it("is limited to the upgrade authority", async () => {
      const result = await initialize(h.owner);
      expect(result.ok).toBe(false);
      expect(anchorError(result)).toBe("NotUpgradeAuthority");
    });

    it("stores the admin and oracle once", async () => {
      expect((await initialize()).ok).toBe(true);
      const [config] = await findConfigPda();
      const account = h.svm.getAccount(config);
      if (!account.exists) throw new Error("config missing");
      const data = decodeConfig(account).data;
      expect(data.admin).toBe(h.admin.address);
      expect(data.oracle).toBe(h.oracle.address);
      expect(data.paused).toBe(false);
      expect((await initialize()).ok).toBe(false);
    });
  });

  describe("admin", () => {
    beforeEach(async () => {
      expect((await initialize()).ok).toBe(true);
    });

    it("only the admin changes the oracle or pauses", async () => {
      const setOracle = await send(h.svm, h.owner, [
        await getSetOracleInstructionAsync({ admin: h.owner, oracle: h.owner.address }),
      ]);
      expect(anchorError(setOracle)).toBe("NotAdmin");
      const pause = await send(h.svm, h.owner, [
        await getSetPausedInstructionAsync({ admin: h.owner, paused: true }),
      ]);
      expect(anchorError(pause)).toBe("NotAdmin");
    });

    it("a replaced oracle can no longer register", async () => {
      const next = await generateKeyPairSigner();
      h.svm.airdrop(next.address, lamports(1_000_000_000n));
      const result = await send(h.svm, h.admin, [
        await getSetOracleInstructionAsync({ admin: h.admin, oracle: next.address }),
      ]);
      expect(result.ok).toBe(true);
      expect(anchorError(await register("WB-00000001"))).toBe("NotOracle");
      expect((await register("WB-00000001", { signer: next })).ok).toBe(true);
    });

    it("pausing stops registrations, updates and transfers", async () => {
      expect((await register("WB-00000002")).ok).toBe(true);
      expect((await setStatus("WB-00000002", AssetStatus.TransferPending, 2n)).ok).toBe(true);
      const pause = await send(h.svm, h.admin, [
        await getSetPausedInstructionAsync({ admin: h.admin, paused: true }),
      ]);
      expect(pause.ok).toBe(true);
      expect(anchorError(await register("WB-00000003"))).toBe("Paused");
      expect(anchorError(await setStatus("WB-00000002", AssetStatus.Active, 3n))).toBe("Paused");
      expect(anchorError(await transfer("WB-00000002"))).toBe("Paused");
      const unpause = await send(h.svm, h.admin, [
        await getSetPausedInstructionAsync({ admin: h.admin, paused: false }),
      ]);
      expect(unpause.ok).toBe(true);
      expect((await transfer("WB-00000002")).ok).toBe(true);
    });
  });

  describe("register_asset", () => {
    beforeEach(async () => {
      expect((await initialize()).ok).toBe(true);
    });

    it("creates the record and mints the Core asset to the owner", async () => {
      expect((await register("WB-7F93A281", { status: AssetStatus.Verified })).ok).toBe(true);
      const data = await record("WB-7F93A281");
      expect(data.wbId).toBe("WB-7F93A281");
      expect(data.owner).toBe(h.owner.address);
      expect(data.coreAsset).toBe(await coreAddress("WB-7F93A281"));
      expect(data.status).toBe(AssetStatus.Verified);
      expect(data.statusSeq).toBe(1n);
      expect(data.trustScore).toBe(0);
      expect(data.verificationLevel).toBe(VerificationLevel.Unverified);
      expect(data.transferCount).toBe(0);
      expect(coreAssetOwner(h.svm, data.coreAsset)).toBe(h.owner.address);
      const core = h.svm.getAccount(data.coreAsset);
      expect(core.exists && core.programAddress).toBe(MPL_CORE_PROGRAM_ADDRESS);
    });

    it("registers each WB ID once", async () => {
      expect((await register("WB-7F93A281")).ok).toBe(true);
      expect((await register("WB-7F93A281")).ok).toBe(false);
    });

    it("is limited to the oracle", async () => {
      expect(anchorError(await register("WB-7F93A281", { signer: h.owner }))).toBe("NotOracle");
    });

    it.each(["WB-7f93a281", "WB-7F93A28", "XX-7F93A281", "WB-7F93A2811", "WB-7F93A28G"])(
      "rejects the malformed WB ID %s",
      async (wbId) => {
        expect(anchorError(await register(wbId))).toBe("InvalidWbId");
      },
    );

    it("rejects an empty or overlong URI", async () => {
      expect(anchorError(await register("WB-00000001", { uri: "" }))).toBe("InvalidUri");
      expect(anchorError(await register("WB-00000002", { uri: "x".repeat(201) }))).toBe(
        "InvalidUri",
      );
    });

    it.each([
      AssetStatus.Draft,
      AssetStatus.Tokenized,
      AssetStatus.TransferPending,
      AssetStatus.Disputed,
      AssetStatus.ReportedStolen,
      AssetStatus.Revoked,
    ])("only registers published, transferable assets (status %i rejected)", async (status) => {
      expect(anchorError(await register("WB-00000001", { status }))).toBe("InvalidInitialStatus");
    });
  });

  describe("the owner cannot move the token outside WorthyBound (ADR 0002)", () => {
    const WB = "WB-0000AAAA";
    let core: Address;
    let thief: KeyPairSigner;

    beforeEach(async () => {
      expect((await initialize()).ok).toBe(true);
      expect((await register(WB)).ok).toBe(true);
      core = await coreAddress(WB);
      thief = await generateKeyPairSigner();
    });

    it("cannot transfer it directly", async () => {
      const result = await send(h.svm, h.owner, [coreTransfer(core, h.owner, thief.address)]);
      expect(rejectedByPermanentFreeze(result)).toBe(true);
      expect(coreAssetOwner(h.svm, core)).toBe(h.owner.address);
    });

    it("cannot thaw it", async () => {
      // UpdatePluginV1(PermanentFreezeDelegate { frozen: false })
      const result = await send(h.svm, h.owner, [
        coreIx(
          [6, 5, 0],
          [
            { address: core, role: AccountRole.WRITABLE },
            none,
            signerMeta(h.owner, AccountRole.WRITABLE_SIGNER),
            signerMeta(h.owner, AccountRole.READONLY_SIGNER),
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
            none,
          ],
        ),
      ]);
      expect(result.ok).toBe(false);
      // mpl-core NoApprovals: only the config PDA may update the permanent freeze.
      expect(result.logs.some((l) => l.includes("custom program error: 0x1a"))).toBe(true);
    });

    it("cannot burn it", async () => {
      const result = await send(h.svm, h.owner, [
        coreIx(
          [12, 0],
          [
            { address: core, role: AccountRole.WRITABLE },
            none,
            signerMeta(h.owner, AccountRole.WRITABLE_SIGNER),
            signerMeta(h.owner, AccountRole.READONLY_SIGNER),
            none,
            none,
          ],
        ),
      ]);
      expect(rejectedByPermanentFreeze(result)).toBe(true);
      expect(h.svm.getAccount(core).exists).toBe(true);
    });

    it("cannot move it through a transfer delegate it adds", async () => {
      // AddPluginV1(TransferDelegate, Some(Address(thief)))
      const add = await send(h.svm, h.owner, [
        coreIx(
          [2, 3, 1, 3, ...getAddressEncoder().encode(thief.address)],
          [
            { address: core, role: AccountRole.WRITABLE },
            none,
            signerMeta(h.owner, AccountRole.WRITABLE_SIGNER),
            signerMeta(h.owner, AccountRole.READONLY_SIGNER),
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
            none,
          ],
        ),
      ]);
      h.svm.airdrop(thief.address, lamports(1_000_000_000n));
      const move = await send(h.svm, thief, [coreTransfer(core, thief, thief.address)]);
      // Core lets the owner add the delegate, but the permanent freeze still rejects the move.
      expect(add.ok).toBe(true);
      expect(rejectedByPermanentFreeze(move)).toBe(true);
      expect(coreAssetOwner(h.svm, core)).toBe(h.owner.address);
    });
  });

  describe("update_status", () => {
    const WB = "WB-0000BBBB";
    beforeEach(async () => {
      expect((await initialize()).ok).toBe(true);
      expect((await register(WB)).ok).toBe(true);
    });

    it("mirrors newer status changes from the oracle", async () => {
      expect((await setStatus(WB, AssetStatus.ReportedStolen, 2n)).ok).toBe(true);
      const data = await record(WB);
      expect(data.status).toBe(AssetStatus.ReportedStolen);
      expect(data.statusSeq).toBe(2n);
    });

    it("is limited to the oracle", async () => {
      expect(anchorError(await setStatus(WB, AssetStatus.Revoked, 2n, h.owner))).toBe("NotOracle");
    });

    it("rejects older or repeated updates", async () => {
      expect((await setStatus(WB, AssetStatus.Verified, 2n)).ok).toBe(true);
      expect(anchorError(await setStatus(WB, AssetStatus.Active, 2n))).toBe("StaleUpdate");
      expect(anchorError(await setStatus(WB, AssetStatus.Active, 1n))).toBe("StaleUpdate");
      expect((await record(WB)).status).toBe(AssetStatus.Verified);
    });

    it("never returns to DRAFT or TOKENIZED", async () => {
      expect(anchorError(await setStatus(WB, AssetStatus.Draft, 2n))).toBe("InvalidStatus");
      expect(anchorError(await setStatus(WB, AssetStatus.Tokenized, 2n))).toBe("InvalidStatus");
    });

    it("keeps REVOKED final", async () => {
      expect((await setStatus(WB, AssetStatus.Revoked, 2n)).ok).toBe(true);
      expect(anchorError(await setStatus(WB, AssetStatus.Active, 3n))).toBe("AssetRevoked");
    });
  });

  describe("commit_trust_score", () => {
    const WB = "WB-0000CCCC";
    beforeEach(async () => {
      expect((await initialize()).ok).toBe(true);
      expect((await register(WB)).ok).toBe(true);
    });

    async function commit(
      score: number,
      trustSeq: bigint,
      opts: { engine?: string; weights?: string; signer?: KeyPairSigner } = {},
    ) {
      const signer = opts.signer ?? h.oracle;
      return send(h.svm, signer, [
        await getCommitTrustScoreInstructionAsync({
          oracle: signer,
          assetRecord: await recordAddress(WB),
          score,
          level: VerificationLevel.Inspected,
          engineVersion: opts.engine ?? "1.1.0",
          weightsVersion: opts.weights ?? "weights-2026.2",
          inputsHash: HASH,
          trustSeq,
        }),
      ]);
    }

    it("records the score, level, versions and inputs hash", async () => {
      expect((await commit(72, 5n)).ok).toBe(true);
      const data = await record(WB);
      expect(data.trustScore).toBe(72);
      expect(data.verificationLevel).toBe(VerificationLevel.Inspected);
      expect(data.engineVersion).toBe("1.1.0");
      expect(data.weightsVersion).toBe("weights-2026.2");
      expect(Uint8Array.from(data.inputsHash)).toEqual(HASH);
      expect(data.trustSeq).toBe(5n);
    });

    it("rejects scores above 100", async () => {
      expect(anchorError(await commit(101, 5n))).toBe("InvalidTrustScore");
    });

    it("rejects empty or overlong versions", async () => {
      expect(anchorError(await commit(50, 5n, { engine: "" }))).toBe("InvalidVersion");
      expect(anchorError(await commit(50, 5n, { weights: "w".repeat(25) }))).toBe("InvalidVersion");
    });

    it("rejects older snapshots", async () => {
      expect((await commit(60, 5n)).ok).toBe(true);
      expect(anchorError(await commit(40, 4n))).toBe("StaleUpdate");
      expect((await record(WB)).trustScore).toBe(60);
    });

    it("is limited to the oracle", async () => {
      expect(anchorError(await commit(60, 5n, { signer: h.owner }))).toBe("NotOracle");
    });
  });

  describe("transfer_asset", () => {
    const WB = "WB-0000DDDD";
    beforeEach(async () => {
      expect((await initialize()).ok).toBe(true);
      expect((await register(WB)).ok).toBe(true);
    });

    it("moves the token to the buyer and keeps it frozen", async () => {
      expect((await setStatus(WB, AssetStatus.TransferPending, 2n)).ok).toBe(true);
      const result = await transfer(WB, { statusAfter: AssetStatus.ReverificationRequired });
      expect(result.ok).toBe(true);
      const data = await record(WB);
      expect(data.owner).toBe(h.buyer.address);
      expect(data.status).toBe(AssetStatus.ReverificationRequired);
      expect(data.statusSeq).toBe(3n);
      expect(data.transferCount).toBe(1);
      const core = await coreAddress(WB);
      expect(coreAssetOwner(h.svm, core)).toBe(h.buyer.address);

      // The buyer cannot move it on directly either.
      const onward = await send(h.svm, h.buyer, [coreTransfer(core, h.buyer, h.owner.address)]);
      expect(rejectedByPermanentFreeze(onward)).toBe(true);
      expect(coreAssetOwner(h.svm, core)).toBe(h.buyer.address);
    });

    it("needs a pending transfer", async () => {
      expect(anchorError(await transfer(WB))).toBe("NotTransferPending");
    });

    it.each([
      ["DISPUTED", AssetStatus.Disputed],
      ["REPORTED_STOLEN", AssetStatus.ReportedStolen],
      ["REPORTED_LOST", AssetStatus.ReportedLost],
      ["REVOKED", AssetStatus.Revoked],
    ])("is blocked while %s", async (_name, status) => {
      expect((await setStatus(WB, status, 2n)).ok).toBe(true);
      expect(anchorError(await transfer(WB))).toBe("NotTransferPending");
      expect(coreAssetOwner(h.svm, await coreAddress(WB))).toBe(h.owner.address);
    });

    describe("while pending", () => {
      beforeEach(async () => {
        expect((await setStatus(WB, AssetStatus.TransferPending, 2n)).ok).toBe(true);
      });

      it("completes with a durable nonce transaction signed by the parties at different times", async () => {
        const nonceAccount = await generateKeyPairSigner();
        expect(
          (
            await send(
              h.svm,
              h.oracle,
              createNonceAccountInstructions({
                payer: h.oracle,
                nonceAccount,
                authority: h.oracle.address,
                lamports: h.svm.minimumBalanceForRentExemption(NONCE_ACCOUNT_SIZE),
              }),
            )
          ).ok,
        ).toBe(true);
        const account = h.svm.getAccount(nonceAccount.address);
        if (!account.exists) throw new Error("nonce account missing");
        const transaction = await buildTransferTransaction({
          wbId: WB,
          oracle: h.oracle.address,
          seller: h.owner.address,
          buyer: h.buyer.address,
          statusAfter: "VERIFIED",
          statusSeq: 3n,
          nonceAccount: nonceAccount.address,
          nonce: readNonceAccount(account.data).nonce,
        });
        const buyerSignature = await transferSignature(
          transaction,
          await walletSign(transaction, h.buyer),
          h.buyer.address,
        );
        // Blockhashes move on while the seller has not signed yet.
        for (let i = 0; i < 3; i++) h.svm.expireBlockhash();
        const sellerSignature = await transferSignature(
          transaction,
          await walletSign(transaction, h.owner),
          h.owner.address,
        );
        const complete = await completeTransferTransaction(
          transaction,
          { [h.buyer.address]: buyerSignature, [h.owner.address]: sellerSignature },
          h.oracle,
        );
        const result = h.svm.sendTransaction(complete);
        expect(result).not.toBeInstanceOf(FailedTransactionMetadata);
        const data = await record(WB);
        expect(data.owner).toBe(h.buyer.address);
        expect(data.status).toBe(AssetStatus.Verified);
        expect(coreAssetOwner(h.svm, await coreAddress(WB))).toBe(h.buyer.address);
        // The nonce has advanced, so the same transaction cannot run again.
        expect(h.svm.sendTransaction(complete)).toBeInstanceOf(FailedTransactionMetadata);
      });

      it("needs the current owner as seller", async () => {
        const other = await generateKeyPairSigner();
        expect(anchorError(await transfer(WB, { seller: other }))).toBe("NotOwner");
      });

      it("needs the oracle", async () => {
        expect(anchorError(await transfer(WB, { oracle: h.buyer }))).toBe("NotOracle");
      });

      it("cannot transfer to the seller", async () => {
        expect(anchorError(await transfer(WB, { buyer: h.owner }))).toBe("SameOwner");
      });

      it("must complete as ACTIVE, VERIFIED or REVERIFICATION_REQUIRED", async () => {
        expect(anchorError(await transfer(WB, { statusAfter: AssetStatus.Disputed }))).toBe(
          "InvalidStatusAfterTransfer",
        );
      });

      it("rejects an older timestamp", async () => {
        expect(anchorError(await transfer(WB, { statusSeq: 2n }))).toBe("StaleUpdate");
      });

      it("rejects another asset's Core asset", async () => {
        expect((await register("WB-0000EEEE")).ok).toBe(true);
        const result = await transfer(WB, { coreAsset: await coreAddress("WB-0000EEEE") });
        expect(anchorError(result)).toBe("CoreAssetMismatch");
        expect(coreAssetOwner(h.svm, await coreAddress("WB-0000EEEE"))).toBe(h.owner.address);
      });
    });
  });
});
