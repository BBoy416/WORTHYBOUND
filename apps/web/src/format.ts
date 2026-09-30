/** `LUXURY_WATCH` → `Luxury watch`, as in the token metadata. */
export const humanize = (value: string): string =>
  value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

export const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

export const formatDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

export const explorerUrl = (kind: "address" | "tx", value: string): string =>
  `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;

export const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** `"2500000000"` lamports → `2.5 SOL`, exactly. */
export const formatSol = (lamports: string): string => {
  const value = BigInt(lamports);
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${value / LAMPORTS_PER_SOL}${fraction ? `.${fraction}` : ""} SOL`;
};

/** `"2.5"` SOL → `"2500000000"` lamports; null unless a number with at most 9 decimals. */
export const solToLamports = (sol: string): string | null => {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(sol.trim());
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  return (BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, "0"))).toString();
};
