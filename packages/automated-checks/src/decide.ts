import {
  type AutomatedCheckResult,
  CHECK_PROBLEMS,
  type CheckProblem,
  FAILING_CHECK_PROBLEMS,
} from "@worthybound/shared";

/** What the model reports about one file, before the decision rule is applied. */
export interface ModelFinding {
  verdict: "CONSISTENT" | "PROBLEMS_FOUND" | "CANNOT_TELL";
  problems: readonly string[];
  confidence: number;
}

/** A check passes or fails only with at least this confidence; otherwise it is inconclusive. */
export const MIN_CONFIDENCE = 0.7;

/**
 * Turns a model finding into a result by a fixed rule, so the model never decides alone:
 * FAILED needs a problem that suggests a fake, PASSED needs a consistent file without problems,
 * both with at least MIN_CONFIDENCE. Anything else is INCONCLUSIVE.
 */
export function decide(finding: ModelFinding): {
  result: AutomatedCheckResult;
  problems: CheckProblem[];
  confidence: number;
} {
  const problems = CHECK_PROBLEMS.filter((p) => finding.problems.includes(p));
  const confidence = Number.isFinite(finding.confidence)
    ? Math.min(1, Math.max(0, finding.confidence))
    : 0;
  const sure = confidence >= MIN_CONFIDENCE;
  if (sure && problems.some((p) => FAILING_CHECK_PROBLEMS.includes(p))) {
    return { result: "FAILED", problems, confidence };
  }
  if (sure && problems.length === 0 && finding.verdict === "CONSISTENT") {
    return { result: "PASSED", problems, confidence };
  }
  return { result: "INCONCLUSIVE", problems, confidence };
}
