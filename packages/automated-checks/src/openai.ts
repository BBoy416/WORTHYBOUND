import { VERIFIER_REPORT_RECOMMENDATIONS } from "@worthybound/shared";
import { decide, type ModelFinding } from "./decide.js";
import {
  EVIDENCE_INSTRUCTIONS,
  EVIDENCE_SCHEMA,
  evidencePrompt,
  REPORT_INSTRUCTIONS,
  REPORT_SCHEMA,
  reportPrompt,
} from "./prompts.js";
import {
  type CheckEngine,
  CheckEngineError,
  type EvidenceCheckInput,
  type EvidenceCheckOutcome,
  type VerifierApplicationInput,
  type VerifierReportOutcome,
} from "./types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";

export interface OpenAIEngineOptions {
  apiKey: string;
  model?: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ResponseContent {
  type: string;
  text?: string;
  refusal?: string;
  annotations?: { type: string; url?: string }[];
}

interface ResponsesResult {
  status?: string;
  model?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: ResponseContent[] }[];
}

const MAX_TEXT = 2_000;
const MAX_ITEMS = 10;

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new CheckEngineError(`invalid ${field}`, false);
  return value.trim().slice(0, MAX_TEXT);
};

const texts = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) throw new CheckEngineError(`invalid ${field}`, false);
  return value
    .map((v) => text(v, field))
    .filter((v) => v !== "")
    .slice(0, MAX_ITEMS);
};

/**
 * Checks and reports with the OpenAI Responses API and Structured Outputs. Requests are not
 * stored by OpenAI (`store: false`); API data is not used for training.
 */
export function createOpenAIEngine(options: OpenAIEngineOptions): CheckEngine {
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;

  async function respond(
    body: object,
  ): Promise<{ output: unknown; model: string; urls: string[] }> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, store: false, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CheckEngineError(`request failed: ${(error as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as ResponsesResult;
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new CheckEngineError(
        `service returned ${res.status}: ${json.error?.message ?? "no details"}`.slice(0, 300),
        retryable,
      );
    }
    if (json.status !== "completed") {
      throw new CheckEngineError(
        `response ${json.status ?? "unknown"}: ${json.incomplete_details?.reason ?? ""}`.trim(),
        json.status !== "failed",
      );
    }
    const content = (json.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? []);
    if (content.some((c) => c.type === "refusal")) {
      throw new CheckEngineError("the model refused to answer", false);
    }
    const answer = content.find((c) => c.type === "output_text" && c.text);
    if (!answer?.text) throw new CheckEngineError("the response had no output", true);
    let output: unknown;
    try {
      output = JSON.parse(answer.text);
    } catch {
      throw new CheckEngineError("the response was not valid JSON", true);
    }
    const urls = content.flatMap((c) =>
      (c.annotations ?? []).flatMap((a) => (a.type === "url_citation" && a.url ? [a.url] : [])),
    );
    return { output, model: json.model ?? model, urls };
  }

  const format = (name: string, schema: object) => ({
    format: { type: "json_schema", name, strict: true, schema },
  });

  return {
    id: "openai",

    async checkEvidence(input: EvidenceCheckInput): Promise<EvidenceCheckOutcome> {
      const base64 = Buffer.from(input.file.data).toString("base64");
      const dataUrl = `data:${input.file.mimeType};base64,${base64}`;
      const file =
        input.file.mimeType === "application/pdf"
          ? { type: "input_file", filename: input.file.filename, file_data: dataUrl }
          : { type: "input_image", image_url: dataUrl, detail: "high" };
      const { output, model: used } = await respond({
        instructions: EVIDENCE_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: evidencePrompt(input) }, file],
          },
        ],
        text: format("evidence_check", EVIDENCE_SCHEMA),
      });
      const o = output as Record<string, unknown>;
      const verdict = o.verdict as ModelFinding["verdict"];
      if (!["CONSISTENT", "PROBLEMS_FOUND", "CANNOT_TELL"].includes(verdict)) {
        throw new CheckEngineError("invalid verdict", false);
      }
      const decided = decide({
        verdict,
        problems: texts(o.problems, "problems"),
        confidence: typeof o.confidence === "number" ? o.confidence : 0,
      });
      const documentNumber =
        typeof o.documentNumber === "string" ? o.documentNumber.trim().slice(0, 100) : "";
      return {
        ...decided,
        summary: text(o.summary, "summary"),
        documentNumber: documentNumber || null,
        model: used,
      };
    },

    async reportOnVerifier(input: VerifierApplicationInput): Promise<VerifierReportOutcome> {
      const searchable = Boolean(input.website || input.businessName);
      const {
        output,
        model: used,
        urls,
      } = await respond({
        instructions: REPORT_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: reportPrompt(input) }] }],
        ...(searchable ? { tools: [{ type: "web_search" }] } : {}),
        text: format("verifier_report", REPORT_SCHEMA),
      });
      const o = output as Record<string, unknown>;
      const recommendation = o.recommendation as VerifierReportOutcome["recommendation"];
      if (!VERIFIER_REPORT_RECOMMENDATIONS.includes(recommendation)) {
        throw new CheckEngineError("invalid recommendation", false);
      }
      const sources = [...new Set([...texts(o.sources, "sources"), ...urls])]
        .filter((u) => /^https?:\/\//.test(u))
        .slice(0, MAX_ITEMS);
      return {
        recommendation,
        summary: text(o.summary, "summary"),
        strengths: texts(o.strengths, "strengths"),
        concerns: texts(o.concerns, "concerns"),
        questions: texts(o.questions, "questions"),
        sources,
        model: used,
      };
    },
  };
}
