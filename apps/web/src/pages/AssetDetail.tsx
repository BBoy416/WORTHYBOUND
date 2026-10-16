import { ASSET_CATEGORIES } from "@worthybound/shared";
import { useEffect, useState, type FormEvent } from "react";
import { get, patch, post } from "../api.js";
import { GuidedCapture } from "../components/Capture.js";
import { EvidenceList, UploadForm } from "../components/Evidence.js";
import {
  Badge,
  Card,
  ChainLink,
  ErrorText,
  Facts,
  Field,
  Loading,
  TrustDial,
  useAction,
  useLoad,
} from "../components/ui.js";
import { formatDate, formatDateTime, humanize } from "../format.js";
import { Link } from "../router.js";
import { useSession } from "../session.js";
import { ConfirmOwnership, RemoteCheckRequests } from "./PurchaseCheck.js";
import { StartTransfer } from "./Transfers.js";
import type {
  AutomatedChecksAvailability,
  OwnerAsset,
  OwnerEvidence,
  OwnerRequest,
  OwnerTrust,
  PublishedTemplate,
} from "../types.js";

const TOKENIZABLE = ["ACTIVE", "VERIFIED", "REVERIFICATION_REQUIRED"];
const PUBLISHED = ["ACTIVE", "VERIFIED", "REVERIFICATION_REQUIRED"];
const REPORTABLE = [...PUBLISHED, "TRANSFER_PENDING"];

export function AssetDetailPage({ wbId }: { wbId: string }) {
  const base = `/assets/${encodeURIComponent(wbId)}`;
  const asset = useLoad(() => get<OwnerAsset>(base), [base]);
  const evidence = useLoad(() => get<{ items: OwnerEvidence[] }>(`${base}/evidence`), [base]);
  const trust = useLoad(() => get<OwnerTrust | null>(`${base}/trust`), [base]);
  const requests = useLoad(
    () => get<{ items: OwnerRequest[] }>(`${base}/verification-requests`),
    [base],
  );
  const reloadAll = () => (asset.reload(), evidence.reload(), trust.reload(), requests.reload());

  const pending = asset.data?.tokenizationStatus === "PENDING";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => asset.reload(), 3000);
    return () => clearInterval(timer);
  }, [pending]);

  const checking = evidence.data?.items.some((e) => e.automatedCheck?.status === "PENDING");
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => (evidence.reload(), trust.reload(), asset.reload()), 5000);
    return () => clearInterval(timer);
  }, [checking]);

  const a = asset.data;
  if (!a) return <Loading error={asset.error} />;
  const needsPhotos =
    a.status !== "REVOKED" &&
    evidence.data !== undefined &&
    !evidence.data.items.some((e) => e.type === "PHOTO");
  return (
    <div>
      <p className="crumbs">
        <Link to="/assets">My assets</Link> / <span className="mono">{a.wbId}</span>
      </p>
      <section className="hero-passport">
        <div className="hero-info">
          <p className="eyebrow">{humanize(a.category)}</p>
          <h1>
            {a.brand ?? "Unnamed"} <span className="gold">{a.model}</span>
          </h1>
          <p className="mono wbid">{a.wbId}</p>
          <div className="badges">
            <Badge value={a.status} />
            <Badge value={a.verificationLevel} />
            <Badge value={a.tokenizationStatus} />
          </div>
          {a.passportUrl && (
            <p>
              <a href={a.passportUrl} target="_blank" rel="noreferrer">
                Public passport ↗
              </a>
            </p>
          )}
        </div>
        <div className="hero-score">
          <TrustDial score={trust.data ? trust.data.score : null} />
        </div>
      </section>

      {needsPhotos && (
        <Card title="Add photos of your item">
          <p className="muted small">
            Photos appear as the item's thumbnail and stay private unless you choose to show them on
            the public passport. Add receipts, certificates and other documents in the evidence
            vault below.
          </p>
          <UploadForm
            requestPath={`${base}/evidence/uploads`}
            types={["PHOTO"]}
            allowPublic
            multiple
            submitLabel="Add photos"
            onDone={reloadAll}
          />
        </Card>
      )}

      <div className="grid">
        <Card title="Details">
          <Facts
            rows={[
              ["Serial (private)", a.serialNumber ?? "—"],
              ["Condition (stated)", a.condition ? humanize(a.condition) : "—"],
              ["Registered", formatDate(a.createdAt)],
              ["Published", formatDate(a.publishedAt)],
            ]}
          />
          {a.publicDescription && <p className="small">{a.publicDescription}</p>}
          {a.publishedAt === null && a.status !== "REVOKED" && (
            <EditDraft asset={a} onChange={reloadAll} />
          )}
        </Card>
        <Lifecycle asset={a} onChange={reloadAll} />
      </div>

      <GuidedCapture base={base} asset={a} onChange={reloadAll} />

      {a.publishedAt !== null && a.status !== "REVOKED" && (
        <>
          <RemoteCheckRequests base={base} onChange={reloadAll} />
          <Card title="Confirm ownership to a buyer">
            <ConfirmOwnership asset={a} />
          </Card>
          <PassportQr base={base} wbId={a.wbId} />
        </>
      )}

      <Card title="Evidence vault">
        <AutomatedChecks base={base} asset={a} />
        {evidence.data ? (
          <EvidenceList
            items={evidence.data.items}
            downloadPath={(id) => `${base}/evidence/${id}/download`}
            previewPath={(id) => `${base}/evidence/${id}/preview`}
            onVisibility={async (e) => {
              await post(`${base}/evidence/${e.id}/visibility`, {
                visibility: e.visibility === "PUBLIC" ? "PRIVATE" : "PUBLIC",
              });
              reloadAll();
            }}
          />
        ) : (
          <Loading error={evidence.error} />
        )}
        {a.status !== "REVOKED" && (
          <UploadForm
            requestPath={`${base}/evidence/uploads`}
            allowPublic
            multiple
            onDone={reloadAll}
          />
        )}
      </Card>

      <Verification asset={a} requests={requests.data?.items ?? null} onChange={reloadAll} />
      <TrustBreakdown trust={trust.data} error={trust.error} />
    </div>
  );
}

