import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { gitLines, gitLog, gitShow, linkCommits } from '../src/server/git';
import { graphLayout } from '../web/src/gitGraph';

let repo = '';
let data = '';
const git = (args: string[], date?: string) =>
  execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).toString();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-git-'));
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-gitdata-'));
  git(['init', '-q', '-b', 'main']);
  write('src/a.ts', 'a\nb\n');
  write('package-lock.json', '{\n}\n'); // lockfiles are not code
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Add a'], '2026-10-01T10:00:00Z');
  write('src/a.ts', 'a\nb\nc\n');
  write('docs/x.md', '# x\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Extend a and add docs'], '2026-10-02T10:00:00Z');
  write('src/b.ts', 'b\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Add b'], '2026-10-02T18:00:00Z');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

test('log with line counts, message search and path filter', async () => {
  const all = await gitLog(repo, {});
  expect(all.map((c) => c.subject)).toEqual(['Add b', 'Extend a and add docs', 'Add a']);
  expect(all[1]).toMatchObject({ added: 2, removed: 0, files: 2 });
  expect((await gitLog(repo, { q: 'docs' })).map((c) => c.subject)).toEqual(['Extend a and add docs']);
  expect((await gitLog(repo, { path: 'src/b.ts' })).map((c) => c.subject)).toEqual(['Add b']);
});

test('one commit: message, files and diff', async () => {
  const [c] = await gitLog(repo, { q: 'Extend' });
  const d = await gitShow(repo, c.sha);
  expect(d.message.trim()).toBe('Extend a and add docs');
  expect(d.files).toEqual([
    { path: 'docs/x.md', added: 1, removed: 0 },
    { path: 'src/a.ts', added: 1, removed: 0 },
  ]);
  expect(d.diff).toContain('+c');
  await expect(gitShow(repo, '--evil')).rejects.toThrow();
});

test('lines per top-level folder at the last commit of each day', async () => {
  const r = await gitLines(repo, data);
  expect(r.days).toEqual(['2026-10-01', '2026-10-02']);
  expect(r.series.src).toEqual([2, 4]);
  expect(r.series.docs).toEqual([0, 1]);
  expect(Object.keys(r.series)).not.toContain('(root)'); // package-lock.json is skipped
  const again = await gitLines(repo, data); // cached
  expect(again).toEqual(r);
});

test('log covers every branch with parents and branch names', async () => {
  git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
  write('side.txt', 's\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'On side'], '2026-10-03T10:00:00Z');
  git(['checkout', '-q', 'main']);
  const all = await gitLog(repo, {});
  expect(all.map((c) => c.subject).sort()).toEqual(['Add a', 'Add b', 'Extend a and add docs', 'On side']);
  const side = all.find((c) => c.subject === 'On side')!;
  expect(side.refs).toEqual(['side']);
  expect(side.parents).toEqual([all.find((c) => c.subject === 'Extend a and add docs')!.sha]);
  expect(all.find((c) => c.subject === 'Add b')!.refs).toEqual(['main']);
});

test('graph lanes: a branch splits off and the history joins again', () => {
  // a <- b <- d (main), a <- c (side), m merges d and c
  const { rows, width } = graphLayout([
    { sha: 'm', parents: ['d', 'c'] },
    { sha: 'd', parents: ['b'] },
    { sha: 'c', parents: ['a'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);
  expect(width).toBe(2);
  expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0, 0]);
  expect(rows[0].segs).toEqual([
    [0, 0.5, 0, 1],
    [0, 0.5, 1, 1],
  ]);
  expect(rows[4].segs).toEqual([
    [0, 0, 0, 0.5],
    [1, 0, 0, 0.5],
  ]);
  // a parent outside the list leaves no dangling lane
  expect(graphLayout([{ sha: 'x', parents: ['gone'] }, { sha: 'y', parents: [] }]).rows.map((r) => r.lane)).toEqual([0, 0]);
});

test('commits find their session by printed id, else by when a git commit ran in that repository', () => {
  const at = (iso: string) => Date.parse(iso);
  const commits = [
    { sha: 'aaaaaaa1111', date: '2026-10-01T10:00:06+08:00' },
    { sha: 'bbbbbbb2222', date: '2026-10-01T02:00:07Z' }, // same moment as the run below, no printed id
    { sha: 'ccccccc3333', date: '2026-10-01T03:00:00Z' }, // nothing ran then
  ];
  const sessions = [
    { id: 'claude:printed', cwd: '/w/other', commitShas: ['aaaaaaa'] },
    { id: 'claude:quiet', cwd: '/w/repo/sub', commitRuns: [[at('2026-10-01T02:00:05Z'), at('2026-10-01T02:00:08Z')]] as [number, number][] },
    { id: 'claude:elsewhere', cwd: '/w/repo2', commitRuns: [[at('2026-10-01T02:00:05Z'), at('2026-10-01T02:00:08Z')]] as [number, number][] },
  ];
  const owner = linkCommits(commits, sessions, '/w/repo');
  expect(owner.get('aaaaaaa1111')).toBe('claude:printed');
  expect(owner.get('bbbbbbb2222')).toBe('claude:quiet');
  expect(owner.has('ccccccc3333')).toBe(false);
});

test('a broken branch name (a sync conflict copy) does not hide the history', async () => {
  const head = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main 2'), `${head}\n`);
  const all = await gitLog(repo, {});
  expect(all.length).toBeGreaterThan(0);
  fs.rmSync(path.join(repo, '.git', 'refs', 'heads', 'main 2'));
});

test('the commit list is cached until a branch moves', async () => {
  const cacheDir = path.join(data, 'gitcache');
  const first = await gitLog(repo, { cacheDir });
  expect(fs.readdirSync(cacheDir)).toHaveLength(1);
  expect(await gitLog(repo, { cacheDir })).toEqual(first);
  write('later.txt', 'x\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Later'], '2026-10-04T10:00:00Z');
  const next = await gitLog(repo, { cacheDir });
  expect(next.length).toBe(first.length + 1);
});
