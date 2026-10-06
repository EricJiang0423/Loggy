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

  test('related sessions share edited files', async () => {
    const { sessions } = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    const s = sessions.find((x: any) => !x.isSubagent && x.filesChanged > 0);
    const r = (await (await fetch(`${app.url}/api/related?id=${encodeURIComponent(s.id)}`)).json()) as any;
    expect(Array.isArray(r.related)).toBe(true);
    for (const x of r.related) expect(x.id).not.toBe(s.id);
    expect(r.related.length).toBeGreaterThan(0); // demo sessions in one project reuse the same file names
  });

  test('bookmarks, labels and notes are kept per session', async () => {
    const { sessions } = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    const id = sessions.find((x: any) => !x.isSubagent).id;
    const post = (body: unknown) => fetch(`${app.url}/api/mark`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ id, star: true, label: 'later' })).status).toBe(200);
    expect((await post({ id, note: 'check the migration' })).status).toBe(200);
    expect((await post({ id, label: 'bogus' })).status).toBe(400);
    const after = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    expect(after.sessions.find((x: any) => x.id === id).mark).toMatchObject({ star: true, label: 'later', note: 'check the migration' });
    await post({ id, star: false, label: null, note: '' });
    const cleared = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    expect(cleared.sessions.find((x: any) => x.id === id).mark).toBeUndefined();
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

  test('AI settings: JSON only, the key is never sent back, and the connection can be tested', async () => {
    const post = (p: string, body: unknown, type = 'application/json') => fetch(`${app.url}${p}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
    expect((await post('/api/settings/ai', { model: 'x' }, 'text/plain')).status).toBe(400);
    const saved = (await (await post('/api/settings/ai', { provider: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'corp-model', apiKey: 'sk-very-secret', headers: { 'X-Team': 'q' } })).json()) as any;
    expect(saved.ai).toMatchObject({ provider: 'openai', model: 'corp-model', hasKey: true, headers: { 'X-Team': 'q' } });
    const stateText = await (await fetch(`${app.url}/api/state`)).text();
    expect(stateText).not.toContain('sk-very-secret');
    expect(JSON.parse(stateText).aiAvailable).toBe(true);
    const tested = (await (await post('/api/ai/test', { provider: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'corp-model' })).json()) as any;
    expect(tested.ok).toBe(false);
    // omitting the key keeps it; an empty key clears it
    expect(((await (await post('/api/settings/ai', { provider: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'm2' })).json()) as any).ai.hasKey).toBe(true);
    expect(((await (await post('/api/settings/ai', { provider: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'm2', apiKey: '' })).json()) as any).ai.hasKey).toBe(false);
  });

  test('summaries need an API key', async () => {
    const res = await fetch(`${app.url}/api/summarize?id=x`, { method: 'POST' });
    expect([400, 404]).toContain(res.status);
  });
});
