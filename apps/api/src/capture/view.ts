import type { CaptureSession, Evidence } from "@worthybound/database";
import {
  CAPTURE_SESSION_STATUSES,
  CAPTURE_SHOT_INSTRUCTIONS,
  CAPTURE_SHOTS,
  type CaptureShot,
} from "@worthybound/shared";
import { z } from "zod";

export type SessionRecord = CaptureSession & {
  evidence: Pick<Evidence, "id" | "captureShot" | "createdAt">[];
};

/** The owner's view of a capture session. */
export const captureSessionSchema = z.object({
  id: z.uuid(),
  /** Write this on paper and photograph it next to the item. */
  code: z.string(),
  status: z.enum(CAPTURE_SESSION_STATUSES),
  shots: z.array(
    z.object({
      shot: z.enum(CAPTURE_SHOTS),
      instruction: z.string(),
      /** The photo taken for the shot, once it arrived. */
      evidenceId: z.uuid().nullable(),
      receivedAt: z.iso.datetime().nullable(),
    }),
  ),
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CaptureSessionView = z.infer<typeof captureSessionSchema>;

export function toCaptureSession(session: SessionRecord, at: Date): CaptureSessionView {
  const taken = new Map(session.evidence.map((e) => [e.captureShot, e]));
  return {
    id: session.id,
    code: session.code,
    // A session past its expiry is shown as expired before it is recorded as such.
    status: session.status === "OPEN" && session.expiresAt <= at ? "EXPIRED" : session.status,
    shots: (session.shots as CaptureShot[]).map((shot) => {
      const photo = taken.get(shot);
      return {
        shot,
        instruction: CAPTURE_SHOT_INSTRUCTIONS[shot],
        evidenceId: photo?.id ?? null,
        receivedAt: photo?.createdAt.toISOString() ?? null,
      };
    }),
    expiresAt: session.expiresAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
  };
}
