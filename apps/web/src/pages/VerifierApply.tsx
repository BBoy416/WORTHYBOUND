import { ASSET_CATEGORIES, VERIFIER_ENTITY_TYPES } from "@worthybound/shared";
import { useState, type FormEvent } from "react";
import { ApiError, get, post } from "../api.js";
import { Badge, Card, ErrorText, Field, Loading, useAction, useLoad } from "../components/ui.js";
import { formatDate, formatDateTime, humanize } from "../format.js";
import type { ApplicantVerifier } from "../types.js";

/** Apply to become a verifier, or follow an application. */
export function VerifierApplyPage() {
  const mine = useLoad(
    () =>
      get<ApplicantVerifier>("/verifier/me").catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }),
    [],
  );
  if (mine.data === undefined) return <Loading error={mine.error} />;
  const v = mine.data;
  const canApply =
    v === null ||
    (v.status === "REJECTED" &&
      v.canApplyAgainAt !== null &&
      new Date(v.canApplyAgainAt) <= new Date());
  return (
    <div className="narrow">
      <h1>Become a verifier</h1>
      {v && (
        <Card title="Your application" actions={<Badge value={v.status} />}>
          {v.identityRequired && (
            <p className="small">
              Your identity has not been verified yet. It must be verified before your application
              can be approved.
            </p>
          )}
          {v.status === "REJECTED" && v.canApplyAgainAt && (
            <p className="small">You can apply again from {formatDate(v.canApplyAgainAt)}.</p>
          )}
          <ul className="list compact">
            {v.categories.map((c) => (
              <li key={`${c.category}-${c.createdAt}`}>
                {humanize(c.category)} <Badge value={c.status} />
                {c.reason && <span className="muted"> · {c.reason}</span>}
              </li>
            ))}
          </ul>
          <ul className="list compact">
            {v.history.map((h, i) => (
              <li key={i} className="muted">
                {formatDateTime(h.createdAt)} · {humanize(h.toStatus)}
                {h.reason && ` · ${h.reason}`}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {canApply && <ApplicationForm onDone={mine.reload} />}
    </div>
  );
}

function ApplicationForm({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [form, setForm] = useState({
    entityType: "INDIVIDUAL" as string,
    businessName: "",
    website: "",
    bio: "",
  });
  const [categories, setCategories] = useState<string[]>([]);
  const set = (name: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [name]: e.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const text = Object.fromEntries(
        Object.entries(form)
          .filter(([k, v]) => k !== "entityType" && v.trim() !== "")
          .map(([k, v]) => [k, v.trim()]),
      );
      await post("/verifier/application", {
        entityType: form.entityType,
        ...text,
        categories: ASSET_CATEGORIES.filter((c) => categories.includes(c)),
      });
      onDone();
    });
  };
  return (
    <Card title="Apply">
      <p className="muted small">
        Verifiers check items for owners and sign what they found. An administrator reviews each
        application and approves it one category at a time. Individuals are not named publicly;
        organisations are. To help the review, your application may be summarised by an AI model
        (OpenAI), which may look up the business name and website you give; it does not decide.
      </p>
      <form className="form" onSubmit={submit}>
        <Field label="You are">
          <select value={form.entityType} onChange={set("entityType")}>
            {VERIFIER_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </Field>
        {form.entityType !== "INDIVIDUAL" && (
          <Field label="Business name (shown publicly)">
            <input value={form.businessName} onChange={set("businessName")} />
          </Field>
        )}
        <Field label="Website (https)">
          <input value={form.website} onChange={set("website")} placeholder="https://" />
        </Field>
        <Field label="Experience and qualifications">
          <textarea value={form.bio} onChange={set("bio")} rows={4} />
        </Field>
        <fieldset>
          <legend>Categories you want to verify</legend>
          {ASSET_CATEGORIES.map((c) => (
            <label key={c} className="check">
              <input
                type="checkbox"
                checked={categories.includes(c)}
                onChange={() =>
                  setCategories(
                    categories.includes(c) ? categories.filter((x) => x !== c) : [...categories, c],
                  )
                }
              />
              {humanize(c)}
            </label>
          ))}
        </fieldset>
        <ErrorText error={error} />
        <button type="submit" disabled={busy || categories.length === 0}>
          {busy ? "Sending…" : "Send application"}
        </button>
      </form>
    </Card>
  );
}