/** The owner's printable QR code of the public passport link. */
function PassportQr({ base, wbId }: { base: string; wbId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let live = true;
    fetch(`${base}/passport-qr`, {
      headers: { accept: "image/svg+xml" },
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const blob = new Blob([await res.text()], { type: "image/svg+xml" });
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => live && setError("The QR code could not be loaded."));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [base]);
  return (
    <Card title="Passport QR code">
      <div className="passport-qr">
        {url && <img src={url} alt={`QR code of the passport ${wbId}`} width={180} height={180} />}
        <div>
          <p className="small">
            Print it for the item's box, papers or display tag. Anyone who scans it sees the public
            passport, never your identity, serial number or private evidence.
          </p>
          <p className="muted small">
            A QR code can be copied, so it identifies the passport, not the item: buyers should
            still run a check before buying. Avoid sticking it on the item itself.
          </p>
          {url && (
            <p className="actions">
              <a className="button ghost small" href={url} download={`${wbId}-passport-qr.svg`}>
                Download
              </a>
              <a className="button ghost small" href={url} target="_blank" rel="noreferrer">
                Open to print
              </a>
            </p>
          )}
          <ErrorText error={error} />
        </div>
      </div>
    </Card>
  );
}

const DRAFT_FIELDS = [
  "category",
  "brand",
  "model",
  "serialNumber",
  "publicDescription",
  "description",
] as const;

/** Edits a draft's details; they are locked once the passport is published. */
function EditDraft({ asset: a, onChange }: { asset: OwnerAsset; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const initial = Object.fromEntries(DRAFT_FIELDS.map((f) => [f, a[f] ?? ""])) as Record<
    (typeof DRAFT_FIELDS)[number],
    string
  >;
  const [open, setOpen] = useState(a.missingForPublish.length > 0);
  const [form, setForm] = useState(initial);
  const set = (name: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [name]: e.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const body = Object.fromEntries(
        DRAFT_FIELDS.filter((f) => form[f].trim() !== "" && form[f] !== initial[f]).map((f) => [
          f,
          form[f],
        ]),
      );
      if (Object.keys(body).length > 0) await patch(`/assets/${a.wbId}`, body);
      setOpen(false);
      onChange();
    });
  };

  if (!open) {
    return (
      <p>
        <button className="ghost small" onClick={() => setOpen(true)}>
          Edit details
        </button>
      </p>
    );
  }
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Category">
        <select value={form.category} onChange={set("category")}>
          {ASSET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label="Brand">
          <input value={form.brand} onChange={set("brand")} placeholder="Rolex" />
        </Field>
        <Field label="Model">
          <input value={form.model} onChange={set("model")} placeholder="Submariner 124060" />
        </Field>
      </div>
      <Field label="Serial number (private, never shown or written on-chain)">
        <input value={form.serialNumber} onChange={set("serialNumber")} autoComplete="off" />
      </Field>
      <Field label="Public description (shown on the passport)">
        <textarea value={form.publicDescription} onChange={set("publicDescription")} rows={3} />
      </Field>
      <Field label="Private notes (you and your verifiers only)">
        <textarea value={form.description} onChange={set("description")} rows={2} />
      </Field>
      <p className="muted small">Category, brand, model and serial are locked once published.</p>
      <ErrorText error={error} />
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save details"}
      </button>
    </form>
  );
}

