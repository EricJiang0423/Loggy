import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { detectHarnesses } from '../src/server/harnesses';

test('a harness counts as installed when its logs or its command are found', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-h-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'claude', 'projects'), { recursive: true });
  const before = process.env.PATH;
  process.env.PATH = bin;
  try {
    const found = detectHarnesses({ claude: [path.join(root, 'claude', 'projects')], codex: [path.join(root, 'none')], kimi: [path.join(root, 'none2')], pi: [path.join(root, 'none3')] });
    const by = Object.fromEntries(found.map((h) => [h.agent, h]));
    expect(by.claude).toMatchObject({ installed: true, logs: true });
    expect(by.pi).toMatchObject({ installed: true, logs: false, command: true });
    // codex / kimi: no logs and no command in this PATH (a real install elsewhere may still show as an app)
    expect(by.codex.logs).toBe(false);
    expect(by.kimi.logs).toBe(false);
  } finally {
    process.env.PATH = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
