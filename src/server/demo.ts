// Synthetic Claude Code and Codex logs in the real on-disk formats. Used by `loggy --demo`,
// the test suite and the performance benchmark. Nothing here comes from real sessions.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DemoExpectation {
  agent: 'claude' | 'codex';
  file: string;
  sessionId: string;
  turns: number;
  inputs: number;
  tokens: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pushes: number;
  interrupts: number;
  compactions: number;
  questions: number;
  subagent: boolean;
  running: boolean;
  /** Commits the session made; makeDemoRepos turns them into real ones. */
  made?: { sha: string; ts: number; msg: string; cwd: string; branch: string }[];
}

export interface DemoOptions {
  sessions?: number;
  days?: number;
  now?: number;
  seed?: number;
  /** Repeat each tool step to make large files for benchmarks. */
  bulk?: number;
  /** Put project directories under this folder (so they can be real git repos). */
  projectsRoot?: string;
}

const PROJECTS = [
  { cwd: '/home/demo/work/orbit-web', dirs: ['src/ui', 'src/api', 'src/state', 'tests', 'docs'], branch: 'feat/calendar' },
  { cwd: '/home/demo/work/ledger-api', dirs: ['internal/http', 'internal/db', 'cmd', 'migrations', 'docs'], branch: 'main' },
  { cwd: '/home/demo/work/vision-lab', dirs: ['models', 'data', 'notebooks', 'scripts', 'eval'], branch: 'exp/augment' },
  { cwd: '/home/demo/notes', dirs: ['daily', 'ideas'], branch: 'main' },
];

const PROMPTS = [
  'Add a weekly calendar view to the sessions tab',
  '把会话列表改成虚拟滚动，滚动要流畅',
  'Fix the flaky test in the payment retry handler',
  '给 API 加上分页，并补上测试',
  'Why is the dashboard slow on first load? Profile it',
  'Refactor the auth middleware to use the new token format',
  '帮我写一下 README 的安装部分',
  'Rename the "Ideas" tab to "Backlog" everywhere',
  'Add dark mode support to the settings page',
  '数据集增强脚本跑得太慢，帮我优化一下',
  'Migrate the users table to add a last_seen column',
  'Review this diff and point out anything risky',
  '把错误提示改成中英文双语',
  'Write an evaluation script for the new model checkpoint',
  'Investigate why CI fails only on Linux',
  'Clean up unused dependencies',
];
const FOLLOWUPS = ['Looks good, also add tests', '可以，顺便更新一下文档', 'Make the colors a bit softer', 'commit 一下', 'Ship it', '还有一个边界情况：空列表', 'Use the existing helper instead'];
const REPLIES = [
  'Done. I added the view and wired it into the tab bar; tests pass.',
  '已完成：改动集中在两个文件，所有测试通过。',
  'I found the cause: the query ran once per row. It now runs once per page.',
  'Should I also migrate the old records, or leave them as they are?',
  '需要我顺便把旧接口也删掉吗？',
  'Committed and pushed to the feature branch.',
];
const MODELS_CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-haiku-4-5'];
const MODELS_CODEX = ['gpt-5.5-codex', 'gpt-5.5', 'gpt-5.4-mini'];
const FILES = ['index.ts', 'view.tsx', 'store.ts', 'handler.go', 'query.sql', 'README.md', 'train.py', 'utils.ts', 'calendar.tsx', 'api.test.ts'];

