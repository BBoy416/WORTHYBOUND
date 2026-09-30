import { createHash } from "node:crypto";
import {
  type CheckEngine,
  CheckEngineError,
  type CheckFileMimeType,
  CHECK_VERSION,
  type EvidenceCheckOutcome,
  REPORT_VERSION,
  type VerifierApplicationInput,
} from "@worthybound/automated-checks";
import type { AutomatedJob, PrismaClient } from "@worthybound/database";
import type { Storage } from "@worthybound/storage";
import { canonicalJson, sha256Hex } from "@worthybound/trust-engine";
import type { FastifyBaseLogger } from "fastify";
import { writeAudit } from "../audit.js";
import { checkImage, readAll } from "../evidence/inspect.js";
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

/** Deterministic result for a file already attached to another asset (ADR 0010). */
const REUSED_FILE_CHECK = { engine: "worthybound", model: "exact-duplicate-v1" };

/**
 * Runs queued AI checks of owner evidence and reports on verifier applications (ADR 0013).
 * Results are stored append-only; each evidence result recomputes the asset's Trust Score. A
 * report never changes the application: reviewers decide. One worker per database, like chain
 * sync.
 */
export function createAutomatedChecks(options: AutomatedChecksOptions): AutomatedChecks {
  const { prisma, storage, engine, now, log } = options;
  let running: Promise<number> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function checkEvidence(job: AutomatedJob): Promise<void> {
    const evidence = await prisma.evidence.findUnique({
      where: { id: job.entityId },
      include: {
        asset: true,
        automatedChecks: { where: { checkVersion: CHECK_VERSION }, take: 1 },
      },
    });
    if (!evidence || !isCheckedEvidence(evidence)) throw new Skipped("evidence_not_checkable");
    if (!checksAllowed(evidence.asset)) throw new Skipped("no_consent");
    if (evidence.automatedChecks.length > 0) return;

    let outcome: Omit<EvidenceCheckOutcome, "confidence"> & { confidence: number | null };
    let engineId = engine.id;
    if (evidence.duplicateOfId) {
      outcome = {
        result: "FAILED",
        problems: ["REUSED_FILE"],
        summary: `Same SHA-256 as evidence ${evidence.duplicateOfId} on another asset.`,
        confidence: null,
        model: REUSED_FILE_CHECK.model,
      };
      engineId = REUSED_FILE_CHECK.engine;
    } else {
      const stored = await readAll(await storage.read(evidence.storageKey));
      if (createHash("sha256").update(stored).digest("hex") !== evidence.sha256) {
        log.warn({ evidenceId: evidence.id }, "stored evidence does not match its hash");
        throw new Skipped("hash_mismatch");
      }
      const image = evidence.mimeType !== "application/pdf";
      const data = image
        ? await checkImage(stored).catch(() => {
            throw new Skipped("image_unreadable");
          })
        : stored;
      outcome = await engine.checkEvidence({
        asset: {
          category: evidence.asset.category,
          brand: evidence.asset.brand,
          model: evidence.asset.model,
          condition: evidence.asset.condition,
        },
        evidence: { type: evidence.type, description: evidence.description },
        file: {
          mimeType: (image ? "image/jpeg" : "application/pdf") as CheckFileMimeType,
          data,
          filename: image ? `${evidence.id}.jpg` : `${evidence.id}.pdf`,
        },
      });
    }

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
          engine: engineId,
          model: outcome.model,
          checkVersion: CHECK_VERSION,
          sha256: evidence.sha256,
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

  async function fail(job: AutomatedJob, error: unknown): Promise<void> {
    const attempts = job.attempts + 1;
    const final =
      error instanceof Skipped ||
      (error instanceof CheckEngineError && !error.retryable) ||
      attempts >= MAX_CHECK_ATTEMPTS;
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    log.warn({ jobId: job.id, kind: job.kind, attempts, err: message }, "automated check failed");
    const at = now();
    await prisma.automatedJob.update({
      where: { id: job.id },
      data: {
        status: final ? "FAILED" : "PENDING",
        attempts,
        lastError: message,
        runAfter: final ? job.runAfter : new Date(at.getTime() + retryDelayMs(attempts)),
        updatedAt: at,
      },
    });
  }

  async function process(job: AutomatedJob): Promise<void> {
    try {
      if (job.kind === "EVIDENCE_CHECK") await checkEvidence(job);
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
