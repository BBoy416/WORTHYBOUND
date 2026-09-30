import {
  OWNER_CODE_MINUTES,
  ownerConfirmationMessage,
  REMOTE_CHECK_HOURS,
  type RemoteCodeResult,
} from "@worthybound/shared";
import { useEffect, useState } from "react";
import { get, post, postFile } from "../api.js";
import { Camera, SessionShots, useCountdown } from "../components/Capture.js";
import { Badge, Card, ErrorText, Field, Loading, useAction, useLoad } from "../components/ui.js";
import { formatDateTime, humanize } from "../format.js";
import { Link, useRouter } from "../router.js";
import { useSession } from "../session.js";
import type { OwnerAsset, PurchaseCheck, RemoteCheckRequest } from "../types.js";
import { connectWallet, signText, toBase58 } from "../wallet.js";

const RESULT_TEXT: Record<string, string> = {
  MATCH: "The item in front of you matches the recorded item.",
  NO_MATCH: "The item in front of you does not match the recorded item. Do not buy it.",
  INCONCLUSIVE: "The photos could not tell whether this is the recorded item.",
};

const REMOTE_RESULT_TEXT: Record<string, string> = {
  MATCH: "The filmed item matches the recorded item.",
  NO_MATCH: "The filmed item does not match the recorded item. Do not buy it.",
  INCONCLUSIVE: "The photos could not tell whether the filmed item is the recorded item.",
};

const CODE_CHECK_TEXT: Record<RemoteCodeResult, string> = {
  SHOWN: "The seller's photo shows your code next to the item.",
  MISSING: "Your code is not visible in the seller's photo. Look for it in the video.",
  MISMATCH: "The seller's photo shows a different code. Do not rely on this check.",
  FAILED: "The AI check of the seller's code photo failed. Do not rely on this check.",
  UNCLEAR:
    "The AI check could not confirm your code in the seller's photo. Look for it in the video.",
  PENDING: "Checking your code in the seller's photo…",
  UNAVAILABLE: "Your code could not be checked automatically. Look for it in the video.",
};

