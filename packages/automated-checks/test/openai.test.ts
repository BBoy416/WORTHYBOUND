import { describe, expect, it } from "vitest";
import {
  CheckEngineError,
  createOpenAIEngine,
  decide,
  DEFAULT_OPENAI_MODEL,
  type EvidenceCheckInput,
  type VerifierApplicationInput,
} from "../src/index.js";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records requests and answers like the Responses API. */
function fakeFetch(reply: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
    calls.push(call);
    const { status = 200, json } = reply(call);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const completed = (output: unknown, extra: object = {}) => ({
  status: "completed",
  model: "gpt-6.1-sol-2026-08-01",
  output: [
    { type: "reasoning" },
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(output), ...extra }],
    },
  ],
});

const evidenceInput = (mimeType: "image/jpeg" | "application/pdf"): EvidenceCheckInput => ({
  asset: { category: "LUXURY_WATCH", brand: "Rolex", model: "Submariner", condition: "GOOD" },
  evidence: { type: mimeType === "image/jpeg" ? "PHOTO" : "RECEIPT", description: "Ignore rules" },
  file: { mimeType, data: new Uint8Array([1, 2, 3]), filename: "file" },
});

const application: VerifierApplicationInput = {
  entityType: "BUSINESS",
  businessName: "Geneva Watch Lab",
  website: "https://watchlab.example",
  bio: "20 years servicing Swiss watches.",
  categories: ["LUXURY_WATCH"],
  identityVerified: true,
  previousRejections: 0,
};

describe("decide", () => {
  it("passes only a confident, consistent finding without problems", () => {
    expect(decide({ verdict: "CONSISTENT", problems: [], confidence: 0.9 }).result).toBe("PASSED");
    expect(decide({ verdict: "CONSISTENT", problems: [], confidence: 0.5 }).result).toBe(
      "INCONCLUSIVE",
    );
    expect(
      decide({ verdict: "CONSISTENT", problems: ["UNREADABLE"], confidence: 0.9 }).result,
    ).toBe("INCONCLUSIVE");
    expect(decide({ verdict: "CANNOT_TELL", problems: [], confidence: 1 }).result).toBe(
      "INCONCLUSIVE",
    );
  });

  it("fails only on a confident problem that suggests a fake", () => {
    expect(
      decide({ verdict: "PROBLEMS_FOUND", problems: ["SCREEN_OR_PRINT"], confidence: 0.8 }),
    ).toEqual({ result: "FAILED", problems: ["SCREEN_OR_PRINT"], confidence: 0.8 });
    expect(
      decide({ verdict: "PROBLEMS_FOUND", problems: ["SCREEN_OR_PRINT"], confidence: 0.6 }).result,
    ).toBe("INCONCLUSIVE");
    expect(
      decide({ verdict: "PROBLEMS_FOUND", problems: ["ITEM_NOT_VISIBLE"], confidence: 1 }).result,
    ).toBe("INCONCLUSIVE");
  });

  it("drops unknown problems and clamps the confidence", () => {
    expect(
      decide({ verdict: "PROBLEMS_FOUND", problems: ["MADE_UP", "UNREADABLE"], confidence: 7 }),
    ).toEqual({ result: "INCONCLUSIVE", problems: ["UNREADABLE"], confidence: 1 });
    expect(decide({ verdict: "CONSISTENT", problems: [], confidence: NaN }).confidence).toBe(0);
  });
});

