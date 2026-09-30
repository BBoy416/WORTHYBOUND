import type { AutomatedCheck, AutomatedJob, PrismaClient } from "@worthybound/database";
import {
  AUTOMATED_CHECK_RESULTS,
  CHECK_PROBLEMS,
  VERIFIER_REPORT_RECOMMENDATIONS,
} from "@worthybound/shared";
import { z } from "zod";

/**
 * The owner's view of an evidence item's AI check: the result and the problem categories, never
 * the detection details (ADR 0013). UNAVAILABLE: the check could not be made.
 */
export const evidenceCheckSchema = z.object({
  status: z.enum([...AUTOMATED_CHECK_RESULTS, "PENDING", "UNAVAILABLE"]),
  problems: z.array(z.enum(CHECK_PROBLEMS)),
  checkedAt: z.iso.datetime().nullable(),
});
export type EvidenceCheckView = z.infer<typeof evidenceCheckSchema>;

/** The latest check of each evidence item, or its queued or failed job; absent if never checked. */
export async function evidenceCheckStates(
  db: Pick<PrismaClient, "automatedCheck" | "automatedJob">,
  evidenceIds: readonly string[],
): Promise<Map<string, EvidenceCheckView>> {
  const states = new Map<string, EvidenceCheckView>();
  if (evidenceIds.length === 0) return states;
  const [checks, jobs] = await Promise.all([
    db.automatedCheck.findMany({
      where: { evidenceId: { in: [...evidenceIds] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.automatedJob.findMany({
      where: { kind: "EVIDENCE_CHECK", entityId: { in: [...evidenceIds] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  for (const job of jobs) {
    if (job.status === "COMPLETED") continue;
    states.set(job.entityId, {
      status: job.status === "PENDING" ? "PENDING" : "UNAVAILABLE",
      problems: [],
      checkedAt: null,
    });
  }
  for (const check of checks) states.set(check.evidenceId, toEvidenceCheck(check));
  return states;
}

const toEvidenceCheck = (check: AutomatedCheck): EvidenceCheckView => ({
  status: check.result,
  problems: check.problems.filter((p): p is EvidenceCheckView["problems"][number] =>
    (CHECK_PROBLEMS as readonly string[]).includes(p),
  ),
  checkedAt: check.createdAt.toISOString(),
});

/** An administrator's view of a check, with the detection details. */
export const adminCheckSchema = z.object({
  id: z.uuid(),
  evidenceId: z.uuid(),
  result: z.enum(AUTOMATED_CHECK_RESULTS),
  problems: z.array(z.string()),
  summary: z.string(),
  confidence: z.number().nullable(),
  engine: z.string(),
  model: z.string(),
  checkVersion: z.string(),
  sha256: z.string(),
  createdAt: z.iso.datetime(),
});

export const toAdminCheck = (c: AutomatedCheck): z.infer<typeof adminCheckSchema> => ({
  id: c.id,
  evidenceId: c.evidenceId,
  result: c.result,
  problems: c.problems,
  summary: c.summary,
  confidence: c.confidence,
  engine: c.engine,
  model: c.model,
  checkVersion: c.checkVersion,
  sha256: c.sha256,
  createdAt: c.createdAt.toISOString(),
});

/** An AI report on a verifier application, for reviewers only (ADR 0013). */
export const verifierReportSchema = z.object({
  id: z.uuid(),
  recommendation: z.enum(VERIFIER_REPORT_RECOMMENDATIONS),
  summary: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  questions: z.array(z.string()),
  sources: z.array(z.string()),
  engine: z.string(),
  model: z.string(),
  reportVersion: z.string(),
  createdAt: z.iso.datetime(),
});

export const verifierReportsSchema = z.object({
  /** Whether reports can be requested (an engine is configured). */
  available: z.boolean(),
  /** A report is queued or being written. */
  pending: z.boolean(),
  /** Why the last request failed, if it did and no report was written since. */
  lastError: z.string().nullable(),
  /** Newest first. */
  items: z.array(verifierReportSchema),
});

export function toVerifierReports(
  reports: readonly {
    id: string;
    recommendation: z.infer<typeof verifierReportSchema>["recommendation"];
    summary: string;
    strengths: string[];
    concerns: string[];
    questions: string[];
    sources: string[];
    engine: string;
    model: string;
    reportVersion: string;
    createdAt: Date;
  }[],
  latestJob: AutomatedJob | null,
  available: boolean,
): z.infer<typeof verifierReportsSchema> {
  const newest = reports[0]?.createdAt.getTime() ?? 0;
  return {
    available,
    pending: latestJob?.status === "PENDING",
    lastError:
      latestJob?.status === "FAILED" && latestJob.updatedAt.getTime() > newest
        ? "The report could not be written. Try again later."
        : null,
    items: reports.map((r) => ({
      id: r.id,
      recommendation: r.recommendation,
      summary: r.summary,
      strengths: r.strengths,
      concerns: r.concerns,
      questions: r.questions,
      sources: r.sources,
      engine: r.engine,
      model: r.model,
      reportVersion: r.reportVersion,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
