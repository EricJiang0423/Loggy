import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readCodexThreads } from '../src/server/codexstate';
import { groupProjects } from '../src/server/projects';
import type { SessionSummary } from '../src/shared/types';

test('Codex thread names (latest rename wins) and Codex app projects', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-codexhome-'));
  fs.writeFileSync(
    path.join(home, 'session_index.jsonl'),
    [
      { id: 't1', thread_name: 'first name', updated_at: '2026-10-01T10:00:00Z' },
      { id: 't2', thread_name: 'other', updated_at: '2026-10-01T11:00:00Z' },
      { id: 't1', thread_name: '0918 | renamed', updated_at: '2026-10-03T10:00:00Z' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(home, '.codex-global-state.json'),
    JSON.stringify({ 'local-projects': { p1: { id: 'p1', name: 'Nightly jobs', rootPaths: ['/w'] } }, 'thread-project-assignments': { t1: { projectKind: 'local', projectId: 'p1' }, t3: { projectKind: 'local', projectId: 'gone' } } }),
  );
  const r = readCodexThreads(home);
  expect(r.names.get('t1')).toBe('0918 | renamed');
  expect(r.names.get('t2')).toBe('other');
  expect(r.projects.get('t1')).toEqual(['/w']);
  expect(r.projects.has('t3')).toBe(false);
  expect(readCodexThreads(path.join(home, 'missing')).names.size).toBe(0);

  // A Codex project is a folder like any other: a thread that ran elsewhere counts as in it, and
  // shares the group with Claude sessions there.
  const S = (id: string, sessionId: string, cwd: string) => ({ id, sessionId, cwd, agent: 'codex', isSubagent: false, project: '', projectPath: '' }) as SessionSummary;
  const list = [S('codex:t1', 't1', '/scratch/2026-10-01/x'), S('claude:c1', 'c1', '/w'), S('codex:t2', 't2', '/elsewhere')];
  groupProjects(list, 'smart', (cwd) => ({ root: cwd, isGit: false }), () => true, new Map([['t1', '/w']]));
  expect(list[0].project).toBe('w');
  expect(list[1].project).toBe('w');
  expect(list[2].project).toBe('elsewhere');
  fs.rmSync(home, { recursive: true, force: true });
});