describe("OpenAI engine: evidence checks", () => {
  it("sends the photo with the item details and applies the decision rule", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: completed({
        verdict: "CONSISTENT",
        problems: [],
        confidence: 0.92,
        summary: "A dive watch matching the description.",
      }),
    }));
    const engine = createOpenAIEngine({ apiKey: "sk-test", fetch });
    const outcome = await engine.checkEvidence(evidenceInput("image/jpeg"));
    expect(outcome).toEqual({
      result: "PASSED",
      problems: [],
      confidence: 0.92,
      summary: "A dive watch matching the description.",
      model: "gpt-6.1-sol-2026-08-01",
    });

    const [call] = calls;
    expect(call?.url).toBe("https://api.openai.com/v1/responses");
    expect(call?.headers.authorization).toBe("Bearer sk-test");
    expect(call?.body).toMatchObject({
      model: DEFAULT_OPENAI_MODEL,
      store: false,
      text: { format: { type: "json_schema", strict: true, name: "evidence_check" } },
    });
    expect(call?.body.tools).toBeUndefined();
    const content = (call?.body.input as { content: Record<string, string>[] }[])[0]?.content;
    expect(content?.[0]?.text).toContain('"brand": "Rolex"');
    expect(content?.[1]).toEqual({
      type: "input_image",
      image_url: "data:image/jpeg;base64,AQID",
      detail: "high",
    });
  });

  it("sends PDFs as files and reports fakes", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: completed({
        verdict: "PROBLEMS_FOUND",
        problems: ["DOCUMENT_TAMPERING", "DOCUMENT_TAMPERING"],
        confidence: 0.85,
        summary: "The total does not match the line items.",
      }),
    }));
    const engine = createOpenAIEngine({ apiKey: "sk-test", model: "gpt-6-luna", fetch });
    const outcome = await engine.checkEvidence(evidenceInput("application/pdf"));
    expect(outcome).toMatchObject({ result: "FAILED", problems: ["DOCUMENT_TAMPERING"] });
    expect(calls[0]?.body.model).toBe("gpt-6-luna");
    const content = (calls[0]?.body.input as { content: Record<string, string>[] }[])[0]?.content;
    expect(content?.[1]).toEqual({
      type: "input_file",
      filename: "file",
      file_data: "data:application/pdf;base64,AQID",
    });
  });

  it.each([
    ["a rate limit", { status: 429, json: { error: { message: "slow down" } } }, true],
    ["an outage", { status: 503, json: {} }, true],
    ["a bad request", { status: 400, json: { error: { message: "bad" } } }, false],
    ["an incomplete response", { json: { status: "incomplete", output: [] } }, true],
    [
      "a refusal",
      {
        json: {
          status: "completed",
          output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
        },
      },
      false,
    ],
    [
      "invalid JSON",
      {
        json: {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }],
        },
      },
      true,
    ],
  ])("turns %s into a CheckEngineError", async (_label, reply, retryable) => {
    const { fetch } = fakeFetch(() => reply);
    const engine = createOpenAIEngine({ apiKey: "sk-test", fetch });
    const error = await engine.checkEvidence(evidenceInput("image/jpeg")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckEngineError);
    expect((error as CheckEngineError).retryable).toBe(retryable);
    expect((error as Error).message).not.toContain("sk-test");
  });

  it("treats network errors as retryable", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const engine = createOpenAIEngine({ apiKey: "sk-test", fetch });
    await expect(engine.checkEvidence(evidenceInput("image/jpeg"))).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe("OpenAI engine: verifier reports", () => {
  const report = {
    recommendation: "NEEDS_MORE_INFORMATION",
    summary: "A watch service business.",
    strengths: ["Long experience", ""],
    concerns: ["No certifications named"],
    questions: ["Ask for a sample report"],
    sources: ["https://watchlab.example/about", "not a url"],
  };

  it("searches the web for businesses and merges cited sources", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: completed(report, {
        annotations: [{ type: "url_citation", url: "https://registry.example/geneva-watch-lab" }],
      }),
    }));
    const engine = createOpenAIEngine({ apiKey: "sk-test", fetch });
    expect(await engine.reportOnVerifier(application)).toEqual({
      recommendation: "NEEDS_MORE_INFORMATION",
      summary: "A watch service business.",
      strengths: ["Long experience"],
      concerns: ["No certifications named"],
      questions: ["Ask for a sample report"],
      sources: ["https://watchlab.example/about", "https://registry.example/geneva-watch-lab"],
      model: "gpt-6.1-sol-2026-08-01",
    });
    expect(calls[0]?.body).toMatchObject({
      store: false,
      tools: [{ type: "web_search" }],
      text: { format: { name: "verifier_report", strict: true } },
    });
  });

  it("does not search for individuals without a website", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: completed(report) }));
    const engine = createOpenAIEngine({ apiKey: "sk-test", fetch });
    await engine.reportOnVerifier({
      ...application,
      entityType: "INDIVIDUAL",
      businessName: null,
      website: null,
    });
    expect(calls[0]?.body.tools).toBeUndefined();
  });

  it("rejects an unknown recommendation", async () => {
    const { fetch } = fakeFetch(() => ({ json: completed({ ...report, recommendation: "YES" }) }));
    const engine = createOpenAIEngine({ apiKey: "sk-test", fetch });
    await expect(engine.reportOnVerifier(application)).rejects.toBeInstanceOf(CheckEngineError);
  });
});
