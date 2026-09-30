import {
  DELIVERY_EXTENSION_DAYS,
  MAX_DELIVERY_EXTENSIONS,
  RECEIPT_CHECK_HOURS,
  RELEASE_AFTER_DAYS,
  SHIP_WITHIN_DAYS,
  type TransferDelivery,
} from "@worthybound/shared";
import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { SessionShots, useCountdown } from "../components/Capture.js";
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
import type { CaptureSession, OwnerAsset, Transfer, TransferEscrow } from "../types.js";
import { signTransaction } from "../wallet.js";

const OPEN = ["PENDING", "ACCEPTED"];

const CLOSED_REASONS: Record<string, string> = {
  rejected: "Declined by the buyer.",
  cancelled_by_sender: "Cancelled by the seller.",
  cancelled_by_recipient: "Cancelled by the buyer.",
  expired: "Expired before both parties signed.",
  asset_reported_stolen: "Cancelled: the item was reported stolen.",
  asset_reported_lost: "Cancelled: the item was reported lost.",
  not_shipped: "Refunded: the seller did not ship in time.",
  delivery_overdue: "Refunded: the item did not arrive in time.",
  refunded_by_admin: "Refunded by an administrator.",
  paid_after_close: "Refunded: the payment arrived after the transfer ended.",
  escrow_refunded: "Refunded to the buyer.",
};

/** Why an escrow is held for an administrator; otherwise the buyer's own words. */
const DISPUTE_REASONS: Record<string, string> = {
  receipt_no_match: "The buyer's photos do not match the seller's photos before shipping.",
  release_failed: "Completing the transfer on Solana failed; the buyer can only be refunded.",
  asset_reported_stolen: "The item was reported stolen after shipping.",
  asset_reported_lost: "The item was reported lost after shipping.",
};

/** Both have signed and the transaction is with Solana, unless sending gave up. */
const sending = (t: Transfer) =>
  t.signedBySeller && t.signedByBuyer && t.chain !== null && t.chain.status !== "FAILED";

/** A payment into escrow that was sent and not given up. */
const paying = (e: TransferEscrow) => e.payment !== null && e.payment.status !== "FAILED";

/** Who can cancel now; in escrow, a paid sale is refunded instead (ADR 0014). */
function cancellable(t: Transfer): boolean {
  const seller = t.role === "SENDER";
  const e = t.escrow;
  if (t.status === "PENDING") return seller;
  if (t.status !== "ACCEPTED") return false;
  if (!e) return !sending(t);
  if (e.status === "AWAITING_PAYMENT") return !paying(e);
  if (e.status === "PAID") return seller;
  if (e.status === "SHIPPED") {
    return !seller && e.deliveryDueAt !== null && new Date(e.deliveryDueAt) <= new Date();
  }
  return false;
}

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
  const canCancel = cancellable(t);
  const refunds = t.escrow?.status === "PAID" || t.escrow?.status === "SHIPPED";

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
            {t.delivery === "SHIPPED"
              ? `The seller ships this item. Accepting prepares the transfer for you and the seller to sign; you then pay ${formatSol(t.priceLamports)} into escrow. The seller is paid, and the item becomes yours, only once you have received it.`
              : "Accepting prepares a transaction that you and the seller both sign"}
            {t.delivery !== "SHIPPED" &&
              paid &&
              `; signing it pays ${formatSol(t.priceLamports)} to the seller`}
            {t.delivery !== "SHIPPED" && "."}{" "}
            <button className="small" disabled={busy} onClick={() => act("accept")}>
              Accept
            </button>{" "}
            <button className="ghost small" disabled={busy} onClick={() => act("reject")}>
              Decline
            </button>
          </p>
        ))}

      {t.status === "ACCEPTED" && (!t.escrow || t.escrow.status === "AWAITING_PAYMENT") && (
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
                {t.escrow
                  ? seller
                    ? `Signing approves the transfer; it runs only when the sale is released, paying you ${formatSol(t.priceLamports)} from escrow in the same transaction. WorthyBound pays the network fee.`
                    : "Signing approves the transfer; it runs only when the sale is released, after you received the item. Nothing is paid yet. WorthyBound pays the network fee."
                  : paid && !seller
                    ? `Your wallet pays ${formatSol(t.priceLamports)} to the seller in the same transaction as the transfer: both happen or neither does. WorthyBound pays the network fee.`
                    : paid
                      ? `You receive ${formatSol(t.priceLamports)} in the same transaction as the transfer. WorthyBound pays the network fee.`
                      : "Your wallet signs the transfer only; WorthyBound pays the network fee."}
              </span>
            </p>
          ) : !(t.signedBySeller && t.signedByBuyer) ? (
            <p className="small muted">Waiting for the {seller ? "buyer" : "seller"} to sign.</p>
          ) : t.escrow ? (
            <EscrowPayment transfer={t} escrow={t.escrow} onChange={onChange} />
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

      {t.escrow && t.escrow.status !== "AWAITING_PAYMENT" && (
        <EscrowSteps transfer={t} escrow={t.escrow} onChange={onChange} />
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
          onClick={() =>
            confirm(
              refunds
                ? `Cancel this sale? ${formatSol(t.priceLamports)} is refunded to the buyer.`
                : "Cancel this transfer?",
            ) && act("cancel")
          }
        >
          {refunds ? "Cancel and refund" : "Cancel transfer"}
        </button>
      )}
      <ErrorText error={error} />
    </li>
  );
}

