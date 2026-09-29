import { ASSET_CATEGORIES, ITEM_CONDITIONS } from "@worthybound/shared";
import { useState, type FormEvent } from "react";
import { post } from "../api.js";
import { Card, ErrorText, Field, useAction } from "../components/ui.js";
import { humanize } from "../format.js";
import { useRouter } from "../router.js";
import type { OwnerAsset } from "../types.js";

export function NewAssetPage() {
  const { navigate } = useRouter();
  const { busy, error, run } = useAction();
  const [key] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({
    category: "LUXURY_WATCH" as string,
    brand: "",
    model: "",
    serialNumber: "",
    publicDescription: "",
    description: "",
    condition: "",
  });
  const set = (name: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [name]: e.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ""));
      const asset = await post<OwnerAsset>("/assets", body, { "idempotency-key": key });
      navigate(`/assets/${asset.wbId}`);
    });
  };

  return (
    <div className="narrow">
      <h1>Register an asset</h1>
      <Card>
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
          <ErrorText error={error} />
          <button type="submit" disabled={busy}>
            {busy ? "Registering…" : "Register as draft"}
          </button>
        </form>
      </Card>
    </div>
  );
}
