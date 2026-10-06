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
  expect(r.projects.get('t1')).toBe('Nightly jobs');
  expect(r.projects.has('t3')).toBe(false);
  expect(readCodexThreads(path.join(home, 'missing')).names.size).toBe(0);

  // Smart grouping puts the thread in its Codex project, even though its folder is shared.
  const S = (id: string, sessionId: string, cwd: string) => ({ id, sessionId, cwd, agent: 'codex', isSubagent: false, project: '', projectPath: '' }) as SessionSummary;
  const list = [S('codex:t1', 't1', '/w'), S('codex:t2', 't2', '/w')];
  groupProjects(list, 'smart', (cwd) => ({ root: cwd, isGit: false }), () => true, r.projects);
  expect(list[0].project).toBe('Nightly jobs');
  expect(list[1].project).toBe('w');
  fs.rmSync(home, { recursive: true, force: true });
});
