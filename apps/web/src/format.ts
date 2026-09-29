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
