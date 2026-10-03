import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { detailFile, summarizeFile } from '../src/core/parse';
import { generateDemo, type DemoExpectation } from '../src/server/demo';

let dir: string;
let exps: DemoExpectation[];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-test-'));
  exps = generateDemo(dir, { sessions: 60, seed: 7, now: Date.UTC(2026, 9, 3, 12) });
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function tokensOf(s: ReturnType<typeof summarizeFile>['summary']): number {
  return s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
}

describe('synthetic logs', () => {
  test('summaries match what the generator wrote', () => {
    expect(exps.length).toBeGreaterThan(60);
    for (const e of exps) {
      const { summary: s } = summarizeFile(e.file, e.agent);
      const ctx = `${e.agent} ${path.basename(e.file)}`;
      expect(s.turns, ctx).toBe(e.turns);
      expect(s.userInputs, ctx).toBe(e.inputs);
      expect(tokensOf(s), ctx).toBe(e.tokens);
      expect(s.filesChanged, ctx).toBe(e.filesChanged);
      expect(s.linesAdded, ctx).toBe(e.linesAdded);
      expect(s.linesRemoved, ctx).toBe(e.linesRemoved);
      expect(s.commits, ctx).toBe(e.commits);
      expect(s.pushes, ctx).toBe(e.pushes);
      expect(s.interrupts, ctx).toBe(e.interrupts);
      expect(s.compactions, ctx).toBe(e.compactions);
      expect(s.questions, ctx).toBe(e.questions);
      expect(s.isSubagent, ctx).toBe(e.subagent);
      if (e.running) expect(s.lastTurn.ended, ctx).toBe(false);
      expect(s.costUSD).toBeGreaterThanOrEqual(0);
    }
  });

  test('detail view agrees with the summary', () => {
    for (const e of exps.slice(0, 20)) {
      const d = detailFile(e.file, e.agent);
      expect(d.turns.length).toBe(e.turns);
      expect(d.commits.length).toBe(e.commits);
      expect(d.files.length).toBe(e.filesChanged);
      expect(d.timeline.length).toBeGreaterThan(0);
      expect(d.timeline.filter((t) => t.kind === 'user').length).toBe(e.inputs);
    }
  });

  test('resuming from a cached state gives the same result as a full parse', () => {
    for (const e of exps.filter((x) => !x.subagent).slice(0, 12)) {
      const full = summarizeFile(e.file, e.agent);
      const text = fs.readFileSync(e.file, 'utf8');
      const lines = text.split('\n');
      const half = lines.slice(0, Math.floor(lines.length / 2)).join('\n') + '\n';
      const tmp = path.join(dir, `part-${path.basename(e.file)}`);
      fs.writeFileSync(tmp, half);
      const first = summarizeFile(tmp, e.agent);
      fs.writeFileSync(tmp, text);
      const resumed = summarizeFile(tmp, e.agent, { state: JSON.parse(JSON.stringify(first.state)), offset: first.offset });
      expect(resumed.summary.turns).toBe(full.summary.turns);
      expect(tokensOf(resumed.summary)).toBe(tokensOf(full.summary));
      expect(resumed.summary.linesAdded).toBe(full.summary.linesAdded);
      expect(resumed.summary.costUSD).toBeCloseTo(full.summary.costUSD, 6);
      fs.rmSync(tmp);
    }
  });
});

function writeLines(name: string, recs: unknown[], tail = '\n'): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + tail);
  return f;
}

