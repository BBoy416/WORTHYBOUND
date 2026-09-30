import { useEffect, useState } from "react";
import { get, post, put } from "../api.js";
import { GuidedCapture } from "../components/Capture.js";
import { EvidenceList, UploadForm } from "../components/Evidence.js";
import {
  Badge,
  Card,
  ChainLink,
  ErrorText,
  Facts,
  Loading,
  TrustDial,
  useAction,
  useLoad,
} from "../components/ui.js";
import { formatDate, formatDateTime, humanize } from "../format.js";
import { Link } from "../router.js";
import { useSession } from "../session.js";
import { StartTransfer } from "./Transfers.js";
import type {
  AutomatedChecksConsent,
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
        </Card>
        <Lifecycle asset={a} onChange={reloadAll} />
      </div>

      <GuidedCapture base={base} asset={a} onChange={reloadAll} />

      <Card title="Evidence vault">
        <AutomatedChecks base={base} asset={a} onChange={reloadAll} />
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

/** The owner's consent to AI checks of their uploads for this asset. */
function AutomatedChecks({
  base,
  asset: a,
  onChange,
}: {
  base: string;
  asset: OwnerAsset;
  onChange: () => void;
}) {
  const consent = useLoad(() => get<AutomatedChecksConsent>(`${base}/automated-checks`), [base]);
  const { busy, error, run } = useAction();
  const c = consent.data;
  if (!c || !c.available || (a.status === "REVOKED" && !c.enabled)) return null;
  const set = (enabled: boolean) =>
    void run(async () => {
      await put(`${base}/automated-checks`, { enabled });
      consent.reload();
      onChange();
    });
  return (
    <div className="ai-checks">
      {c.enabled ? (
        <p className="small">
          <Badge value="ACTIVE" label="AI checks on" /> Since {formatDate(c.enabledAt)}, each photo
          and document you add is checked for signs of a fake: photos of screens, generated or
          edited images, documents that do not match this item.{" "}
          <button className="ghost small" disabled={busy} onClick={() => set(false)}>
            Turn off
          </button>
        </p>
      ) : (
        <p className="small">
          Turn on AI checks to have your photos and documents checked for signs of a fake. Passed
          checks can raise the Trust Score up to 65 without a verifier; failed checks lower it until
          a verifier reviews the file. Files are sent to OpenAI without their metadata (location,
          camera) and are not used for training. Results already recorded stay if you turn checks
          off.{" "}
          <button className="small" disabled={busy} onClick={() => set(true)}>
            Turn on AI checks
          </button>
        </p>
      )}
      <ErrorText error={error ?? consent.error} />
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
