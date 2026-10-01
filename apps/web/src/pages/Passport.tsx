import type { PublicPassport } from "@worthybound/shared";
import { ApiError, get } from "../api.js";
import { Badge, Card, ChainLink, Facts, Loading, TrustDial, useLoad } from "../components/ui.js";
import { formatDate, formatDateTime, humanize } from "../format.js";
import { StartPurchaseCheck } from "./PurchaseCheck.js";

const WARNING: Partial<Record<string, string>> = {
  REPORTED_STOLEN:
    "This item has been reported stolen. Do not buy it; contact WorthyBound support.",
  REPORTED_LOST: "This item has been reported lost.",
  DISPUTED: "This item is under dispute. Transfers are blocked until it is resolved.",
  REVOKED: "This passport has been revoked.",
};

export function PassportPage({ wbId }: { wbId: string }) {
  const { data, error } = useLoad(
    () =>
      get<{ passport: PublicPassport }>(`/passport/${encodeURIComponent(wbId)}`).catch(
        (e: unknown) => {
          if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return null;
          throw e;
        },
      ),
    [wbId],
  );
  if (data === undefined) return <Loading error={error} />;
  if (data === null) return <p className="error">No public passport with WB ID {wbId}.</p>;
  const p = data.passport;
  const photos = p.publicEvidence.filter((e) => e.mimeType.startsWith("image/"));
  const warning = WARNING[p.status];

  return (
    <div className="passport">
      {warning && (
        <p className="alert" role="alert">
          {warning}
        </p>
      )}
      <section className="hero-passport">
        <div className="hero-photo">
          {photos[0] ? (
            <img src={photos[0].path} alt={`${p.brand ?? ""} ${p.model ?? ""}`} />
          ) : (
            <div className="no-photo">No public photo</div>
          )}
        </div>
        <div className="hero-info">
          <p className="eyebrow">Digital passport · {humanize(p.category)}</p>
          <h1>
            {p.brand} <span className="gold">{p.model}</span>
          </h1>
          <p className="mono wbid">{p.wbId}</p>
          <div className="badges">
            <Badge value={p.status} />
            <Badge value={p.verificationLevel} />
            {p.tokenization.status === "TOKENIZED" && (
              <Badge value="TOKENIZED" label="On Solana devnet" />
            )}
          </div>
          {p.description && <p>{p.description}</p>}
        </div>
        <div className="hero-score">
          <TrustDial score={p.trust?.score ?? null} />
          <p className="muted small">
            {p.trust ? `Computed ${formatDate(p.trust.computedAt)}` : "Not yet scored"}
          </p>
        </div>
      </section>

      <p className="disclaimer">
        {p.trust?.disclaimer ?? "A token is not proof of authenticity. Trust must be earned."}
      </p>

      <div className="grid">
        <Card title="Verification">
          {p.automatedChecks && (
            <p className="small">
              <Badge value="PASSED" label="Automated checks passed" />{" "}
              {p.automatedChecks.filesPassed === 1
                ? "1 photo or document"
                : `${p.automatedChecks.filesPassed} photos and documents`}{" "}
              checked for signs of a fake · {formatDate(p.automatedChecks.lastPassedAt)}. Not an
              inspection by a verifier.
            </p>
          )}
          {p.attestations.length === 0 ? (
            <p className="muted">No verifier has attested to this item yet.</p>
          ) : (
            <ul className="list">
              {p.attestations.map((a) => (
                <li key={a.id}>
                  <div>
                    <strong>{humanize(a.claimType)}</strong> <Badge value={a.result} />{" "}
                    {a.status !== "ACTIVE" && <Badge value={a.status} />}
                    {a.conditionGrade && (
                      <span className="muted"> · grade {humanize(a.conditionGrade)}</span>
                    )}
                  </div>
                  <div className="muted small">
                    {a.verifier.publicName ?? "Approved verifier"} · {humanize(a.method)} ·{" "}
                    {formatDate(a.issuedAt)}
                    {a.expiresAt && ` · valid until ${formatDate(a.expiresAt)}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Condition">
          <Facts
            rows={[
              [
                "Verified",
                p.condition.verified
                  ? `${humanize(p.condition.verified.grade)} (${formatDate(p.condition.verified.assessedAt)})`
                  : "Not verified",
              ],
              ["Owner-stated", p.condition.ownerStated ? humanize(p.condition.ownerStated) : "—"],
              ["Current custody since", formatDate(p.custody.currentSince)],
              ["Transfers", String(p.custody.transferCount)],
            ]}
          />
        </Card>

        <Card title="On-chain record">
          <Facts
            rows={[
              ["Tokenization", humanize(p.tokenization.status)],
              [
                "Asset token",
                p.tokenization.chainAssetAddress ? (
                  <ChainLink kind="address" value={p.tokenization.chainAssetAddress} />
                ) : (
                  "—"
                ),
              ],
              [
                "WorthyBound record",
                p.tokenization.chainRecordAddress ? (
                  <ChainLink kind="address" value={p.tokenization.chainRecordAddress} />
                ) : (
                  "—"
                ),
              ],
            ]}
          />
          {p.chainTransactions.length > 0 && (
            <ul className="list compact">
              {p.chainTransactions.map((t) => (
                <li key={t.signature}>
                  {humanize(t.kind)} · <ChainLink kind="tx" value={t.signature} />{" "}
                  <span className="muted small">{formatDateTime(t.confirmedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Evidence">
          {photos.length > 1 && (
            <div className="thumbs">
              {photos.slice(1).map((e) => (
                <img key={e.evidenceId} src={e.path} alt={humanize(e.type)} />
              ))}
            </div>
          )}
          {p.evidenceCommitments.length === 0 ? (
            <p className="muted">No evidence sealed yet.</p>
          ) : (
            <p className="small">
              {p.evidenceCommitments.at(-1)?.evidenceCount} files sealed · Merkle root{" "}
              <span className="mono">{p.evidenceCommitments.at(-1)?.merkleRoot.slice(0, 16)}…</span>
            </p>
          )}
          <p className="muted small">Private evidence is kept in the vault and never shown here.</p>
        </Card>
      </div>

      {p.status !== "REVOKED" && <StartPurchaseCheck wbId={p.wbId} />}

      <Card title="Provenance">
        <ol className="timeline">
          {p.provenance.map((e) => (
            <li key={e.sequence}>
              <strong>{humanize(e.type)}</strong>{" "}
              <span className="muted small">{formatDateTime(e.occurredAt)}</span>
              <div className="mono tiny">{e.hash.slice(0, 24)}…</div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