/** Once both signed a shipped transfer: the buyer pays the price into escrow. */
function EscrowPayment({
  transfer: t,
  escrow: e,
  onChange,
}: {
  transfer: Transfer;
  escrow: TransferEscrow;
  onChange: () => void;
}) {
  const { me } = useSession();
  const { busy, error, run } = useAction();
  const pay = () =>
    void run(async () => {
      const wallet = me?.user.walletAddress ?? "";
      const signedTransaction = await signTransaction(wallet, e.paymentTransaction as string);
      await post(`/transfers/${t.id}/payment`, { signedTransaction });
      onChange();
    });
  if (t.role === "SENDER") {
    return (
      <p className="small muted">
        {paying(e)
          ? "The buyer's payment is being sent to escrow on Solana…"
          : "Waiting for the buyer to pay into escrow."}
      </p>
    );
  }
  if (!e.awaitingYourPayment) {
    return <p className="small muted">Sending your payment to escrow on Solana…</p>;
  }
  return (
    <>
      {e.payment?.status === "FAILED" && (
        <p className="small error">
          Your last payment did not go through, for example because the wallet lacked the SOL. Sign
          the payment again.
        </p>
      )}
      <p className="small">
        <button className="small" disabled={busy} onClick={pay}>
          {busy ? "Check your wallet…" : `Pay ${formatSol(t.priceLamports)} into escrow`}
        </button>{" "}
        <span className="muted">
          WorthyBound holds the payment. The seller has {SHIP_WITHIN_DAYS} days to ship, or you are
          refunded; they are paid only once you have received the item.
        </span>
      </p>
      <ErrorText error={error} />
    </>
  );
}

