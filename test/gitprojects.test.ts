import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { findGitProjects } from '../src/server/gitprojects';
import { readRemote, type Place } from '../src/server/projects';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-gp-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function repo(dir: string, remote: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

const placeOf = (cwd: string): Place => {
  for (let d = cwd; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return { root: d, isGit: true, remote: readRemote(d) };
    if (path.dirname(d) === d) return { root: cwd, isGit: false };
  }
};

test('a project grouped by its remote finds its clone below the folder its sessions ran in', () => {
  const work = path.join(root, 'work');
  const app = repo(path.join(work, 'Project', 'APP'), 'git@github.com:Team/App.git');
  const tool = repo(path.join(root, 'code', 'tool'), 'https://github.com/team/tool');
  const s = (id: string, cwd: string, projectPath: string, project: string) => ({ id, cwd, projectPath, project, isSubagent: false }) as never;
  const found = findGitProjects(
    [
      s('a', work, 'repo:github.com/team/app', 'APP'), // started in the parent folder, named the repo in a PR link
      s('b', path.join(tool, 'src'), tool, 'tool'), // ran inside the repo
      s('c', work, work, 'work'), // a plain folder: no repository
    ],
    placeOf,
  );
  expect(found).toEqual([
    { path: app, name: 'APP', groups: ['repo:github.com/team/app'] },
    { path: tool, name: 'tool', groups: [tool] },
  ]);
});
