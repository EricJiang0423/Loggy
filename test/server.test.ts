import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { start, type Running } from '../src/server/app';
import { DEFAULT_AI_MODEL } from '../src/server/config';
import { generateDemo } from '../src/server/demo';

let app: Running;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-srv-'));
  generateDemo(dir, { sessions: 30, seed: 11 });
  app = await start(
    {
      port: 0,
      host: '127.0.0.1',
      open: false,
      demo: false,
      rebuild: true,
      claudeDirs: [path.join(dir, 'claude')],
      codexDirs: [path.join(dir, 'codex')],
      dataDir: path.join(dir, 'data'),
      aiModel: DEFAULT_AI_MODEL,
      version: 'test',
    },
    { quiet: true, workerUrl: null },
  );
  for (let i = 0; i < 100 && app.indexer.progress.phase !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('http api', () => {
  test('lists sessions and returns deltas', async () => {
    const full = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    expect(full.full).toBe(true);
    expect(full.sessions.length).toBeGreaterThanOrEqual(30);
    const delta = (await (await fetch(`${app.url}/api/sessions?since=${full.gen}`)).json()) as any;
    expect(delta.full).toBe(false);
    expect(delta.sessions.length).toBe(0);
  });

  test('returns a session detail with a completion check', async () => {
    const { sessions } = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    const s = sessions.find((x: { isSubagent: boolean }) => !x.isSubagent);
    const d = (await (await fetch(`${app.url}/api/session?id=${encodeURIComponent(s.id)}`)).json()) as any;
    expect(d.summary.id).toBe(s.id);
    expect(d.turns.length).toBe(s.turns);
    expect(d.completion).toHaveProperty('turnEnded');
  });

  test('picks up appended lines without a restart', async () => {
    const before = ((await (await fetch(`${app.url}/api/state`)).json()) as { generation: number }).generation;
    const file = [...app.indexer.entries.values()].find((e) => e.agent === 'claude' && !e.summary.isSubagent)!.file;
    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'x', timestamp: new Date().toISOString(), promptId: 'new', cwd: '/w', isSidechain: false, message: { role: 'user', content: 'one more thing' } }) + '\n');
    let after = before;
    for (let i = 0; i < 100 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 50));
      after = ((await (await fetch(`${app.url}/api/state`)).json()) as { generation: number }).generation;
    }
    expect(after).toBeGreaterThan(before);
  });

  test('search finds sessions by prompt text', async () => {
    const r = (await (await fetch(`${app.url}/api/search?q=calendar`)).json()) as { ids: string[] };
    expect(r.ids.length).toBeGreaterThan(0);
  });

  test('rejects foreign Host headers (DNS rebinding)', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const u = new URL(app.url);
      http.get({ host: u.hostname, port: u.port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(403);
  });

  test('summaries need an API key', async () => {
    const res = await fetch(`${app.url}/api/summarize?id=x`, { method: 'POST' });
    expect([400, 404]).toContain(res.status);
  });
});
