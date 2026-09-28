import { describe, expect, it } from "vitest";
import {
  ASSET_LIFECYCLE,
  ASSET_STATUSES,
  assertTransition,
  ATTESTATION_LIFECYCLE,
  ATTESTATION_STATUSES,
  canTransition,
  CATEGORY_PERMISSION_LIFECYCLE,
  CATEGORY_PERMISSION_STATUSES,
  DISPUTE_LIFECYCLE,
  DISPUTE_STATUSES,
  DomainError,
  EVIDENCE_REVIEW_LIFECYCLE,
  isTerminal,
  type Lifecycle,
  nextStatuses,
  REVIEW_STATUSES,
  TEMPLATE_VERSION_LIFECYCLE,
  TEMPLATE_VERSION_STATUSES,
  TRANSFER_LIFECYCLE,
  TRANSFER_STATUSES,
  VERIFICATION_REQUEST_LIFECYCLE,
  VERIFICATION_REQUEST_STATUSES,
  VERIFIER_LIFECYCLE,
  VERIFIER_STATUSES,
} from "../src/index.js";

type AnyLifecycle = Lifecycle<string, string>;

const LIFECYCLES: [AnyLifecycle, readonly string[]][] = [
  [ASSET_LIFECYCLE, ASSET_STATUSES],
  [VERIFIER_LIFECYCLE, VERIFIER_STATUSES],
  [CATEGORY_PERMISSION_LIFECYCLE, CATEGORY_PERMISSION_STATUSES],
  [TEMPLATE_VERSION_LIFECYCLE, TEMPLATE_VERSION_STATUSES],
  [VERIFICATION_REQUEST_LIFECYCLE, VERIFICATION_REQUEST_STATUSES],
  [ATTESTATION_LIFECYCLE, ATTESTATION_STATUSES],
  [EVIDENCE_REVIEW_LIFECYCLE, REVIEW_STATUSES],
  [TRANSFER_LIFECYCLE, TRANSFER_STATUSES],
  [DISPUTE_LIFECYCLE, DISPUTE_STATUSES],
];

/** Every (from, to, actor) triple a lifecycle allows. */
function edges(lifecycle: AnyLifecycle): [string, string, string][] {
  return Object.entries(lifecycle.transitions).flatMap(([from, targets]) =>
    Object.entries(targets).flatMap(([to, actors]) =>
      (actors ?? []).map((actor): [string, string, string] => [from, to, actor]),
    ),
  );
}

function sourcesOf(lifecycle: AnyLifecycle, to: string): string[] {
  return [
    ...new Set(
      edges(lifecycle)
        .filter(([, target]) => target === to)
        .map(([from]) => from),
    ),
  ];
}

function actorsInto(lifecycle: AnyLifecycle, to: string): Set<string> {
  return new Set(
    edges(lifecycle)
      .filter(([, target]) => target === to)
      .map(([, , actor]) => actor),
  );
}

