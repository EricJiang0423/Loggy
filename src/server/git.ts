// Read-only views of a project's git history: commit list, one commit, and code size over time.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './config.js';

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer, timeout: 60_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export interface GitCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  parents: string[];
  /** branch and tag names pointing here */
  refs: string[];
  added: number;
  removed: number;
  files: number;
}

const SHA = /^[0-9a-f]{4,40}$/;

/** Commits of all local branches, children before parents. `q` searches messages, `path` keeps commits that touched it. */
export async function gitLog(root: string, o: { q?: string; path?: string; limit?: number }): Promise<GitCommit[]> {
  const args = ['log', '--branches', 'HEAD', '--topo-order', `--max-count=${Math.min(o.limit ?? 300, 2000)}`, '--format=%x1e%H%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s', '--numstat', '--no-color'];
  if (o.q) args.push('-i', `--grep=${o.q}`);
  args.push('--');
  if (o.path) args.push(o.path);
  const out = await git(root, args);
  const commits: GitCommit[] = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split('\n');
    const [sha, author, date, parents, refs, subject] = head.split('\x1f');
    const c: GitCommit = {
      sha,
      author,
      date,
      subject: subject ?? '',
      parents: parents ? parents.split(' ') : [],
      refs: refs ? refs.split(', ').map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD') : [],
      added: 0,
      removed: 0,
      files: 0,
    };
    for (const line of rest) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      c.files++;
      c.added += m[1] === '-' ? 0 : Number(m[1]);
      c.removed += m[2] === '-' ? 0 : Number(m[2]);
    }
    commits.push(c);
  }
  return commits;
}

/** One commit: full message, changed files and the patch (capped). */
export async function gitShow(root: string, sha: string): Promise<{ sha: string; message: string; files: { path: string; added: number; removed: number }[]; diff: string; cut: boolean }> {
  if (!SHA.test(sha)) throw new Error('bad commit id');
  const meta = await git(root, ['show', '--no-color', '--format=%B%x1e', '--numstat', sha]);
  const [message, numstat = ''] = meta.split('\x1e');
  const files = numstat
    .split('\n')
    .map((l) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[3], added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) }));
  const LIMIT = 400_000;
  let diff = await git(root, ['show', '--no-color', '--format=', '--patch', sha]);
  const cut = diff.length > LIMIT;
  if (cut) diff = diff.slice(0, LIMIT);
  return { sha, message, files, diff, cut };
}

// ---------- code size over time ----------

/** Not code: lockfiles, data, media, binaries. */
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.(json|lock|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|bz2|xz|7z|mp4|mov|mp3|wav|woff2?|ttf|otf|eot|parquet|feather|pkl|npy|npz|h5|db|sqlite|bin|exe|dll|so|dylib|class|jar|pyc|onnx|pt|ckpt)$/i;
const MAX_BLOB = 1024 * 1024;
const MAX_DAYS = 90;

interface LinesCache {
  blobs: Record<string, number>;
  commits: Record<string, Record<string, number>>;
}

/** Lines per blob from `git cat-file --batch`; binaries and large files count 0. */
function countBlobs(root: string, shas: string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const out: Record<string, number> = {};
    if (!shas.length) return resolve(out);
    const p = spawn('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true });
    let buf = Buffer.alloc(0);
    let idx = 0;
    p.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl === -1) return;
        const header = buf.toString('utf8', 0, nl).split(' ');
        const size = Number(header[2] ?? 0);
        if (header[1] === 'missing') {
          buf = buf.subarray(nl + 1);
          idx++;
          continue;
        }
        if (buf.length < nl + 1 + size + 1) return;
        const body = buf.subarray(nl + 1, nl + 1 + size);
        let lines = 0;
        if (size <= MAX_BLOB && !body.subarray(0, 8000).includes(0)) {
          for (const b of body) if (b === 10) lines++;
          if (size && body[size - 1] !== 10) lines++;
        }
        out[header[0]] = lines;
        buf = buf.subarray(nl + 1 + size + 1);
        idx++;
      }
    });
    p.on('error', reject);
    p.on('close', () => (idx >= shas.length ? resolve(out) : reject(new Error('git cat-file ended early'))));
    p.stdin.end(shas.join('\n') + '\n');
  });
}

