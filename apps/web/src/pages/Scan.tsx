import { isWbId, wbIdFromScan } from "@worthybound/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card, ErrorText } from "../components/ui.js";
import { useRouter } from "../router.js";

/** The browser's built-in QR decoder (Chrome, Edge and Android); not in every browser. */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

const detectorClass = (): BarcodeDetectorConstructor | undefined =>
  (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;

/**
 * Scans a passport QR code with the camera and opens the passport. Only WorthyBound passport
 * links on this site are opened; any other code is refused, so a fake sticker cannot send the
 * buyer to another website.
 */
export function ScanPage() {
  const { navigate } = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [wbId, setWbId] = useState("");
  const Detector = detectorClass();

  useEffect(() => {
    if (!Detector) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setError("This browser has no camera access. Enter the WB ID instead.");
      return;
    }
    const detector = new Detector({ formats: ["qr_code"] });
    let live = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
      const v = video.current;
      if (!live) return;
      if (v && v.readyState >= 2) {
        const codes = await detector.detect(v).catch(() => []);
        for (const code of codes) {
          const id = wbIdFromScan(code.rawValue, [window.location.origin]);
          if (id) {
            live = false;
            return navigate(`/passport/${id}`);
          }
          setRefused(true);
        }
      }
      timer = setTimeout(() => void scan(), 250);
    };
    media
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        if (!live) return s.getTracks().forEach((t) => t.stop());
        if (video.current) video.current.srcObject = s;
        void scan();
      })
      .catch(() => live && setError("Allow camera access to scan, or enter the WB ID instead."));
    return () => {
      live = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const lookUp = (event: FormEvent) => {
    event.preventDefault();
    const id = wbId.trim().toUpperCase();
    if (!isWbId(id)) return setError("A WB ID looks like WB-7F93A281.");
    navigate(`/passport/${id}`);
  };

  return (
    <div className="narrow">
      <h1>Scan a passport QR code</h1>
      <Card>
        {Detector ? (
          <>
            <div className="camera">
              <video ref={video} autoPlay playsInline muted />
            </div>
            <p className="muted small">
              Point the camera at the QR code on the item's papers or tag.
            </p>
          </>
        ) : (
          <p className="small">
            This browser cannot scan QR codes. Use your phone's camera app, or enter the WB ID
            below.
          </p>
        )}
        {refused && (
          <p className="error" role="alert">
            This QR code is not a WorthyBound passport, so it was not opened.
          </p>
        )}
        <p className="muted small">
          A QR code only opens the passport; it can be copied, so it does not prove that an item is
          the one registered. Before buying, start a check from the passport.
        </p>
        <form className="lookup" onSubmit={lookUp}>
          <input
            aria-label="WB ID"
            placeholder="WB-7F93A281"
            value={wbId}
            onChange={(e) => setWbId(e.target.value)}
          />
          <button type="submit">Check</button>
        </form>
        <ErrorText error={error} />
      </Card>
    </div>
  );
}
