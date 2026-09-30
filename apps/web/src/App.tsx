import type { ReactNode } from "react";
import { ErrorText, Loading, useAction } from "./components/ui.js";
import { Logo } from "./components/Logo.js";
import { shortAddress } from "./format.js";
import { AdminPage, VerifierReviewPage } from "./pages/Admin.js";
import { AssetDetailPage } from "./pages/AssetDetail.js";
import { AssetsPage } from "./pages/Assets.js";
import { HomePage } from "./pages/Home.js";
import { NewAssetPage } from "./pages/NewAsset.js";
import { PassportPage } from "./pages/Passport.js";
import { TransfersPage } from "./pages/Transfers.js";
import { VerifierQueuePage, VerifierRequestPage } from "./pages/Verifier.js";
import { VerifierApplyPage } from "./pages/VerifierApply.js";
import { Link, match, useRouter } from "./router.js";
import { hasRole, useSession } from "./session.js";

function Header() {
  const { me, signIn, signOut } = useSession();
  const { navigate } = useRouter();
  const { busy, error, run } = useAction();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <Logo />
      </Link>
      <nav>
        {me && <Link to="/assets">My assets</Link>}
        {me && <Link to="/transfers">Transfers</Link>}
        {hasRole(me, "VERIFIER") && <Link to="/verifier">Verify</Link>}
        {me && !hasRole(me, "VERIFIER") && <Link to="/verifier/apply">Become a verifier</Link>}
        {(hasRole(me, "ADMIN") || hasRole(me, "VERIFIER_REVIEWER")) && (
          <Link to="/admin">Admin</Link>
        )}
        {me ? (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => void run(async () => (await signOut(), navigate("/")))}
          >
            <span className="mono">{shortAddress(me.user.walletAddress)}</span> · Sign out
          </button>
        ) : (
          <button className="small" disabled={busy} onClick={() => void run(signIn)}>
            {busy ? "Check your wallet…" : "Connect wallet"}
          </button>
        )}
      </nav>
      {error && (
        <div className="topbar-error">
          <ErrorText error={error} />
        </div>
      )}
    </header>
  );
}

function SignedIn({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  if (!me) return <p className="muted">Connect your wallet to continue.</p>;
  return <>{children}</>;
}

export function Page({ path }: { path: string }) {
  let m: Record<string, string> | null;
  if (path === "/" || path === "") return <HomePage />;
  if ((m = match("/passport/:wbId", path))) return <PassportPage wbId={m.wbId as string} />;
  if (path === "/assets")
    return (
      <SignedIn>
        <AssetsPage />
      </SignedIn>
    );
  if (path === "/assets/new")
    return (
      <SignedIn>
        <NewAssetPage />
      </SignedIn>
    );
  if ((m = match("/assets/:wbId", path)))
    return (
      <SignedIn>
        <AssetDetailPage wbId={m.wbId as string} />
      </SignedIn>
    );
  if (path === "/transfers")
    return (
      <SignedIn>
        <TransfersPage />
      </SignedIn>
    );
  if (path === "/verifier/apply")
    return (
      <SignedIn>
        <VerifierApplyPage />
      </SignedIn>
    );
  if (
    path === "/admin" ||
    path === "/admin/templates" ||
    path === "/admin/roles" ||
    path === "/admin/checks"
  )
    return (
      <SignedIn>
        <AdminPage
          key={path}
          tab={
            path === "/admin"
              ? "verifiers"
              : path === "/admin/templates"
                ? "templates"
                : path === "/admin/roles"
                  ? "roles"
                  : "checks"
          }
        />
      </SignedIn>
    );
  if ((m = match("/admin/verifiers/:id", path)))
    return (
      <SignedIn>
        <VerifierReviewPage verifierId={m.id as string} />
      </SignedIn>
    );
  if (path === "/verifier")
    return (
      <SignedIn>
        <VerifierQueuePage />
      </SignedIn>
    );
  if ((m = match("/verifier/requests/:id", path)))
    return (
      <SignedIn>
        <VerifierRequestPage requestId={m.id as string} />
      </SignedIn>
    );
  return <p className="muted">Page not found.</p>;
}

export function App() {
  const { path } = useRouter();
  return (
    <>
      <Header />
      <main className="container">
        <Page path={path} />
      </main>
      <footer className="footer">
        <p>
          A token is not proof of authenticity. The Trust Score measures recorded evidence and
          verification; it does not guarantee authenticity, ownership, legal title or value.
        </p>
        <p className="muted tiny">WorthyBound · Solana devnet</p>
      </footer>
    </>
  );
}
