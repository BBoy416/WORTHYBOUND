import { ASSET_CATEGORIES, ITEM_CONDITIONS } from "@worthybound/shared";
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

const PUBLISHED = ["ACTIVE", "VERIFIED", "REVERIFICATION_REQUIRED"];

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
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
    const timer = setInterval(reloadAll, 3000);
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
            Every item needs a profile photo: you choose it in the evidence vault below, and it is
            shown on the public passport and as the token&apos;s image, without its location or
            camera data. Other photos stay private unless you choose to show them. Add receipts,
            certificates and other documents in the evidence vault too.
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
          {a.status !== "REVOKED" &&
            !(a.publishedAt === null && a.tokenizationStatus === "PENDING") && (
              <EditDetails asset={a} onChange={reloadAll} />
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
          <PassportLabel base={base} wbId={a.wbId} />
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
            profileEvidenceId={a.profileEvidenceId}
            onProfile={
              a.status === "REVOKED" ||
              (a.publishedAt === null && a.tokenizationStatus === "PENDING")
                ? undefined
                : async (e) => {
                    if (
                      e.visibility !== "PUBLIC" &&
                      !confirm(
                        "The profile photo is shown on the public passport and as the token's image, without its location or camera data. Use this photo?",
                      )
                    ) {
                      return;
                    }
                    await post(`${base}/evidence/${e.id}/profile`);
                    reloadAll();
                  }
            }
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

/** Prints the label at its real size from a hidden frame, so no pop-up window is needed. */
const printLabel = (svg: string, wbId: string) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  frame.srcdoc =
    `<!doctype html><html><head><title>${wbId} passport label</title><style>` +
    "@page{margin:0.5in}html,body{margin:0;background:#fff}" +
    "svg{display:block;width:2.5in;height:2.5in}</style></head><body>" +
    `${svg}</body></html>`;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
};

/** The owner's printable 2 × 2 inch passport label with a QR code of the public passport link. */
function PassportLabel({ base, wbId }: { base: string; wbId: string }) {
  const [label, setLabel] = useState<{ svg: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let live = true;
    fetch(`${base}/passport-label`, {
      headers: { accept: "image/svg+xml" },
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const svg = await res.text();
        if (!live) return;
        objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setLabel({ svg, url: objectUrl });
      })
      .catch(() => live && setError("The label could not be loaded."));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [base]);
  return (
    <Card title="Passport label">
      <div className="passport-label">
        {label && (
          <img src={label.url} alt={`Passport label of ${wbId}`} width={200} height={200} />
        )}
        <div>
          <p className="small">
            Only you can print this label. Anyone who scans it sees the public passport, never your
            identity, serial number or private evidence.
          </p>
          <h3>What you can do with it</h3>
          <ul className="small">
            <li>Let a buyer, appraiser or insurer scan it to open this item&apos;s passport.</li>
            <li>Show that the item has a WorthyBound record when you list, show or sell it.</li>
          </ul>
          <h3>How to keep it with the item</h3>
          <ol className="small">
            <li>Print at 100% (&quot;Actual size&quot;) and cut along the dashed line.</li>
            <li>
              Keep it in the item&apos;s box, with its papers or certificate, or on its display tag
              or case. Do not stick it on the item itself.
            </li>
            <li>
              A sleeve or laminated pouch keeps it readable. Reprint it here if it is damaged.
            </li>
            <li>When you sell the item, hand the label over with it.</li>
          </ol>
          <p className="muted small">
            A label can be copied, so it identifies the passport, not the item: buyers should still
            run a check before buying.
          </p>
          {label && (
            <p className="actions">
              <button className="small" onClick={() => printLabel(label.svg, wbId)}>
                Print label
              </button>
              <a
                className="button ghost small"
                href={label.url}
                download={`${wbId}-passport-label.svg`}
              >
                Download
              </a>
            </p>
          )}
          <ErrorText error={error} />
        </div>
      </div>
    </Card>
  );
}

const IDENTITY_FIELDS = ["category", "brand", "model", "serialNumber"] as const;
const DETAIL_FIELDS = ["publicDescription", "description", "condition"] as const;
type EditableField = (typeof IDENTITY_FIELDS)[number] | (typeof DETAIL_FIELDS)[number];

/**
 * Edits an asset's details. Category, brand, model and serial are locked once the passport is
 * published; the descriptions and the stated condition can still be updated.
 */
function EditDetails({ asset: a, onChange }: { asset: OwnerAsset; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const published = a.publishedAt !== null;
  const fields: readonly EditableField[] = published
    ? DETAIL_FIELDS
    : [...IDENTITY_FIELDS, ...DETAIL_FIELDS];
  const initial = Object.fromEntries(fields.map((f) => [f, a[f] ?? ""])) as Record<
    EditableField,
    string
  >;
  const [open, setOpen] = useState(
    !published && a.missingForPublish.some((m) => m === "brand" || m === "model"),
  );
  const [form, setForm] = useState(initial);
  const set = (name: EditableField) => (e: { target: { value: string } }) =>
    setForm({ ...form, [name]: e.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const changed = fields.filter((f) => form[f].trim() !== "" && form[f] !== initial[f]);
      // A published asset's condition change is recorded in its history.
      const viaPatch = changed.filter((f) => !(published && f === "condition"));
      const body = Object.fromEntries(viaPatch.map((f) => [f, form[f]]));
      if (Object.keys(body).length > 0) await patch(`/assets/${a.wbId}`, body);
      if (published && changed.includes("condition")) {
        await post(`/assets/${a.wbId}/condition`, { condition: form.condition });
      }
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
      {!published && (
        <>
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
        </>
      )}
      <Field label="Public description (shown on the passport)">
        <textarea value={form.publicDescription} onChange={set("publicDescription")} rows={3} />
      </Field>
      <Field label="Private notes (you and your verifiers only)">
        <textarea value={form.description} onChange={set("description")} rows={2} />
      </Field>
      <Field label="Condition (your own assessment)">
        <select value={form.condition} onChange={set("condition")}>
          <option value="">Not stated</option>
          {ITEM_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted small">
        {published
          ? "Category, brand, model and serial are locked. Add photos and documents in the evidence vault at any time."
          : "Category, brand, model and serial are locked once published."}
      </p>
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
  const canPublish =
    a.publishedAt === null &&
    a.status === "DRAFT" &&
    (a.tokenizationStatus === "NOT_TOKENIZED" || a.tokenizationStatus === "FAILED");
  const kycMissing = me?.kycRequired === true && me.user.identityStatus !== "VERIFIED";

  return (
    <Card title="Passport and token">
      {canPublish &&
        (a.missingForPublish.length > 0 ? (
          <p className="muted">
            To publish, add: {listed(a.missingForPublish)}.
            {a.missingForPublish.includes("a profile photo") &&
              " Choose one of your photos with “Use as profile photo” in the evidence vault."}
          </p>
        ) : (
          <>
            <p className="small">
              Every passport is backed by a token. Your item is minted as a frozen token to your
              wallet on Solana devnet, then its passport goes public. Brand, model and serial are
              locked once published.
            </p>
            <p>
              <button disabled={busy || kycMissing} onClick={() => void act(`${base}/publish`)}>
                Tokenize and publish
              </button>
              {kycMissing && <span className="muted small"> Needs a verified identity (KYC).</span>}
            </p>
          </>
        ))}
      {a.tokenizationStatus === "PENDING" && a.publishedAt === null && (
        <p className="muted">
          Minting on devnet… the passport goes public once the token is confirmed. This updates
          automatically.
        </p>
      )}
      {a.tokenizationStatus === "FAILED" && (
        <p className="error">Tokenization failed, so the passport is not public yet. Try again.</p>
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
      {a.status === "DRAFT" && a.tokenizationStatus !== "PENDING" && (
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
