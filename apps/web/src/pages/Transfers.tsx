import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import {
  Badge,
  Card,
  ChainLink,
  ErrorText,
  Field,
  Loading,
  useAction,
  useLoad,
} from "../components/ui.js";
import { formatDateTime, formatSol, shortAddress, solToLamports } from "../format.js";
import { Link } from "../router.js";
import { useSession } from "../session.js";
import type { OwnerAsset, Transfer } from "../types.js";
import { signTransaction } from "../wallet.js";

const OPEN = ["PENDING", "ACCEPTED"];

const CLOSED_REASONS: Record<string, string> = {
  rejected: "Declined by the buyer.",
  cancelled_by_sender: "Cancelled by the seller.",
  cancelled_by_recipient: "Cancelled by the buyer.",
  expired: "Expired before both parties signed.",
  asset_reported_stolen: "Cancelled: the item was reported stolen.",
  asset_reported_lost: "Cancelled: the item was reported lost.",
};

/** Both have signed and the transaction is with Solana, unless sending gave up. */
const sending = (t: Transfer) =>
  t.signedBySeller && t.signedByBuyer && t.chain !== null && t.chain.status !== "FAILED";

export function TransfersPage() {
  const transfers = useLoad(() => get<{ items: Transfer[] }>("/transfers"), []);
  const open = transfers.data?.items.some((t) => OPEN.includes(t.status));
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => transfers.reload(), 5000);
    return () => clearInterval(timer);
  }, [open]);

  return (
    <div>
      <h1>Transfers</h1>
      <p className="muted">
        An item changes hands only when the buyer has accepted and both of you have signed with your
        wallets. WorthyBound then completes the transfer on Solana and starts a new custody period
        for the buyer.
      </p>
      {!transfers.data ? (
        <Loading error={transfers.error} />
      ) : transfers.data.items.length === 0 ? (
        <Card>
          <p className="muted">
            No transfers yet. Start one from a tokenized asset's page; transfers to you appear here.
          </p>
        </Card>
      ) : (
        <Card>
          <ul className="list">
            {transfers.data.items.map((t) => (
              <TransferItem key={t.id} transfer={t} onChange={transfers.reload} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TransferItem({ transfer: t, onChange }: { transfer: Transfer; onChange: () => void }) {
  const { me } = useSession();
  const { busy, error, run } = useAction();
  const act = (action: string) =>
    void run(async () => (await post(`/transfers/${t.id}/${action}`), onChange()));
  const sign = () =>
    void run(async () => {
      const wallet = me?.user.walletAddress ?? "";
      const signedTransaction = await signTransaction(wallet, t.transaction as string);
      await post(`/transfers/${t.id}/signature`, { signedTransaction });
      onChange();
    });
  const seller = t.role === "SENDER";
  const paid = t.priceLamports !== "0";
  const canCancel = (t.status === "PENDING" && seller) || (t.status === "ACCEPTED" && !sending(t));

  return (
    <li>
      <div>
        <strong>
          {t.asset.brand ?? "Unnamed"} {t.asset.model}
        </strong>{" "}
        <span className="mono small">{t.asset.wbId}</span> <Badge value={t.status} />
      </div>
      <div className="muted small">
        {seller ? "To " : "From "}
        <span className="mono">
          {shortAddress(seller ? t.toWalletAddress : t.fromWalletAddress)}
        </span>{" "}
        · {paid ? `Price ${formatSol(t.priceLamports)}` : "No payment"} · Started{" "}
        {formatDateTime(t.createdAt)}
        {OPEN.includes(t.status) && !sending(t) && ` · Expires ${formatDateTime(t.expiresAt)}`}
      </div>

      {t.status === "PENDING" &&
        (seller ? (
          <p className="small">Waiting for the buyer to accept.</p>
        ) : (
          <p className="small">
            Accepting prepares a transaction that you and the seller both sign
            {paid && `; signing it pays ${formatSol(t.priceLamports)} to the seller`}.{" "}
            <button className="small" disabled={busy} onClick={() => act("accept")}>
              Accept
            </button>{" "}
            <button className="ghost small" disabled={busy} onClick={() => act("reject")}>
              Decline
            </button>
          </p>
        ))}

      {t.status === "ACCEPTED" && (
        <>
          <p className="small">
            Seller: {t.signedBySeller ? "signed" : "not signed yet"} · Buyer:{" "}
            {t.signedByBuyer ? "signed" : "not signed yet"}
          </p>
          {t.awaitingYourSignature ? (
            <p className="small">
              <button className="small" disabled={busy} onClick={sign}>
                {busy ? "Check your wallet…" : "Sign with wallet"}
              </button>{" "}
              <span className="muted">
                {paid && !seller
                  ? `Your wallet pays ${formatSol(t.priceLamports)} to the seller in the same transaction as the transfer: both happen or neither does. WorthyBound pays the network fee.`
                  : paid
                    ? `You receive ${formatSol(t.priceLamports)} in the same transaction as the transfer. WorthyBound pays the network fee.`
                    : "Your wallet signs the transfer only; WorthyBound pays the network fee."}
              </span>
            </p>
          ) : !(t.signedBySeller && t.signedByBuyer) ? (
            <p className="small muted">Waiting for the {seller ? "buyer" : "seller"} to sign.</p>
          ) : t.chain?.status === "FAILED" ? (
            <p className="small error">
              Completing the transfer on Solana failed. WorthyBound retries automatically; if it
              keeps failing, you can cancel.
            </p>
          ) : (
            <p className="small muted">Completing the transfer on Solana…</p>
          )}
        </>
      )}

      {t.status === "COMPLETED" && (
        <p className="small">
          Completed {formatDateTime(t.completedAt)}
          {t.chain?.signature && (
            <>
              {" "}
              · <ChainLink kind="tx" value={t.chain.signature} />
            </>
          )}
          {!seller && (
            <>
              {" "}
              · <Link to={`/assets/${encodeURIComponent(t.asset.wbId)}`}>View asset</Link>
            </>
          )}
        </p>
      )}

      {t.closedReason && (
        <p className="small muted">
          {CLOSED_REASONS[t.closedReason] ?? `Closed: ${t.closedReason.replaceAll("_", " ")}.`}
        </p>
      )}

      {canCancel && (
        <button
          className="ghost small danger"
          disabled={busy}
          onClick={() => confirm("Cancel this transfer?") && act("cancel")}
        >
          Cancel transfer
        </button>
      )}
      <ErrorText error={error} />
    </li>
  );
}

/** On the asset page: starts a transfer of a tokenized asset, or points to the open one. */
export function StartTransfer({ asset: a, onChange }: { asset: OwnerAsset; onChange: () => void }) {
  const [wallet, setWallet] = useState("");
  const [price, setPrice] = useState("");
  const { busy, error, run } = useAction();
  const priceLamports = price.trim() ? solToLamports(price) : "0";
  if (a.status === "TRANSFER_PENDING") {
    return (
      <p className="small">
        A transfer of this item is open. <Link to="/transfers">Manage transfers</Link>
      </p>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await post("/transfers", {
            assetId: a.wbId,
            toWalletAddress: wallet.trim(),
            ...(priceLamports && priceLamports !== "0" ? { priceLamports } : {}),
          });
          setWallet("");
          setPrice("");
          onChange();
        });
      }}
    >
      <Field label="Transfer to wallet">
        <input
          className="mono"
          value={wallet}
          onChange={(event) => setWallet(event.target.value)}
          placeholder="Buyer's Solana wallet address"
          required
        />
      </Field>
      <Field label="Price in SOL (optional)">
        <input
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="e.g. 2.5; empty for no payment"
        />
      </Field>
      {priceLamports === null && (
        <p className="small error">Enter the price as a number, with at most 9 decimals.</p>
      )}
      <p className="muted small">
        With a price, the buyer pays you in SOL in the same transaction that transfers the item, on
        Solana devnet. The buyer must have signed in to WorthyBound with this wallet and verified
        their identity. The item stays yours until the buyer accepts and both of you sign; the
        transfer expires after 72 hours otherwise.
      </p>
      <button className="small" disabled={busy || !wallet.trim() || priceLamports === null}>
        Start transfer
      </button>
      <ErrorText error={error} />
    </form>
  );
}
