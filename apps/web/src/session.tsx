import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, get, post } from "./api.js";
import type { Me } from "./types.js";
import { connectWallet, signText, toBase64 } from "./wallet.js";

interface Session {
  me: Me | null;
  loading: boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get<Me>("/auth/me")
      .then(setMe)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) console.error(error);
      })
      .finally(() => setLoading(false));
  }, []);

  /** Sign-In With Solana: the API issues the message, the wallet signs its exact bytes. */
  const signIn = useCallback(async () => {
    const { provider, address } = await connectWallet();
    const { message } = await post<{ message: string }>("/auth/nonce", { address });
    const signed = await signText(provider, message);
    setMe(
      await post<Me>("/auth/verify", {
        address,
        message: toBase64(signed.message),
        signature: toBase64(signed.signature),
      }),
    );
  }, []);

  const signOut = useCallback(async () => {
    await post("/auth/logout");
    setMe(null);
  }, []);

  return <SessionContext value={{ me, loading, signIn, signOut }}>{children}</SessionContext>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}

export const hasRole = (me: Me | null, role: string) => me?.roles.includes(role) ?? false;
