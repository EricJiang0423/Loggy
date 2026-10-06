import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { detailFile, summarizeFile } from '../src/core/parse';
import { liveStatus } from '../src/shared/status';

let home = '';
let sessionDir = '';
const T = Date.UTC(2026, 9, 1, 2, 0, 0);
const at = (s: number) => T + s * 1000;

function write(agent: string, recs: Record<string, unknown>[]): string {
  const file = path.join(sessionDir, 'agents', agent, 'wire.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const call = (id: string, name: string, args: unknown, s: number) => ({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.call', toolCallId: id, name, args }, time: at(s) });
const result = (id: string, output: string, s: number, isError?: boolean) => ({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.result', toolCallId: id, result: { output, ...(isError ? { isError } : {}) } }, time: at(s) });
const usage = (model: string, s: number, scope = 'turn') => ({ type: 'usage.record', agentId: 'main', model, usage: { inputOther: 1000, output: 200, inputCacheRead: 9000, inputCacheCreation: 0 }, usageScope: scope, time: at(s) });

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-kimi-'));
  sessionDir = path.join(home, 'sessions', 'wd_app_0123456789ab', 'session_k1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), '[models."kimi-code/k3-256k"]\nprovider = "x"\nmax_context_size = 20000\n');
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ id: 'session_k1', cwd: '/w/app', title: 'Renamed', isCustomTitle: true, agents: { main: { type: 'main' }, 'agent-1': { type: 'sub', parentAgentId: 'main' } } }),
  );
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

test('a Kimi Code session: turns, inputs, tokens, edits, commits and harness settings', () => {
  const file = write('main', [
    { type: 'metadata', protocol_version: '1.5', created_at: at(0) },
    { type: 'permission.set_mode', agentId: 'main', mode: 'auto', time: at(0) },
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi-code/k3-256k', thinkingEffort: 'high', environmentDisclosure: { cwd: '/w/app' }, time: at(0) },
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'add a page' }], origin: { kind: 'user' }, turnId: 0, time: at(1) },
    { type: 'plan_mode.enter', agentId: 'main', id: 'p', time: at(2) },
    usage('kimi-code/k3-256k', 3),
    call('c1', 'Edit', { path: '/w/app/a.ts', old_string: 'a', new_string: 'a\nb' }, 4),
    result('c1', 'ok', 5),
    call('c2', 'Bash', { command: 'git commit -qm "Add page"' }, 6),
    result('c2', '', 8),
    { type: 'plan_mode.exit', agentId: 'main', time: at(9) },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', part: { type: 'text', text: 'Done.' } }, time: at(10) },
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', durationMs: 9000, time: at(10) },
    // a scheduled job runs a turn on its own: a turn, not your input
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'nightly check' }], origin: { kind: 'cron_job' }, turnId: 1, time: at(100) },
    { type: 'permission.set_mode', agentId: 'main', mode: 'yolo', time: at(101) },
    { type: 'config.update', agentId: 'main', thinkingEffort: 'max', time: at(101) },
    usage('kimi-code/k3-256k', 102),
    usage('kimi-code/k3-256k', 103, 'session'), // compaction call: tokens, not context
    { type: 'context.apply_compaction', agentId: 'main', time: at(103) },
    { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled', durationMs: 3000, time: at(104) },
  ]);
  const { summary: s } = summarizeFile(file, 'kimi');
  expect(s).toMatchObject({ id: 'kimi:session_k1', cwd: '/w/app', title: 'Renamed', titleSource: 'custom', turns: 2, userInputs: 1, toolCalls: 2, filesChanged: 1, linesAdded: 2, linesRemoved: 1, compactions: 1, interrupts: 1, hasPlan: true });
  expect(s.tokens).toMatchObject({ input: 3000, output: 600, cacheRead: 27000 });
  expect(s.commitRuns).toEqual([[at(6), at(8)]]);
  expect(s.ctxPeakPct).toBe(50); // 10000 of the 20000 window from config.toml
  expect(s.knobs).toMatchObject({ permission: { auto: 1, yolo: 1 }, effort: { high: 1, max: 1 }, plan: { on: 1, off: 1 }, model: { 'kimi-code/k3-256k': 2 } });
  expect(s.knobSwitches).toMatchObject({ permission: 1, effort: 1, plan: 2 });
  expect(s.outcome).toBe('abandoned');

  const d = detailFile(file, 'kimi');
  expect(d.turns.map((t) => t.knobs?.permission)).toEqual(['auto', 'yolo']);
  expect(d.timeline.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['add a page']);
  expect(d.timeline.some((i) => i.kind === 'system' && i.text.startsWith('[cron]'))).toBe(true);
  expect(d.files).toEqual([{ path: '/w/app/a.ts', added: 2, removed: 1, edits: 1 }]);

  // Plan mode switched on before the input and off during the turn: the turn used it.
  const early = write('main', [
    { type: 'plan_mode.enter', agentId: 'main', id: 'p', time: at(0) },
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'plan it' }], origin: { kind: 'user' }, turnId: 0, time: at(1) },
    { type: 'plan_mode.exit', agentId: 'main', time: at(5) },
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', durationMs: 4000, time: at(6) },
  ]);
  expect(summarizeFile(early, 'kimi').summary.knobs?.plan).toEqual({ on: 1 });
});

test('an open approval request means the session waits for you; subagents point at their parent', () => {
  const file = write('main', [
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'deploy' }], origin: { kind: 'user' }, turnId: 0, time: at(0) },
    call('c1', 'Bash', { command: 'rm -rf dist' }, 1),
    { type: 'interaction.request', agentId: 'main', id: 'i1', kind: 'approval', request: { toolName: 'Bash' }, time: at(2) },
  ]);
  const { summary } = summarizeFile(file, 'kimi');
  expect(liveStatus({ ...summary, mtime: at(2) }, at(60))).toBe('needs_input');

  const sub = write('agent-1', [
    { type: 'turn.prompt', agentId: 'agent-1', input: [{ type: 'text', text: 'find callers' }], origin: { kind: 'system_trigger', name: 'subagent' }, turnId: 0, time: at(0) },
    { type: 'turn.ended', agentId: 'agent-1', turnId: 0, reason: 'completed', durationMs: 1, time: at(5) },
  ]);
  expect(summarizeFile(sub, 'kimi').summary).toMatchObject({ id: 'kimi:session_k1/agent-1', parentId: 'kimi:session_k1', isSubagent: true, turns: 1, userInputs: 1 });
});
