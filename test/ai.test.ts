import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseSummaryJson, resolveAi, summarizeWithAi, testAi } from '../src/server/ai';
import { readSettings, writeSettings } from '../src/server/settings';

const SUMMARY = { title: 'Calendar view', bullets: ['Added a week view'], decisions: [], unverified: [], concerns: [], openQuestions: [], nextSteps: [], requests: [{ text: 'add it', kind: 'request', done: true }], type: 'implementation', workComplete: true };

const detail = {
  summary: { id: 'claude:s1', project: 'demo', cwd: '/w/demo', branch: 'main' },
  turns: [{ idx: 1, prompt: 'add a calendar', response: 'Done.', files: [], interrupted: false }],
  timeline: [],
  commits: [],
  questions: [],
} as unknown as Parameters<typeof summarizeWithAi>[2];

describe('which AI endpoint is used', () => {
  test('environment only: the Anthropic key and the default model', () => {
    expect(resolveAi(undefined, { ANTHROPIC_API_KEY: 'k' }, 'claude-haiku-4-5')).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', source: 'env' });
    expect(resolveAi(undefined, {}, 'm')).toBeUndefined();
  });

  test('saved settings win, and the key can come from a named variable', () => {
    const r = resolveAi({ provider: 'openai', baseURL: 'https://llm.corp/v1', model: 'corp-large', apiKeyEnv: 'CORP_KEY' }, { CORP_KEY: 'secret', ANTHROPIC_API_KEY: 'other' }, 'm');
    expect(r).toMatchObject({ provider: 'openai', baseURL: 'https://llm.corp/v1', model: 'corp-large', apiKey: 'secret', source: 'settings' });
  });

  test('a gateway without a key is allowed; turning it off wins over the environment', () => {
    expect(resolveAi({ provider: 'openai', baseURL: 'http://gw/v1', model: 'x' }, {}, 'm')).toMatchObject({ apiKey: undefined });
    expect(resolveAi({ enabled: false }, { ANTHROPIC_API_KEY: 'k' }, 'm')).toBeUndefined();
    expect(resolveAi({ provider: 'openai', model: 'x' }, {}, 'm')).toBeUndefined(); // OpenAI format needs an address
  });
});

test('summary JSON is read from fenced or chatty replies and checked', () => {
  expect(parseSummaryJson('```json\n' + JSON.stringify(SUMMARY) + '\n```').title).toBe('Calendar view');
  expect(parseSummaryJson('Here you go:\n' + JSON.stringify(SUMMARY) + '\nThanks').workComplete).toBe(true);
  expect(() => parseSummaryJson('{"title": "x"}')).toThrow();
  expect(() => parseSummaryJson('no json here')).toThrow();
});

test('settings are merged and stored privately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-set-'));
  writeSettings(dir, { groupBy: 'repo' });
  writeSettings(dir, { ai: { provider: 'openai', baseURL: 'http://gw/v1', model: 'x', apiKey: 'k' } });
  expect(readSettings(dir)).toMatchObject({ groupBy: 'repo', ai: { model: 'x', apiKey: 'k' } });
  if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'settings.json')).mode & 0o077).toBe(0);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('company gateways', () => {
  let server: http.Server;
  let base = '';
  let dataDir = '';
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-ai-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ url: req.url ?? '', headers: req.headers, body });
        const text = '```json\n' + JSON.stringify(SUMMARY) + '\n```';
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/chat/completions') {
          res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
        } else if (req.url === '/v1/messages') {
          res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('OpenAI-compatible endpoint with a bearer key and extra headers', async () => {
    const r = resolveAi({ provider: 'openai', baseURL: `${base}/v1`, model: 'corp-large', apiKey: 'sk-corp', headers: { 'X-Team': 'quant' } }, {}, 'm')!;
    const s = await summarizeWithAi(dataDir, r, detail, 'zh-CN');
    expect(s).toMatchObject({ title: 'Calendar view', model: 'corp-large', lang: 'zh-CN' });
    const req = seen.at(-1)!;
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-corp');
    expect(req.headers['x-team']).toBe('quant');
    expect(req.body.model).toBe('corp-large');
  });

  test('Anthropic-format gateway with either auth style', async () => {
    for (const auth of ['bearer', 'x-api-key'] as const) {
      const r = resolveAi({ provider: 'anthropic', baseURL: base, model: 'corp-claude', apiKey: 'tok', auth }, {}, 'm')!;
      const s = await summarizeWithAi(dataDir, r, detail, 'en');
      expect(s.title).toBe('Calendar view');
      const req = seen.at(-1)!;
      expect(req.url).toBe('/v1/messages');
      if (auth === 'bearer') expect(req.headers.authorization).toBe('Bearer tok');
      else expect(req.headers['x-api-key']).toBe('tok');
    }
  });

  test('connection test reports the model and timing', async () => {
    const r = resolveAi({ provider: 'openai', baseURL: `${base}/v1`, model: 'corp-large' }, {}, 'm')!;
    expect(await testAi(r)).toMatchObject({ ok: true, model: 'corp-large' });
    const bad = resolveAi({ provider: 'openai', baseURL: `${base}/nope`, model: 'corp-large' }, {}, 'm')!;
    expect(await testAi(bad)).toMatchObject({ ok: false });
  });
});