/** Tells the owner that their uploads are checked by AI, when checks are available. */
function AutomatedChecks({ base, asset: a }: { base: string; asset: OwnerAsset }) {
  const checks = useLoad(
    () => get<AutomatedChecksAvailability>(`${base}/automated-checks`),
    [base],
  );
  if (!checks.data?.available || a.status === "REVOKED") return null;
  return (
    <div className="ai-checks">
      <p className="small">
        <Badge value="ACTIVE" label="AI checks on" /> Each photo and document you add is checked for
        signs of a fake: photos of screens, generated or edited images, documents that do not match
        this item. Passed checks can raise the Trust Score up to 65 without a verifier; failed
        checks lower it until a verifier reviews the file. Files are sent to OpenAI without their
        metadata (location, camera) and are not used for training.
      </p>
      <ErrorText error={checks.error} />
    </div>
  );
}

function Lifecycle({ asset: a, onChange }: { asset: OwnerAsset; onChange: () => void }) {
  const { me } = useSession();
  const { busy, error, run } = useAction();
  const base = `/assets/${a.wbId}`;
  const act = (path: string, body?: unknown) =>
    run(async () => (await post(path, body), onChange()));
  const canPublish = a.publishedAt === null && (a.status === "DRAFT" || a.status === "TOKENIZED");
  const canTokenize =
    a.publishedAt !== null &&
    TOKENIZABLE.includes(a.status) &&
    (a.tokenizationStatus === "NOT_TOKENIZED" || a.tokenizationStatus === "FAILED");
  const kycMissing = me?.user.identityStatus !== "VERIFIED";

  return (
    <Card title="Passport and token">
      {canPublish &&
        (a.missingForPublish.length > 0 ? (
          <p className="muted">To publish, add: {a.missingForPublish.join(" and ")}.</p>
        ) : (
          <p>
            <button disabled={busy} onClick={() => void act(`${base}/publish`)}>
              Publish passport
            </button>{" "}
            <span className="muted small">Brand, model and serial are locked once published.</span>
          </p>
        ))}
      {canTokenize && (
        <p>
          <button disabled={busy || kycMissing} onClick={() => void act(`${base}/tokenize`)}>
            Tokenize on Solana devnet
          </button>
          {kycMissing && <span className="muted small"> Needs a verified identity (KYC).</span>}
        </p>
      )}
      {a.tokenizationStatus === "PENDING" && (
        <p className="muted">Minting on devnet… this updates automatically.</p>
      )}
      {a.tokenizationStatus === "FAILED" && (
        <p className="error">Tokenization failed. You can try again.</p>
      )}
      <Facts
        rows={[
          [
            "Asset token",
            a.chainAssetAddress ? <ChainLink kind="address" value={a.chainAssetAddress} /> : "—",
          ],
          [
            "WorthyBound record",
            a.chainRecordAddress ? <ChainLink kind="address" value={a.chainRecordAddress} /> : "—",
          ],
        ]}
      />
      {a.tokenizationStatus === "TOKENIZED" && REPORTABLE.includes(a.status) && (
        <StartTransfer asset={a} onChange={onChange} />
      )}
      {REPORTABLE.includes(a.status) && (
        <p className="actions">
          <button
            className="ghost small danger"
            disabled={busy}
            onClick={() =>
              confirm("Report this item lost?") &&
              void act(`${base}/status`, { toStatus: "REPORTED_LOST" })
            }
          >
            Report lost
          </button>
          <button
            className="ghost small danger"
            disabled={busy}
            onClick={() =>
              confirm(
                "Report this item stolen? Any open transfer is cancelled, and transfers are blocked until an admin clears it.",
              ) && void act(`${base}/status`, { toStatus: "REPORTED_STOLEN" })
            }
          >
            Report stolen
          </button>
        </p>
      )}
      {a.status === "REPORTED_LOST" && (
        <button
          className="ghost small"
          disabled={busy}
          onClick={() => void act(`${base}/status`, { toStatus: "REVERIFICATION_REQUIRED" })}
        >
          Mark recovered
        </button>
      )}
      {a.status === "DRAFT" && (
        <button
          className="ghost small danger"
          disabled={busy}
          onClick={() =>
            confirm("Discard this draft?") && void act(`${base}/status`, { toStatus: "REVOKED" })
          }
        >
          Discard draft
        </button>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

function Verification({
  asset: a,
  requests,
  onChange,
}: {
  asset: OwnerAsset;
  requests: OwnerRequest[] | null;
  onChange: () => void;
}) {
  const templates = useLoad(
    () => get<{ items: PublishedTemplate[] }>(`/templates?category=${a.category}`),
    [a.category],
  );
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useAction();
  const open = requests?.filter((r) => r.status === "OPEN" || r.status === "ASSIGNED") ?? [];
  const canRequest = a.publishedAt !== null && PUBLISHED.includes(a.status);

  return (
    <Card title="Verification">
      {requests === null ? (
        <Loading />
      ) : requests.length === 0 ? (
        <p className="muted">No verification requested yet.</p>
      ) : (
        <ul className="list">
          {requests.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.template.name}</strong>{" "}
                <span className="muted small">v{r.template.version}</span>{" "}
                <Badge value={r.status} />
              </div>
              <div className="muted small">
                Requested {formatDateTime(r.createdAt)}
                {r.verifier && ` · ${r.verifier.publicName ?? "Approved verifier"}`}
                {r.attestations.length > 0 &&
                  ` · ${r.attestations.map((x) => `${humanize(x.claimType)}: ${humanize(x.result)}`).join(", ")}`}
              </div>
              {(r.status === "OPEN" || r.status === "ASSIGNED") && (
                <button
                  className="ghost small"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => (await post(`/verification-requests/${r.id}/cancel`), onChange()),
                    )
                  }
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canRequest && open.length === 0 && templates.data && templates.data.items.length > 0 && (
        <div className="row">
          <select
            aria-label="Verification template"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">Choose a verification…</option>
            {templates.data.items.map((t) => (
              <option key={t.templateVersionId} value={t.templateVersionId}>
                {t.name} (needs {t.requiredClaims.map(humanize).join(", ")})
              </option>
            ))}
          </select>
          <button
            disabled={busy || !choice}
            onClick={() =>
              void run(
                async () => (
                  await post(`/assets/${a.wbId}/verification-requests`, {
                    templateVersionId: choice,
                  }),
                  setChoice(""),
                  onChange()
                ),
              )
            }
          >
            Request verification
          </button>
        </div>
      )}
      {!canRequest && <p className="muted small">Publish the passport to request verification.</p>}
      <ErrorText error={error ?? templates.error} />
    </Card>
  );
}

function TrustBreakdown({
  trust,
  error,
}: {
  trust: OwnerTrust | null | undefined;
  error: string | null;
}) {
  if (trust === undefined) return <Loading error={error} />;
  if (trust === null) return null;
  return (
    <Card title="Trust Score breakdown (private)">
      <table className="table">
        <tbody>
          {trust.factors.map((f) => (
            <tr key={f.code}>
              <td>{humanize(f.code)}</td>
              <td className="num gold">+{f.points}</td>
            </tr>
          ))}
          {trust.deductions.map((d) => (
            <tr key={d.code}>
              <td>{humanize(d.code)}</td>
              <td className="num error">−{Math.abs(d.points)}</td>
            </tr>
          ))}
          {trust.capsApplied.map((c) => (
            <tr key={c.code}>
              <td>Capped: {humanize(c.code)}</td>
              <td className="num">≤ {c.limit}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Score</td>
            <td className="num">{trust.score}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted tiny">
        Engine {trust.engineVersion} · weights {trust.weightsVersion} ·{" "}
        {formatDateTime(trust.computedAt)}
      </p>
      <p className="disclaimer">{trust.disclaimer}</p>
    </Card>
  );
}
