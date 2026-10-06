import { expect, test } from 'vitest';
import type { SessionSummary } from '../src/shared/types';
import { groupProjects, normalizeRemote, type Place } from '../src/server/projects';

const S = (id: string, cwd: string, extra: Partial<SessionSummary> = {}) => ({ id, cwd, isSubagent: false, project: '', projectPath: '', ...extra }) as SessionSummary;

// Two clones of one repo, a deleted Codex folder that knows its repo, and plain folders.
const places: Record<string, Place> = {
  '/w/a/RL': { root: '/w/a/RL', isGit: true, remote: 'github.com/alice/rl' },
  '/w/a/RL/sub': { root: '/w/a/RL', isGit: true, remote: 'github.com/alice/rl' },
  '/w/b/RL': { root: '/w/b/RL', isGit: true, remote: 'github.com/alice/rl' },
  '/w/c/RL': { root: '/w/c/RL', isGit: true, remote: 'github.com/bob/rl' },
  '/w/d/app': { root: '/w/d/app', isGit: true }, // a clone without an origin remote
};
const placeOf = (cwd: string): Place => places[cwd] ?? { root: cwd, isGit: false };

const onDisk = new Set(['/w/a/RL', '/w/a/RL/sub', '/w/b/RL', '/w/c/RL', '/home/me', '/notes']);
function run(list: SessionSummary[], mode: Parameters<typeof groupProjects>[1]) {
  groupProjects(list, mode, placeOf, (p) => onDisk.has(p));
  return Object.fromEntries(list.map((s) => [s.id, s.project]));
}

test('remote URLs are normalized', () => {
  expect(normalizeRemote('git@github.com:Alice/RL.git')).toBe('github.com/Alice/RL');
  expect(normalizeRemote('https://user:tok@github.com/alice/rl/')).toBe('github.com/alice/rl');
  expect(normalizeRemote('ssh://git@gitlab.example.com:2222/team/app.git')).toBe('gitlab.example.com/team/app');
  expect(normalizeRemote('')).toBeUndefined();
});

test('smart grouping joins clones, deleted folders that know their repo, and their neighbours', () => {
  const list = [
    S('c1', '/w/a/RL'),
    S('c2', '/w/b/RL'),
    S('x1', '/gone/rl-work', { repo: 'https://github.com/alice/rl.git' }),
    S('c3', '/gone/rl-work'), // Claude in the same deleted folder: no repo in its log
    S('c4', '/w/a/RL/sub/deleted-dir'), // under a known repo root
    S('k1', '/scratch/x', { isSubagent: true, parentId: 'c1' }),
    S('f1', '/notes'),
    S('h1', '/home/me', { repo: 'git@github.com:carol/other.git' }), // odd: repo recorded in an existing plain folder
    S('h2', '/home/me'),
    S('h3', '/home/me/gone'),
  ];
  const p = run(list, 'smart');
  expect(new Set([p.c1, p.c2, p.x1, p.c3, p.c4, p.k1]).size).toBe(1);
  expect(p.c1).toBe('rl');
  expect(p.f1).toBe('notes');
  expect(p.h1).toBe('other');
  expect(p.h2).toBe('me'); // an existing plain folder does not inherit a neighbour's repo
  expect(p.h3).toBe('gone');
  expect(list.find((s) => s.id === 'c1')!.projectPath).toBe('/w/a/RL');
});

test('a git root without a remote takes the repo its Codex sessions recorded', () => {
  for (const mode of ['smart', 'repo'] as const) {
    const p = run([S('x2', '/w/d/app', { repo: 'https://github.com/dan/app.git' }), S('c7', '/w/d/app')], mode);
    expect(p.c7, mode).toBe(p.x2);
  }
});

test('repo, git root and folder modes', () => {
  const list = () => [S('c1', '/w/a/RL'), S('c2', '/w/b/RL'), S('c5', '/w/c/RL'), S('c6', '/w/a/RL/sub')];
  const repo = run(list(), 'repo');
  expect(repo.c1).toBe(repo.c2);
  expect(repo.c1).not.toBe(repo.c5); // same name, other owner
  expect(repo.c1).toBe('rl · alice');
  const git = run(list(), 'git');
  expect(new Set([git.c1, git.c2, git.c5]).size).toBe(3);
  expect(git.c6).toBe(git.c1);
  const folder = run(list(), 'folder');
  expect(folder.c6).toBe('sub');
});

test('a folder whose origin changed keeps one project: the latest recorded remote', () => {
  const list = [
    S('x1', '/gone/qlib', { repo: 'https://github.com/upstream/qlib.git', start: 1 }),
    S('x2', '/gone/qlib', { repo: 'https://github.com/me/qlib.git', start: 2 }),
    S('c1', '/gone/qlib'),
  ];
  const p = run(list, 'smart');
  expect(new Set([p.x1, p.x2, p.c1])).toEqual(new Set(['qlib']));
});

test('a plain folder that holds several projects does not merge them: each session keeps the repo it recorded', () => {
  const list = [
    S('p1', '/notes', { repo: 'https://github.com/team/orion', start: 1 }),
    S('a1', '/notes', { repo: 'https://github.com/team/vega', start: 2 }),
  ];
  const p = run(list, 'smart');
  expect(p.p1).not.toBe(p.a1);
  expect(p.p1.toLowerCase()).toContain('orion');
});
