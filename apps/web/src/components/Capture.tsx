import { CAPTURE_SESSION_MINUTES } from "@worthybound/shared";
import { useEffect, useRef, useState } from "react";
import { get, post } from "../api.js";
import { formatDateTime, humanize } from "../format.js";
import type { CaptureSession, OwnerAsset } from "../types.js";
import { uploadEvidence } from "./Evidence.js";
import { Card, ErrorText, Loading, useAction, useLoad } from "./ui.js";

/** Minutes and seconds until `iso`, ticking every second. */
function useCountdown(iso: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  if (!iso) return null;
  const left = Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/**
 * The device camera. Photos come only from the live camera, never from the gallery, as guided
 * capture requires (ADR 0013).
 */
function Camera({
  label,
  busy,
  onPhoto,
}: {
  label: string;
  busy: boolean;
  onPhoto: (photo: Blob) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setError("This browser has no camera access. Open this page on your phone.");
      return;
    }
    let live = true;
    let stream: MediaStream | null = null;
    media
      .getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      })
      .then((s) => {
        stream = s;
        if (!live) return s.getTracks().forEach((t) => t.stop());
        if (video.current) video.current.srcObject = s;
        setReady(true);
      })
      .catch(() => live && setError("Allow camera access to take the photos, then reload."));
    return () => {
      live = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const snap = () => {
    const v = video.current;
    if (!v || v.videoWidth === 0) return setError("The camera is not ready yet; try again.");
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    canvas.toBlob(
      (photo) => (photo ? onPhoto(photo) : setError("The photo could not be taken.")),
      "image/jpeg",
      0.92,
    );
  };

  return (
    <div className="camera">
      <video ref={video} autoPlay playsInline muted aria-label="Camera" />
      <button disabled={!ready || busy} onClick={snap}>
        {busy ? "Uploading…" : label}
      </button>
      <ErrorText error={error} />
    </div>
  );
}

/** Guided capture on the asset page: a timed session of shots taken with the camera. */
export function GuidedCapture({
  base,
  asset: a,
  onChange,
}: {
  base: string;
  asset: OwnerAsset;
  onChange: () => void;
}) {
  const sessions = useLoad(
    () => get<{ items: CaptureSession[] }>(`${base}/capture-sessions`),
    [base],
  );
  const { busy, error, run } = useAction();
  const current = sessions.data?.items.find((s) => s.status === "OPEN") ?? null;
  const countdown = useCountdown(current?.expiresAt ?? null);
  const lastCompleted = sessions.data?.items.find((s) => s.status === "COMPLETED");
  useEffect(() => {
    if (countdown === "0:00") sessions.reload();
  }, [countdown]);

  if (a.status === "REVOKED") return null;
  if (!sessions.data) {
    return (
      <Card title="Guided capture">
        <Loading error={sessions.error} />
      </Card>
    );
  }

  const next = current?.shots.find((s) => s.evidenceId === null) ?? null;
  const take = (photo: Blob) =>
    void run(async () => {
      if (!current || !next) return;
      try {
        await uploadEvidence(`${base}/evidence/uploads`, photo, {
          type: "PHOTO",
          originalFilename: `${next.shot.toLowerCase()}.jpg`,
          captureSessionId: current.id,
          captureShot: next.shot,
        });
      } finally {
        sessions.reload();
        onChange();
      }
    });

  return (
    <Card title="Guided capture">
      {!current ? (
        <>
          <p className="small">
            Photos taken here, during a timed session, show that you have the item in front of you
            now. You get a code valid for {CAPTURE_SESSION_MINUTES} minutes: write it on paper, then
            take each shot with this page's camera; the last one shows the item next to the code.
            Photos from your gallery cannot be used. With AI checks on, each shot is checked,
            including that the code is visible.
          </p>
          {lastCompleted && (
            <p className="muted small">
              Last completed {formatDateTime(lastCompleted.completedAt)}.
            </p>
          )}
          {sessions.data.items[0]?.status === "EXPIRED" && (
            <p className="muted small">
              The last session expired before every shot was taken. Its photos stay in the evidence
              vault.
            </p>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => (await post(`${base}/capture-sessions`), sessions.reload()))
            }
          >
            Start guided capture
          </button>
        </>
      ) : (
        <>
          <p>
            Write this code on paper: <strong className="capture-code mono">{current.code}</strong>{" "}
            <span className="muted small">Expires in {countdown}</span>
          </p>
          <ol className="capture-shots small">
            {current.shots.map((s) => (
              <li key={s.shot} className={s.evidenceId ? "done" : ""}>
                <strong>{humanize(s.shot)}</strong>: {s.instruction}
                {s.evidenceId && " ✓"}
              </li>
            ))}
          </ol>
          {next && (
            <Camera label={`Take photo: ${humanize(next.shot)}`} busy={busy} onPhoto={take} />
          )}
        </>
      )}
      <ErrorText error={error ?? sessions.error} />
    </Card>
  );
}
