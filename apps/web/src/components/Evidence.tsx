import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  EVIDENCE_TYPES,
  PUBLIC_PHOTO_MIME_TYPES,
  type EvidenceMimeType,
} from "@worthybound/shared";
import { useState, type FormEvent } from "react";
import { post, putFile, sha256Hex, type PresignedUpload } from "../api.js";
import { formatBytes, formatDate, humanize } from "../format.js";
import type { OwnerEvidence } from "../types.js";
import { Badge, ErrorText, Field, useAction } from "./ui.js";

const isMime = (type: string): type is EvidenceMimeType =>
  (EVIDENCE_MIME_TYPES as readonly string[]).includes(type);

/**
 * Picks a file, hashes it in the browser, asks the API for an upload, sends the file straight to
 * storage and completes the upload. `requestPath` is the owner's or the verifier's upload endpoint.
 */
export function UploadForm({
  requestPath,
  types = EVIDENCE_TYPES,
  allowPublic,
  onDone,
}: {
  requestPath: string;
  types?: readonly string[];
  allowPublic: boolean;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<string>(types[0] ?? "PHOTO");
  const [visibility, setVisibility] = useState("PRIVATE");
  const [description, setDescription] = useState("");
  const [step, setStep] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    void run(async () => {
      if (!isMime(file.type))
        throw new Error(`Files of type ${file.type || "unknown"} are not accepted`);
      if (file.size > EVIDENCE_MAX_BYTES[file.type])
        throw new Error("This file is too large for its type");
      setStep("Hashing…");
      const sha256 = await sha256Hex(file);
      setStep("Uploading…");
      const { uploadId, upload } = await post<{ uploadId: string; upload: PresignedUpload }>(
        requestPath,
        {
          type,
          sha256,
          mimeType: file.type,
          sizeBytes: file.size,
          originalFilename: file.name,
          ...(allowPublic ? { visibility } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      );
      await putFile(upload, file);
      setStep("Checking…");
      await post(`/evidence/uploads/${uploadId}/complete`);
      setFile(null);
      setDescription("");
      (event.target as HTMLFormElement).reset();
      onDone();
    }).finally(() => setStep(""));
  };

  const canBePublic =
    allowPublic &&
    file !== null &&
    (PUBLIC_PHOTO_MIME_TYPES as readonly string[]).includes(file.type);
  return (
    <form className="form upload" onSubmit={submit}>
      <div className="row">
        <Field label="File">
          <input
            type="file"
            accept={EVIDENCE_MIME_TYPES.join(",")}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {canBePublic && (
        <label className="check">
          <input
            type="checkbox"
            checked={visibility === "PUBLIC"}
            onChange={(e) => setVisibility(e.target.checked ? "PUBLIC" : "PRIVATE")}
          />
          Show this photo on the public passport (metadata is removed)
        </label>
      )}
      <ErrorText error={error} />
      <button type="submit" disabled={busy || !file}>
        {busy ? step || "Working…" : "Add evidence"}
      </button>
    </form>
  );
}

export function EvidenceList({
  items,
  downloadPath,
  onVisibility,
  onReview,
}: {
  items: OwnerEvidence[];
  downloadPath: (id: string) => string;
  onVisibility?: (item: OwnerEvidence) => Promise<void>;
  onReview?: (item: OwnerEvidence, status: "ACCEPTED" | "REJECTED") => Promise<void>;
}) {
  const { error, run } = useAction();
  const open = (id: string) =>
    run(async () => {
      const { url } = await post<{ url: string }>(downloadPath(id));
      window.open(url, "_blank", "noopener");
    });
  if (items.length === 0) return <p className="muted">No evidence yet.</p>;
  return (
    <>
      <ErrorText error={error} />
      <ul className="list">
        {items.map((e) => (
          <li key={e.id} className="evidence-row">
            {e.publicPath ? (
              <img className="thumb" src={e.publicPath} alt="" />
            ) : (
              <span className="thumb file">{e.mimeType.split("/")[1]?.toUpperCase()}</span>
            )}
            <div className="grow">
              <div>
                <strong>{humanize(e.type)}</strong> <Badge value={e.visibility} />{" "}
                <Badge value={e.reviewStatus} />
                {e.source === "VERIFIER" && <Badge value="VERIFIER" label="From verifier" />}
              </div>
              <div className="muted small">
                {e.originalFilename ?? e.id} · {formatBytes(e.sizeBytes)} ·{" "}
                {formatDate(e.createdAt)}
                {e.reviewReason && ` · ${e.reviewReason}`}
              </div>
              <div className="mono tiny">sha256 {e.sha256.slice(0, 24)}…</div>
            </div>
            <div className="actions">
              <button className="ghost small" onClick={() => void open(e.id)}>
                Open
              </button>
              {onVisibility &&
                (PUBLIC_PHOTO_MIME_TYPES as readonly string[]).includes(e.mimeType) && (
                  <button className="ghost small" onClick={() => void run(() => onVisibility(e))}>
                    Make {e.visibility === "PUBLIC" ? "private" : "public"}
                  </button>
                )}
              {onReview && e.reviewStatus === "PENDING" && (
                <>
                  <button
                    className="ghost small"
                    onClick={() => void run(() => onReview(e, "ACCEPTED"))}
                  >
                    Accept
                  </button>
                  <button
                    className="ghost small danger"
                    onClick={() => void run(() => onReview(e, "REJECTED"))}
                  >
                    Reject
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