class Rng {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  uuid(): string {
    const h = () => Math.floor(this.next() * 0x10000).toString(16).padStart(4, '0');
    return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
  }
  hex(n: number): string {
    let s = '';
    while (s.length < n) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function patchLines(r: Rng, added: number, removed: number): string[] {
  const lines = [' context line'];
  for (let i = 0; i < removed; i++) lines.push(`-old line ${i}`);
  for (let i = 0; i < added; i++) lines.push(`+new line ${i} ${r.hex(6)}`);
  lines.push(' context line');
  return lines;
}

export function generateDemo(root: string, opts: DemoOptions = {}): DemoExpectation[] {
  const r = new Rng(opts.seed ?? 42);
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 21;
  const total = opts.sessions ?? 140;
  const bulk = Math.max(1, opts.bulk ?? 1);
  const claudeRoot = path.join(root, 'claude', 'projects');
  const codexRoot = path.join(root, 'codex', 'sessions');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  const out: DemoExpectation[] = [];
  const projects = opts.projectsRoot ? PROJECTS.map((p) => ({ ...p, cwd: path.join(opts.projectsRoot!, path.basename(p.cwd)) })) : PROJECTS;

  for (let i = 0; i < total; i++) {
    const running = i >= total - 2;
    const dayOffset = running ? 0 : Math.floor(Math.pow(r.next(), 1.3) * days);
    const day = new Date(now - dayOffset * 86400_000);
    day.setHours(0, 0, 0, 0);
    let start = day.getTime() + (r.int(8, 22) * 60 + r.int(0, 59)) * 60_000;
    if (running) start = now - r.int(8, 25) * 60_000;
    else if (start > now - 3600_000) start = now - r.int(2, 6) * 3600_000;
    const project = r.pick(projects);
    const agent = i % 3 === 2 ? 'codex' : 'claude';
    const exp = agent === 'claude' ? claudeSession(r, claudeRoot, project, start, running, bulk, out) : codexSession(r, codexRoot, project, start, running, bulk);
    out.push(exp);
  }
  return out;
}

function claudeSession(
  r: Rng,
  root: string,
  project: (typeof PROJECTS)[number],
  start: number,
  running: boolean,
  bulk: number,
  all: DemoExpectation[],
): DemoExpectation {
  const sessionId = r.uuid();
  const dir = path.join(root, encodeCwd(project.cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  const model = r.pick(MODELS_CLAUDE);
  const version = r.pick(['2.1.260', '2.1.271', '2.1.280', '2.1.286']);
  const base = { isSidechain: false, userType: 'external', entrypoint: r.pick(['cli', 'claude-desktop']), cwd: project.cwd, sessionId, version, gitBranch: project.branch };
  let t = start;
  let parent: string | null = null;
  const exp: DemoExpectation = {
    agent: 'claude', file, sessionId, turns: 0, inputs: 0, tokens: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0,
    commits: 0, pushes: 0, interrupts: 0, compactions: 0, questions: 0, subagent: false, running,
  };
  const touched = new Set<string>();
  const turns = running ? r.int(2, 4) : r.int(1, 9);
  let ctx = r.int(18_000, 30_000);
  const push = (rec: Record<string, unknown>) => {
    const uuid = r.uuid();
    lines.push(JSON.stringify({ parentUuid: parent, ...rec, uuid, timestamp: iso(t), ...base }));
    parent = uuid;
    return uuid;
  };
  const assistant = (content: unknown[], stop: string, usage: { in: number; cr: number; cw: number; out: number }) => {
    const id = `msg_${r.hex(24)}`;
    const u = {
      input_tokens: usage.in,
      cache_creation_input_tokens: usage.cw,
      cache_read_input_tokens: usage.cr,
      output_tokens: usage.out,
      output_tokens_details: { thinking_tokens: Math.floor(usage.out / 3) },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: usage.cw, ephemeral_5m_input_tokens: 0 },
    };
    // Claude Code writes one line per content block, each repeating the same usage.
    for (const block of content) {
      push({ type: 'assistant', requestId: `req_${r.hex(24)}`, message: { model, id, type: 'message', role: 'assistant', content: [block], stop_reason: stop, stop_sequence: null, usage: u } });
    }
    exp.tokens += usage.in + usage.cw + usage.cr + usage.out;
  };
  const usage = () => {
    const cw = r.int(200, 6000);
    const u = { in: r.int(1, 8), cr: ctx, cw, out: r.int(80, 2500) };
    ctx += cw;
    return u;
  };

  lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId }));
  for (let k = 0; k < turns; k++) {
    const prompt = k === 0 ? r.pick(PROMPTS) : r.pick(FOLLOWUPS);
    const promptId = r.uuid();
    push({ promptId, type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' }, permissionMode: 'default' });
    exp.turns++;
    exp.inputs++;
    t += r.int(3, 20) * 1000;
    const steps = r.int(1, 6) * bulk;
    const lastTurn = k === turns - 1;
    for (let st = 0; st < steps; st++) {
      const toolId = `toolu_${r.hex(24)}`;
      const kind = r.pick(['Read', 'Edit', 'Edit', 'Bash', 'Grep']);
      const f = `${project.cwd}/${r.pick(project.dirs)}/${r.pick(FILES)}`;
      const input = kind === 'Bash' ? { command: 'npm test', description: 'Run tests' } : kind === 'Grep' ? { pattern: 'TODO' } : { file_path: f };
      assistant([{ type: 'thinking', thinking: '', signature: '' }, { type: 'tool_use', id: toolId, name: kind, input }], 'tool_use', usage());
      t += r.int(2, 40) * 1000;
      let result: Record<string, unknown> = { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
      let isError = false;
      if (kind === 'Edit') {
        const a = r.int(1, 30);
        const rm = r.int(0, 12);
        result = { filePath: f, oldString: 'a', newString: 'b', originalFile: null, structuredPatch: [{ oldStart: 10, oldLines: rm + 2, newStart: 10, newLines: a + 2, lines: patchLines(r, a, rm) }], userModified: false, replaceAll: false };
        exp.linesAdded += a;
        exp.linesRemoved += rm;
        touched.add(f);
      } else if (kind === 'Bash' && r.chance(0.15)) {
        isError = true;
        result = { stdout: '', stderr: 'FAIL 1 test', interrupted: false, isImage: false, noOutputExpected: false };
      }
      push({ promptId, type: 'user', message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: isError ? 'Exit code 1' : 'ok', is_error: isError }] }, toolUseResult: result, sourceToolAssistantUUID: parent });
      t += r.int(1, 10) * 1000;
    }
    if (running && lastTurn) {
      // Still working: last record is a tool call without a result.
      t = Date.now() - 20_000;
      assistant([{ type: 'tool_use', id: `toolu_${r.hex(24)}`, name: 'Bash', input: { command: 'npm run build' } }], 'tool_use', usage());
      break;
    }
    if (r.chance(0.08) && !lastTurn) {
      push({ promptId, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      exp.interrupts++;
      t += r.int(20, 120) * 1000;
      continue;
    }
    if (r.chance(0.12)) {
      const toolId = `toolu_${r.hex(24)}`;
      assistant([{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: { questions: [{ question: 'Which layout do you prefer?', header: 'Layout', multiSelect: false, options: [{ label: 'Inside the sessions tab (Recommended)' }, { label: 'A separate tab' }] }] } }], 'tool_use', usage());
      exp.questions++;
      t += r.int(20, 200) * 1000;
      push({ promptId, type: 'user', message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: 'answered' }] }, toolUseResult: { questions: [{ question: 'Which layout do you prefer?', options: [{ label: 'Inside the sessions tab (Recommended)' }, { label: 'A separate tab' }] }], answers: { 'Which layout do you prefer?': 'Inside the sessions tab (Recommended)' } } });
    }
    const commitNow = touched.size > 0 && (r.chance(0.55) || (lastTurn && r.chance(0.7)));
    if (commitNow) {
      const toolId = `toolu_${r.hex(24)}`;
      const msg = r.pick(['Add calendar view', 'Fix retry handler', 'Paginate list endpoint', 'Speed up augmentation']);
      assistant([{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `git add -A && git commit -m "${msg}"` } }], 'tool_use', usage());
      t += r.int(2, 8) * 1000;
      const sha = r.hex(7);
      const doPush = r.chance(0.5);
      (exp.made ??= []).push({ sha, ts: t, msg, cwd: project.cwd, branch: project.branch });
      push({ promptId, type: 'user', message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: `[${project.branch} ${sha}] ${msg}` }] }, toolUseResult: { stdout: `[${project.branch} ${sha}] ${msg}`, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, gitOperation: doPush ? { commit: { sha, kind: 'committed' }, push: { branch: project.branch } } : { commit: { sha, kind: 'committed' } } } });
      exp.commits++;
      if (doPush) exp.pushes++;
    }
    if (k === 4 && r.chance(0.5)) {
      lines.push(JSON.stringify({ parentUuid: null, logicalParentUuid: parent, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, timestamp: iso(t), uuid: r.uuid(), level: 'info', compactMetadata: { trigger: 'auto', preTokens: ctx } }));
      exp.compactions++;
      ctx = r.int(20_000, 40_000);
    }
    assistant([{ type: 'text', text: r.pick(REPLIES) }], 'end_turn', usage());
    t += r.int(1, 4) * 1000;
    if (k === 0) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: prompt.slice(0, 60), sessionId }));
    if (!lastTurn) t += r.int(30, 900) * 1000;
  }
  exp.filesChanged = touched.size;
  if (!running && r.chance(0.3)) {
    lines.push(JSON.stringify({ type: 'assistant', parentUuid: parent, uuid: r.uuid(), timestamp: iso(t), ...base, message: { model, id: `msg_${r.hex(24)}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, quotaLimits: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: Math.floor((t + 3 * 3600_000) / 1000) } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (running) fs.utimesSync(file, new Date(), new Date());
  else fs.utimesSync(file, new Date(t), new Date(t));

  if (!running && r.chance(0.2)) {
    const agentId = r.hex(16);
    const subDir = path.join(dir, sessionId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const subFile = path.join(subDir, `agent-${agentId}.jsonl`);
    const st = start + 60_000;
    const sub = [
      { ...base, parentUuid: null, isSidechain: true, promptId: r.uuid(), agentId, type: 'user', message: { role: 'user', content: 'Search the codebase for every caller of the old API' }, uuid: r.uuid(), timestamp: iso(st) },
      { ...base, parentUuid: null, isSidechain: true, agentId, type: 'assistant', message: { model: 'claude-haiku-4-5', id: `msg_${r.hex(24)}`, role: 'assistant', content: [{ type: 'text', text: 'Found 4 callers.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1200, output_tokens: 300 } }, uuid: r.uuid(), timestamp: iso(st + 40_000) },
    ];
    fs.writeFileSync(subFile, sub.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.utimesSync(subFile, new Date(st + 40_000), new Date(st + 40_000));
    all.push({ agent: 'claude', file: subFile, sessionId: `${sessionId}/agent-${agentId}`, turns: 1, inputs: 1, tokens: 10505, filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0, pushes: 0, interrupts: 0, compactions: 0, questions: 0, subagent: true, running: false });
  }
  return exp;
}

function codexSession(r: Rng, root: string, project: (typeof PROJECTS)[number], start: number, running: boolean, bulk: number): DemoExpectation {
  const d = new Date(start);
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const id = r.uuid();
  const stamp = iso(start).slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const model = r.pick(MODELS_CODEX);
  const lines: string[] = [];
  let t = start;
  let ordinal = 0;
  const rec = (type: string, payload: unknown) => lines.push(JSON.stringify({ timestamp: iso(t), ordinal: ordinal++, type, payload }));
  const exp: DemoExpectation = {
    agent: 'codex', file, sessionId: id, turns: 0, inputs: 0, tokens: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0,
    commits: 0, pushes: 0, interrupts: 0, compactions: 0, questions: 0, subagent: false, running,
  };
  rec('session_meta', { id, session_id: id, timestamp: iso(t), cwd: project.cwd, originator: r.pick(['codex_cli_rs', 'Codex Desktop']), cli_version: r.pick(['0.153.4', '0.155.0', '0.159.2']), source: 'cli', model_provider: 'openai', git: { commit_hash: r.hex(40), branch: project.branch } });
  const tot = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const touched = new Set<string>();
  let used5h = r.int(5, 60);
  let used7d = r.int(20, 80);
  const turns = running ? 2 : r.int(1, 7);
  for (let k = 0; k < turns; k++) {
    const turnId = r.uuid();
    rec('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(t / 1000), model_context_window: 258400 });
    rec('turn_context', { turn_id: turnId, cwd: project.cwd, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model });
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] });
    const prompt = k === 0 ? r.pick(PROMPTS) : r.pick(FOLLOWUPS);
    rec('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'UserMessage', id: r.hex(6), content: [{ type: 'text', text: prompt, text_elements: [] }] }, completed_at_ms: t });
    exp.turns++;
    exp.inputs++;
    const steps = r.int(1, 6) * bulk;
    for (let st = 0; st < steps; st++) {
      t += r.int(3, 30) * 1000;
      rec('response_item', { type: 'reasoning', id: `rs_${r.hex(20)}`, summary: [], content: null, encrypted_content: r.hex(800) });
      const callId = `call_${r.hex(20)}`;
      if (r.chance(0.4)) {
        const f = `${project.cwd}/${r.pick(project.dirs)}/${r.pick(FILES)}`;
        const a = r.int(1, 25);
        const rm = r.int(0, 10);
        rec('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${f}\n*** End Patch\n` });
        rec('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'FileChange', id: callId, changes: { [f]: { type: 'update', unified_diff: patchLines(r, a, rm).join('\n'), move_path: null } }, status: 'completed' } });
        exp.linesAdded += a;
        exp.linesRemoved += rm;
        touched.add(f);
      } else {
        const failed = r.chance(0.1);
        rec('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg TODO', workdir: project.cwd }), call_id: callId });
        rec('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'CommandExecution', id: callId, command: ['/bin/zsh', '-lc', 'rg TODO'], cwd: project.cwd, aggregated_output: failed ? 'error' : 'src/a.ts:1: TODO', exit_code: failed ? 1 : 0, status: failed ? 'failed' : 'completed', duration: { secs: 1, nanos: 0 } } });
      }
      const inc = { input_tokens: r.int(20_000, 60_000), cached: 0, out: r.int(100, 1500) };
      inc.cached = Math.floor(inc.input_tokens * 0.9);
      tot.input_tokens += inc.input_tokens;
      tot.cached_input_tokens += inc.cached;
      tot.output_tokens += inc.out;
      tot.reasoning_output_tokens += Math.floor(inc.out / 3);
      tot.total_tokens = tot.input_tokens + tot.output_tokens;
      used5h = Math.min(100, used5h + r.int(0, 2));
      used7d = Math.min(100, used7d + (r.chance(0.3) ? 1 : 0));
      rec('event_msg', {
        type: 'token_count',
        info: { total_token_usage: { ...tot }, last_token_usage: { input_tokens: inc.input_tokens, cached_input_tokens: inc.cached, cache_write_input_tokens: 0, output_tokens: inc.out, reasoning_output_tokens: 0, total_tokens: inc.input_tokens + inc.out }, model_context_window: 258400 },
        rate_limits: { limit_id: 'codex', limit_name: null, primary: { used_percent: used5h, window_minutes: 300, resets_at: Math.floor(t / 1000) + 3600 }, secondary: { used_percent: used7d, window_minutes: 10080, resets_at: Math.floor(t / 1000) + 400000 }, credits: null, plan_type: 'pro' },
      });
    }
    if (running && k === turns - 1) {
      t = Date.now() - 15_000;
      rec('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cargo test"}', call_id: `call_${r.hex(20)}` });
      break;
    }
    t += r.int(2, 10) * 1000;
    if (r.chance(0.08)) {
      rec('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
      exp.interrupts++;
    } else {
      if (touched.size && r.chance(0.5)) {
        const sha = r.hex(7);
        (exp.made ??= []).push({ sha, ts: t, msg: 'Tidy handlers', cwd: project.cwd, branch: project.branch });
        rec('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git commit -am wip"}', call_id: `call_${r.hex(20)}` });
        rec('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'CommandExecution', id: r.hex(8), command: ['/bin/zsh', '-lc', 'git commit -am "Tidy handlers"'], aggregated_output: `[${project.branch} ${sha}] Tidy handlers\n 2 files changed`, exit_code: 0, status: 'completed' } });
        exp.commits++;
      }
      const reply = r.pick(REPLIES);
      rec('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'AgentMessage', id: r.hex(6), content: [{ type: 'Text', text: reply }] } });
      rec('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: reply, started_at: Math.floor(start / 1000), completed_at: Math.floor(t / 1000) });
    }
    t += r.int(60, 1200) * 1000;
  }
  exp.tokens = tot.input_tokens + tot.output_tokens;
  exp.filesChanged = touched.size;
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (running) fs.utimesSync(file, new Date(), new Date());
  else fs.utimesSync(file, new Date(t), new Date(t));
  return exp;
}

const DEMO_RULES = [
  '# Notes for coding agents\n\n- Run `npm test` before committing.\n',
  '\n## Style\n\n- Prefer small, focused commits.\n- Keep UI strings in the i18n files (zh-CN and en).\n',
  '\n## Calendar\n\n- Session bars are drawn on a canvas; do not render one DOM node per bucket.\n',
  '\n## Release\n\n- Update CHANGELOG.md with every user-visible change.\n',
];

/**
 * Creates small git repositories for the demo projects: a CLAUDE.md / AGENTS.md history, then the
 * commits the demo sessions made (their logs are rewritten to the real ids). A project that works
 * on a feature branch merges it into main halfway.
 */
export function makeDemoRepos(projectsRoot: string, exps: DemoExpectation[] = [], now = Date.now(), days = 21): void {
  const made = exps.flatMap((e) => (e.made ?? []).map((m) => ({ ...m, file: e.file }))).sort((a, b) => a.ts - b.ts);
  for (const p of PROJECTS) {
    const dir = path.join(projectsRoot, path.basename(p.cwd));
    fs.mkdirSync(dir, { recursive: true });
    try {
      const git = (args: string[], when?: number) =>
        execFileSync('git', args, {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Demo',
            GIT_AUTHOR_EMAIL: 'demo@example.invalid',
            GIT_COMMITTER_NAME: 'Demo',
            GIT_COMMITTER_EMAIL: 'demo@example.invalid',
            ...(when ? { GIT_AUTHOR_DATE: new Date(when).toISOString(), GIT_COMMITTER_DATE: new Date(when).toISOString() } : {}),
          },
        }).toString();
      git(['init', '-q', '-b', 'main']);
      let text = '';
      DEMO_RULES.forEach((rule, i) => {
        text += rule;
        const file = i % 2 === 0 ? 'CLAUDE.md' : 'AGENTS.md';
        const prev = fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
        fs.writeFileSync(path.join(dir, file), prev + rule);
        git(['add', file]);
        git(['commit', '-q', '-m', `Update ${file}: ${rule.trim().split('\n')[0].replace(/^#+\s*/, '')}`], now - (days - i * 5) * 86400_000);
      });
      const mine = made.filter((m) => path.basename(m.cwd) === path.basename(p.cwd) && m.ts > now - (days - (DEMO_RULES.length - 1) * 5) * 86400_000);
      if (!mine.length) continue;
      if (p.branch !== 'main') git(['checkout', '-q', '-b', p.branch]);
      const half = Math.floor(mine.length / 2);
      mine.forEach((m, i) => {
        if (p.branch !== 'main' && i === half && i > 0) {
          git(['checkout', '-q', 'main']);
          fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), `- ${m.msg}\n`);
          git(['add', 'CHANGELOG.md']);
          git(['commit', '-q', '-m', 'Update CHANGELOG'], m.ts - 120_000);
          git(['merge', '-q', '--no-ff', '-m', `Merge branch '${p.branch}'`, p.branch], m.ts - 60_000);
          git(['checkout', '-q', p.branch]);
        }
        const rel = path.join(p.dirs[i % p.dirs.length], 'changes.md');
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.appendFileSync(path.join(dir, rel), `- ${m.msg}\n`);
        git(['add', rel]);
        git(['commit', '-q', '-m', m.msg], m.ts);
        const sha = git(['rev-parse', '--short=7', 'HEAD']).trim();
        fs.writeFileSync(m.file, fs.readFileSync(m.file, 'utf8').replaceAll(m.sha, sha));
      });
    } catch {
      // git missing: the instructions page just shows the files without history.
    }
  }
}

/** Appends activity to the running demo sessions so the live view has something to show. */
export function tickDemo(expectations: DemoExpectation[]): void {
  for (const e of expectations.filter((x) => x.running)) {
    const now = new Date().toISOString();
    const line =
      e.agent === 'claude'
        ? { parentUuid: null, isSidechain: false, type: 'assistant', uuid: cryptoId(), timestamp: now, cwd: '', sessionId: e.sessionId, message: { model: 'claude-opus-5-5', id: `msg_${cryptoId()}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${cryptoId()}`, name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use', usage: { input_tokens: 3, cache_read_input_tokens: 40000, cache_creation_input_tokens: 800, output_tokens: 150 } } }
        : { timestamp: now, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cargo test"}', call_id: `call_${cryptoId()}` } };
    fs.appendFileSync(e.file, JSON.stringify(line) + '\n');
  }
}

function cryptoId(): string {
  return Math.random().toString(16).slice(2, 14);
}
