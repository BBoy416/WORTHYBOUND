import {
  ASSURANCE_LEVELS,
  ATTESTATION_RESULTS,
  ITEM_CONDITIONS,
  VERIFIER_EVIDENCE_TYPES,
} from "@worthybound/shared";
import { useState, type FormEvent } from "react";
import { get, post } from "../api.js";
import { EvidenceList, UploadForm } from "../components/Evidence.js";
import {
  Badge,
  Card,
  ErrorText,
  Facts,
  Field,
  Loading,
  useAction,
  useLoad,
} from "../components/ui.js";
import { formatDate, formatDateTime, humanize } from "../format.js";
import { Link } from "../router.js";
import type { OwnerEvidence, VerifierRequest } from "../types.js";
import { connectWallet, signText, toBase58 } from "../wallet.js";

export function VerifierQueuePage() {
  const [scope, setScope] = useState<"open" | "mine">("mine");
  const { data, error } = useLoad(
    () => get<{ items: VerifierRequest[] }>(`/verifier/requests?scope=${scope}`),
    [scope],
  );
  return (
    <div>
      <div className="page-head">
        <h1>Verification requests</h1>
        <div className="tabs">
          <button className={scope === "mine" ? "" : "ghost"} onClick={() => setScope("mine")}>
            Assigned to me
          </button>
          <button className={scope === "open" ? "" : "ghost"} onClick={() => setScope("open")}>
            Open queue
          </button>
        </div>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : data.items.length === 0 ? (
        <Card>
          <p className="muted">
            {scope === "open"
              ? "No open requests in your categories."
              : "No requests assigned to you."}
          </p>
        </Card>
      ) : (
        <ul className="list cards">
          {data.items.map((r) => (
            <li key={r.id}>
              <Link to={`/verifier/requests/${r.id}`}>
                <strong>
                  {r.asset.brand} {r.asset.model}
                </strong>{" "}
                <span className="mono small">{r.asset.wbId}</span>
              </Link>{" "}
              <Badge value={r.status} />
              <div className="muted small">
                {r.template.name} v{r.template.version} · {humanize(r.asset.category)} · requested{" "}
                {formatDate(r.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VerifierRequestPage({ requestId }: { requestId: string }) {
  const base = `/verifier/requests/${requestId}`;
  const request = useLoad(() => get<VerifierRequest>(base), [base]);
  const evidence = useLoad(
    () =>
      request.data?.assignedToYou
        ? get<{ items: OwnerEvidence[] }>(`${base}/evidence`)
        : Promise.resolve({ items: [] }),
    [base, request.data?.assignedToYou],
  );
  const { busy, error, run } = useAction();
  const act = (path: string) => run(async () => (await post(path), request.reload()));
  const r = request.data;
  if (!r) return <Loading error={request.error} />;
  const working = r.assignedToYou && r.status === "ASSIGNED";
  const claimed = new Set(
    r.attestations.filter((a) => a.status === "ACTIVE").map((a) => a.claimType),
  );

  return (
    <div>
      <p className="crumbs">
        <Link to="/verifier">Verification requests</Link> /{" "}
        <span className="mono">{r.asset.wbId}</span>
      </p>
      <div className="page-head">
        <h1>
          {r.asset.brand} <span className="gold">{r.asset.model}</span>
        </h1>
        <Badge value={r.status} />
      </div>
      <div className="grid">
        <Card title="Item">
          <Facts
            rows={[
              ["WB ID", <span className="mono">{r.asset.wbId}</span>],
              ["Category", humanize(r.asset.category)],
              ["Serial", r.asset.serialNumber ?? (r.assignedToYou ? "—" : "Shown once assigned")],
              [
                "Owner-stated condition",
                r.asset.ownerStatedCondition ? humanize(r.asset.ownerStatedCondition) : "—",
              ],
            ]}
          />
          {r.asset.publicDescription && <p className="small">{r.asset.publicDescription}</p>}
        </Card>
        <Card title={`${r.template.name} v${r.template.version}`}>
          <Facts
            rows={[
              ["Claims to attest", r.template.requiredClaims.map(humanize).join(", ")],
              [
                "Required evidence",
                r.template.requiredEvidence
                  .map((e) => `${e.minCount}× ${humanize(e.type)}`)
                  .join(", ") || "—",
              ],
              ["Allowed methods", r.template.allowedMethods.map(humanize).join(", ")],
              ["Valid for", `${r.template.validityMonths} months`],
            ]}
          />
          <p className="actions">
            {r.status === "OPEN" && (
              <button disabled={busy} onClick={() => void act(`${base}/claim`)}>
                Take this request
              </button>
            )}
            {working && (
              <>
                <button
                  disabled={busy || r.template.requiredClaims.some((c) => !claimed.has(c))}
                  onClick={() => void act(`${base}/complete`)}
                >
                  Mark complete
                </button>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => void act(`${base}/release`)}
                >
                  Release
                </button>
              </>
            )}
          </p>
          <ErrorText error={error} />
        </Card>
      </div>

      {r.assignedToYou && (
        <Card title="Evidence">
          {evidence.data ? (
            <EvidenceList
              items={evidence.data.items}
              downloadPath={(id) => `${base}/evidence/${id}/download`}
              previewPath={(id) => `${base}/evidence/${id}/preview`}
              {...(working
                ? {
                    onReview: async (e: OwnerEvidence, status: "ACCEPTED" | "REJECTED") => {
                      const reason =
                        status === "REJECTED" ? prompt("Why is this evidence rejected?") : null;
                      if (status === "REJECTED" && !reason) return;
                      await post(`${base}/evidence/${e.id}/review`, {
                        status,
                        ...(reason ? { reason } : {}),
                      });
                      evidence.reload();
                    },
                  }
                : {})}
            />
          ) : (
            <Loading error={evidence.error} />
          )}
          {working && (
            <UploadForm
              requestPath={`${base}/evidence/uploads`}
              types={VERIFIER_EVIDENCE_TYPES}
              allowPublic={false}
              onDone={evidence.reload}
            />
          )}
        </Card>
      )}

      {r.assignedToYou && (
        <Card title="Attestations">
          {r.attestations.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="list">
              {r.attestations.map((a) => (
                <li key={a.id}>
                  <strong>{humanize(a.claimType)}</strong> <Badge value={a.result} />{" "}
                  <Badge value={a.status} />
                  <span className="muted small">
                    {" "}
                    {humanize(a.method)} · {formatDateTime(a.issuedAt)}
                    {a.conditionGrade && ` · ${humanize(a.conditionGrade)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {working && (
            <AttestForm request={r} evidence={evidence.data?.items ?? []} onDone={request.reload} />
          )}
        </Card>
      )}
    </div>
  );
}

/** Builds the claim, gets its exact message from the API, signs it with the verifier's wallet and submits it. */
function AttestForm({
  request: r,
  evidence,
  onDone,
}: {
  request: VerifierRequest;
  evidence: OwnerEvidence[];
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [claimType, setClaimType] = useState<string>(
    r.template.requiredClaims[0] ?? "AUTHENTICATION",
  );
  const [result, setResult] = useState<string>("CONFIRMED");
  const [method, setMethod] = useState<string>(r.template.allowedMethods[0] ?? "IN_PERSON");
  const [assuranceLevel, setAssurance] = useState<string>("HIGH");
  const [conditionGrade, setGrade] = useState<string>("EXCELLENT");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt);
      expiresAt.setMonth(expiresAt.getMonth() + r.template.validityMonths);
      const draft = {
        claimType,
        result,
        method,
        assuranceLevel,
        ...(claimType === "CONDITION" && result === "CONFIRMED" ? { conditionGrade } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        evidence: evidence
          .filter((e) => selected.has(e.id))
          .map((e) => ({ evidenceId: e.id, sha256: e.sha256 })),
      };
      const { message, verifierAddress } = await post<{ message: string; verifierAddress: string }>(
        `/verifier/requests/${r.id}/attestations/message`,
        draft,
      );
      const { provider, address } = await connectWallet();
      if (address !== verifierAddress)
        throw new Error(`Switch your wallet to the verifier wallet ${verifierAddress}`);
      const { signature } = await signText(provider, message);
      await post(`/verifier/requests/${r.id}/attestations`, {
        ...draft,
        signature: toBase58(signature),
      });
      setNotes("");
      setSelected(new Set());
      onDone();
    });
  };

  const select = (
    options: readonly string[],
    value: string,
    onChange: (v: string) => void,
    label: string,
  ) => (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {humanize(o)}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <form className="form attest" onSubmit={submit}>
      <h3>Sign an attestation</h3>
      <div className="row">
        {select(r.template.requiredClaims, claimType, setClaimType, "Claim")}
        {select(ATTESTATION_RESULTS, result, setResult, "Result")}
      </div>
      <div className="row">
        {select(r.template.allowedMethods, method, setMethod, "Method")}
        {select(ASSURANCE_LEVELS, assuranceLevel, setAssurance, "Assurance")}
        {claimType === "CONDITION" &&
          result === "CONFIRMED" &&
          select(ITEM_CONDITIONS, conditionGrade, setGrade, "Condition grade")}
      </div>
      <Field label="Notes (private to you)">
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {evidence.length > 0 && (
        <fieldset className="evidence-pick">
          <legend>Evidence supporting this claim</legend>
          {evidence.map((e) => (
            <label key={e.id} className="check">
              <input
                type="checkbox"
                checked={selected.has(e.id)}
                onChange={(ev) => {
                  const next = new Set(selected);
                  if (ev.target.checked) next.add(e.id);
                  else next.delete(e.id);
                  setSelected(next);
                }}
              />
              {humanize(e.type)} · {e.originalFilename ?? e.id.slice(0, 8)}
            </label>
          ))}
        </fieldset>
      )}
      <p className="muted small">
        Your wallet signs the exact claim text. The signature is published on the passport.
      </p>
      <ErrorText error={error} />
      <button type="submit" disabled={busy}>
        {busy ? "Waiting for wallet…" : "Sign and submit"}
      </button>
    </form>
  );
}
