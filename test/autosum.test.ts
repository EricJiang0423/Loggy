import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { start, type Running } from '../src/server/app';
import { needsSummary, SUMMARY_FORMAT } from '../src/server/autosum';
import { DEFAULT_AI_MODEL } from '../src/server/config';
import { generateDemo } from '../src/server/demo';
import { writeSettings } from '../src/server/settings';

const DAY = 86400_000;
const now = Date.UTC(2026, 9, 6, 12);
const session = (end: number, status = 'ended') => ({ end, turns: 3, status }) as never;
const saved = (createdAt: number, end: number, extra = {}) => ({ format: SUMMARY_FORMAT, lang: 'zh-CN', createdAt, basis: { end, turns: 3 }, ...extra }) as never;

describe('which sessions get a summary', () => {
  test('sessions of the last 7 days without one, once they are not running', () => {
    expect(needsSummary(session(now - DAY), undefined, now, 'zh-CN', 7)).toBe(true);
    expect(needsSummary(session(now - 8 * DAY), undefined, now, 'zh-CN', 7)).toBe(false);
    expect(needsSummary(session(now - 60_000, 'running'), undefined, now, 'zh-CN', 7)).toBe(false);
    expect(needsSummary(session(now - 60_000, 'needs_input'), undefined, now, 'zh-CN', 7)).toBe(false);
  });

  test('a changed session is summarized again at most once a day', () => {
    const end = now - 2 * 3600_000;
    expect(needsSummary(session(end), saved(now - 3 * 3600_000, end), now, 'zh-CN', 7)).toBe(false); // unchanged
    expect(needsSummary(session(end), saved(now - 3 * 3600_000, end - 3600_000), now, 'zh-CN', 7)).toBe(false); // changed, but summarized today
    expect(needsSummary(session(end), saved(now - 25 * 3600_000, end - 3600_000), now, 'zh-CN', 7)).toBe(true); // changed, summary older than a day
  });

  test('older formats and another language are replaced', () => {
    const end = now - DAY;
    expect(needsSummary(session(end), saved(now - 3600_000, end, { format: 1 }), now, 'zh-CN', 7)).toBe(true);
    expect(needsSummary(session(end), saved(now - 3600_000, end, { lang: 'en' }), now, 'zh-CN', 7)).toBe(true);
  });
});

describe('automatic summaries end to end', () => {
  let app: Running;
  let gw: http.Server;
  let dir = '';
  let calls = 0;

  beforeAll(async () => {
    gw = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls++;
        const body = JSON.parse(raw);
        const system = String(body.messages?.[0]?.content ?? '');
        const reply = (content: string) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
        };
        if (system.includes('STEP 1')) return reply(JSON.stringify({ projects: [] }));
        if (system.includes('STEP 2')) return reply(JSON.stringify({ categories: [{ name: 'Apps', description: 'app work' }], projects: [] }));
        if (system.includes('STEP 3')) return reply(JSON.stringify({ sessions: [] }));
        const summary = { title: '自动标题', bullets: ['完成了一件事'], decisions: [], unverified: ['没有在浏览器里看过'], concerns: [], openQuestions: [], nextSteps: ['检查一下页面'], requests: [], type: 'implementation', workComplete: false };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(summary) }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-auto-'));
    generateDemo(dir, { sessions: 12, seed: 5, days: 3 });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeSettings(path.join(dir, 'data'), { ai: { provider: 'openai', baseURL: base, model: 'corp', auto: true, lang: 'zh-CN' } });
    app = await start(
      { port: 0, host: '127.0.0.1', open: false, demo: false, rebuild: true, claudeDirs: [path.join(dir, 'claude')], codexDirs: [path.join(dir, 'codex')], dataDir: path.join(dir, 'data'), aiModel: DEFAULT_AI_MODEL, version: 'test' },
      { quiet: true, workerUrl: null, autoSummaries: false },
    );
    for (let i = 0; i < 100 && app.indexer.progress.phase !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    await app.close();
    gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a run summarizes the recent sessions and the list shows the result', async () => {
    const res = (await (await fetch(`${app.url}/api/ai/auto/run?wait=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as any;
    expect(res.done).toBeGreaterThan(0);
    expect(res.failed).toBe(0);
    const { sessions } = (await (await fetch(`${app.url}/api/sessions`)).json()) as any;
    const withAi = sessions.filter((s: any) => s.ai);
    expect(withAi.length).toBe(res.done);
    expect(withAi[0].ai).toMatchObject({ title: '自动标题', next: ['检查一下页面'], type: 'implementation' });
    // the run also built the smart categories; every recent session falls back to its project's
    const state = (await (await fetch(`${app.url}/api/state`)).json()) as any;
    expect(state.ai.categories).toEqual([{ name: 'Apps', description: 'app work' }]);
    expect(withAi.every((x: any) => x.category === 'Apps')).toBe(true);
    const before = calls;
    const again = (await (await fetch(`${app.url}/api/ai/auto/run?wait=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as any;
    expect(again.done).toBe(0);
    expect(calls).toBe(before);
  });
});