/** A paid shipped transfer: shipping, delivery, the receipt check, and release or refund. */
function EscrowSteps({
  transfer: t,
  escrow: e,
  onChange,
}: {
  transfer: Transfer;
  escrow: TransferEscrow;
  onChange: () => void;
}) {
  const { busy, error, run } = useAction();
  const act = (action: string) =>
    void run(async () => (await post(`/transfers/${t.id}/${action}`), onChange()));
  const seller = t.role === "SENDER";
  const price = formatSol(t.priceLamports);
  const overdue = e.deliveryDueAt !== null && new Date(e.deliveryDueAt) <= new Date();
  const shipment = e.shippedAt && (
    <p className="small">
      Shipped {formatDateTime(e.shippedAt)} with {e.carrier}, tracking{" "}
      <span className="mono">{e.trackingNumber}</span>.
    </p>
  );

  return (
    <div className="escrow">
      <p className="small">
        <Badge value={e.status} label={`Escrow: ${ESCROW_LABELS[e.status]}`} />
        {e.paidAt && (
          <span className="muted">
            {" "}
            · {price} paid {formatDateTime(e.paidAt)}
          </span>
        )}
      </p>

      {e.status === "PAID" &&
        (seller ? (
          <>
            <p className="small">
              The buyer's payment is in escrow. Ship by {formatDateTime(e.shipBy)}, or the buyer is
              refunded. First film the item and the sealed package with this page's camera, with the
              session's code written on the package.
            </p>
            <ShipmentCapture transfer={t} escrow={e} onChange={onChange} />
            {e.shipmentFilmed && <ShipForm transferId={t.id} onChange={onChange} />}
          </>
        ) : (
          <p className="small">
            Your payment is in escrow. The seller ships by {formatDateTime(e.shipBy)}, or you are
            refunded.
          </p>
        ))}

      {e.status === "SHIPPED" && (
        <>
          {shipment}
          {seller ? (
            <p className="small muted">
              The buyer confirms delivery by {formatDateTime(e.deliveryDueAt)}. Without a
              confirmation or a reported problem, the sale is released {RELEASE_AFTER_DAYS} days
              after that.
            </p>
          ) : (
            <>
              <p className="small">
                {overdue
                  ? `The delivery period ended ${formatDateTime(e.deliveryDueAt)}. You can cancel for a refund, or wait longer.`
                  : `Expected by ${formatDateTime(e.deliveryDueAt)}.`}{" "}
                When the package arrives, confirm it, then photograph the package with the seller's
                code and the item within {RECEIPT_CHECK_HOURS} hours.
              </p>
              <p className="small">
                <button className="small" disabled={busy} onClick={() => act("delivered")}>
                  I received it
                </button>{" "}
                {e.deliveryExtensions < MAX_DELIVERY_EXTENSIONS && (
                  <button className="ghost small" disabled={busy} onClick={() => act("extend")}>
                    Wait {DELIVERY_EXTENSION_DAYS} more days
                  </button>
                )}
              </p>
            </>
          )}
        </>
      )}

      {e.status === "DELIVERED" && (
        <>
          {shipment}
          <p className="small">
            Delivered {formatDateTime(e.deliveredAt)}. The sale is released{" "}
            {formatDateTime(e.releaseAt)}, or earlier if the buyer's photos match the seller's
            photos before shipping.
          </p>
          {!seller && e.receiptCheckId && (
            <p className="small">
              <Link to={`/checks/${e.receiptCheckId}`}>Photograph the package and the item</Link>
            </p>
          )}
        </>
      )}

      {e.status === "DISPUTED" && (
        <p className="small">
          Held for an administrator:{" "}
          {e.disputeReason &&
            (DISPUTE_REASONS[e.disputeReason] ?? `the buyer reported “${e.disputeReason}”`)}
          . Neither the payment nor the item moves until they decide.
        </p>
      )}
      {e.status === "RELEASING" && (
        <p className="small muted">
          Releasing the sale: paying the seller from escrow and transferring the item on Solana…
        </p>
      )}
      {e.status === "REFUNDING" && (
        <p className="small muted">Refunding {price} to the buyer on Solana…</p>
      )}
      {e.status === "REFUNDED" && (
        <p className="small">
          {price} refunded to the buyer
          {e.refund?.signature && (
            <>
              {" "}
              · <ChainLink kind="tx" value={e.refund.signature} />
            </>
          )}
        </p>
      )}
      {e.resolution && (
        <p className="small">
          Administrator's decision ({formatDateTime(e.resolvedAt)}): {e.resolution}
        </p>
      )}

      {!seller && (e.status === "SHIPPED" || e.status === "DELIVERED") && (
        <DisputeForm transferId={t.id} onChange={onChange} />
      )}
      <ErrorText error={error} />
    </div>
  );
}

const ESCROW_LABELS: Record<TransferEscrow["status"], string> = {
  AWAITING_PAYMENT: "awaiting payment",
  PAID: "paid",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  DISPUTED: "held",
  RELEASING: "releasing",
  RELEASED: "released",
  REFUNDING: "refunding",
  REFUNDED: "refunded",
};

/** The seller's timed capture session of the item and the sealed package, before shipping. */
function ShipmentCapture({
  transfer: t,
  escrow: e,
  onChange,
}: {
  transfer: Transfer;
  escrow: TransferEscrow;
  onChange: () => void;
}) {
  const path = `/transfers/${t.id}/shipment-session`;
  const session = useLoad(
    () => (e.shipmentSessionId ? get<CaptureSession>(path) : Promise.resolve(null)),
    [path, e.shipmentSessionId],
  );
  const { busy, error, run } = useAction();
  const current = session.data?.status === "OPEN" ? session.data : null;
  const countdown = useCountdown(current?.expiresAt ?? null);
  useEffect(() => {
    if (countdown === "0:00") session.reload();
  }, [countdown]);

  if (e.shipmentFilmed) {
    return <p className="small">Item and package filmed ✓</p>;
  }
  if (!current) {
    return (
      <>
        {session.data?.status === "EXPIRED" && (
          <p className="muted small">The last session expired before every shot was taken.</p>
        )}
        <button
          className="small"
          disabled={busy || session.data === undefined}
          onClick={() => void run(async () => (await post(path), session.reload(), onChange()))}
        >
          Film the item and the package
        </button>
        <ErrorText error={error ?? session.error} />
      </>
    );
  }
  return (
    <>
      <p>
        Write this code on the package:{" "}
        <strong className="capture-code mono">{current.code}</strong>{" "}
        <span className="muted small">Expires in {countdown}</span>
      </p>
      <SessionShots
        base={`/assets/${encodeURIComponent(t.asset.wbId)}`}
        session={current}
        onChange={() => (session.reload(), onChange())}
      />
      <ErrorText error={error ?? session.error} />
    </>
  );
}

