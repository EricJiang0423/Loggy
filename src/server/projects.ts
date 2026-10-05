// Which project a session belongs to. Sessions are grouped by git remote, git root or working
// directory; "smart" also places sessions whose folder is gone, using what other sessions know.

import fs from 'node:fs';
import path from 'node:path';
import type { SessionSummary } from '../shared/types.js';

export type GroupBy = 'smart' | 'repo' | 'git' | 'folder';
export const GROUP_BY: GroupBy[] = ['smart', 'repo', 'git', 'folder'];

export interface Place {
  /** Git root containing the cwd, or the cwd itself. */
  root: string;
  isGit: boolean;
  /** Normalized origin remote of that root. */
  remote?: string;
}

/** `git@github.com:Owner/Repo.git`, `https://user@host/Owner/Repo` … → `host/Owner/Repo`. */
export function normalizeRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u = url.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const scp = /^[^@/]+@([^:/]+):(?!\d+\/)(.+)$/.exec(u); // git@host:owner/repo
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  return u || undefined;
}

/** Origin URL from a repo's git config (worktrees point to the main repo's config). */
export function readRemote(root: string): string | undefined {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const target = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!target) return undefined;
      gitDir = path.resolve(root, target);
      const common = path.join(gitDir, 'commondir');
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
    }
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const origin = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? /\[remote "[^"]+"\]([^[]*)/.exec(config)?.[1];
    return normalizeRemote(/^\s*url\s*=\s*(.+)$/m.exec(origin ?? '')?.[1]);
  } catch {
    return undefined;
  }
}

/** Loggy's own settings in the data dir. */
export function readSettings(dataDir: string): { groupBy?: GroupBy } {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    return GROUP_BY.includes(s.groupBy) ? { groupBy: s.groupBy } : {};
  } catch {
    return {};
  }
}

export function writeSettings(dataDir: string, settings: { groupBy: GroupBy }): void {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

interface Group {
  key: string;
  name: string;
  /** Owner (repo) or parent folder, used when two groups share a name. */
  hint: string;
  /** A folder on disk for this group, when there is one. */
  dir?: string;
}

const isUnder = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function repoGroup(repo: string): Group {
  const parts = repo.split('/');
  return { key: `repo:${repo.toLowerCase()}`, name: parts[parts.length - 1], hint: parts[parts.length - 2] ?? '' };
}

function dirGroup(dir: string, isGit: boolean): Group {
  return { key: dir, name: path.basename(dir) || dir, hint: path.basename(path.dirname(dir)), dir: isGit ? dir : undefined };
}

/** Sets `project` and `projectPath` (the group key) on every session. */
export function groupProjects(list: SessionSummary[], mode: GroupBy, placeOf: (cwd: string) => Place, exists: (p: string) => boolean = fs.existsSync): void {
  const groups = new Map<string, Group>();
  const pick = new Map<SessionSummary, Group>();
  const repoOf = (s: SessionSummary, p: Place) => p.remote ?? normalizeRemote(s.repo);

  // A git root without an origin remote takes the repo that sessions inside it recorded.
  const repoByRoot = new Map<string, string>();
  if (mode === 'smart' || mode === 'repo') {
    for (const s of list) {
      const p = s.cwd ? placeOf(s.cwd) : undefined;
      const repo = normalizeRemote(s.repo);
      if (p?.isGit && !p.remote && repo && !repoByRoot.has(p.root)) repoByRoot.set(p.root, repo);
    }
  }

  // Pass 1: what each session knows about itself.
  const unknown = new Set<SessionSummary>();
  const repoByCwd = new Map<string, string>();
  for (const s of list) {
    if (!s.cwd) {
      pick.set(s, { key: '', name: '(unknown)', hint: '' });
      continue;
    }
    const p = placeOf(s.cwd);
    const repo = mode === 'smart' || mode === 'repo' ? (repoOf(s, p) ?? repoByRoot.get(p.root)) : undefined;
    if (repo && !repoByCwd.has(s.cwd)) repoByCwd.set(s.cwd, repo);
    let g: Group;
    if (mode === 'folder') g = dirGroup(s.cwd, p.isGit && p.root === s.cwd);
    else if (repo) g = repoGroup(repo);
    else g = dirGroup(p.root, p.isGit);
    if (mode === 'smart' && !repo && !p.isGit) unknown.add(s);
    pick.set(s, g);
  }

  if (mode === 'smart') {
    // Folders known to belong to a group: git roots on disk, and deleted folders whose sessions
    // recorded a repo. An existing non-repo folder (e.g. home) can hold sessions of any project.
    const known: [string, Group][] = [];
    for (const [s, g] of pick) {
      if (unknown.has(s) || !s.cwd) continue;
      const p = placeOf(s.cwd);
      if (p.isGit) known.push([p.root, g]);
      else if (!exists(s.cwd)) known.push([s.cwd, g]);
    }
    known.sort((a, b) => b[0].length - a[0].length);
    for (const s of unknown) {
      const repo = exists(s.cwd) ? undefined : repoByCwd.get(s.cwd);
      if (repo) pick.set(s, repoGroup(repo));
      else {
        const hit = known.find(([dir]) => isUnder(s.cwd, dir));
        if (hit) pick.set(s, hit[1]);
      }
    }
    // Subagents that still have no git or repo context follow their parent.
    const byId = new Map(list.map((s) => [s.id, s]));
    for (const s of unknown) {
      const parent = s.parentId ? byId.get(s.parentId) : undefined;
      if (parent && pick.get(s)!.key === placeOf(s.cwd).root) pick.set(s, pick.get(parent)!);
    }
  }

  // One Group object per key; a repo group shows the most used folder on disk.
  const dirVotes = new Map<string, Map<string, number>>();
  for (const [s, g] of pick) {
    if (!groups.has(g.key)) groups.set(g.key, { ...g });
    const p = s.cwd ? placeOf(s.cwd) : undefined;
    if (g.key.startsWith('repo:') && p?.isGit) {
      const votes = dirVotes.get(g.key) ?? new Map<string, number>();
      votes.set(p.root, (votes.get(p.root) ?? 0) + 1);
      dirVotes.set(g.key, votes);
    }
  }
  for (const [key, votes] of dirVotes) {
    const dir = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    if (!groups.has(dir)) groups.get(key)!.dir = dir; // never share a key with a folder group
  }

  // Same name, different groups: add the owner or parent folder.
  const byName = new Map<string, Group[]>();
  for (const g of groups.values()) byName.set(g.name, [...(byName.get(g.name) ?? []), g]);
  for (const same of byName.values()) if (same.length > 1) for (const g of same) if (g.hint) g.name = `${g.name} · ${g.hint}`;

  for (const [s, g0] of pick) {
    const g = groups.get(g0.key)!;
    s.project = g.name;
    s.projectPath = g.dir ?? g.key;
  }
}
