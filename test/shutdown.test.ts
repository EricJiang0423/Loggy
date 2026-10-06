import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { start } from '../src/server/app';
import { DEFAULT_AI_MODEL } from '../src/server/config';

test('closing the server does not wait for an open page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-close-'));
  const app = await start(
    { port: 0, host: '127.0.0.1', open: false, demo: false, rebuild: true, claudeDirs: [path.join(dir, 'claude')], codexDirs: [path.join(dir, 'codex')], dataDir: path.join(dir, 'data'), aiModel: DEFAULT_AI_MODEL, version: 'test' },
    { quiet: true, workerUrl: null, autoSummaries: false },
  );
  // a page's event stream stays open until the server ends it
  await new Promise<void>((resolve) => http.get(`${app.url}/api/events`, (res) => (res.on('error', () => undefined), resolve())).on('error', () => undefined));
  const done = await Promise.race([app.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
  expect(done).toBe('closed');
  fs.rmSync(dir, { recursive: true, force: true });
});
