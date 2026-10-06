import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Indexer } from '../src/server/indexer';
import { Pool } from '../src/server/pool';

// Claude Code keeps ~/.claude/sessions/<pid>.json for each running process with its current
// state: busy, waiting (a permission prompt or a question) or idle.
test('a live Claude process state overrides the guess from the log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-live-'));
  const claude = path.join(root, 'claude');
  const proj = path.join(claude, 'projects', '-w-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(claude, 'sessions'));
  const sid = 'cccccccc-0000-4000-8000-000000000003';
  const now = new Date().toISOString();
  const recs = [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, sessionId: sid, cwd: '/w/app', timestamp: now, promptId: 'p1', origin: { kind: 'human' }, message: { role: 'user', content: 'run the tests' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, sessionId: sid, cwd: '/w/app', timestamp: now, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ix = new Indexer({ claudeDirs: [claude], codexDirs: [] }, new Pool(undefined), path.join(root, 'data'));
  await ix.scan();
  expect(ix.summaries()[0].status).toBe('running'); // the log alone says the tool call is open

  const pidFile = path.join(claude, 'sessions', `${process.pid}.json`);
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, sessionId: sid, status: 'waiting', statusUpdatedAt: Date.now() }));
  expect(ix.summaries()[0].status).toBe('needs_input'); // waiting for approval, right away

  fs.writeFileSync(pidFile, JSON.stringify({ pid: 999_999_999, sessionId: sid, status: 'waiting', statusUpdatedAt: Date.now() }));
  expect(ix.summaries()[0].status).toBe('running'); // that process is gone: ignore the file
  fs.rmSync(root, { recursive: true, force: true });
});
