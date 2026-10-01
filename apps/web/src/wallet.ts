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

/** Phones and tablets, where wallets are apps and no provider is injected in the browser. */
function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Reopens the current page in Phantom's in-app browser, which does inject a provider. */
function openInPhantom(): void {
  const target = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  window.location.href = `https://phantom.app/ul/browse/${target}?ref=${ref}`;
}

export async function connectWallet(): Promise<{ provider: SolanaProvider; address: string }> {
  const provider = walletProvider();
  if (!provider) {
    if (isMobile()) {
      openInPhantom();
      throw new Error("Opening Phantom. Continue in the Phantom app.");
    }
    throw new Error("No Solana wallet found. Install Phantom and reload the page.");
  }
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

/** A wallet registered through the Wallet Standard (Phantom, Solflare, Backpack, …). */
interface StandardWallet {
  readonly name: string;
  readonly accounts: readonly WalletAccount[];
  readonly features: Readonly<Record<string, unknown>>;
}

interface WalletAccount {
  readonly address: string;
}

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface SignTransactionFeature {
  signTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

const standardWallets: StandardWallet[] = [];

const registry = {
  register(...wallets: StandardWallet[]) {
    for (const w of wallets) if (!standardWallets.includes(w)) standardWallets.push(w);
    return () => {
      for (const w of wallets) {
        const i = standardWallets.indexOf(w);
        if (i >= 0) standardWallets.splice(i, 1);
      }
    };
  },
};

// Wallets loaded before the app answer "app-ready"; later ones announce themselves.
window.addEventListener("wallet-standard:register-wallet", (event) =>
  (event as CustomEvent<(api: typeof registry) => void>).detail(registry),
);
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));

/**
 * Signs a transaction (base64 wire bytes) with the wallet account `address` without sending it,
 * and returns the signed transaction in the same form.
 */
export async function signTransaction(address: string, transaction: string): Promise<string> {
  const wallets = standardWallets.filter((w) => "solana:signTransaction" in w.features);
  if (wallets.length === 0) {
    throw new Error("No wallet that can sign Solana transactions was found. Install Phantom.");
  }
  const sign = async (wallet: StandardWallet, account: WalletAccount) => {
    const feature = wallet.features["solana:signTransaction"] as SignTransactionFeature;
    const [output] = await feature.signTransaction({
      account,
      transaction: fromBase64(transaction),
      chain: "solana:devnet",
    });
    if (!output) throw new Error("The wallet did not return a signed transaction.");
    return toBase64(output.signedTransaction);
  };
  for (const wallet of wallets) {
    const account = wallet.accounts.find((a) => a.address === address);
    if (account) return sign(wallet, account);
  }
  for (const wallet of wallets) {
    const connect = wallet.features["standard:connect"] as ConnectFeature | undefined;
    const account = (await connect?.connect())?.accounts.find((a) => a.address === address);
    if (account) return sign(wallet, account);
  }
  throw new Error(`Switch your wallet to the account ${address} and try again.`);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
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
