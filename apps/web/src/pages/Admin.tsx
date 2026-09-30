import {
  ASSET_CATEGORIES,
  ATTESTATION_METHODS,
  AUTOMATED_CHECK_RESULTS,
  CHECK_PROBLEM_MESSAGES,
  CATEGORY_PERMISSION_LIFECYCLE,
  CLAIM_TYPES,
  DEFAULT_TEMPLATE_VALIDITY_MONTHS,
  EVIDENCE_TYPES,
  MAX_TEMPLATE_VALIDITY_MONTHS,
  nextStatuses,
  PERMISSION_STATUSES_REQUIRING_REASON,
  reviewActor,
  VERIFIER_LIFECYCLE,
  VERIFIER_STATUSES,
  VERIFIER_STATUSES_REQUIRING_REASON,
  type AutomatedCheckResult,
  type CategoryPermissionStatus,
  type Role,
  type VerifierStatus,
} from "@worthybound/shared";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { del, get, post } from "../api.js";
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
import { formatDate, formatDateTime, humanize, shortAddress } from "../format.js";
import { Link } from "../router.js";
import { useSession } from "../session.js";
import type {
  AdminCheck,
  AdminTemplate,
  AdminTemplateVersion,
  ReviewVerifier,
  RoleAssignment,
  VerifierReports,
  VerifierSummary,
} from "../types.js";

type Tab = "verifiers" | "templates" | "roles" | "checks";

const ACTION_LABELS: Record<string, string> = {
  UNDER_REVIEW: "Start review",
  APPROVED: "Approve",
  REJECTED: "Reject",
  SUSPENDED: "Suspend",
  REVOKED: "Revoke",
};

/** Administrators see every tab; verifier reviewers only the verifier applications. */
export function AdminPage({ tab }: { tab: Tab }) {
  const { me } = useSession();
  const actor = reviewActor((me?.roles ?? []) as Role[]);
  if (!actor) return <p className="muted">This page is for administrators.</p>;
  const isAdmin = actor === "ADMIN";
  const current = isAdmin ? tab : "verifiers";
  return (
    <div>
      <div className="page-head">
        <h1>{isAdmin ? "Admin" : "Verifier applications"}</h1>
        {isAdmin && (
          <nav className="tabs">
            <TabLink to="/admin" active={current === "verifiers"}>
              Verifiers
            </TabLink>
            <TabLink to="/admin/templates" active={current === "templates"}>
              Templates
            </TabLink>
            <TabLink to="/admin/roles" active={current === "roles"}>
              Roles
            </TabLink>
            <TabLink to="/admin/checks" active={current === "checks"}>
              AI checks
            </TabLink>
          </nav>
        )}
      </div>
      {current === "verifiers" && <VerifiersTab />}
      {current === "templates" && <TemplatesTab />}
      {current === "roles" && <RolesTab />}
      {current === "checks" && <ChecksTab />}
    </div>
  );
}

function TabLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link to={to} className={active ? "button small" : "button ghost small"}>
      {children}
    </Link>
  );
}

// ─── Verifiers ────────────────────────────────────────────────────────────────

