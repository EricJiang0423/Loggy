import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { handOff, shq } from '../src/server/launch';
import type { SessionSummary } from '../src/shared/types';

test('handoff writes the file and a command whose first message names the old session', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-handoff-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "it's here "));
  const from = { agent: 'codex', sessionId: '0199a0b0-0000-7000-8000-000000000001', cwd, projectPath: cwd, title: 'x' } as SessionSummary;
  const r = await handOff(data, from, 'claude', 'copy', '# handoff\nnext: ship it', 'zh-CN');
  expect(fs.readFileSync(r.file, 'utf8')).toContain('ship it');
  expect(r.cwd).toBe(cwd);
  expect(r.command.startsWith('claude ')).toBe(true);
  // The quoted message reaches the program intact, so the chain can be linked from it.
  const arg = execFileSync('sh', ['-c', `printf %s ${r.command.slice('claude '.length)}`], { encoding: 'utf8' });
  expect(arg).toContain('codex:0199a0b0-0000-7000-8000-000000000001');
  expect(arg).toContain(r.file);
  expect(execFileSync('sh', ['-c', `printf %s ${shq(cwd)}`], { encoding: 'utf8' })).toBe(cwd);
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
