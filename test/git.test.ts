import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { gitLines, gitLog, gitShow } from '../src/server/git';

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
