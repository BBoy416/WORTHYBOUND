import type { Address, KeyPairSigner, Signature } from "@solana/kit";
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

  return {
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
  };
}
