import type {
  AssetCategory,
  AutomatedCheckResult,
  CaptureShot,
  CheckProblem,
  EvidenceType,
  ItemCondition,
  ItemMatchResult,
  VerifierEntityType,
  VerifierReportRecommendation,
} from "@worthybound/shared";

/** Version of the evidence checks, prompt and decision rule; stored with every result. */
export const CHECK_VERSION = "evidence-check-v3";
/** Version of the item comparison prompt and decision rule; stored with every result. */
export const ITEM_MATCH_VERSION = "item-match-v1";
/** Version of the verifier application report prompt; stored with every report. */
export const REPORT_VERSION = "verifier-report-v1";

export type CheckFileMimeType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export interface EvidenceCheckInput {
  /** What the owner says the item is. */
  asset: {
    category: AssetCategory;
    brand: string | null;
    model: string | null;
    condition: ItemCondition | null;
  };
  evidence: {
    type: EvidenceType;
    description: string | null;
  };
  /** Set for a photo taken in a capture session (ADR 0013). */
  capture: {
    shot: CaptureShot;
    /** What the shot should show. */
    instruction: string;
    /** The session's code, for the shot of the item next to the code; otherwise null. */
    code: string | null;
  } | null;
  /** The file to examine, prepared by the caller (images without metadata). */
  file: { mimeType: CheckFileMimeType; data: Uint8Array; filename: string };
  /** What a PDF says about itself; null for images. Can be forged or missing. */
  pdfMetadata: PdfMetadata | null;
}

/** Metadata read from a PDF's document information and XMP (see `readPdfMetadata`). */
export interface PdfMetadata {
  producer: string | null;
  creator: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  /** Software named in the XMP edit history. */
  historyAgents: string[];
  /** Times the file was saved again after it was first written (incremental updates). */
  incrementalUpdates: number;
}

export interface EvidenceCheckOutcome {
  result: AutomatedCheckResult;
  problems: CheckProblem[];
  /** Detection details, for administrators only. */
  summary: string;
  confidence: number;
  /** The document's own number (receipt, invoice, certificate) as printed; null if none. */
  documentNumber: string | null;
  /** Model that produced the result, as reported by the service. */
  model: string;
}

/** A photo prepared by the caller: an oriented JPEG without metadata. */
export interface CheckPhoto {
  /** What the photo shows, e.g. a capture shot or `verifier photo`. */
  label: string;
  data: Uint8Array;
}

export interface ItemMatchInput {
  asset: { category: AssetCategory; brand: string | null; model: string | null };
  /** The asset's recorded photos: the verifier's and the latest capture session's. */
  reference: CheckPhoto[];
  /** Photos a buyer just took of the item in front of them (ADR 0014). */
  candidate: CheckPhoto[];
}

export interface ItemMatchOutcome {
  result: ItemMatchResult;
  /** Details for administrators only. */
  summary: string;
  confidence: number;
  model: string;
}

export interface VerifierApplicationInput {
  entityType: VerifierEntityType;
  businessName: string | null;
  website: string | null;
  bio: string | null;
  categories: readonly AssetCategory[];
  identityVerified: boolean;
  /** Earlier rejections of this applicant. */
  previousRejections: number;
}

export interface VerifierReportOutcome {
  recommendation: VerifierReportRecommendation;
  summary: string;
  strengths: string[];
  concerns: string[];
  questions: string[];
  /** Web pages the model consulted. */
  sources: string[];
  model: string;
}

/** A replaceable check service (ADR 0013). */
export interface CheckEngine {
  /** Stored as the engine of every result, e.g. `openai`. */
  readonly id: string;
  checkEvidence(input: EvidenceCheckInput): Promise<EvidenceCheckOutcome>;
  /** Whether the candidate photos show the same physical item as the reference photos. */
  compareItem(input: ItemMatchInput): Promise<ItemMatchOutcome>;
  reportOnVerifier(input: VerifierApplicationInput): Promise<VerifierReportOutcome>;
}

/** A check that could not be made. Retryable errors (rate limits, outages) may succeed later. */
export class CheckEngineError extends Error {
  override name = "CheckEngineError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
