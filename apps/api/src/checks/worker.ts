import { createHash } from "node:crypto";
import {
  type CheckEngine,
  CheckEngineError,
  type CheckFileMimeType,
  CHECK_VERSION,
  type EvidenceCheckOutcome,
  imageEditorIn,
  ITEM_MATCH_VERSION,
  normalizeDocumentNumber,
  type PdfMetadata,
  readPdfMetadata,
  REPORT_VERSION,
  type VerifierApplicationInput,
} from "@worthybound/automated-checks";
import type { Asset, AutomatedJob, Evidence, PrismaClient } from "@worthybound/database";
import {
  CAPTURE_CODE_SHOT,
  CAPTURE_SHOT_INSTRUCTIONS,
  type CaptureShot,
  type CheckProblem,
} from "@worthybound/shared";
import type { Storage } from "@worthybound/storage";
import { canonicalJson, sha256Hex } from "@worthybound/trust-engine";
import type { FastifyBaseLogger } from "fastify";
import { writeAudit } from "../audit.js";
import { checkImage, perceptualHash, readAll } from "../evidence/inspect.js";
import { recordInconclusive, referencePhotos } from "../purchase-checks/service.js";
import { recordTrust } from "../trust/record.js";
import { checksAllowed, isCheckedEvidence } from "./queue.js";

export interface AutomatedChecksOptions {
  prisma: PrismaClient;
  storage: Storage;
  engine: CheckEngine;
  now: () => Date;
  log: FastifyBaseLogger;
}

export interface AutomatedChecks {
  engine: CheckEngine;
  /** Processes due jobs once, oldest first; returns how many were attempted. */
  runOnce(): Promise<number>;
  /** Runs `runOnce` every `intervalMs` until stopped. */
  start(intervalMs?: number): void;
  /** Runs soon once started, e.g. after checks were queued. */
  kick(): void;
  stop(): Promise<void>;
}

/** Jobs that keep failing are retried with growing delays, then left FAILED. */
export const MAX_CHECK_ATTEMPTS = 3;
const retryDelayMs = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 10 * 60_000);

/** A job that cannot run, e.g. its evidence is no longer eligible. Not retried. */
class Skipped extends Error {}

/** Engine of the checks that compare files and records instead of asking a model. */
const DETERMINISTIC_ENGINE = "worthybound";
/** Rules of the deterministic checks, stored as the model of their results. */
const RULES = {
  /** Same SHA-256 as a file on another asset (ADR 0010). */
  exactDuplicate: "exact-duplicate-v1",
  /** Perceptual hash within SIMILAR_PHOTO_MAX_DISTANCE of an earlier photo on another asset. */
  similarPhoto: "perceptual-hash-v1",
  /** A PDF receipt whose metadata names an image editor. */
  pdfImageEditor: "pdf-metadata-v1",
} as const;

/** Photos whose perceptual hashes differ in at most this many of 64 bits are near-identical. */
export const SIMILAR_PHOTO_MAX_DISTANCE = 6;

type Outcome = Omit<EvidenceCheckOutcome, "confidence" | "documentNumber"> & {
  confidence: number | null;
  engine: string;
  documentNumberHash: string | null;
};

const deterministic = (problem: CheckProblem, summary: string, model: string): Outcome => ({
  result: "FAILED",
  problems: [problem],
  summary,
  confidence: null,
  model,
  engine: DETERMINISTIC_ENGINE,
  documentNumberHash: null,
});

/** PDF metadata in one line for administrators. */
function describePdf(m: PdfMetadata): string {
  const parts = [
    m.producer && `producer "${m.producer}"`,
    m.creator && `creator "${m.creator}"`,
    m.createdAt && `created ${m.createdAt}`,
    m.modifiedAt && `modified ${m.modifiedAt}`,
    m.incrementalUpdates > 0 && `saved again ${m.incrementalUpdates} time(s)`,
    m.historyAgents.length > 0 && `edit history: ${m.historyAgents.join(", ")}`,
  ].filter(Boolean);
  return `PDF metadata: ${parts.length > 0 ? parts.join("; ") : "none"}.`;
}

