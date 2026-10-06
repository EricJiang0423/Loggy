import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inLanguage, summarizeWithAi, type AiConfig } from '../src/server/ai';
import { needsSummary, SUMMARY_FORMAT } from '../src/server/autosum';

describe('language check', () => {
  test('Chinese with English names and code passes; English does not', () => {
    expect(inLanguage(['修复 Codex 的 token 统计 bug', '在 `src/server/git.ts` 里按时间匹配提交'], 'zh-CN')).toBe(true);
    expect(inLanguage(['Fix the token count in Codex', 'Match commits by time'], 'zh-CN')).toBe(false);
    expect(inLanguage(['Fix the token count in Codex'], 'en')).toBe(true);
    expect(inLanguage(['修复统计问题，并补上测试'], 'en')).toBe(false);
    expect(inLanguage(['v0.6.1', 'npm test'], 'zh-CN')).toBe(true); // nothing to judge
  });

  test('a saved summary in the wrong language is redone', () => {
    const now = Date.UTC(2026, 9, 7);
    const saved = { format: SUMMARY_FORMAT, lang: 'zh-CN', createdAt: now - 3600_000, basis: { end: now - 7200_000, turns: 3 }, title: 'Add a calendar view', bullets: ['Added the week view'], decisions: [], requests: [] } as never;
    expect(needsSummary({ end: now - 7200_000, turns: 3, status: 'ended' }, saved, now, 'zh-CN', 7)).toBe(true);
  });
});

describe('summaries are written in the chosen language', () => {
  let gw: http.Server;
  let base = '';
  let dir = '';
  const replies: string[] = [];
  const prompts: string[] = [];

  beforeAll(async () => {
    gw = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        prompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'));
        const title = replies.shift() ?? 'Add a calendar view';
        const summary = { title, bullets: [title], decisions: [], unverified: [], concerns: [], openQuestions: [], nextSteps: [], requests: [], type: 'implementation', workComplete: true };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(summary) } }] }));
      });
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-lang-'));
  });

  afterAll(() => {
    gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ai: () => AiConfig = () => ({ provider: 'openai', baseURL: base, model: 'm', auth: 'bearer', headers: {}, source: 'settings' });
  const detail = { summary: { id: 'claude:x', project: 'p', cwd: '/w/p', end: 1, turns: 1 }, turns: [], timeline: [], commits: [], questions: [], files: [] } as never;

  test('an answer in the wrong language is asked for again', async () => {
    replies.push('Add a calendar view', '加入周日历视图');
    prompts.length = 0;
    const s = await summarizeWithAi(dir, ai(), detail, 'zh-CN');
    expect(s.title).toBe('加入周日历视图');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Simplified Chinese');
    expect(prompts[1]).toContain('was not written in Simplified Chinese');
  });

  test('two answers in the wrong language fail instead of being saved', async () => {
    replies.push('Add a calendar view', 'Add a week view');
    await expect(summarizeWithAi(dir, ai(), detail, 'zh-CN')).rejects.toThrow(/Simplified Chinese/);
  });
});
