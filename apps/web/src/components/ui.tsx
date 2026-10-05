import { useCallback, useEffect, useState, type ReactNode } from "react";
import { explorerUrl, humanize, shortAddress } from "../format.js";

/** Loads data on mount and on `reload()`. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const run = useCallback(load, deps);
  useEffect(() => {
    let live = true;
    run()
      .then((value) => live && (setData(value), setError(null)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [run, version]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}

/** Runs an action, disabling the button and showing any error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES: Record<string, string> = {
  VERIFIED: "gold",
  TOKENIZED: "gold",
  CONFIRMED: "gold",
  ACCEPTED: "gold",
  ATTESTED: "gold",
  ACTIVE: "ok",
  PUBLIC: "ok",
  COMPLETED: "ok",
  PASSED: "ok",
  MATCH: "ok",
  PENDING: "wait",
  INCONCLUSIVE: "wait",
  OPEN: "wait",
  UNDER_REVIEW: "wait",
  UPHELD: "bad",
  ASSIGNED: "wait",
  DRAFT: "wait",
  TRANSFER_PENDING: "wait",
  REPORTED_STOLEN: "bad",
  REPORTED_LOST: "bad",
  DISPUTED: "bad",
  REVOKED: "bad",
  REJECTED: "bad",
  FAILED: "bad",
  NO_MATCH: "bad",
  CONTRADICTED: "bad",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${TONES[value] ?? ""}`}>{label ?? humanize(value)}</span>;
}

/** Trust Score dial: a gold ring filled to the score. */
export function TrustDial({ score, size = 132 }: { score: number | null; size?: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const filled = score === null ? 0 : (Math.max(0, Math.min(100, score)) / 100) * c;
  return (
    <svg
      className="dial"
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={score === null ? "Not yet scored" : `Trust Score ${score} of 100`}
    >
      <circle cx="60" cy="60" r={r} className="dial-track" />
      <circle
        cx="60"
        cy="60"
        r={r}
        className="dial-fill"
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="58" textAnchor="middle" className="dial-score">
        {score ?? "—"}
      </text>
      <text x="60" y="78" textAnchor="middle" className="dial-label">
        TRUST SCORE
      </text>
    </svg>
  );
}

export function ChainLink({ kind, value }: { kind: "address" | "tx"; value: string }) {
  return (
    <a className="mono" href={explorerUrl(kind, value)} target="_blank" rel="noreferrer">
      {shortAddress(value)} ↗
    </a>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
