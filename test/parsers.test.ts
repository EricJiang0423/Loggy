import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { detailFile, summarizeFile } from '../src/core/parse';
import { generateDemo, type DemoExpectation } from '../src/server/demo';
import { liveStatus } from '../src/shared/status';

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
    // token_usage_record repeats the same usage at thread level, so only token_count is counted.
    expect(summary.tokens.input + summary.tokens.cacheRead).toBe(1000);
    expect(summary.tokens.cacheRead).toBe(800);
    expect(summary.tokens.output).toBe(10);
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

describe('claude: real-log regressions', () => {
  const base = { cwd: '/w/p', sessionId: 's2', version: '2.1.280', gitBranch: 'main', isSidechain: false };
  let n = 0;
  const ts = () => new Date(Date.UTC(2026, 9, 1, 10, 0, n++)).toISOString();
  const human = (text: string) => ({ ...base, type: 'user', uuid: `u${n}`, timestamp: ts(), promptId: `p${n}`, origin: { kind: 'human' }, message: { role: 'user', content: text } });
  const reply = (id: string, content: unknown[], stop: string | null, extra: object = {}) => ({
    ...base,
    type: 'assistant',
    uuid: `a${n}`,
    timestamp: ts(),
    ...extra,
    message: { id, model: 'claude-opus-5', content, stop_reason: stop, usage: { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 10 } },
  });
  const toolResult = (id: string, r: object) => ({ ...base, type: 'user', uuid: `r${n}`, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: r });

  test('a message id that reappears after many others is still counted once', () => {
    const recs: unknown[] = [human('go')];
    for (let i = 0; i < 100; i++) recs.push(reply(`m${i}`, [{ type: 'text', text: 'x' }], null));
    recs.push(reply('m0', [{ type: 'text', text: 'x' }], 'end_turn'));
    const { summary } = summarizeFile(writeLines('far-dup.jsonl', recs), 'claude');
    expect(summary.tokens.output).toBe(1000);
  });

  test('background tasks finished through a queued notification are not pending', () => {
    const f = writeLines('bg-queue.jsonl', [
      human('run it in the background'),
      reply('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }], 'tool_use'),
      toolResult('t1', { stdout: '', backgroundTaskId: 'bgtask1' }),
      reply('m2', [{ type: 'text', text: 'Started.' }], 'end_turn'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: 's2', content: '<task-notification><task-id>bgtask1</task-id><status>completed</status></task-notification>' },
    ]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.pendingBackground).toBe(0);
    expect(summary.outcome).toBe('done');
  });

  test('background tasks finished through a queued-command attachment are not pending', () => {
    const f = writeLines('bg-attach.jsonl', [
      human('run it in the background'),
      reply('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }], 'tool_use'),
      toolResult('t1', { stdout: '', backgroundTaskId: 'bgtask2' }),
      { ...base, type: 'attachment', timestamp: ts(), attachment: { type: 'queued_command', prompt: '<task-notification><task-id>bgtask2</task-id></task-notification>', commandMode: 'task-notification' } },
      reply('m2', [{ type: 'text', text: 'Done.' }], 'end_turn'),
    ]);
    expect(summarizeFile(f, 'claude').summary.pendingBackground).toBe(0);
  });

  test('an API error ends the turn, so the session is not shown as running', () => {
    const f = writeLines('api-error.jsonl', [
      human('do it'),
      { ...base, type: 'assistant', uuid: 'e1', timestamp: ts(), isApiErrorMessage: true, error: 'rate_limit', message: { id: 'x1', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } } },
    ]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.lastTurn.ended).toBe(true);
    expect(summary.outcome).toBe('abandoned');
    expect(liveStatus({ ...summary, mtime: Date.parse('2026-10-01T10:01:00Z') }, Date.parse('2026-10-01T10:01:30Z'))).toBe('idle');
  });

  test('tool use after the turn ended (e.g. after a task notification) reopens the turn', () => {
    const f = writeLines('reopen.jsonl', [
      human('go'),
      reply('m1', [{ type: 'text', text: 'Waiting for the build.' }], 'end_turn'),
      reply('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'make' } }], 'tool_use'),
    ]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.lastTurn.ended).toBe(false);
  });

  test('a session continued in another session is not left unfinished', () => {
    const f = writeLines('continued.jsonl', [human('go'), human('and this'), { type: 'continued-in', timestamp: ts(), sessionId: 's2', continuedInSessionId: 's3' }]);
    const { summary } = summarizeFile(f, 'claude');
    expect(summary.lastTurn.ended).toBe(true);
    expect(summary.outcome).toBe('done');
  });

  test('a refusal ends the turn', () => {
    const f = writeLines('refusal.jsonl', [human('go'), reply('m1', [{ type: 'text', text: 'No.' }], 'refusal')]);
    expect(summarizeFile(f, 'claude').summary.lastTurn.ended).toBe(true);
  });

  test('a subagent whose final reply has no stop_reason is finished', () => {
    const sub = path.join(dir, 'parent-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const f = path.join(sub, 'agent-x1.jsonl');
    const recs = [
      { ...base, isSidechain: true, type: 'user', uuid: 'su1', timestamp: ts(), message: { role: 'user', content: 'look around' } },
      reply('s1', [{ type: 'tool_use', id: 'st1', name: 'Read', input: { file_path: '/w/p/a' } }], 'tool_use', { isSidechain: true }),
      { ...toolResult('st1', { type: 'text' }), isSidechain: true },
      reply('s2', [{ type: 'text', text: 'Found it.' }], null, { isSidechain: true }),
    ];
    fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(summarizeFile(f, 'claude').summary.outcome).toBe('done');
  });

  test('1M-context models are not measured against 200K', () => {
    const f = writeLines('ctx1m.jsonl', [
      human('go'),
      { ...base, type: 'assistant', uuid: 'c1', timestamp: ts(), message: { id: 'c1', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 0, cache_read_input_tokens: 150_000, output_tokens: 1 } } },
    ]);
    expect(summarizeFile(f, 'claude').summary.ctxPeakPct).toBeCloseTo(15, 5);
  });
});

describe('codex: real-log regressions', () => {
  const usage = (input: number, cached: number, out: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: 0, total_tokens: input + out });
  const tc = (t: string, total: ReturnType<typeof usage>, last: ReturnType<typeof usage>, window?: number) => ({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: window } } });
  const meta = (id: string, t: string, extra: object = {}) => ({ timestamp: t, type: 'session_meta', payload: { id, cwd: '/w/p', cli_version: '0.159.2', source: 'vscode', ...extra } });
  const ev = (t: string, payload: object) => ({ timestamp: t, type: 'event_msg', payload });
  const userMsg = (t: string, text: string) => ev(t, { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
  const id = (k: number) => `0199a0b0-0000-7000-8000-00000000010${k}`;

  test('totals inherited from a parent thread are not counted as the subagent usage', () => {
    const f = writeLines(`rollout-2026-10-01T12-00-00-${id(1)}.jsonl`, [
      meta(id(1), '2026-10-01T12:00:00Z', { forked_from_id: 'p', source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } }),
      ev('2026-10-01T12:00:00Z', { type: 'task_started', turn_id: 't1' }),
      userMsg('2026-10-01T12:00:00Z', 'check'),
      tc('2026-10-01T12:00:01Z', usage(1_000_000, 900_000, 5_000), usage(0, 0, 0)),
      tc('2026-10-01T12:00:02Z', usage(1_002_000, 901_000, 5_100), usage(2_000, 1_000, 100)),
      ev('2026-10-01T12:00:03Z', { type: 'task_complete', turn_id: 't1', last_agent_message: 'ok' }),
    ]);
    const { summary } = summarizeFile(f, 'codex');
    expect(summary.tokens.input + summary.tokens.cacheRead).toBe(2_000);
    expect(summary.tokens.output).toBe(100);
  });

  test('a counter that restarts after a resume keeps counting', () => {
    const f = writeLines(`rollout-2026-10-01T13-00-00-${id(2)}.jsonl`, [
      meta(id(2), '2026-10-01T13:00:00Z'),
      ev('2026-10-01T13:00:00Z', { type: 'task_started', turn_id: 't1' }),
      userMsg('2026-10-01T13:00:00Z', 'a'),
      tc('2026-10-01T13:00:01Z', usage(5_000, 0, 100), usage(5_000, 0, 100)),
      tc('2026-10-01T13:00:02Z', usage(6_000, 0, 200), usage(1_000, 0, 100)),
      ev('2026-10-01T13:00:03Z', { type: 'task_complete', turn_id: 't1' }),
      ev('2026-10-01T14:00:00Z', { type: 'task_started', turn_id: 't2' }),
      userMsg('2026-10-01T14:00:00Z', 'b'),
      tc('2026-10-01T14:00:01Z', usage(800, 0, 10), usage(800, 0, 10)),
      tc('2026-10-01T14:00:02Z', usage(1_500, 0, 20), usage(700, 0, 10)),
      ev('2026-10-01T14:00:03Z', { type: 'task_complete', turn_id: 't2' }),
    ]);
    const { summary } = summarizeFile(f, 'codex');
    expect(summary.tokens.input).toBe(7_500);
    expect(summary.tokens.output).toBe(220);
  });

  test('turn start comes from the record time, not a skewed started_at', () => {
    const f = writeLines(`rollout-2026-10-01T15-00-00-${id(3)}.jsonl`, [
      meta(id(3), '2026-10-01T15:00:00Z'),
      ev('2026-10-01T15:00:00Z', { type: 'task_started', turn_id: 't1', started_at: Date.parse('2026-10-01T18:00:00Z') / 1000 }),
      userMsg('2026-10-01T15:00:01Z', 'a'),
      ev('2026-10-01T15:00:05Z', { type: 'task_complete', turn_id: 't1' }),
    ]);
    const { summary } = summarizeFile(f, 'codex');
    expect(summary.end).toBe(Date.parse('2026-10-01T15:00:05Z'));
    expect(summary.activeMs).toBe(5_000);
  });

  test('the same text sent again later in a running turn is a new input', () => {
    const f = writeLines(`rollout-2026-10-01T16-00-00-${id(4)}.jsonl`, [
      meta(id(4), '2026-10-01T16:00:00Z'),
      ev('2026-10-01T16:00:00Z', { type: 'task_started', turn_id: 't1' }),
      userMsg('2026-10-01T16:00:00Z', 'continue'),
      ev('2026-10-01T16:00:00Z', { type: 'user_message', message: 'continue' }),
      userMsg('2026-10-01T17:00:00Z', 'continue'),
      ev('2026-10-01T17:00:00Z', { type: 'user_message', message: 'continue' }),
      ev('2026-10-01T17:00:05Z', { type: 'task_complete', turn_id: 't1' }),
    ]);
    expect(summarizeFile(f, 'codex').summary.userInputs).toBe(2);
  });

  test('peak context uses the window of the model that made the request', () => {
    const f = writeLines(`rollout-2026-10-01T17-00-00-${id(5)}.jsonl`, [
      meta(id(5), '2026-10-01T17:00:00Z'),
      ev('2026-10-01T17:00:00Z', { type: 'task_started', turn_id: 't1', model_context_window: 200_000 }),
      userMsg('2026-10-01T17:00:00Z', 'a'),
      tc('2026-10-01T17:00:01Z', usage(150_000, 0, 1), usage(150_000, 0, 1), 200_000),
      ev('2026-10-01T17:00:02Z', { type: 'task_complete', turn_id: 't1' }),
      ev('2026-10-01T17:01:00Z', { type: 'task_started', turn_id: 't2', model_context_window: 100_000 }),
      userMsg('2026-10-01T17:01:00Z', 'b'),
      tc('2026-10-01T17:01:01Z', usage(160_000, 0, 2), usage(10_000, 0, 1), 100_000),
      ev('2026-10-01T17:01:02Z', { type: 'task_complete', turn_id: 't2' }),
    ]);
    expect(summarizeFile(f, 'codex').summary.ctxPeakPct).toBeCloseTo(75, 5);
  });

  test('a thread continued in a new rollout file is one session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-pages-'));
    const day = path.join(root, 'codex', 'sessions', '2026', '10', '01');
    fs.mkdirSync(day, { recursive: true });
    const thread = id(6);
    const page2 = '0199a0b0-0000-7000-8000-000000000199';
    const w = (name: string, recs: unknown[]) => fs.writeFileSync(path.join(day, name), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    w(`rollout-2026-10-01T09-00-00-${thread}.jsonl`, [
      meta(thread, '2026-10-01T09:00:00Z'),
      ev('2026-10-01T09:00:00Z', { type: 'task_started', turn_id: 't1' }),
      userMsg('2026-10-01T09:00:00Z', 'first'),
      tc('2026-10-01T09:00:01Z', usage(1_000, 0, 10), usage(1_000, 0, 10)),
      ev('2026-10-01T09:00:02Z', { type: 'task_complete', turn_id: 't1' }),
    ]);
    w(`rollout-2026-10-01T10-00-00-${page2}.jsonl`, [
      meta(thread, '2026-10-01T10:00:00Z', { history_base: { thread_id: thread, end_ordinal_exclusive: 5, end_byte_offset: 100 } }),
      ev('2026-10-01T10:00:00Z', { type: 'task_started', turn_id: 't2' }),
      userMsg('2026-10-01T10:00:00Z', 'second'),
      tc('2026-10-01T10:00:01Z', usage(3_000, 0, 30), usage(2_000, 0, 20)),
      ev('2026-10-01T10:00:02Z', { type: 'task_complete', turn_id: 't2' }),
    ]);
    const { Indexer } = await import('../src/server/indexer');
    const { Pool } = await import('../src/server/pool');
    const ix = new Indexer({ claudeDirs: [], codexDirs: [path.join(root, 'codex')] }, new Pool(undefined), path.join(root, 'data'));
    await ix.scan();
    const list = ix.summaries().filter((s) => s.sessionId === thread);
    expect(list.length).toBe(1);
    expect(list[0].turns).toBe(2);
    expect(list[0].userInputs).toBe(2);
    expect(list[0].start).toBe(Date.parse('2026-10-01T09:00:00Z'));
    expect(list[0].tokens.input + list[0].tokens.output).toBe(3_030);
    const d = detailFile(ix.pagesOf(`codex:${thread}`).map((e) => e.file), 'codex');
    expect(d.turns.length).toBe(2);
    expect(d.timeline.filter((t) => t.kind === 'user').length).toBe(2);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
