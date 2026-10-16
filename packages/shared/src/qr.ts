import { isWbId, type WbId } from "./ids.js";

// QR codes (ISO/IEC 18004) for passport links: byte mode, error correction level M,
// versions 1–10 (up to 213 bytes), which is ample for a passport URL.

const MAX_VERSION = 10;
/** Error correction codewords per block and number of blocks at level M, by version. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits of level M. */
const LEVEL_M = 0;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number): number =>
  Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Multiplication in GF(2^8) with the QR polynomial 0x11D. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Reed–Solomon error correction codewords of `data`. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] = result[i]! ^ gfMultiply(divisor[i]!, factor);
  }
  return result;
}

/** Data codewords: byte-mode segment, terminator and padding. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  const capacity = dataCodewords(version) * 8;
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const result: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    result.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  return result;
}

/** Splits the data into blocks, adds error correction to each and interleaves them. */
export function interleave(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version]!;
  const ecc = ECC_PER_BLOCK[version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - ecc + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const remainder = rsRemainder(block, ecc);
    if (i < shortBlocks) block.push(0);
    all.push([...block, ...remainder]);
  }
  const result: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLength - ecc || j >= shortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

export const QR_MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The 15 format bits of level M with `mask`, error-protected and masked. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

class Matrix {
  readonly modules: boolean[][];
  readonly reserved: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  fn(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, version: number) {
  const { size } = m;
  for (let i = 0; i < size; i++) {
    m.fn(6, i, i % 2 === 0);
    m.fn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) m.fn(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m.fn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }),
  );
  drawFormat(m, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.fn(a, b, dark);
      m.fn(b, a, dark);
    }
  }
}

function drawFormat(m: Matrix, mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = m;
  for (let i = 0; i <= 5; i++) m.fn(8, i, bit(i));
  m.fn(8, 7, bit(6));
  m.fn(8, 8, bit(7));
  m.fn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.fn(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.fn(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.fn(8, size - 15 + i, bit(i));
  m.fn(8, size - 8, true);
}

/** Visits the data modules in placement order (two-column zigzag from the bottom right). */
export function forEachDataModule(
  size: number,
  reserved: readonly (readonly boolean[])[],
  visit: (x: number, y: number) => void,
) {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y]![x]) visit(x, y);
      }
    }
  }
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines = [...modules, ...modules.map((_, x) => modules.map((row) => row[x]!))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const s = line.map((d) => (d ? "1" : "0")).join("");
    for (const pattern of ["10111010000", "00001011101"]) {
      for (let i = s.indexOf(pattern); i !== -1; i = s.indexOf(pattern, i + 1)) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) {
        score += 3;
      }
    }
  }
  const dark = modules.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

export interface QrCode {
  version: number;
  mask: number;
  /** `modules[y][x]` is true for a dark module; no quiet zone. */
  modules: boolean[][];
}

/** Encodes `text` (UTF-8) as a QR code at error correction level M. */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) {
    if (++version > MAX_VERSION) throw new RangeError("text too long for a QR code");
  }
  const codewords = interleave(encodeData(bytes, version), version);
  const base = new Matrix(version * 4 + 17);
  drawFunctionPatterns(base, version);
  let i = 0;
  forEachDataModule(base.size, base.reserved, (x, y) => {
    base.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
    i++;
  });

  let best: QrCode | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(base.size);
    base.modules.forEach((row, y) => row.forEach((d, x) => (m.modules[y]![x] = d)));
    base.reserved.forEach((row, y) => row.forEach((r, x) => (m.reserved[y]![x] = r)));
    forEachDataModule(m.size, m.reserved, (x, y) => {
      if (QR_MASKS[mask]!(x, y)) m.modules[y]![x] = !m.modules[y]![x];
    });
    drawFormat(m, mask);
    const score = penalty(m.modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, mask, modules: m.modules };
    }
  }
  return best!;
}

/** A QR code as a standalone SVG with a 4-module quiet zone. */
export function qrSvg(text: string, title: string): string {
  const { modules } = encodeQr(text);
  const size = modules.length + 8;
  const path = modules
    .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + 4} ${y + 4}h1v1h-1z` : "")))
    .join("");
  const escaped = title.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges">` +
    `<title>${escaped}</title><rect width="100%" height="100%" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  );
}

/**
 * The WB ID of a scanned passport QR code, or null for anything else. Accepts only a bare WB ID or
 * a passport link on one of `origins`, so a scanner never follows a code to another website.
 */
export function wbIdFromScan(scanned: string, origins: readonly string[]): WbId | null {
  const text = scanned.trim();
  const bare = text.toUpperCase();
  if (isWbId(bare)) return bare;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!origins.includes(url.origin)) return null;
  const match = /^\/passport\/([^/]+)\/?$/.exec(url.pathname);
  const id = match?.[1]?.toUpperCase();
  return id && isWbId(id) ? id : null;
}