/** On the public passport: a signed-in buyer starts a check of the item in front of them. */
export function StartPurchaseCheck({ wbId }: { wbId: string }) {
  const { me } = useSession();
  const { navigate } = useRouter();
  const { busy, error, run } = useAction();
  const start = (kind: "purchase-checks" | "remote-checks") =>
    void run(async () => {
      const check = await post<PurchaseCheck>(`/assets/${encodeURIComponent(wbId)}/${kind}`);
      navigate(`/checks/${check.id}`);
    });
  return (
    <Card title="Check before buying">
      <p className="small">
        Meeting the seller? Check that they own this item and that the item in front of you is the
        one recorded here: the seller signs a code with the owner's wallet, and you photograph the
        item with this page's camera. You never see who the seller is.
      </p>
      <p className="small">
        Buying from afar? Request a remote check: within {REMOTE_CHECK_HOURS} hours, the owner films
        the item with a code you see, and you watch the video and get the result.
      </p>
      {me ? (
        <div className="actions">
          <button disabled={busy} onClick={() => start("purchase-checks")}>
            Start a check
          </button>
          <button className="ghost" disabled={busy} onClick={() => start("remote-checks")}>
            Request a remote check
          </button>
        </div>
      ) : (
        <p className="muted small">Connect your wallet to check this item before buying.</p>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

/** The buyer's check: the seller's confirmation, then photos of the item and the result. */
export function PurchaseCheckPage({ checkId }: { checkId: string }) {
  const path = `/purchase-checks/${encodeURIComponent(checkId)}`;
  const check = useLoad(() => get<PurchaseCheck>(path), [path]);
  const [current, setCurrent] = useState<PurchaseCheck | null>(null);
  const { busy, error, run } = useAction();
  const c = current ?? check.data;
  const countdown = useCountdown(c?.owner.codeExpiresAt ?? null);

  const waiting =
    c !== undefined &&
    c !== null &&
    (c.kind === "REMOTE"
      ? c.status === "OPEN" || c.owner.codeCheck === "PENDING"
      : c.owner.code !== null || c.item.comparing);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => (setCurrent(null), check.reload()), 3000);
    return () => clearInterval(timer);
  }, [waiting]);
  useEffect(() => {
    if (countdown !== "0:00") return;
    setCurrent(null);
    check.reload();
  }, [countdown]);

  if (!c) return <Loading error={check.error} />;
  if (c.kind === "REMOTE") {
    return <RemoteCheck check={c} path={path} error={error ?? check.error} />;
  }
  const open = c.status === "OPEN";
  const next = c.item.shots.find((s) => s.receivedAt === null) ?? null;
  const take = (photo: Blob) =>
    void run(async () => {
      if (!next) return;
      setCurrent(await postFile<PurchaseCheck>(`${path}/photos/${next.shot}`, photo));
    });

  return (
    <div>
      <CheckHeader check={c} />
      {c.status === "EXPIRED" && (
        <p className="muted">
          This check expired before every photo was taken.{" "}
          <Link to={`/passport/${c.asset.wbId}`}>Start a new one</Link> from the passport.
        </p>
      )}

      <Card title="1. The seller">
        {c.owner.confirmed ? (
          <p>
            <Badge value="CONFIRMED" label="Confirmed current owner" />{" "}
            <span className="muted small">
              The seller signed your code with the owner's wallet ·{" "}
              {formatDateTime(c.owner.confirmedAt)}
            </span>
          </p>
        ) : c.owner.code ? (
          <>
            <p>
              Ask the seller to confirm this code on their asset page:{" "}
              <strong className="capture-code mono">{c.owner.code}</strong>{" "}
              <span className="muted small">Expires in {countdown}</span>
            </p>
            <p className="muted small">
              Their wallet asks them to sign: “{c.owner.message}”. This page updates when they do.
            </p>
          </>
        ) : open ? (
          <p>
            <span className="muted small">
              The code expired. Codes are valid for {OWNER_CODE_MINUTES} minutes.
            </span>{" "}
            <button
              className="small"
              disabled={busy}
              onClick={() =>
                void run(async () => setCurrent(await post<PurchaseCheck>(`${path}/owner-code`)))
              }
            >
              New code
            </button>
          </p>
        ) : (
          <p className="muted">The seller did not confirm ownership.</p>
        )}
      </Card>

      <Card title="2. The item">
        {c.item.result ? (
          <>
            <p>
              <Badge value={c.item.result} /> {RESULT_TEXT[c.item.result]}
            </p>
            {c.item.reason && <p className="muted small">{c.item.reason}.</p>}
          </>
        ) : c.item.comparing ? (
          <p className="muted">Comparing your photos with the recorded ones…</p>
        ) : (
          <p className="small">
            Photograph the item in front of you with this page's camera. The photos are compared
            with the item's recorded photos and are never shown to anyone else.
          </p>
        )}
        <ol className="capture-shots small">
          {c.item.shots.map((s) => (
            <li key={s.shot} className={s.receivedAt ? "done" : ""}>
              <strong>{humanize(s.shot)}</strong>: {s.instruction}
              {s.receivedAt && " ✓"}
            </li>
          ))}
        </ol>
        {open && next && (
          <Camera label={`Take photo: ${humanize(next.shot)}`} busy={busy} onPhoto={take} />
        )}
        {c.item.shots.some((s) => s.receivedAt) && (
          <div className="compare">
            <div>
              <h3>Your photos</h3>
              <div className="thumbs">
                {c.item.shots
                  .filter((s) => s.receivedAt)
                  .map((s) => (
                    <img key={s.shot} src={`${path}/photos/${s.shot}`} alt={humanize(s.shot)} />
                  ))}
              </div>
            </div>
            {c.item.recordedPhotos.length > 0 && (
              <div>
                <h3>Recorded photos</h3>
                <div className="thumbs">
                  {c.item.recordedPhotos.map((p) => (
                    <img key={p.path} src={p.path} alt="Recorded photo" />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <p className="disclaimer">
        A result means the item matches what WorthyBound recorded; it is not a guarantee of
        authenticity. Private recorded photos are compared but never shown.
      </p>
      <ErrorText error={error ?? check.error} />
    </div>
  );
}

function CheckHeader({ check: c }: { check: PurchaseCheck }) {
  return (
    <>
      <p className="crumbs">
        <Link to={`/passport/${c.asset.wbId}`}>Passport</Link> /{" "}
        <span className="mono">{c.asset.wbId}</span> /{" "}
        {c.kind === "REMOTE" ? "Remote check" : "Check before buying"}
      </p>
      <h1>
        {c.asset.brand} <span className="gold">{c.asset.model}</span>
      </h1>
      <div className="badges">
        <Badge value={c.asset.status} />
        <Badge value={c.asset.verificationLevel} />
      </div>
      {c.asset.transferBlocked && (
        <p className="alert" role="alert">
          This item is {humanize(c.asset.status).toLowerCase()}: it cannot be transferred. Do not
          buy it.
        </p>
      )}
    </>
  );
}

/** The buyer's remote check: the code, the seller's filming, the video and the result. */
function RemoteCheck({
  check: c,
  path,
  error,
}: {
  check: PurchaseCheck;
  path: string;
  error: string | null;
}) {
  const video = useAction();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const received = c.item.shots.filter((s) => s.receivedAt).length;
  return (
    <div>
      <CheckHeader check={c} />
      {c.status === "EXPIRED" && (
        <p className="muted">
          The seller did not film the item in time.{" "}
          <Link to={`/passport/${c.asset.wbId}`}>Request a new check</Link> from the passport.
        </p>
      )}

      <Card title="1. The seller">
        <p>
          Your code: <strong className="capture-code mono">{c.owner.code}</strong>
        </p>
        {c.owner.confirmed ? (
          <>
            <p>
              <Badge value="CONFIRMED" label="Confirmed current owner" />{" "}
              <span className="muted small">
                The owner's account filmed the item · {formatDateTime(c.owner.confirmedAt)}
              </span>
            </p>
            {c.owner.codeCheck && <p className="small">{CODE_CHECK_TEXT[c.owner.codeCheck]}</p>}
          </>
        ) : c.status === "OPEN" ? (
          <>
            <p className="small">
              Ask the seller to open this item's page on WorthyBound: your request is there with the
              same code. They film the item with the code written on paper in view. You never see
              who they are, and they never see who you are.
            </p>
            <p className="muted small">
              Open until {formatDateTime(c.expiresAt)}
              {received > 0 && ` · The seller is filming: ${received} of ${c.item.shots.length}`}.
              This page updates when they finish.
            </p>
          </>
        ) : (
          <p className="muted">The seller did not film the item.</p>
        )}
      </Card>

      <Card title="2. The item">
        {c.item.videoAvailable &&
          (videoUrl ? (
            <video className="check-video" src={videoUrl} controls playsInline />
          ) : (
            <button
              disabled={video.busy}
              onClick={() =>
                void video.run(async () =>
                  setVideoUrl((await post<{ url: string }>(`${path}/video`)).url),
                )
              }
            >
              Watch the seller's video
            </button>
          ))}
        {c.item.result ? (
          <>
            <p>
              <Badge value={c.item.result} /> {REMOTE_RESULT_TEXT[c.item.result]}
            </p>
            {c.item.reason && <p className="muted small">{c.item.reason}.</p>}
          </>
        ) : c.item.comparing ? (
          <p className="muted">Comparing the seller's photos with the recorded ones…</p>
        ) : (
          <p className="small">
            The seller's photos are compared with the item's recorded photos. Their video is shown
            only to you.
          </p>
        )}
        <ol className="capture-shots small">
          {c.item.shots.map((s) => (
            <li key={s.shot} className={s.receivedAt ? "done" : ""}>
              <strong>{humanize(s.shot)}</strong>: {s.instruction}
              {s.receivedAt && " ✓"}
            </li>
          ))}
        </ol>
        {c.item.recordedPhotos.length > 0 && (
          <div>
            <h3>Recorded photos</h3>
            <div className="thumbs">
              {c.item.recordedPhotos.map((p) => (
                <img key={p.path} src={p.path} alt="Recorded photo" />
              ))}
            </div>
          </div>
        )}
        <ErrorText error={video.error} />
      </Card>

      <p className="disclaimer">
        A result means the filmed item matches what WorthyBound recorded; it is not a guarantee of
        authenticity. Private recorded photos are compared but never shown.
      </p>
      <ErrorText error={error} />
    </div>
  );
}

/** On the owner's asset page: buyers' remote checks, each filmed in its own capture session. */
export function RemoteCheckRequests({ base, onChange }: { base: string; onChange: () => void }) {
  const requests = useLoad(
    () => get<{ items: RemoteCheckRequest[] }>(`${base}/remote-checks`),
    [base],
  );
  const { busy, error, run } = useAction();
  const items = requests.data?.items ?? [];
  const filming = items.find((r) => r.session?.status === "OPEN")?.session ?? null;
  const countdown = useCountdown(filming?.expiresAt ?? null);
  useEffect(() => {
    if (countdown === "0:00") requests.reload();
  }, [countdown]);

  if (items.length === 0) return null;
  const reload = () => (requests.reload(), onChange());
  return (
    <Card title="Remote checks from buyers">
      <p className="small">
        Buyers who cannot meet you ask you to film this item. For each request, write its code on
        paper, take each shot with this page's camera, then record a short video turning the item
        around with the code in view. Photos and videos from your gallery cannot be used. You never
        see who the buyer is; they see that the owner's account filmed the item, and the video.
      </p>
      {items.map((r) => (
        <div key={r.id} className="stack">
          <p>
            Code: <strong className="capture-code mono">{r.code}</strong>{" "}
            <span className="muted small">
              Requested {formatDateTime(r.createdAt)} · open until {formatDateTime(r.expiresAt)}
            </span>
          </p>
          {r.filmed ? (
            <p className="small">Filmed. The buyer can watch the video and see the result.</p>
          ) : r.session?.status === "OPEN" ? (
            <>
              <p className="muted small">Expires in {countdown}</p>
              <SessionShots base={base} session={r.session} onChange={reload} />
            </>
          ) : (
            <>
              {r.session?.status === "EXPIRED" && (
                <p className="muted small">
                  The last filming expired before every shot was taken. Start again.
                </p>
              )}
              <button
                className="small"
                disabled={busy || filming !== null}
                onClick={() =>
                  void run(async () => {
                    await post(`${base}/remote-checks/${r.id}/capture-session`);
                    requests.reload();
                  })
                }
              >
                Film for this buyer
              </button>
            </>
          )}
        </div>
      ))}
      <ErrorText error={error} />
    </Card>
  );
}

/** On the owner's asset page: the owner signs a buyer's code to confirm they own the item. */
export function ConfirmOwnership({ asset: a }: { asset: OwnerAsset }) {
  const { me } = useSession();
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const normalized = code.replace(/\s/g, "").toUpperCase();
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const { provider, address } = await connectWallet();
          if (address !== me?.user.walletAddress) {
            throw new Error(`Switch your wallet to the owner's wallet ${me?.user.walletAddress}`);
          }
          const { signature } = await signText(
            provider,
            ownerConfirmationMessage(a.wbId, normalized),
          );
          await post(`/assets/${encodeURIComponent(a.wbId)}/owner-confirmations`, {
            code: normalized,
            signature: toBase58(signature),
          });
          setCode("");
          setDone(true);
        });
      }}
    >
      <Field label="Buyer's code">
        <input
          value={code}
          onChange={(event) => (setCode(event.target.value), setDone(false))}
          placeholder="e.g. K7P2QX"
          autoComplete="off"
        />
      </Field>
      <p className="muted small">
        A buyer checking this item gets a code on their phone. Signing it with your wallet shows
        them that the owner is in front of them; they do not see your wallet or name.
      </p>
      <button className="small" disabled={busy || normalized.length !== 6}>
        Confirm to buyer
      </button>
      {done && <p className="small">Confirmed. The buyer's page shows it now.</p>}
      <ErrorText error={error} />
    </form>
  );
}