function ShipForm({ transferId, onChange }: { transferId: string; onChange: () => void }) {
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await post(`/transfers/${transferId}/shipment`, {
            carrier: carrier.trim(),
            trackingNumber: tracking.trim(),
          });
          onChange();
        });
      }}
    >
      <Field label="Carrier">
        <input value={carrier} onChange={(event) => setCarrier(event.target.value)} required />
      </Field>
      <Field label="Tracking number">
        <input
          className="mono"
          value={tracking}
          onChange={(event) => setTracking(event.target.value)}
          required
        />
      </Field>
      <button className="small" disabled={busy || !carrier.trim() || !tracking.trim()}>
        Mark as shipped
      </button>
      <ErrorText error={error} />
    </form>
  );
}

/** The buyer reports a problem; the payment and the item are held for an administrator. */
function DisputeForm({ transferId, onChange }: { transferId: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  if (!open) {
    return (
      <button className="ghost small danger" onClick={() => setOpen(true)}>
        Report a problem
      </button>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await post(`/transfers/${transferId}/dispute`, { reason: reason.trim() });
          setOpen(false);
          onChange();
        });
      }}
    >
      <Field label="What is wrong?">
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} required />
      </Field>
      <p className="muted small">
        The payment stays in escrow and the item with the seller until an administrator decides to
        pay the seller or refund you.
      </p>
      <button className="small danger" disabled={busy || !reason.trim()}>
        Report problem
      </button>{" "}
      <button type="button" className="ghost small" onClick={() => setOpen(false)}>
        Back
      </button>
      <ErrorText error={error} />
    </form>
  );
}

/** On the asset page: starts a transfer of a tokenized asset, or points to the open one. */
export function StartTransfer({ asset: a, onChange }: { asset: OwnerAsset; onChange: () => void }) {
  const [wallet, setWallet] = useState("");
  const [price, setPrice] = useState("");
  const [delivery, setDelivery] = useState<TransferDelivery>("IN_PERSON");
  const { busy, error, run } = useAction();
  const priceLamports = price.trim() ? solToLamports(price) : "0";
  const shipped = delivery === "SHIPPED";
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
            delivery,
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
      <Field label="Delivery">
        <select
          value={delivery}
          onChange={(event) => setDelivery(event.target.value as TransferDelivery)}
        >
          <option value="IN_PERSON">Handed over in person</option>
          <option value="SHIPPED">Shipped, with the price in escrow</option>
        </select>
      </Field>
      <Field label={shipped ? "Price in SOL" : "Price in SOL (optional)"}>
        <input
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          placeholder={shipped ? "e.g. 2.5" : "e.g. 2.5; empty for no payment"}
          required={shipped}
        />
      </Field>
      {priceLamports === null && (
        <p className="small error">Enter the price as a number, with at most 9 decimals.</p>
      )}
      <p className="muted small">
        {shipped
          ? `The buyer pays the price into escrow. You then film the item and the sealed package and ship within ${SHIP_WITHIN_DAYS} days; you are paid, and the item passes to the buyer, once the buyer's photos on arrival match yours, or ${RELEASE_AFTER_DAYS} days after delivery unless they report a problem.`
          : "With a price, the buyer pays you in SOL in the same transaction that transfers the item."}{" "}
        On Solana devnet. The buyer must have signed in to WorthyBound with this wallet and verified
        their identity. The item stays yours until the buyer accepts and both of you sign; the
        transfer expires after 72 hours otherwise.
      </p>
      <button
        className="small"
        disabled={
          busy || !wallet.trim() || priceLamports === null || (shipped && priceLamports === "0")
        }
      >
        Start transfer
      </button>
      <ErrorText error={error} />
    </form>
  );
}
