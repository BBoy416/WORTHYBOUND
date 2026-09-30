import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  WORTHYBOUND_PROGRAM_ADDRESS,
} from "../src/index.js";

export const PROGRAM_SO = fileURLToPath(
  new URL("../../../target/deploy/worthybound.so", import.meta.url),
);
const MPL_CORE_SO = fileURLToPath(new URL("./fixtures/mpl_core.so", import.meta.url));

/**
 * Program tests need `anchor build` (or `cargo-build-sbf`) first. They are skipped when the
 * program is not built, unless WB_REQUIRE_PROGRAM=1 (CI), where a missing build fails.
 */
export const programBuilt = existsSync(PROGRAM_SO);
if (!programBuilt && process.env.WB_REQUIRE_PROGRAM === "1") {
  throw new Error(`WB_REQUIRE_PROGRAM=1 but ${PROGRAM_SO} does not exist; run anchor build`);
}

export type Harness = {
  svm: LiteSVM;
  admin: KeyPairSigner;
  oracle: KeyPairSigner;
  owner: KeyPairSigner;
  buyer: KeyPairSigner;
};

export async function createHarness(): Promise<Harness> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(WORTHYBOUND_PROGRAM_ADDRESS, PROGRAM_SO);
  svm.addProgramFromFile(MPL_CORE_PROGRAM_ADDRESS, MPL_CORE_SO);
  const [admin, oracle, owner, buyer] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  for (const signer of [admin, oracle, owner, buyer]) {
    svm.airdrop(signer.address, lamports(10_000_000_000n));
  }
  setUpgradeAuthority(svm, admin.address);
  return { svm, admin, oracle, owner, buyer };
}

/** Address of the program's ProgramData account (upgradeable loader). */
export function programDataAddress(svm: LiteSVM): Address {
  const program = svm.getAccount(WORTHYBOUND_PROGRAM_ADDRESS);
  if (!program.exists) throw new Error("program not loaded");
  // UpgradeableLoaderState::Program { programdata_address }: u32 tag, then 32 bytes.
  return decodeAddress(program.data.slice(4, 36));
}

/** Rewrites the ProgramData header so `authority` is the upgrade authority. */
function setUpgradeAuthority(svm: LiteSVM, authority: Address): void {
  const address = programDataAddress(svm);
  const account = svm.getAccount(address);
  if (!account.exists) throw new Error("program data missing");
  // UpgradeableLoaderState::ProgramData: u32 tag, u64 slot, Option<Pubkey> authority.
  const data = new Uint8Array(account.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority), 13);
  svm.setAccount({ ...account, address, programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS, data });
}

function decodeAddress(bytes: Uint8Array): Address {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s as Address;
}

export type SendResult =
  { ok: true; logs: string[] } | { ok: false; logs: string[]; error: string };

/** Signs with every signer attached to the instructions and sends; never throws on failure. */
export async function send(
  svm: LiteSVM,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<SendResult> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const result = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (result instanceof FailedTransactionMetadata) {
    const logs = result.meta().logs();
    return { ok: false, logs, error: result.err().toString() };
  }
  return { ok: true, logs: result.logs() };
}

/** Anchor error name from the program logs, e.g. `NotOracle`. */
export function anchorError(result: SendResult): string | undefined {
  const line = result.logs.find((l) => l.includes("Error Code: "));
  return line?.match(/Error Code: (\w+)/)?.[1];
}

/** Metaplex Core rejected the instruction because the asset is frozen by its permanent freeze. */
export function rejectedByPermanentFreeze(result: SendResult): boolean {
  return (
    !result.ok &&
    result.logs.some((l) => l.includes("permanent_freeze_delegate.rs") && l.endsWith(":Reject"))
  );
}

/** Owner of a Metaplex Core asset: BaseAssetV1 is key (u8), then owner (32 bytes). */
export function coreAssetOwner(svm: LiteSVM, asset: Address): Address {
  const account = svm.getAccount(asset);
  if (!account.exists) throw new Error("core asset missing");
  return decodeAddress(account.data.slice(1, 33));
}

/** Signs a base64 wire transaction as a wallet does and returns it as base64. */
export async function walletSign(transaction: string, signer: KeyPairSigner): Promise<string> {
  const decoded = getTransactionDecoder().decode(Buffer.from(transaction, "base64"));
  const signed = await partiallySignTransaction([signer.keyPair], decoded as Transaction);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
}
