import fs from 'node:fs';
import zlib from 'node:zlib';

const CHUNK = 8 * 1024 * 1024;

export interface LineScan {
  /** Byte offset just after the last line that was consumed. */
  endOffset: number;
  /** Size of the file when it was read. */
  size: number;
}

/**
 * Calls `onLine` for every complete line from `startOffset`. A trailing line without a
 * newline is only consumed when it is valid JSON (a writer may still be appending it).
 * `.zst` files are decompressed in memory and always read from the start.
 */
export function scanLines(
  file: string,
  startOffset: number,
  onLine: (buf: Buffer, start: number, end: number) => void,
): LineScan {
  if (file.endsWith('.zst')) {
    const data = decompressZstd(fs.readFileSync(file));
    scanBuffer(data, 0, onLine, true);
    return { endOffset: data.length, size: data.length };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = startOffset;
    let carry: Buffer | null = null;
    let consumed = startOffset;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const chunk = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, chunk, 0, len, pos);
      if (read <= 0) break;
      pos += read;
      const buf: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl === -1) {
        carry = buf;
        continue;
      }
      scanBuffer(buf.subarray(0, lastNl + 1), 0, onLine, false);
      consumed += lastNl + 1;
      carry = lastNl + 1 < buf.length ? Buffer.from(buf.subarray(lastNl + 1)) : null;
    }
    if (carry && carry.length) {
      const text = carry.toString('utf8').trim();
      if (text && isCompleteJson(text)) {
        onLine(carry, 0, carry.length);
        consumed += carry.length;
      }
    }
    return { endOffset: consumed, size };
  } finally {
    fs.closeSync(fd);
  }
}

function scanBuffer(
  buf: Buffer,
  from: number,
  onLine: (buf: Buffer, start: number, end: number) => void,
  includeTail: boolean,
): void {
  let start = from;
  const n = buf.length;
  while (start < n) {
    let nl = buf.indexOf(10, start);
    if (nl === -1) {
      if (!includeTail) break;
      nl = n;
    }
    let end = nl;
    if (end > start && buf[end - 1] === 13) end--;
    if (end > start) onLine(buf, start, end);
    start = nl + 1;
  }
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function decompressZstd(data: Buffer): Buffer {
  const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
  if (typeof z.zstdDecompressSync !== 'function') {
    throw new Error('This Node.js version cannot read .zst files (needs Node 22.15+).');
  }
  return z.zstdDecompressSync(data);
}

/** Position of `needle` inside [start, end) (bounded search), or -1. */
export function indexIn(buf: Buffer, needle: Buffer, start: number, end: number): number {
  const at = buf.subarray(start, end).indexOf(needle);
  return at === -1 ? -1 : start + at;
}

/** Finds `"key":"` within the first `limit` bytes and returns the string value (no escapes). */
export function sniffString(buf: Buffer, start: number, end: number, needle: Buffer, limit = 400): string | undefined {
  const at = indexIn(buf, needle, start, Math.min(end, start + limit));
  if (at === -1) return undefined;
  const vStart = at + needle.length;
  const vEnd = indexIn(buf, QUOTE, vStart, end);
  if (vEnd === -1) return undefined;
  return buf.toString('latin1', vStart, vEnd);
}

/** Returns the first `count` values of `"type":"<value>"` within the first `limit` bytes. */
export function sniffTypes(buf: Buffer, start: number, end: number, count: number, limit = 600): string[] {
  const out: string[] = [];
  const stop = Math.min(end, start + limit);
  let pos = start;
  while (out.length < count) {
    const at = indexIn(buf, TYPE_NEEDLE, pos, stop);
    if (at === -1) break;
    const vStart = at + TYPE_NEEDLE.length;
    const vEnd = indexIn(buf, QUOTE, vStart, end);
    if (vEnd === -1) break;
    out.push(buf.toString('latin1', vStart, vEnd));
    pos = vEnd + 1;
  }
  return out;
}

const QUOTE = Buffer.from('"');
export const TYPE_NEEDLE = Buffer.from('"type":"');

export function parseTs(value: unknown): number {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** Reads the leading `"timestamp":"..."` of a line without parsing it. */
const TS_NEEDLE = Buffer.from('"timestamp":"');
export function sniffTimestamp(buf: Buffer, start: number, end: number): number {
  const s = sniffString(buf, start, end, TS_NEEDLE, 120);
  return s ? parseTs(s) : 0;
}
