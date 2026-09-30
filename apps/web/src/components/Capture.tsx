import {
  CAPTURE_SESSION_MINUTES,
  CAPTURE_VIDEO_MAX_BYTES,
  CAPTURE_VIDEO_SHOT,
} from "@worthybound/shared";
import { useEffect, useRef, useState, type RefObject } from "react";
import { get, post } from "../api.js";
import { formatDateTime, humanize } from "../format.js";
import type { CaptureSession, OwnerAsset } from "../types.js";
import { uploadEvidence } from "./Evidence.js";
import { Card, ErrorText, Loading, useAction, useLoad } from "./ui.js";

/** Minutes and seconds until `iso`, ticking every second. */
export function useCountdown(iso: string | null): string | null {
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

/** The back camera's live stream, shown in `video`; stopped when the component unmounts. */
function useCameraStream(video: RefObject<HTMLVideoElement | null>) {
  const [stream, setStream] = useState<MediaStream | null>(null);
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
        setStream(s);
      })
      .catch(() => live && setError("Allow camera access to take the photos, then reload."));
    return () => {
      live = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return { stream, error, setError };
}

/**
 * The device camera. Photos come only from the live camera, never from the gallery, as guided
 * capture requires (ADR 0013).
 */
export function Camera({
  label,
  busy,
  onPhoto,
}: {
  label: string;
  busy: boolean;
  onPhoto: (photo: Blob) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { stream, error, setError } = useCameraStream(video);
  const ready = stream !== null;

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

/** Longest video recorded for the video shot. */
export const VIDEO_MAX_SECONDS = 60;
/** Recording bitrate; a full-length video stays well under the size limit. */
const VIDEO_BITS_PER_SECOND = 4_000_000;
/** Recording formats the Evidence Vault accepts, in order of preference. */
const VIDEO_FORMATS = ["video/mp4;codecs=avc1", "video/mp4"];

/**
 * Records a video from the live camera, never from the gallery, as MP4 and without sound, for at
 * most `VIDEO_MAX_SECONDS`.
 */
export function VideoRecorder({
  busy,
  onVideo,
}: {
  busy: boolean;
  onVideo: (video: Blob) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { stream, error, setError } = useCameraStream(video);
  const recorder = useRef<MediaRecorder | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const format =
    typeof MediaRecorder === "undefined"
      ? undefined
      : VIDEO_FORMATS.find((f) => MediaRecorder.isTypeSupported(f));

  useEffect(() => {
    if (seconds === null) return;
    if (seconds >= VIDEO_MAX_SECONDS) return recorder.current?.stop();
    const timer = setTimeout(() => setSeconds(seconds + 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  useEffect(
    () => () => {
      const r = recorder.current;
      if (!r) return;
      r.onstop = null;
      r.stop();
    },
    [],
  );

  const start = () => {
    if (!stream || !format) return;
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream, {
      mimeType: format,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    r.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
    r.onstop = () => {
      recorder.current = null;
      setSeconds(null);
      const clip = new Blob(chunks, { type: "video/mp4" });
      if (clip.size === 0) return setError("The video could not be recorded.");
      if (clip.size > CAPTURE_VIDEO_MAX_BYTES) {
        return setError("The video is too large; record a shorter one.");
      }
      onVideo(clip);
    };
    r.start(1000);
    recorder.current = r;
    setSeconds(0);
  };

  const elapsed = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  return (
    <div className="camera">
      <video ref={video} autoPlay playsInline muted aria-label="Camera" />
      {seconds === null ? (
        <button disabled={!stream || !format || busy} onClick={start}>
          {busy ? "Uploading…" : "Start recording"}
        </button>
      ) : (
        <button onClick={() => recorder.current?.stop()}>
          Stop and upload ({elapsed(seconds)} / {elapsed(VIDEO_MAX_SECONDS)})
        </button>
      )}
      {stream && !format && (
        <ErrorText error="This browser cannot record MP4 video. Use Safari, or Chrome on your phone." />
      )}
      <ErrorText error={error} />
    </div>
  );
}

/**
 * The shots of an open capture session: each taken in turn from the camera, photos then, for a
 * remote check, the video; uploaded to the Evidence Vault with the session.
 */
export function SessionShots({
  base,
  session,
  onChange,
}: {
  base: string;
  session: CaptureSession;
  onChange: () => void;
}) {
  const { busy, error, run } = useAction();
  const next = session.shots.find((s) => s.evidenceId === null) ?? null;
  const send = (file: Blob, type: "PHOTO" | "VIDEO", extension: string) =>
    void run(async () => {
      if (!next) return;
      try {
        await uploadEvidence(`${base}/evidence/uploads`, file, {
          type,
          originalFilename: `${next.shot.toLowerCase()}.${extension}`,
          captureSessionId: session.id,
          captureShot: next.shot,
        });
      } finally {
        onChange();
      }
    });
  return (
    <>
      <ol className="capture-shots small">
        {session.shots.map((s) => (
          <li key={s.shot} className={s.evidenceId ? "done" : ""}>
            <strong>{humanize(s.shot)}</strong>: {s.instruction}
            {s.evidenceId && " ✓"}
          </li>
        ))}
      </ol>
      {next &&
        (next.shot === CAPTURE_VIDEO_SHOT ? (
          <VideoRecorder busy={busy} onVideo={(clip) => send(clip, "VIDEO", "mp4")} />
        ) : (
          <Camera
            label={`Take photo: ${humanize(next.shot)}`}
            busy={busy}
            onPhoto={(photo) => send(photo, "PHOTO", "jpg")}
          />
        ))}
      <ErrorText error={error} />
    </>
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

  return (
    <Card title="Guided capture">
      {!current ? (
        <>
          <p className="small">
            Photos taken here, during a timed session, show that you have the item in front of you
            now. You get a code valid for {CAPTURE_SESSION_MINUTES} minutes: write it on paper, then
            take each shot with this page's camera; the last one shows the item next to the code.
            Photos from your gallery cannot be used. Each shot is checked by AI, including that the
            code is visible.
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
          <SessionShots
            base={base}
            session={current}
            onChange={() => (sessions.reload(), onChange())}
          />
        </>
      )}
      <ErrorText error={error ?? sessions.error} />
    </Card>
  );
}