describe("lifecycle structure", () => {
  it.each(LIFECYCLES.map(([l, s]) => [l.name, l, s] as const))(
    "%s: covers exactly its statuses, has no self-loops and no empty actor lists",
    (_name, lifecycle, statuses) => {
      expect(Object.keys(lifecycle.transitions).sort()).toEqual([...statuses].sort());
      for (const [from, targets] of Object.entries(lifecycle.transitions)) {
        for (const [to, actors] of Object.entries(targets)) {
          expect(statuses).toContain(to);
          expect(to, `${from} -> ${to}`).not.toBe(from);
          expect(actors?.length, `${from} -> ${to}`).toBeGreaterThan(0);
        }
      }
    },
  );

  it.each(LIFECYCLES.map(([l, s]) => [l.name, l, s] as const))(
    "%s: every status is reachable from the initial status",
    (_name, lifecycle, statuses) => {
      const initial = statuses[0] as string;
      const seen = new Set([initial]);
      const queue = [initial];
      while (queue.length > 0) {
        const from = queue.shift() as string;
        for (const to of nextStatuses(lifecycle, from)) {
          if (!seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
      expect([...seen].sort()).toEqual([...statuses].sort());
    },
  );
});

describe("transition checks", () => {
  it("allows a listed transition for a listed actor", () => {
    expect(canTransition(ASSET_LIFECYCLE, "DRAFT", "ACTIVE", "OWNER")).toBe(true);
    expect(() => assertTransition(ASSET_LIFECYCLE, "DRAFT", "ACTIVE", "OWNER")).not.toThrow();
  });

  it("reports INVALID_TRANSITION for a change that never happens", () => {
    expect(canTransition(ASSET_LIFECYCLE, "REVOKED", "ACTIVE", "ADMIN")).toBe(false);
    expect(() => assertTransition(ASSET_LIFECYCLE, "REVOKED", "ACTIVE", "ADMIN")).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  it("reports FORBIDDEN_TRANSITION when the actor may not make the change", () => {
    expect(() => assertTransition(ASSET_LIFECYCLE, "ACTIVE", "VERIFIED", "OWNER")).toThrow(
      DomainError,
    );
    expect(() => assertTransition(ASSET_LIFECYCLE, "ACTIVE", "VERIFIED", "OWNER")).toThrow(
      expect.objectContaining({ code: "FORBIDDEN_TRANSITION" }),
    );
  });

  it("lists next statuses, optionally for one actor", () => {
    expect(nextStatuses(ASSET_LIFECYCLE, "DRAFT").sort()).toEqual([
      "ACTIVE",
      "REVOKED",
      "TOKENIZED",
    ]);
    expect(nextStatuses(ASSET_LIFECYCLE, "DRAFT", "OWNER").sort()).toEqual(["ACTIVE", "REVOKED"]);
  });

  it("identifies terminal statuses", () => {
    expect(isTerminal(ASSET_LIFECYCLE, "REVOKED")).toBe(true);
    expect(isTerminal(ASSET_LIFECYCLE, "ACTIVE")).toBe(false);
  });
});

describe("asset lifecycle", () => {
  it("lets only the system mark an asset verified", () => {
    expect(actorsInto(ASSET_LIFECYCLE, "VERIFIED")).toEqual(new Set(["SYSTEM"]));
  });

  it("never returns an asset to draft and keeps revocation final", () => {
    expect(sourcesOf(ASSET_LIFECYCLE, "DRAFT")).toEqual([]);
    expect(isTerminal(ASSET_LIFECYCLE, "REVOKED")).toBe(true);
  });

  it("starts transfers only from ACTIVE, VERIFIED or REVERIFICATION_REQUIRED, by the owner", () => {
    expect(sourcesOf(ASSET_LIFECYCLE, "TRANSFER_PENDING").sort()).toEqual([
      "ACTIVE",
      "REVERIFICATION_REQUIRED",
      "VERIFIED",
    ]);
    expect(actorsInto(ASSET_LIFECYCLE, "TRANSFER_PENDING")).toEqual(new Set(["OWNER"]));
  });

  it("lets the owner report a published asset lost or stolen from any open status", () => {
    for (const from of [
      "TOKENIZED",
      "ACTIVE",
      "VERIFIED",
      "TRANSFER_PENDING",
      "REVERIFICATION_REQUIRED",
      "DISPUTED",
    ] as const) {
      expect(canTransition(ASSET_LIFECYCLE, from, "REPORTED_STOLEN", "OWNER"), from).toBe(true);
      expect(canTransition(ASSET_LIFECYCLE, from, "REPORTED_LOST", "OWNER"), from).toBe(true);
    }
  });

  it("lets only an admin clear a stolen report, and always requires reverification", () => {
    expect(nextStatuses(ASSET_LIFECYCLE, "REPORTED_STOLEN", "OWNER")).toEqual([]);
    expect(nextStatuses(ASSET_LIFECYCLE, "REPORTED_STOLEN", "ADMIN").sort()).toEqual([
      "REVERIFICATION_REQUIRED",
      "REVOKED",
    ]);
    expect(nextStatuses(ASSET_LIFECYCLE, "REPORTED_LOST").sort()).toEqual([
      "REPORTED_STOLEN",
      "REVERIFICATION_REQUIRED",
      "REVOKED",
    ]);
  });

  it("lets only an admin move assets into or out of a dispute, never straight to verified", () => {
    expect(actorsInto(ASSET_LIFECYCLE, "DISPUTED")).toEqual(new Set(["ADMIN"]));
    expect(nextStatuses(ASSET_LIFECYCLE, "DISPUTED")).not.toContain("VERIFIED");
    expect(nextStatuses(ASSET_LIFECYCLE, "DISPUTED")).not.toContain("TRANSFER_PENDING");
  });

  it("lets owners revoke only their own drafts", () => {
    expect(
      edges(ASSET_LIFECYCLE)
        .filter(([, to, actor]) => to === "REVOKED" && actor === "OWNER")
        .map(([from]) => from),
    ).toEqual(["DRAFT"]);
  });

  it("supports the specification example VERIFIED -> DISPUTED -> REVOKED", () => {
    expect(canTransition(ASSET_LIFECYCLE, "VERIFIED", "DISPUTED", "ADMIN")).toBe(true);
    expect(canTransition(ASSET_LIFECYCLE, "DISPUTED", "REVOKED", "ADMIN")).toBe(true);
  });
});

describe("verifier and permission lifecycles", () => {
  it("never lets an applicant approve or reinstate", () => {
    expect(actorsInto(VERIFIER_LIFECYCLE, "APPROVED").has("APPLICANT")).toBe(false);
    expect(nextStatuses(VERIFIER_LIFECYCLE, "APPLIED", "APPLICANT")).toEqual([]);
  });

  it("requires review before approval", () => {
    expect(sourcesOf(VERIFIER_LIFECYCLE, "APPROVED").sort()).toEqual(["SUSPENDED", "UNDER_REVIEW"]);
  });

  it("makes revocation admin-only and final", () => {
    expect(actorsInto(VERIFIER_LIFECYCLE, "REVOKED")).toEqual(new Set(["ADMIN"]));
    expect(isTerminal(VERIFIER_LIFECYCLE, "REVOKED")).toBe(true);
    expect(actorsInto(CATEGORY_PERMISSION_LIFECYCLE, "APPROVED").has("SYSTEM")).toBe(false);
    expect(isTerminal(CATEGORY_PERMISSION_LIFECYCLE, "REVOKED")).toBe(true);
  });
});

describe("verification lifecycles", () => {
  it("keeps published templates immutable except for retirement", () => {
    expect(nextStatuses(TEMPLATE_VERSION_LIFECYCLE, "PUBLISHED")).toEqual(["RETIRED"]);
    expect(isTerminal(TEMPLATE_VERSION_LIFECYCLE, "RETIRED")).toBe(true);
  });

  it("matches the database: revoked and superseded attestations are final", () => {
    expect(isTerminal(ATTESTATION_LIFECYCLE, "REVOKED")).toBe(true);
    expect(isTerminal(ATTESTATION_LIFECYCLE, "SUPERSEDED")).toBe(true);
  });

  it("does not let an issuer revoke an attestation while it is disputed", () => {
    expect(canTransition(ATTESTATION_LIFECYCLE, "ACTIVE", "REVOKED", "VERIFIER")).toBe(true);
    expect(canTransition(ATTESTATION_LIFECYCLE, "DISPUTED", "REVOKED", "VERIFIER")).toBe(false);
  });

  it("does not let a verifier reopen a finished evidence review", () => {
    expect(isTerminal(EVIDENCE_REVIEW_LIFECYCLE, "ACCEPTED")).toBe(true);
    expect(isTerminal(EVIDENCE_REVIEW_LIFECYCLE, "REJECTED")).toBe(true);
  });
});

describe("transfer and dispute lifecycles", () => {
  it("lets only the recipient accept and only the system complete a transfer", () => {
    expect(actorsInto(TRANSFER_LIFECYCLE, "ACCEPTED")).toEqual(new Set(["RECIPIENT"]));
    expect(actorsInto(TRANSFER_LIFECYCLE, "COMPLETED")).toEqual(new Set(["SYSTEM"]));
    expect(sourcesOf(TRANSFER_LIFECYCLE, "COMPLETED")).toEqual(["ACCEPTED"]);
  });

  it("lets only an admin resolve a dispute, and only the opener withdraw it", () => {
    expect(actorsInto(DISPUTE_LIFECYCLE, "UPHELD")).toEqual(new Set(["ADMIN"]));
    expect(actorsInto(DISPUTE_LIFECYCLE, "REJECTED")).toEqual(new Set(["ADMIN"]));
    expect(actorsInto(DISPUTE_LIFECYCLE, "WITHDRAWN")).toEqual(new Set(["OPENER"]));
  });
});
