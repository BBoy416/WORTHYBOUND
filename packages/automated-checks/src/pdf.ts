import { inflateSync } from "node:zlib";
import type { PdfMetadata } from "./types.js";

const MAX_STREAMS = 500;
const MAX_INFLATED_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 200;

/** Software that edits images; a shop receipt is never written by it (ADR 0013). */
const IMAGE_EDITORS =
  /photoshop|gimp|affinity photo|pixelmator|paint\.net|krita|photopea|corel photo-paint/i;

const clean = (value: string | null | undefined): string | null => {
  // eslint-disable-next-line no-control-regex
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text ? text.slice(0, MAX_TEXT) : null;
};

/** Decodes PDF string bytes: UTF-16BE with a byte order mark, otherwise PDFDocEncoding. */
const decodeBytes = (bytes: Buffer): string =>
  bytes[0] === 0xfe && bytes[1] === 0xff
    ? Buffer.from(bytes.subarray(2)).swap16().toString("utf16le")
    : bytes.toString("latin1");

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

/** Reads the literal `(…)` or hex `<…>` string that starts at `at`, or null. */
function readString(s: string, at: number): string | null {
  if (s[at] === "<") {
    const end = s.indexOf(">", at);
    if (end < 0) return null;
    const hex = s.slice(at + 1, end).replace(/\s+/g, "");
    return decodeBytes(Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex"));
  }
  if (s[at] !== "(") return null;
  let depth = 0;
  let out = "";
  for (let i = at; i < s.length && i < at + 10_000; i++) {
    const c = s[i] as string;
    if (c === "\\") {
      const next = s[i + 1] ?? "";
      const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
        i += octal[0].length;
      } else {
        out += ESCAPES[next] ?? (next === "\r" || next === "\n" ? "" : next);
        i += 1;
      }
      continue;
    }
    if (c === "(") {
      depth += 1;
      if (depth === 1) continue;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return decodeBytes(Buffer.from(out, "latin1"));
    }
    out += c;
  }
  return null;
}

/** The last value of a document information key, e.g. `/Producer`, across all revisions. */
function infoValue(texts: string[], key: string): string | null {
  let value: string | null = null;
  const pattern = new RegExp(`/${key}\\s*(?=[(<])`, "g");
  for (const s of texts) {
    for (const match of s.matchAll(pattern)) {
      const at = (match.index ?? 0) + match[0].length;
      if (s[at] === "<" && s[at + 1] === "<") continue;
      value = readString(s, at) ?? value;
    }
  }
  return clean(value);
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => XML_ENTITIES[e] ?? "");

/** Every value of an XMP property, written as an element or as an attribute. */
function xmpValues(texts: string[], name: string): string[] {
  const escaped = name.replace(":", "\\:");
  const pattern = new RegExp(
    `<${escaped}>\\s*(?:<rdf:Alt>\\s*<rdf:li[^>]*>)?([^<]*)<|${escaped}="([^"]*)"`,
    "g",
  );
  return texts.flatMap((s) =>
    [...s.matchAll(pattern)].flatMap((m) => {
      const value = clean(unescapeXml(m[1] ?? m[2] ?? ""));
      return value ? [value] : [];
    }),
  );
}

/** `D:YYYYMMDDHHmmSS+HH'mm'` (or an XMP date) as an ISO timestamp, or null. */
export function parsePdfDate(value: string | null): string | null {
  if (!value) return null;
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(
      value,
    );
  const date = m
    ? new Date(
        `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}` +
          (m[8] ? `${m[8]}${m[9]}:${m[10] ?? "00"}` : "Z"),
      )
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Object and metadata streams, inflated when compressed; page contents are skipped. */
function metadataStreams(s: string): string[] {
  const out: string[] = [];
  let budget = MAX_INFLATED_BYTES;
  let pos = 0;
  for (let n = 0; n < MAX_STREAMS && budget > 0; n++) {
    const at = s.indexOf("stream", pos);
    if (at < 0) break;
    pos = at + 6;
    if (s.slice(Math.max(0, at - 3), at).trim() === "end") continue;
    const dict = s.slice(Math.max(0, s.lastIndexOf("obj", at)), at);
    if (!/\/(ObjStm|Metadata)\b/.test(dict)) continue;
    const start = at + (s.startsWith("\r\n", pos) ? 8 : 7);
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const raw = Buffer.from(s.slice(start, end), "latin1");
    if (!/\/FlateDecode/.test(dict)) {
      out.push(raw.toString("latin1"));
      continue;
    }
    try {
      const inflated = inflateSync(raw, { maxOutputLength: budget });
      budget -= inflated.length;
      out.push(inflated.toString("latin1"));
    } catch {
      // Damaged or oversized stream: its metadata is not read.
    }
  }
  return out;
}

/**
 * Reads what a PDF says about itself: producer and creator, dates, the software in its XMP edit
 * history, and how often it was saved again. Everything can be forged or removed, so this is a
 * signal, never proof (ADR 0013).
 */
export function readPdfMetadata(bytes: Uint8Array): PdfMetadata {
  const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const texts = [s, ...metadataStreams(s)];
  const first = (...values: (string | null | undefined)[]) =>
    values.find((v): v is string => Boolean(v)) ?? null;
  const linearized = s.slice(0, 2048).includes("/Linearized");
  const saves = (s.match(/%%EOF/g) ?? []).length;
  return {
    producer: first(infoValue(texts, "Producer"), xmpValues(texts, "pdf:Producer").at(-1)),
    creator: first(infoValue(texts, "Creator"), xmpValues(texts, "xmp:CreatorTool").at(-1)),
    createdAt: parsePdfDate(
      first(infoValue(texts, "CreationDate"), xmpValues(texts, "xmp:CreateDate").at(-1)),
    ),
    modifiedAt: parsePdfDate(
      first(infoValue(texts, "ModDate"), xmpValues(texts, "xmp:ModifyDate").at(-1)),
    ),
    historyAgents: [...new Set(xmpValues(texts, "stEvt:softwareAgent"))].slice(0, 10),
    incrementalUpdates: Math.max(0, saves - 1 - (linearized ? 1 : 0)),
  };
}

/** The first image editor named as the PDF's producer, creator or in its edit history. */
export function imageEditorIn(metadata: PdfMetadata): string | null {
  return (
    [metadata.producer, metadata.creator, ...metadata.historyAgents].find(
      (v): v is string => v !== null && IMAGE_EDITORS.test(v),
    ) ?? null
  );
}