function VerifiersTab() {
  const [status, setStatus] = useState<VerifierStatus | "">("APPLIED");
  const list = useLoad(
    () =>
      get<{ items: VerifierSummary[]; nextCursor: string | null }>(
        `/review/verifiers?limit=100${status ? `&status=${status}` : ""}`,
      ),
    [status],
  );
  return (
    <Card
      title="Verifier applications"
      actions={
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as VerifierStatus | "")}
        >
          <option value="">All</option>
          {VERIFIER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
      }
    >
      {!list.data ? (
        <Loading error={list.error} />
      ) : list.data.items.length === 0 ? (
        <p className="muted">No verifiers with this status.</p>
      ) : (
        <ul className="list">
          {list.data.items.map((v) => (
            <li key={v.id}>
              <Link to={`/admin/verifiers/${v.id}`}>
                <strong>{v.businessName ?? humanize(v.entityType)}</strong>
              </Link>{" "}
              <Badge value={v.status} />{" "}
              {v.identityStatus !== "VERIFIED" && (
                <Badge value="PENDING" label="Identity not verified" />
              )}
              <div className="muted small">
                <span className="mono">{shortAddress(v.walletAddress)}</span> ·{" "}
                {v.categories.map((c) => humanize(c.category)).join(", ") || "No categories"} ·
                applied {formatDate(v.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function VerifierReviewPage({ verifierId }: { verifierId: string }) {
  const { me } = useSession();
  const actor = reviewActor((me?.roles ?? []) as Role[]);
  const base = `/review/verifiers/${verifierId}`;
  const verifier = useLoad(() => get<ReviewVerifier>(base), [base]);
  const { busy, error, run } = useAction();
  const [reason, setReason] = useState("");
  if (!actor) return <p className="muted">This page is for administrators.</p>;
  const v = verifier.data;
  if (!v) return <Loading error={verifier.error} />;

  const change = (path: string, status: string, needsReason: boolean) =>
    void run(async () => {
      if (needsReason && !reason.trim())
        throw new Error("Enter a reason first; the verifier will see it");
      await post(path, { status, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setReason("");
      verifier.reload();
    });

  const statusActions = nextStatuses(VERIFIER_LIFECYCLE, v.status, actor);
  const verifierApproved = v.status === "APPROVED" || v.status === "SUSPENDED";
  return (
    <div>
      <p className="crumbs">
        <Link to="/admin">Verifier applications</Link> / {v.businessName ?? humanize(v.entityType)}
      </p>
      <div className="page-head">
        <h1>{v.businessName ?? humanize(v.entityType)}</h1>
        <Badge value={v.status} />
      </div>
      {v.identityStatus !== "VERIFIED" && (
        <div className="alert page-alert">
          Identity not verified. A verifier can be approved only after their identity check (KYC) is
          recorded by the server operator.
        </div>
      )}
      <div className="grid">
        <Card title="Applicant">
          <Facts
            rows={[
              ["Wallet", <span className="mono">{v.walletAddress}</span>],
              ["Type", humanize(v.entityType)],
              ["Business name", v.businessName ?? "—"],
              [
                "Website",
                v.website ? (
                  <a href={v.website} target="_blank" rel="noreferrer">
                    {v.website}
                  </a>
                ) : (
                  "—"
                ),
              ],
              ["Identity", humanize(v.identityStatus)],
              ["Applied", formatDateTime(v.createdAt)],
              ["Approved", formatDateTime(v.approvedAt)],
            ]}
          />
          {v.bio && <p className="small">{v.bio}</p>}
        </Card>
        <Card title="Decision">
          <Field label="Reason (required to reject, suspend or revoke; shown to the verifier)">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
          {statusActions.length > 0 ? (
            <div className="actions spaced">
              {statusActions.map((to) => (
                <button
                  key={to}
                  className={to === "APPROVED" || to === "UNDER_REVIEW" ? "" : "ghost"}
                  disabled={busy}
                  onClick={() =>
                    change(`${base}/status`, to, VERIFIER_STATUSES_REQUIRING_REASON.includes(to))
                  }
                >
                  {ACTION_LABELS[to] ?? humanize(to)}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">No further changes are possible.</p>
          )}
          <ErrorText error={error} />
        </Card>
      </div>
      <AiReport base={base} />
      <Card title="Categories">
        <p className="muted small">
          Approve the verifier first, then each category they may verify.
        </p>
        <ul className="list">
          {v.categories.map((c) => (
            <li key={c.id}>
              <strong>{humanize(c.category)}</strong> <Badge value={c.status} />
              {c.reason && <span className="muted small"> · {c.reason}</span>}
              <div className="actions spaced">
                {nextStatuses(CATEGORY_PERMISSION_LIFECYCLE, c.status, actor)
                  .filter((to) => to !== "APPROVED" || verifierApproved)
                  .map((to: CategoryPermissionStatus) => (
                    <button
                      key={to}
                      className={to === "APPROVED" ? "small" : "ghost small"}
                      disabled={busy}
                      onClick={() =>
                        change(
                          `${base}/categories/${c.category}`,
                          to,
                          PERMISSION_STATUSES_REQUIRING_REASON.includes(to),
                        )
                      }
                    >
                      {c.status === "PENDING" && to === "REVOKED"
                        ? "Refuse"
                        : (ACTION_LABELS[to] ?? humanize(to))}
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="History">
        <ul className="list compact">
          {v.history.map((h, i) => (
            <li key={i}>
              {formatDateTime(h.createdAt)} · {h.fromStatus ? humanize(h.fromStatus) : "New"} →{" "}
              {humanize(h.toStatus)}
              {h.reason && <span className="muted"> · {h.reason}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

const RECOMMENDATION_LABELS: Record<VerifierReports["items"][number]["recommendation"], string> = {
  APPROVE: "Suggests approval",
  REJECT: "Suggests rejection",
  NEEDS_MORE_INFORMATION: "Needs more information",
};

/** The latest AI report on the application. Advisory: the reviewer decides. */
function AiReport({ base }: { base: string }) {
  const reports = useLoad(() => get<VerifierReports>(`${base}/ai-reports`), [base]);
  const { busy, error, run } = useAction();
  const pending = reports.data?.pending;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => reports.reload(), 5000);
    return () => clearInterval(timer);
  }, [pending]);
  const data = reports.data;
  if (!data) return reports.error ? null : <Loading />;
  if (!data.available && data.items.length === 0) return null;
  const [latest] = data.items;
  return (
    <Card title="AI report (advisory)">
      <p className="muted small">
        Written by an AI model from the application and public web pages. It can be wrong: check
        credentials yourself. The applicant never sees it.
      </p>
      {latest ? (
        <>
          <p>
            <Badge
              value={latest.recommendation === "REJECT" ? "REJECTED" : "PENDING"}
              label={RECOMMENDATION_LABELS[latest.recommendation]}
            />{" "}
            <span className="muted small">
              {formatDateTime(latest.createdAt)} · {latest.model}
            </span>
          </p>
          <p className="small">{latest.summary}</p>
          <ReportList title="Strengths" items={latest.strengths} />
          <ReportList title="Concerns" items={latest.concerns} />
          <ReportList title="Ask or verify" items={latest.questions} />
          {latest.sources.length > 0 && (
            <ReportList
              title="Sources"
              items={latest.sources.map((url) => (
                <a href={url} target="_blank" rel="noreferrer noopener">
                  {url}
                </a>
              ))}
            />
          )}
        </>
      ) : (
        !data.pending && <p className="muted">No report yet.</p>
      )}
      {data.pending && <p className="muted small">Writing a report… this updates automatically.</p>}
      {data.lastError && <p className="error small">{data.lastError}</p>}
      {data.available && !data.pending && (
        <button
          className="ghost small"
          disabled={busy}
          onClick={() => void run(async () => (await post(`${base}/ai-reports`), reports.reload()))}
        >
          {latest ? "Write a new report" : "Write a report"}
        </button>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

function ReportList({ title, items }: { title: string; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <p className="small">
        <strong>{title}</strong>
      </p>
      <ul className="small">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

// ─── Templates ────────────────────────────────────────────────────────────────

function TemplatesTab() {
  const templates = useLoad(() => get<{ items: AdminTemplate[] }>("/admin/templates"), []);
  return (
    <>
      <Card title="Verification templates">
        <p className="muted small">
          A template says what a verifier must check for a category. Owners can request verification
          only against a published version. Published versions never change: to change the
          requirements, add a new version and publish it, which retires the old one.
        </p>
        {!templates.data ? (
          <Loading error={templates.error} />
        ) : templates.data.items.length === 0 ? (
          <p className="muted">No templates yet.</p>
        ) : (
          <ul className="list">
            {templates.data.items.map((t) => (
              <TemplateItem key={t.id} template={t} onChange={templates.reload} />
            ))}
          </ul>
        )}
      </Card>
      <NewTemplateForm onDone={templates.reload} />
    </>
  );
}

function TemplateItem({
  template: t,
  onChange,
}: {
  template: AdminTemplate;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const latest = t.versions.at(-1);
  return (
    <li>
      <strong>{t.name}</strong> <span className="mono small">{t.code}</span>{" "}
      <Badge value={t.category} label={humanize(t.category)} />
      {t.description && <p className="muted small">{t.description}</p>}
      {t.versions.length === 0 && <p className="muted small">No versions yet.</p>}
      {t.versions.map((v) => (
        <VersionItem key={v.id} version={v} onChange={onChange} />
      ))}
      {adding ? (
        <VersionForm
          templateId={t.id}
          initial={latest}
          onCancel={() => setAdding(false)}
          onDone={() => (setAdding(false), onChange())}
        />
      ) : (
        <button className="ghost small" onClick={() => setAdding(true)}>
          Add a version
        </button>
      )}
    </li>
  );
}

function VersionItem({
  version: v,
  onChange,
}: {
  version: AdminTemplateVersion;
  onChange: () => void;
}) {
  const { busy, error, run } = useAction();
  const setStatus = (status: "PUBLISHED" | "RETIRED", question: string) =>
    confirm(question) &&
    void run(async () => {
      await post(`/admin/template-versions/${v.id}/status`, { status });
      onChange();
    });
  return (
    <div className="card subcard">
      <div className="card-head">
        <span>
          Version {v.version} <Badge value={v.status} />
        </span>
        {v.status === "DRAFT" && (
          <button
            className="small"
            disabled={busy}
            onClick={() =>
              setStatus(
                "PUBLISHED",
                "Publish this version? It can't be changed afterwards, and it replaces the current published version.",
              )
            }
          >
            Publish
          </button>
        )}
        {v.status === "PUBLISHED" && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() =>
              setStatus(
                "RETIRED",
                "Retire this version? Open requests against it are cancelled and owners can no longer request it.",
              )
            }
          >
            Retire
          </button>
        )}
      </div>
      <Facts
        rows={[
          ["Claims", v.requiredClaims.map(humanize).join(", ")],
          [
            "Evidence",
            v.requiredEvidence.map((e) => `${humanize(e.type)} × ${e.minCount}`).join(", ") ||
              "None",
          ],
          ["Methods", v.allowedMethods.map(humanize).join(", ")],
          ["Verifiers per claim", v.minVerifiers],
          ["Valid for", `${v.validityMonths} months`],
          ["Published", formatDate(v.publishedAt)],
        ]}
      />
      <ErrorText error={error} />
    </div>
  );
}

function NewTemplateForm({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const empty = { code: "", category: "LUXURY_WATCH" as string, name: "", description: "" };
  const [form, setForm] = useState(empty);
  const set = (name: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [name]: e.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await post("/admin/templates", {
        code: form.code.trim(),
        category: form.category,
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      });
      setForm(empty);
      onDone();
    });
  };
  return (
    <Card title="New template">
      <form className="form" onSubmit={submit}>
        <div className="row">
          <Field label="Name">
            <input value={form.name} onChange={set("name")} placeholder="Luxury watch check" />
          </Field>
          <Field label="Code (lower-case letters, digits and '-'; can't be changed)">
            <input value={form.code} onChange={set("code")} placeholder="luxury-watch" />
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={set("category")}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description (shown to owners)">
          <textarea value={form.description} onChange={set("description")} rows={2} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={busy || !form.code.trim() || !form.name.trim()}>
          {busy ? "Creating…" : "Create template"}
        </button>
      </form>
    </Card>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function VersionForm({
  templateId,
  initial,
  onCancel,
  onDone,
}: {
  templateId: string;
  initial: AdminTemplateVersion | undefined;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [claims, setClaims] = useState<string[]>(initial?.requiredClaims ?? []);
  const [methods, setMethods] = useState<string[]>(initial?.allowedMethods ?? []);
  const [evidence, setEvidence] = useState<Record<string, number>>(
    Object.fromEntries((initial?.requiredEvidence ?? []).map((e) => [e.type, e.minCount])),
  );
  const [minVerifiers, setMinVerifiers] = useState(initial?.minVerifiers ?? 1);
  const [validityMonths, setValidityMonths] = useState(
    initial?.validityMonths ?? DEFAULT_TEMPLATE_VALIDITY_MONTHS,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await post(`/admin/templates/${templateId}/versions`, {
        requiredClaims: CLAIM_TYPES.filter((c) => claims.includes(c)),
        requiredEvidence: EVIDENCE_TYPES.filter((t) => (evidence[t] ?? 0) > 0).map((type) => ({
          type,
          minCount: evidence[type],
        })),
        allowedMethods: ATTESTATION_METHODS.filter((m) => methods.includes(m)),
        minVerifiers,
        validityMonths,
      });
      onDone();
    });
  };
  return (
    <form className="form card subcard" onSubmit={submit}>
      <strong>New draft version</strong>
      <fieldset>
        <legend>Claims the verifier must attest</legend>
        {CLAIM_TYPES.map((c) => (
          <label key={c} className="check">
            <input
              type="checkbox"
              checked={claims.includes(c)}
              onChange={() => setClaims(toggle(claims, c))}
            />
            {humanize(c)}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Evidence required (minimum number of files; 0 = not required)</legend>
        <div className="row">
          {EVIDENCE_TYPES.map((t) => (
            <Field key={t} label={humanize(t)}>
              <input
                type="number"
                min={0}
                max={20}
                value={evidence[t] ?? 0}
                onChange={(e) => setEvidence({ ...evidence, [t]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Allowed methods</legend>
        {ATTESTATION_METHODS.map((m) => (
          <label key={m} className="check">
            <input
              type="checkbox"
              checked={methods.includes(m)}
              onChange={() => setMethods(toggle(methods, m))}
            />
            {humanize(m)}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <Field label="Verifiers per claim">
          <input
            type="number"
            min={1}
            max={5}
            value={minVerifiers}
            onChange={(e) => setMinVerifiers(Number(e.target.value))}
          />
        </Field>
        <Field label={`Valid for (months, at most ${MAX_TEMPLATE_VALIDITY_MONTHS})`}>
          <input
            type="number"
            min={1}
            max={MAX_TEMPLATE_VALIDITY_MONTHS}
            value={validityMonths}
            onChange={(e) => setValidityMonths(Number(e.target.value))}
          />
        </Field>
      </div>
      <ErrorText error={error} />
      <div className="actions">
        <button type="submit" disabled={busy || claims.length === 0 || methods.length === 0}>
          {busy ? "Saving…" : "Save draft"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Roles ────────────────────────────────────────────────────────────────────

function RolesTab() {
  const roles = useLoad(
    () => get<{ items: RoleAssignment[] }>("/admin/roles?role=VERIFIER_REVIEWER"),
    [],
  );
  const { busy, error, run } = useAction();
  const [wallet, setWallet] = useState("");
  const grant = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await post("/admin/roles", { walletAddress: wallet.trim(), role: "VERIFIER_REVIEWER" });
      setWallet("");
      roles.reload();
    });
  };
  const revoke = (a: RoleAssignment) =>
    confirm(`Remove the verifier reviewer role from ${shortAddress(a.walletAddress)}?`) &&
    void run(async () => {
      await del(`/admin/roles/${a.id}`);
      roles.reload();
    });
  const active = roles.data?.items.filter((a) => a.revokedAt === null);
  return (
    <Card title="Verifier reviewers">
      <p className="muted small">
        Reviewers can approve or reject verifier applications. Only administrators manage templates
        and roles. Administrators are added by the server operator.
      </p>
      {!active ? (
        <Loading error={roles.error} />
      ) : active.length === 0 ? (
        <p className="muted">No reviewers.</p>
      ) : (
        <ul className="list">
          {active.map((a) => (
            <li key={a.id} className="actions">
              <span className="mono grow">{a.walletAddress}</span>
              <span className="muted small">since {formatDate(a.grantedAt)}</span>
              <button className="ghost small" disabled={busy} onClick={() => revoke(a)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="row spaced" onSubmit={grant}>
        <Field label="Wallet address">
          <input value={wallet} onChange={(e) => setWallet(e.target.value)} autoComplete="off" />
        </Field>
        <button type="submit" disabled={busy || !wallet.trim()}>
          Add reviewer
        </button>
      </form>
      <ErrorText error={error} />
    </Card>
  );
}

// ─── AI checks ────────────────────────────────────────────────────────────────

/** Every AI check with its detection details, which owners never see (ADR 0013). */
function ChecksTab() {
  const [result, setResult] = useState<AutomatedCheckResult | "">("FAILED");
  const [wbId, setWbId] = useState("");
  const [asset, setAsset] = useState("");
  const list = useLoad(
    () =>
      asset
        ? get<{ items: AdminCheck[] }>(
            `/admin/assets/${encodeURIComponent(asset)}/automated-checks`,
          )
        : get<{ items: AdminCheck[] }>(
            `/admin/automated-checks?limit=100${result ? `&result=${result}` : ""}`,
          ),
    [asset, result],
  );
  const items = list.data?.items.filter((c) => !asset || !result || c.result === result);
  const search = (event: FormEvent) => {
    event.preventDefault();
    setAsset(wbId.trim().toUpperCase());
  };
  return (
    <Card
      title="AI checks"
      actions={
        <select
          aria-label="Result"
          value={result}
          onChange={(e) => setResult(e.target.value as AutomatedCheckResult | "")}
        >
          <option value="">All results</option>
          {AUTOMATED_CHECK_RESULTS.map((r) => (
            <option key={r} value={r}>
              {humanize(r)}
            </option>
          ))}
        </select>
      }
    >
      <form className="row spaced" onSubmit={search}>
        <Field label="Asset (WB ID)">
          <input
            value={wbId}
            onChange={(e) => setWbId(e.target.value)}
            placeholder="WB-…"
            autoComplete="off"
          />
        </Field>
        <button type="submit" className="small">
          Show asset
        </button>
        {asset && (
          <button type="button" className="ghost small" onClick={() => (setAsset(""), setWbId(""))}>
            All assets
          </button>
        )}
      </form>
      {!items ? (
        <Loading error={list.error} />
      ) : items.length === 0 ? (
        <p className="muted">No checks.</p>
      ) : (
        <ul className="list">
          {items.map((c) => (
            <li key={c.id}>
              <div>
                <Badge value={c.result} /> <strong>{humanize(c.evidence.type)}</strong>{" "}
                <span className="muted small">{c.evidence.mimeType}</span>
                {c.evidence.reviewStatus !== "PENDING" && (
                  <>
                    {" "}
                    <Badge
                      value={c.evidence.reviewStatus}
                      label={`Verifier ${humanize(c.evidence.reviewStatus).toLowerCase()}`}
                    />
                  </>
                )}
              </div>
              {c.problems.length > 0 && (
                <div className="small error">
                  {c.problems.map((p) => CHECK_PROBLEM_MESSAGES[p]).join(" · ")}
                </div>
              )}
              <p className="small">{c.summary}</p>
              <div className="muted small">
                <button
                  type="button"
                  className="ghost small mono"
                  onClick={() => (setAsset(c.wbId), setWbId(c.wbId))}
                >
                  {c.wbId}
                </button>{" "}
                · {formatDateTime(c.createdAt)} · {c.engine} {c.model} · {c.checkVersion}
                {c.confidence !== null && ` · confidence ${Math.round(c.confidence * 100)}%`}
                {" · "}
                <span className="mono" title={c.sha256}>
                  {c.sha256.slice(0, 12)}…
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