/** Lines per top-level folder at the last commit of each day (the committer's local day), cached. */
export async function gitLines(root: string, dataDir: string): Promise<{ days: string[]; shas: string[]; series: Record<string, number[]> }> {
  const file = path.join(ensureDir(path.join(dataDir, 'cache')), `lines-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
  let cache: LinesCache = { blobs: {}, commits: {} };
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first time
  }
  const log = await git(root, ['log', '--first-parent', '--format=%H %cI']);
  const lastOfDay = new Map<string, string>();
  for (const line of log.split('\n').reverse()) {
    const [sha, date] = line.split(' ');
    if (sha && date) lastOfDay.set(date.slice(0, 10), sha); // newest commit of the day wins
  }
  const days = [...lastOfDay.keys()].sort().slice(-MAX_DAYS);
  for (const day of days) {
    const sha = lastOfDay.get(day)!;
    if (cache.commits[sha]) continue;
    const tree = await git(root, ['ls-tree', '-r', '-z', sha]);
    const entries = tree
      .split('\0')
      .map((e) => /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(e))
      .filter((m): m is RegExpExecArray => !!m && !SKIP.test(m[2]));
    const missing = [...new Set(entries.map((m) => m[1]).filter((b) => cache.blobs[b] === undefined))];
    Object.assign(cache.blobs, await countBlobs(root, missing));
    const perDir: Record<string, number> = {};
    for (const m of entries) {
      const dir = m[2].includes('/') ? m[2].slice(0, m[2].indexOf('/')) : '(root)';
      perDir[dir] = (perDir[dir] ?? 0) + (cache.blobs[m[1]] ?? 0);
    }
    for (const k of Object.keys(perDir)) if (!perDir[k]) delete perDir[k];
    cache.commits[sha] = perDir;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {
    // cache is optional
  }
  const shas = days.map((d) => lastOfDay.get(d)!);
  const dirs = new Set(shas.flatMap((s) => Object.keys(cache.commits[s] ?? {})));
  const series: Record<string, number[]> = {};
  for (const d of dirs) series[d] = shas.map((s) => cache.commits[s]?.[d] ?? 0);
  return { days, shas, series };
}

const RUN_SLACK_MS = 5_000; // commit dates have one-second precision

/**
 * Session that made each commit: by the id the commit printed, else by a session in this
 * repository whose `git commit` command was running at the commit's time (`git commit -q`
 * prints no id).
 */
export function linkCommits(
  commits: { sha: string; date: string }[],
  sessions: { id: string; cwd: string; commitShas?: string[]; commitRuns?: [number, number][] }[],
  root: string,
): Map<string, string> {
  const bySha = new Map<string, string>();
  for (const s of sessions) for (const sha of s.commitShas ?? []) bySha.set(sha.slice(0, 7), s.id);
  const inRepo = sessions.filter((s) => s.commitRuns?.length && (s.cwd === root || s.cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep)));
  const out = new Map<string, string>();
  for (const c of commits) {
    const hit = bySha.get(c.sha.slice(0, 7));
    if (hit) {
      out.set(c.sha, hit);
      continue;
    }
    const t = Date.parse(c.date);
    let best: { id: string; d: number } | undefined;
    for (const s of inRepo) {
      for (const [a, b] of s.commitRuns!) {
        if (t < a - RUN_SLACK_MS || t > b + RUN_SLACK_MS) continue;
        const d = Math.abs(t - (a + b) / 2);
        if (!best || d < best.d) best = { id: s.id, d };
      }
    }
    if (best) out.set(c.sha, best.id);
  }
  return out;
}
