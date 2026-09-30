import {
  canBePublic,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  EVIDENCE_TYPES,
  hasPreview,
  type EvidenceMimeType,
  type EvidenceType,
} from "@worthybound/shared";
import { useState, type FormEvent } from "react";
import { post, putFile, sha256Hex, type PresignedUpload } from "../api.js";
import { formatBytes, formatDate, humanize } from "../format.js";
import type { OwnerEvidence } from "../types.js";
import { Badge, ErrorText, Field, useAction } from "./ui.js";

const isMime = (type: string): type is EvidenceMimeType =>
  (EVIDENCE_MIME_TYPES as readonly string[]).includes(type);

/**
 * Picks files, hashes each in the browser, asks the API for an upload, sends the file straight to
 * storage and completes the upload. `requestPath` is the owner's or the verifier's upload endpoint.
 */
export function UploadForm({
  requestPath,
  types = EVIDENCE_TYPES,
  allowPublic,
  multiple = false,
  submitLabel = "Add evidence",
  onDone,
}: {
  requestPath: string;
  types?: readonly string[];
  allowPublic: boolean;
  multiple?: boolean;
  submitLabel?: string;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [type, setType] = useState<string>(types[0] ?? "PHOTO");
  const [visibility, setVisibility] = useState("PRIVATE");
  const [description, setDescription] = useState("");
  const [step, setStep] = useState("");

  const publicAllowed =
    allowPublic &&
    files.length > 0 &&
    files.every((f) => canBePublic(type as EvidenceType, f.type));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (files.length === 0) return;
    const form = event.target as HTMLFormElement;
    void run(async () => {
      for (const file of files) {
        if (!isMime(file.type))
          throw new Error(`${file.name}: files of type ${file.type || "unknown"} are not accepted`);
        if (file.size > EVIDENCE_MAX_BYTES[file.type])
          throw new Error(`${file.name}: this file is too large for its type`);
      }
      let done = 0;
      try {
        for (const file of files) {
          const of = files.length > 1 ? ` ${done + 1} of ${files.length}` : "";
          setStep(`Hashing${of}…`);
          const sha256 = await sha256Hex(file);
          setStep(`Uploading${of}…`);
          const { uploadId, upload } = await post<{ uploadId: string; upload: PresignedUpload }>(
            requestPath,
            {
              type,
              sha256,
              mimeType: file.type,
              sizeBytes: file.size,
              originalFilename: file.name,
              ...(publicAllowed ? { visibility } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
            },
          );
          await putFile(upload, file);
          setStep(`Checking${of}…`);
          await post(`/evidence/uploads/${uploadId}/complete`);
          done++;
        }
        setFiles([]);
        setDescription("");
        form.reset();
      } finally {
        if (done > 0) onDone();
      }
    }).finally(() => setStep(""));
  };

  return (
    <form className="form upload" onSubmit={submit}>
      <div className="row">
        <Field label={multiple ? "Files" : "File"}>
          <input
            type="file"
            multiple={multiple}
            accept={EVIDENCE_MIME_TYPES.join(",")}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
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
      {publicAllowed && (
        <label className="check">
          <input
            type="checkbox"
            checked={visibility === "PUBLIC"}
            onChange={(e) => setVisibility(e.target.checked ? "PUBLIC" : "PRIVATE")}
          />
          {files.length > 1 ? "Show these photos" : "Show this photo"} on the public passport
          (metadata is removed)
        </label>
      )}
      <ErrorText error={error} />
      <button type="submit" disabled={busy || files.length === 0}>
        {busy ? step || "Working…" : submitLabel}
      </button>
    </form>
  );
}

export function EvidenceList({
  items,
  downloadPath,
  previewPath,
  onVisibility,
  onReview,
}: {
  items: OwnerEvidence[];
  downloadPath: (id: string) => string;
  /** Private previews of JPEG, PNG and WebP files. */
  previewPath?: (id: string) => string;
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
            {previewPath && hasPreview(e.mimeType) ? (
              <img className="thumb" src={previewPath(e.id)} alt="" loading="lazy" />
            ) : e.publicPath ? (
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
              {onVisibility && canBePublic(e.type, e.mimeType) && (
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