/**
 * Runs queued AI checks of owner evidence, reports on verifier applications (ADR 0013) and
 * comparisons of a buyer's photos with an item's recorded photos (ADR 0014). Results are stored
 * append-only; each evidence result recomputes the asset's Trust Score. A report never changes
 * the application: reviewers decide. One worker per database, like chain sync.
 */
export function createAutomatedChecks(options: AutomatedChecksOptions): AutomatedChecks {
  const { prisma, storage, engine, now, log } = options;
  let running: Promise<number> | null = null;
  let timer: NodeJS.Timeout | null = null;

  /**
   * An earlier photo on another asset whose perceptual hash is within the distance. "Earlier"
   * means created before, ties broken by ID, so of two copies only the later one fails.
   */
  async function similarPhoto(evidence: Evidence, fingerprint: bigint) {
    const [match] = await prisma.$queryRaw<{ id: string; wbId: string; distance: number }[]>`
      SELECT e."id", a."wbId",
        bit_count((e."perceptualHash" # ${fingerprint}::bigint)::bit(64))::int AS "distance"
      FROM "evidence" e JOIN "assets" a ON a."id" = e."assetId"
      WHERE e."perceptualHash" IS NOT NULL
        AND e."assetId" <> ${evidence.assetId}::uuid
        AND (e."createdAt", e."id") < (${evidence.createdAt}, ${evidence.id}::uuid)
        AND bit_count((e."perceptualHash" # ${fingerprint}::bigint)::bit(64)) <= ${SIMILAR_PHOTO_MAX_DISTANCE}
      ORDER BY "distance", e."createdAt", e."id"
      LIMIT 1`;
    return match ?? null;
  }

  /**
   * Deterministic checks first (near-identical photos, PDF receipts from image editors), then
   * the check engine; its document number is compared with earlier files on other assets.
   */
  async function examine(
    evidence: Evidence & { asset: Asset; captureSession: { code: string } | null },
  ): Promise<Outcome> {
    const stored = await readAll(await storage.read(evidence.storageKey));
    if (createHash("sha256").update(stored).digest("hex") !== evidence.sha256) {
      log.warn({ evidenceId: evidence.id }, "stored evidence does not match its hash");
      throw new Skipped("hash_mismatch");
    }
    const image = evidence.mimeType !== "application/pdf";
    let pdfMetadata: PdfMetadata | null = null;
    if (image) {
      // Files uploaded before fingerprinting get one when they are first checked.
      let fingerprint = evidence.perceptualHash;
      if (fingerprint === null) {
        fingerprint = await perceptualHash(stored);
        if (fingerprint !== null) {
          await prisma.evidence.update({
            where: { id: evidence.id },
            data: { perceptualHash: fingerprint },
          });
        }
      }
      const similar = fingerprint === null ? null : await similarPhoto(evidence, fingerprint);
      if (similar) {
        return deterministic(
          "SIMILAR_PHOTO",
          `Near-identical to evidence ${similar.id} on ${similar.wbId} ` +
            `(${similar.distance} of 64 fingerprint bits differ).`,
          RULES.similarPhoto,
        );
      }
    } else {
      pdfMetadata = readPdfMetadata(stored);
      const editor = imageEditorIn(pdfMetadata);
      if (editor && evidence.type === "RECEIPT") {
        return deterministic(
          "DOCUMENT_TAMPERING",
          `The receipt's metadata names an image editor (${editor}). ${describePdf(pdfMetadata)}`,
          RULES.pdfImageEditor,
        );
      }
    }

    const data = image
      ? await checkImage(stored).catch(() => {
          throw new Skipped("image_unreadable");
        })
      : stored;
    const { documentNumber, ...found } = await engine.checkEvidence({
      asset: {
        category: evidence.asset.category,
        brand: evidence.asset.brand,
        model: evidence.asset.model,
        condition: evidence.asset.condition,
      },
      evidence: { type: evidence.type, description: evidence.description },
      capture:
        evidence.captureSession && evidence.captureShot
          ? {
              shot: evidence.captureShot as CaptureShot,
              instruction: CAPTURE_SHOT_INSTRUCTIONS[evidence.captureShot as CaptureShot],
              code:
                evidence.captureShot === CAPTURE_CODE_SHOT ? evidence.captureSession.code : null,
            }
          : null,
      file: {
        mimeType: (image ? "image/jpeg" : "application/pdf") as CheckFileMimeType,
        data,
        filename: image ? `${evidence.id}.jpg` : `${evidence.id}.pdf`,
      },
      pdfMetadata,
    });
    const number = normalizeDocumentNumber(documentNumber);
    const outcome: Outcome = {
      ...found,
      summary: pdfMetadata ? `${found.summary} ${describePdf(pdfMetadata)}` : found.summary,
      engine: engine.id,
      documentNumberHash: number ? sha256Hex(`document-number:${number}`) : null,
    };
    if (!outcome.documentNumberHash) return outcome;
    const reused = await prisma.automatedCheck.findFirst({
      where: {
        documentNumberHash: outcome.documentNumberHash,
        assetId: { not: evidence.assetId },
        evidence: {
          OR: [
            { createdAt: { lt: evidence.createdAt } },
            { createdAt: evidence.createdAt, id: { lt: evidence.id } },
          ],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { evidenceId: true, asset: { select: { wbId: true } } },
    });
    if (!reused) return outcome;
    return {
      ...outcome,
      result: "FAILED",
      problems: [...new Set<CheckProblem>([...outcome.problems, "REUSED_DOCUMENT"])],
      summary:
        `Same document number as evidence ${reused.evidenceId} on ${reused.asset.wbId}. ` +
        outcome.summary,
    };
  }

  async function checkEvidence(job: AutomatedJob): Promise<void> {
    const evidence = await prisma.evidence.findUnique({
      where: { id: job.entityId },
      include: {
        asset: true,
        captureSession: { select: { code: true } },
        automatedChecks: { where: { checkVersion: CHECK_VERSION }, take: 1 },
      },
    });
    if (!evidence || !isCheckedEvidence(evidence)) throw new Skipped("evidence_not_checkable");
    if (!checksAllowed(evidence.asset)) throw new Skipped("no_consent");
    if (evidence.automatedChecks.length > 0) return;

    const outcome = evidence.duplicateOfId
      ? deterministic(
          "REUSED_FILE",
          `Same SHA-256 as evidence ${evidence.duplicateOfId} on another asset.`,
          RULES.exactDuplicate,
        )
      : await examine(evidence);

    const at = now();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${evidence.assetId}::uuid FOR UPDATE`;
      const check = await tx.automatedCheck.create({
        data: {
          assetId: evidence.assetId,
          evidenceId: evidence.id,
          result: outcome.result,
          problems: outcome.problems,
          summary: outcome.summary,
          confidence: outcome.confidence,
          engine: outcome.engine,
          model: outcome.model,
          checkVersion: CHECK_VERSION,
          sha256: evidence.sha256,
          documentNumberHash: outcome.documentNumberHash,
          createdAt: at,
        },
      });
      await tx.automatedJob.update({
        where: { id: job.id },
        data: { status: "COMPLETED", attempts: { increment: 1 }, lastError: null, updatedAt: at },
      });
      await writeAudit(
        tx,
        {
          actorId: null,
          action: "evidence.automated_check",
          targetType: "asset",
          targetId: evidence.asset.wbId,
          metadata: {
            evidenceId: evidence.id,
            checkId: check.id,
            result: check.result,
            problems: check.problems,
            engine: check.engine,
            model: check.model,
          },
        },
        null,
      );
      await recordTrust(tx, evidence.assetId, at);
    });
  }

  async function reportOnVerifier(job: AutomatedJob): Promise<void> {
    const verifier = await prisma.verifier.findUnique({
      where: { id: job.entityId },
      include: {
        user: { select: { identityStatus: true } },
        categoryPermissions: {
          where: { status: { in: ["PENDING", "APPROVED"] } },
          orderBy: { createdAt: "asc" },
        },
        statusEvents: { where: { toStatus: "REJECTED" }, select: { id: true } },
      },
    });
    if (!verifier) throw new Skipped("verifier_not_found");
    const input: VerifierApplicationInput = {
      entityType: verifier.entityType,
      businessName: verifier.businessName,
      website: verifier.website,
      bio: verifier.bio,
      categories: [...new Set(verifier.categoryPermissions.map((p) => p.category))],
      identityVerified: verifier.user.identityStatus === "VERIFIED",
      previousRejections: verifier.statusEvents.length,
    };
    const report = await engine.reportOnVerifier(input);
    const at = now();
    await prisma.$transaction(async (tx) => {
      const created = await tx.verifierApplicationReport.create({
        data: {
          verifierId: verifier.id,
          recommendation: report.recommendation,
          summary: report.summary,
          strengths: report.strengths,
          concerns: report.concerns,
          questions: report.questions,
          sources: report.sources,
          inputHash: sha256Hex(canonicalJson({ reportVersion: REPORT_VERSION, input })),
          engine: engine.id,
          model: report.model,
          reportVersion: REPORT_VERSION,
          requestedById: job.requestedById,
          createdAt: at,
        },
      });
      await tx.automatedJob.update({
        where: { id: job.id },
        data: { status: "COMPLETED", attempts: { increment: 1 }, lastError: null, updatedAt: at },
      });
      await writeAudit(
        tx,
        {
          actorId: null,
          action: "verifier.ai_report_created",
          targetType: "verifier",
          targetId: verifier.id,
          metadata: { reportId: created.id, engine: created.engine, model: created.model },
        },
        null,
      );
    });
  }

  /** A stored evidence photo, checked against its hash and without its metadata. */
  async function evidencePhoto(e: Evidence): Promise<Buffer | null> {
    const stored = await readAll(await storage.read(e.storageKey));
    if (createHash("sha256").update(stored).digest("hex") !== e.sha256) {
      log.warn({ evidenceId: e.id }, "stored evidence does not match its hash");
      return null;
    }
    return checkImage(stored).catch(() => null);
  }

  /**
   * Compares a buyer's photos, or for a remote check the photos the seller took in the check's
   * capture session, with the item's recorded photos. Recorded photos are private evidence, so
   * they are sent only with the current owner's consent to AI checks.
   */
  async function matchItem(job: AutomatedJob): Promise<void> {
    const check = await prisma.purchaseCheck.findUnique({
      where: { id: job.entityId },
      include: { asset: true, photos: true },
    });
    if (!check?.photosCompletedAt) throw new Skipped("purchase_check_not_ready");
    if (check.status !== "OPEN") return;
    const finish = (reason: "NO_CONSENT" | "NO_REFERENCE_PHOTOS") =>
      prisma.$transaction(async (tx) => {
        await recordInconclusive(tx, check.id, reason, now());
        await tx.automatedJob.update({
          where: { id: job.id },
          data: { status: "COMPLETED", attempts: { increment: 1 }, updatedAt: now() },
        });
      });
    if (!checksAllowed(check.asset)) return finish("NO_CONSENT");

    const reference: { id: string; label: string; data: Buffer }[] = [];
    for (const e of await referencePhotos(prisma, check.assetId)) {
      const data = await evidencePhoto(e);
      if (!data) continue;
      const label = e.source === "VERIFIER" ? "verifier photo" : `owner photo: ${e.captureShot}`;
      reference.push({ id: e.id, label, data });
    }
    if (reference.length === 0) return finish("NO_REFERENCE_PHOTOS");

    const order = new Map(check.shots.map((s, i) => [s, i]));
    const candidate = [];
    if (check.kind === "REMOTE") {
      const filmed = await prisma.evidence.findMany({
        where: {
          type: "PHOTO",
          captureShot: { not: CAPTURE_CODE_SHOT },
          captureSession: { purchaseCheckId: check.id, status: "COMPLETED" },
        },
      });
      for (const e of filmed.sort(
        (a, b) => (order.get(a.captureShot ?? "") ?? 0) - (order.get(b.captureShot ?? "") ?? 0),
      )) {
        const data = await evidencePhoto(e);
        if (data) candidate.push({ label: `seller photo: ${e.captureShot}`, data });
      }
      if (candidate.length === 0) throw new Skipped("remote_check_photos_unreadable");
    } else {
      for (const p of [...check.photos].sort(
        (a, b) => (order.get(a.shot) ?? 0) - (order.get(b.shot) ?? 0),
      )) {
        candidate.push({
          label: `buyer photo: ${p.shot}`,
          data: await readAll(await storage.read(p.storageKey)),
        });
      }
    }
    const outcome = await engine.compareItem({
      asset: { category: check.asset.category, brand: check.asset.brand, model: check.asset.model },
      reference: reference.map(({ label, data }) => ({ label, data })),
      candidate,
    });
    const at = now();
    await prisma.$transaction(async (tx) => {
      await tx.purchaseCheck.update({
        where: { id: check.id },
        data: {
          status: "COMPLETED",
          itemResult: outcome.result,
          itemSummary: outcome.summary,
          itemConfidence: outcome.confidence,
          engine: engine.id,
          model: outcome.model,
          checkVersion: ITEM_MATCH_VERSION,
          referenceEvidenceIds: reference.map((r) => r.id),
          itemCheckedAt: at,
          updatedAt: at,
        },
      });
      await tx.automatedJob.update({
        where: { id: job.id },
        data: { status: "COMPLETED", attempts: { increment: 1 }, lastError: null, updatedAt: at },
      });
      await writeAudit(
        tx,
        {
          actorId: null,
          action: "purchase_check.item_checked",
          targetType: "purchase_check",
          targetId: check.id,
          metadata: {
            result: outcome.result,
            references: reference.length,
            engine: engine.id,
            model: outcome.model,
          },
        },
        null,
      );
    });
  }

  async function fail(job: AutomatedJob, error: unknown): Promise<void> {
    const attempts = job.attempts + 1;
    const final =
      error instanceof Skipped ||
      (error instanceof CheckEngineError && !error.retryable) ||
      attempts >= MAX_CHECK_ATTEMPTS;
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    log.warn({ jobId: job.id, kind: job.kind, attempts, err: message }, "automated check failed");
    const at = now();
    await prisma.$transaction(async (tx) => {
      await tx.automatedJob.update({
        where: { id: job.id },
        data: {
          status: final ? "FAILED" : "PENDING",
          attempts,
          lastError: message,
          runAfter: final ? job.runAfter : new Date(at.getTime() + retryDelayMs(attempts)),
          updatedAt: at,
        },
      });
      // A buyer waiting for a comparison that cannot be made gets an inconclusive result.
      if (!final || job.kind !== "ITEM_MATCH") return;
      const check = await tx.purchaseCheck.findUnique({
        where: { id: job.entityId },
        select: { status: true, photosCompletedAt: true },
      });
      if (check?.status === "OPEN" && check.photosCompletedAt) {
        await recordInconclusive(tx, job.entityId, "CHECK_FAILED", at);
      }
    });
  }

  async function process(job: AutomatedJob): Promise<void> {
    try {
      if (job.kind === "EVIDENCE_CHECK") await checkEvidence(job);
      else if (job.kind === "ITEM_MATCH") await matchItem(job);
      else await reportOnVerifier(job);
      // Jobs with nothing left to do (already checked) are closed without a new result.
      await prisma.automatedJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { status: "COMPLETED", updatedAt: now() },
      });
    } catch (error) {
      await fail(job, error);
    }
  }

  async function runOnce(): Promise<number> {
    if (running) return running;
    running = (async () => {
      const jobs = await prisma.automatedJob.findMany({
        where: { status: "PENDING", runAfter: { lte: now() } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 20,
      });
      for (const job of jobs) await process(job);
      return jobs.length;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const tick = () => {
    runOnce().catch((error: unknown) => log.error({ err: error }, "automated checks failed"));
  };

  return {
    engine,
    runOnce,
    start(intervalMs = 10_000) {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    kick() {
      if (timer) setImmediate(tick);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
