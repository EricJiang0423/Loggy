// Git repositories behind the projects, found on their own. A project grouped by its remote
// (e.g. sessions started in a parent folder that only named the repo in a PR link) still gets
// its local clone: Loggy looks for a repository with the same remote in and under the folders
// the sessions ran in.

import fs from 'node:fs';
import path from 'node:path';
import type { SessionSummary } from '../shared/types.js';
import { normalizeRemote, readRemote, type Place } from './projects.js';

export interface GitProject {
  path: string;
  name: string;
  /** Project keys (projectPath) whose sessions belong to this repository. */
  groups: string[];
}

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Movies', 'Music']);
// ponytail: two levels below each session folder; deeper clones need a session that ran in them.
const DEPTH = 2;

/** Repositories in `dir` and up to DEPTH levels below it. */
function reposUnder(dir: string, depth: number, out: Set<string>): void {
  if (fs.existsSync(path.join(dir, '.git'))) {
    out.add(dir);
    return;
  }
  if (depth <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) reposUnder(path.join(dir, e.name), depth - 1, out);
}

const key = (remote: string | undefined) => normalizeRemote(remote)?.toLowerCase();

export function findGitProjects(sessions: SessionSummary[], placeOf: (cwd: string) => Place): GitProject[] {
  const main = sessions.filter((s) => !s.isSubagent && s.cwd);
  // Every repository the sessions ran in, and those found below folders that are not repositories.
  const roots = new Set<string>();
  const scanned = new Set<string>();
  for (const s of main) {
    const p = placeOf(s.cwd);
    if (p.isGit) roots.add(p.root);
    else if (!scanned.has(s.cwd)) {
      scanned.add(s.cwd);
      reposUnder(s.cwd, DEPTH, roots);
    }
  }
  const byRemote = new Map<string, string[]>();
  for (const r of roots) {
    const k = key(readRemote(r));
    if (k) byRemote.set(k, [...(byRemote.get(k) ?? []), r]);
  }
  const out = new Map<string, { name: string; groups: Set<string>; n: number }>();
  const add = (root: string, s: SessionSummary) => {
    const e = out.get(root) ?? { name: s.project || path.basename(root), groups: new Set<string>(), n: 0 };
    e.groups.add(s.projectPath);
    e.n++;
    out.set(root, e);
  };
  for (const s of main) {
    const p = placeOf(s.cwd);
    if (p.isGit) {
      add(p.root, s);
      continue;
    }
    // The repo the session named: grouped by it, or recorded in the log.
    const remote = s.projectPath.startsWith('repo:') ? s.projectPath.slice(5).toLowerCase() : key(s.repo);
    const clones = remote ? byRemote.get(remote) : undefined;
    // ponytail: several clones of one remote: the one whose path sorts first (no worktree suffix).
    if (clones?.length) add([...clones].sort((a, b) => a.length - b.length || a.localeCompare(b))[0], s);
  }
  return [...out]
    .map(([p, e]) => ({ path: p, name: e.name, groups: [...e.groups] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