describe('claude edge cases', () => {
  const base = { cwd: '/w/p', sessionId: 's1', version: '2.1.280', gitBranch: 'main', isSidechain: false };
  test('usage repeated on split rows is counted once, using the largest value', () => {
    const f = writeLines('dup.jsonl', [
      { ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', promptId: 'p1', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } },
      { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:05Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 5 } } },
      { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-10-01T10:00:06Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } } },
    ]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.tokens).toMatchObject({ input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 });
    expect(summary.turns).toBe(1);
    expect(summary.outcome).toBe('done');
    // opus 5.5: 10*4 + 50*20 + 1000*0.2 + 100*4*1.25 = 1740 per million
    expect(summary.costUSD).toBeCloseTo(0.00174, 8);
  });

  test('meta records, tool results and interrupts do not start turns', () => {
    const f = writeLines('meta.jsonl', [
      { ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', promptId: 'p1', message: { role: 'user', content: 'do it' } },
      { ...base, type: 'user', uuid: 'u2', timestamp: '2026-10-01T10:00:00Z', promptId: 'p1', isMeta: true, message: { role: 'user', content: 'ctx' } },
      { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:02Z', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...base, type: 'user', uuid: 'u3', timestamp: '2026-10-01T10:00:03Z', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: true }] }, toolUseResult: { stdout: '', stderr: 'x', interrupted: false } },
      { ...base, type: 'user', uuid: 'u4', timestamp: '2026-10-01T10:00:04Z', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.turns).toBe(1);
    expect(summary.toolErrors).toBe(1);
    expect(summary.interrupts).toBe(1);
    expect(summary.outcome).toBe('abandoned');
  });

  test('an unanswered AskUserQuestion leaves the session waiting for the user', () => {
    const f = writeLines('ask.jsonl', [
      { ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', promptId: 'p1', message: { role: 'user', content: 'plan it' } },
      { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:02Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'A or B?', options: [{ label: 'A' }] }] } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.lastTurn.awaitingReply).toBe(true);
    expect(summary.outcome).toBe('leftover');
  });

  test('a partial last line is left for the next read', () => {
    const f = path.join(dir, 'partial.jsonl');
    const line = JSON.stringify({ ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', promptId: 'p1', message: { role: 'user', content: 'x' } });
    fs.writeFileSync(f, line + '\n' + line.slice(0, 30));
    const r = summarizeFile(f, 'claude');
    expect(r.offset).toBe(line.length + 1);
    expect(r.summary.badLines).toBe(0);
  });
});

describe('codex edge cases', () => {
  test('cumulative token snapshots that go backwards are not subtracted or double counted', () => {
    const usage = (input: number, cached: number, out: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 0, total_tokens: input + out });
    const f = writeLines('rollout-2026-10-01T10-00-00-0199a0b0-0000-7000-8000-000000000001.jsonl', [
      { timestamp: '2026-10-01T10:00:00Z', type: 'session_meta', payload: { id: '0199a0b0-0000-7000-8000-000000000001', cwd: '/w/p', cli_version: '0.159.2', source: 'cli' } },
      { timestamp: '2026-10-01T10:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 100000 } },
      { timestamp: '2026-10-01T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.5-codex' } },
      { timestamp: '2026-10-01T10:00:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'go' }] } } },
      { timestamp: '2026-10-01T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: '2026-10-01T10:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1000, 800, 10), last_token_usage: usage(1000, 800, 10), model_context_window: 100000 } } },
      { timestamp: '2026-10-01T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(900, 700, 10), last_token_usage: usage(900, 700, 10) } } },
      { timestamp: '2026-10-01T10:00:04Z', type: 'token_usage_record', payload: { thread_token_usage: usage(1500, 1200, 20) } },
      { timestamp: '2026-10-01T10:00:05Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done.' } },
    ]);
    const { summary } = summarizeFile(f, 'codex');
    expect(summary.tokens.input + summary.tokens.cacheRead).toBe(1500);
    expect(summary.tokens.cacheRead).toBe(1200);
    expect(summary.tokens.output).toBe(20);
    expect(summary.userInputs).toBe(1);
    expect(summary.ctxPeakPct).toBeCloseTo(1, 5);
    expect(summary.outcome).toBe('done');
  });

  test('reads zstd-compressed rollouts', () => {
    const e = exps.find((x) => x.agent === 'codex' && !x.running)!;
    const z = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer };
    if (!z.zstdCompressSync) return;
    const f = path.join(dir, `${path.basename(e.file)}.zst`);
    fs.writeFileSync(f, z.zstdCompressSync(fs.readFileSync(e.file)));
    const a = summarizeFile(e.file, 'codex').summary;
    const b = summarizeFile(f, 'codex').summary;
    expect(b.turns).toBe(a.turns);
    expect(tokensOf(b)).toBe(tokensOf(a));
  });

  test('subagent threads point to their parent', () => {
    const f = writeLines('rollout-2026-10-01T11-00-00-0199a0b0-0000-7000-8000-000000000002.jsonl', [
      { timestamp: '2026-10-01T11:00:00Z', type: 'session_meta', payload: { id: '0199a0b0-0000-7000-8000-000000000002', cwd: '/w/p', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1 } } } } },
    ]);
    const { summary } = summarizeFile(f, 'codex');
    expect(summary.isSubagent).toBe(true);
    expect(summary.parentId).toBe('codex:parent-1');
  });
});
