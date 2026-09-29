import { address } from "@solana/kit";

/** Metaplex Core program (same address on every cluster). */
export const MPL_CORE_PROGRAM_ADDRESS = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

export const BPF_LOADER_UPGRADEABLE_ADDRESS = address(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/** Solana Explorer link for an account or transaction on Devnet. */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}
