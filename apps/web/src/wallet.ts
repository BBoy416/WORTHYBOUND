/** The injected Solana provider of Phantom-compatible wallets. */
interface SolanaProvider {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: "utf8"): Promise<{ signature: Uint8Array }>;
}

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
  }
}

export function walletProvider(): SolanaProvider | null {
  return window.phantom?.solana ?? window.solana ?? null;
}

export async function connectWallet(): Promise<{ provider: SolanaProvider; address: string }> {
  const provider = walletProvider();
  if (!provider) throw new Error("No Solana wallet found. Install Phantom and reload the page.");
  const { publicKey } = await provider.connect();
  return { provider, address: publicKey.toString() };
}

/** Signs the exact UTF-8 bytes of `text` and returns the bytes and the signature. */
export async function signText(
  provider: SolanaProvider,
  text: string,
): Promise<{ message: Uint8Array; signature: Uint8Array }> {
  const message = new TextEncoder().encode(text);
  const { signature } = await provider.signMessage(message, "utf8");
  return { message, signature };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
