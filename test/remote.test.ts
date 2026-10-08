import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { summarizeFile } from '../src/core/parse';
import { allHosts, hostKey, writeCloudRollout } from '../src/server/remote';

test('finds SSH hosts in the Claude and Codex apps, one per destination', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-remote-'));
  const claude = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'ssh_configs.json'), JSON.stringify({ configs: [{ name: 'gz', sshHost: 'me@10.0.0.1', sshIdentityFile: '~/.ssh/id', id: 'x' }] }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(
    path.join(home, '.codex', '.codex-global-state.json'),
    JSON.stringify({ 'codex-managed-remote-connections': [{ displayName: 'same', hostname: 'me@10.0.0.1' }, { displayName: 'box', hostname: 'me@10.0.0.2', sshPort: 2222 }] }),
  );
  const prev = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const hosts = allHosts([{ target: 'devbox', from: 'manual' }], home);
    expect(hosts.map((h) => [h.target, h.from])).toEqual([
      ['devbox', 'manual'],
      ['me@10.0.0.1', 'claude'],
      ['me@10.0.0.2', 'codex'],
    ]);
    expect(hostKey(hosts[2])).toBe('me@10.0.0.2_2222');
  } finally {
    if (prev !== undefined) process.env.CODEX_HOME = prev;
  }
});

test('a Codex Cloud task reads as a finished one-turn session in its repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-cloud-'));
  const task = { id: 'task_e_abc', title: 'Fix login', status: 'ready', updated_at: '2026-10-01T10:00:00Z', environment_label: 'acme/web', url: 'https://chatgpt.com/codex/tasks/task_e_abc', summary: { files_changed: 2, lines_added: 10, lines_removed: 3 } };
  writeCloudRollout(dir, task);
  const file = path.join(dir, 'rollout-cloud-task_e_abc.jsonl');
  const mtime = fs.statSync(file).mtimeMs;
  writeCloudRollout(dir, task); // unchanged: not rewritten
  expect(fs.statSync(file).mtimeMs).toBe(mtime);
  const r = summarizeFile(file, 'codex') as any;
  const s = r.summary ?? r;
  expect(s).toMatchObject({ sessionId: 'task_e_abc', firstPrompt: 'Fix login', turns: 1, repo: 'https://github.com/acme/web', entrypoint: 'Codex Cloud' });
  expect(s.lastTurn.ended).toBe(true);
});
