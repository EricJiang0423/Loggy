// `loggy statusline`: optional Claude Code status line command. Claude Code pipes a JSON
// object to it on every update; we print a short line and keep the rate-limit numbers so
// the dashboard can show Claude's 5-hour / 7-day usage (they are not in the transcripts).

import fs from 'node:fs';
import path from 'node:path';
import type { UsageMeter } from '../shared/types.js';

interface Snapshot {
  ts: number;
  five?: number;
  fiveReset?: number;
  seven?: number;
  sevenReset?: number;
  model?: string;
}

const FILE = 'statusline.jsonl';

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return toMs(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function pct(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export async function runStatusline(dataDir: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let input: Record<string, any> = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    // Print something useful even with bad input.
  }
  const rl = input.rate_limits ?? {};
  const snap: Snapshot = {
    ts: Date.now(),
    five: pct(rl.five_hour?.used_percentage),
    fiveReset: toMs(rl.five_hour?.resets_at),
    seven: pct(rl.seven_day?.used_percentage),
    sevenReset: toMs(rl.seven_day?.resets_at),
    model: input.model?.display_name ?? input.model?.id,
  };
  if (snap.five !== undefined || snap.seven !== undefined) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, FILE);
      const last = lastLine(file);
      const changed = !last || last.five !== snap.five || last.seven !== snap.seven || snap.ts - last.ts > 5 * 60_000;
      if (changed) fs.appendFileSync(file, JSON.stringify(snap) + '\n');
    } catch {
      // Never break the user's status line.
    }
  }
  const parts = [snap.model ?? 'Claude'];
  if (snap.five !== undefined) parts.push(`5h ${Math.round(snap.five)}%`);
  if (snap.seven !== undefined) parts.push(`7d ${Math.round(snap.seven)}%`);
  process.stdout.write(parts.join(' · '));
}

function lastLine(file: string): Snapshot | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').trim().split('\n');
      return JSON.parse(lines[lines.length - 1]);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

let cached: { mtime: number; meters: UsageMeter[] } | undefined;

/** Reads the snapshots written by `loggy statusline`. */
export function readStatuslineMeters(dataDir: string): UsageMeter[] {
  const file = path.join(dataDir, FILE);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  if (cached && cached.mtime === st.mtimeMs) return cached.meters;
  const cutoff = Date.now() - 7 * 86400_000;
  const snaps: Snapshot[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const s = JSON.parse(line) as Snapshot;
      if (s.ts > cutoff) snaps.push(s);
    } catch {
      // skip
    }
  }
  const last = snaps[snaps.length - 1];
  const meters: UsageMeter[] = last
    ? [
        {
          agent: 'claude',
          label: 'statusline',
          ts: last.ts,
          fiveHour: last.five !== undefined ? { usedPercent: last.five, windowMinutes: 300, resetsAt: last.fiveReset } : undefined,
          sevenDay: last.seven !== undefined ? { usedPercent: last.seven, windowMinutes: 10080, resetsAt: last.sevenReset } : undefined,
          history: snaps.filter((s) => s.five !== undefined).map((s) => [s.ts, s.five!]),
          history7: snaps.filter((s) => s.seven !== undefined).map((s) => [s.ts, s.seven!]),
        },
      ]
    : [];
  cached = { mtime: st.mtimeMs, meters };
  return meters;
}
