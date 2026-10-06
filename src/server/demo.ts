// Synthetic Claude Code, Codex and Pi logs in the real on-disk formats. Used by `loggy --demo`,
// the test suite and the performance benchmark. Nothing here comes from real sessions.

import { execFileSync } from 'node:child_process';
import type { Agent } from '../shared/types.js';
import fs from 'node:fs';
import path from 'node:path';

export interface DemoExpectation {
  agent: Agent;
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
const MODELS_PI = ['claude-sonnet-4-5', 'gpt-5.5', 'glm-5.3-flash', 'deepseek-v4.1'];
/** Pi stores the prompt, tool declarations and skills in system messages; they are large and unread. */
const PI_SYSTEM_TEXT = [
  'You are an expert coding assistant operating inside pi, a coding agent harness.',
  'You help users by reading files, executing commands, editing code, and writing new files.',
  '',
  '<tools>',
  ...Array.from({ length: 12 }, (_, i) => `- tool_${i}: ${'Does a thing with files, commands and search results. '.repeat(6)}`),
  '</tools>',
  '',
  '<project>',
  `cwd: ${'/home/demo/work/orbit-web/src/ui'.repeat(4)}`,
  '</project>',
].join('\n');
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
  const piRoot = path.join(root, 'pi', 'sessions');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  const kimiHome = path.join(root, 'kimi');
  fs.mkdirSync(path.join(kimiHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'config.toml'), KIMI_MODELS.map(([m, w]) => `[models."${m}"]\nmax_context_size = ${w}\n`).join('\n'));
  fs.mkdirSync(piRoot, { recursive: true });
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
    const agent = i % 7 === 4 ? 'kimi' : i % 3 === 2 ? 'codex' : i % 3 === 1 ? 'pi' : 'claude';
    const exp =
      agent === 'claude'
        ? claudeSession(r, claudeRoot, project, start, running, bulk, out)
        : agent === 'kimi'
          ? kimiSession(r, kimiHome, project, start, running, bulk, out)
          : agent === 'codex'
            ? codexSession(r, codexRoot, project, start, running, bulk)
            : piSession(r, piRoot, project, start, running, bulk);
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
  let effort = r.pick(['high', 'high', 'medium', 'xhigh', 'max']);
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
      push({ type: 'assistant', requestId: `req_${r.hex(24)}`, effort, message: { model, id, type: 'message', role: 'assistant', content: [block], stop_reason: stop, stop_sequence: null, usage: u } });
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
  // Harness settings: a permission mode per session (sometimes plan mode for a turn), an effort level.
  const baseMode = r.pick(['default', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
  for (let k = 0; k < turns; k++) {
    const prompt = k === 0 ? r.pick(PROMPTS) : r.pick(FOLLOWUPS);
    const promptId = r.uuid();
    const permissionMode = k === 0 && r.chance(0.2) ? 'plan' : baseMode;
    if (k > 0 && r.chance(0.15)) effort = r.pick(['medium', 'high', 'xhigh', 'max']);
    push({ promptId, type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' }, permissionMode });
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
  const approval = r.pick(['on-request', 'never']);
  const sandbox = r.pick(['workspace-write', 'workspace-write', 'read-only', 'danger-full-access']);
  const planFirst = r.chance(0.15);
  let codexEffort = r.pick(['low', 'medium', 'medium', 'high', 'xhigh']);
  for (let k = 0; k < turns; k++) {
    if (k > 0 && r.chance(0.15)) codexEffort = r.pick(['low', 'medium', 'high', 'xhigh']);
    const turnId = r.uuid();
    rec('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(t / 1000), model_context_window: 258400 });
    rec('turn_context', {
      turn_id: turnId,
      cwd: project.cwd,
      approval_policy: approval,
      sandbox_policy: { type: sandbox },
      model,
      effort: codexEffort,
      collaboration_mode: { mode: k === 0 && planFirst ? 'plan' : 'default', settings: { model, reasoning_effort: codexEffort } },
    });
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

const KIMI_MODELS: [string, number][] = [
  ['kimi-code/k3', 1048576],
  ['kimi-code/k3-256k', 262144],
  ['kimi-code/kimi-for-coding', 1048576],
];

/** A Kimi Code session: state.json plus one wire.jsonl per agent (main, and sometimes a subagent). */
function kimiSession(r: Rng, home: string, project: (typeof PROJECTS)[number], start: number, running: boolean, bulk: number, all: DemoExpectation[]): DemoExpectation {
  const id = `session_${r.uuid()}`;
  const wd = path.join(home, 'sessions', `wd_${path.basename(project.cwd)}_${r.hex(12)}`);
  const sessionDir = path.join(wd, id);
  const file = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exp: DemoExpectation = {
    agent: 'kimi', file, sessionId: id, turns: 0, inputs: 0, tokens: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0,
    commits: 0, pushes: 0, interrupts: 0, compactions: 0, questions: 0, subagent: false, running,
  };
  let t = start;
  const lines: string[] = [];
  const rec = (type: string, body: Record<string, unknown>) => lines.push(JSON.stringify({ type, agentId: 'main', ...body, time: t }));
  let model = r.pick(KIMI_MODELS)[0];
  let effort = r.pick(['on', 'high', 'max']);
  const mode = r.pick(['auto', 'yolo', 'yolo', 'manual']);
  lines.push(JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: t }));
  rec('permission.set_mode', { mode });
  rec('profile.bind', { modelAlias: model, profileName: 'agent', thinkingEffort: effort, environmentDisclosure: { cwd: project.cwd } });
  const touched = new Set<string>();
  const turns = running ? 2 : r.int(1, 6);
  let sub = false;
  let firstPrompt = '';
  for (let k = 0; k < turns; k++) {
    const lastTurn = k === turns - 1;
    if (k > 0 && r.chance(0.2)) {
      effort = r.pick(['on', 'high', 'max']);
      if (r.chance(0.5)) model = r.pick(KIMI_MODELS)[0];
      rec('config.update', { thinkingEffort: effort, modelAlias: model });
    }
    const plan = k === 0 && r.chance(0.2);
    if (plan) rec('plan_mode.enter', { id: `plan_${r.hex(8)}` });
    const prompt = k === 0 ? r.pick(PROMPTS) : r.pick(FOLLOWUPS);
    if (k === 0) firstPrompt = prompt;
    rec('turn.prompt', { input: [{ type: 'text', text: prompt }], origin: { kind: 'user' }, turnId: k });
    exp.turns++;
    exp.inputs++;
    const steps = r.int(1, 5) * bulk;
    for (let st = 0; st < steps; st++) {
      t += r.int(2, 15) * 1000;
      const call = `call_${r.hex(24)}`;
      const dir = r.pick(project.dirs);
      const file = `${project.cwd}/${dir}/${r.pick(FILES)}`;
      const kind = r.pick(['Edit', 'Write', 'Bash', 'Read']);
      const args =
        kind === 'Edit' ? { path: file, old_string: 'a\nb', new_string: 'a\nb\nc' } : kind === 'Write' ? { path: file, content: 'x\ny\n' } : kind === 'Bash' ? { command: 'npm test', description: 'Run the tests' } : { path: file };
      rec('context.append_loop_event', { event: { type: 'tool.call', toolCallId: call, name: kind, args, turnId: String(k), step: st } });
      const usage = { inputOther: r.int(100, 2000), output: r.int(50, 1500), inputCacheRead: r.int(10_000, 80_000), inputCacheCreation: 0 };
      exp.tokens += usage.inputOther + usage.output + usage.inputCacheRead;
      lines.push(JSON.stringify({ type: 'usage.record', agentId: 'main', model, usage, usageScope: 'turn', time: t }));
      rec('context.append_loop_event', { event: { type: 'step.end', turnId: String(k), step: st, finishReason: 'tool_use', usage, llmStreamDurationMs: r.int(2000, 20000) } });
      t += r.int(1, 6) * 1000;
      rec('context.append_loop_event', { event: { type: 'tool.result', toolCallId: call, result: { output: 'ok' } } });
      if (kind === 'Edit' || kind === 'Write') {
        touched.add(file);
        exp.linesAdded += kind === 'Edit' ? 3 : 2;
        exp.linesRemoved += kind === 'Edit' ? 2 : 0;
      }
    }
    if (plan) rec('plan_mode.exit', {});
    if (k === 0 && !running && r.chance(0.3)) {
      // A subagent explores while the main agent waits.
      sub = true;
      const call = `call_${r.hex(24)}`;
      rec('context.append_loop_event', { event: { type: 'tool.call', toolCallId: call, name: 'Agent', args: { description: 'Find callers', prompt: 'Find every caller of the old API', subagent_type: 'explore' } } });
      all.push(kimiSubagent(r, sessionDir, project, t, model));
      t += 30_000;
      rec('context.append_loop_event', { event: { type: 'tool.result', toolCallId: call, result: { output: 'Found 4 callers.' } } });
    }
    if (touched.size && (lastTurn || r.chance(0.4)) && !(running && lastTurn)) {
      const call = `call_${r.hex(24)}`;
      const msg = r.pick(['Add calendar view', 'Fix retry handler', 'Paginate list endpoint']);
      const sha = r.hex(7);
      rec('context.append_loop_event', { event: { type: 'tool.call', toolCallId: call, name: 'Bash', args: { command: `git add -A && git commit -m "${msg}"` } } });
      t += 3000;
      rec('context.append_loop_event', { event: { type: 'tool.result', toolCallId: call, result: { output: `[${project.branch} ${sha}] ${msg}\n 2 files changed` } } });
      (exp.made ??= []).push({ sha, ts: t, msg, cwd: project.cwd, branch: project.branch });
      exp.commits++;
    }
    if (running && lastTurn) break; // still working
    const reply = r.pick(REPLIES);
    rec('context.append_loop_event', { event: { type: 'content.part', turnId: String(k), part: { type: 'text', text: reply } } });
    t += 2000;
    if (!lastTurn && r.chance(0.08)) {
      rec('turn.ended', { turnId: k, reason: 'cancelled', durationMs: 1000 });
      exp.interrupts++;
    } else rec('turn.ended', { turnId: k, reason: 'completed', durationMs: 1000 });
    t += r.int(60, 1200) * 1000;
  }
  exp.filesChanged = touched.size;
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const agents: Record<string, unknown> = { main: { homedir: path.dirname(file), type: 'main' } };
  if (sub) agents['agent-1'] = { homedir: path.join(sessionDir, 'agents', 'agent-1'), type: 'sub', parentAgentId: 'main', labels: { profileName: 'explore' } };
  const title = r.chance(0.5) ? { title: firstPrompt.slice(0, 40), titleKind: 'generated', isCustomTitle: false } : { isCustomTitle: false };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ id, version: 2, cwd: project.cwd, createdAt: start, updatedAt: t, archived: false, agents, custom: {}, ...title }));
  if (running) fs.utimesSync(file, new Date(), new Date());
  else fs.utimesSync(file, new Date(t), new Date(t));
  return exp;
}

function piSession(r: Rng, root: string, project: (typeof PROJECTS)[number], start: number, running: boolean, bulk: number): DemoExpectation {
  const dir = path.join(root, encodeCwd(project.cwd));
  fs.mkdirSync(dir, { recursive: true });
  const id = r.uuid();
  const stamp = `${iso(start).slice(0, 23).replace(/[:.]/g, '-')}Z`;
  const file = path.join(dir, `${stamp}_${id}.jsonl`);
  const model = r.pick(MODELS_PI);
  const provider = r.pick(['anthropic', 'openai', 'z-ai']);
  const lines: string[] = [];
  let t = start;
  let parent: string | null = null;
  const exp: DemoExpectation = {
    agent: 'pi', file, sessionId: id, turns: 0, inputs: 0, tokens: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0,
    commits: 0, pushes: 0, interrupts: 0, compactions: 0, questions: 0, subagent: false, running,
  };
  lines.push(JSON.stringify({ type: 'session', version: 3, id, timestamp: iso(t), cwd: project.cwd }));
  lines.push(
    JSON.stringify({
      type: 'message',
      id: r.hex(8),
      parentId: null,
      timestamp: iso(t),
      message: { role: 'system', content: '', sections: { preamble: PI_SYSTEM_TEXT, tools: PI_SYSTEM_TEXT }, cwd: project.cwd, timestamp: t },
    }),
  );
  const entry = (rec: Record<string, unknown>) => {
    const eid = r.hex(8);
    lines.push(JSON.stringify({ ...rec, id: eid, parentId: parent, timestamp: iso(t) }));
    parent = eid;
    return eid;
  };
  lines.push(JSON.stringify({ type: 'model_change', id: r.hex(8), parentId: null, timestamp: iso(t), provider, modelId: model }));
  const touched = new Set<string>();
  let ctx = r.int(18_000, 30_000);
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const usage = () => {
    const inTok = r.int(20, 200);
    const cr = ctx;
    const out = r.int(80, 2500);
    ctx += r.int(200, 6000);
    exp.tokens += inTok + cr + out;
    return { input: inTok, output: out, cacheRead: cr, cacheWrite: 0, totalTokens: inTok + cr + out };
  };
  const assistant = (content: unknown[], stop: string, u: Record<string, number>) => {
    entry({ type: 'message', message: { role: 'assistant', content, provider, model, usage: { ...u, cost: zeroUsage.cost }, stopReason: stop, timestamp: t, api: 'anthropic-messages', thinkingLevel: 'medium' } });
  };

  const turns = running ? r.int(2, 4) : r.int(1, 8);
  for (let k = 0; k < turns; k++) {
    const prompt = k === 0 ? r.pick(PROMPTS) : r.pick(FOLLOWUPS);
    entry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: t } });
    exp.turns++;
    exp.inputs++;
    t += r.int(3, 20) * 1000;
    const steps = r.int(1, 6) * bulk;
    const lastTurn = k === turns - 1;
    for (let st = 0; st < steps; st++) {
      const callId = `call_${r.hex(24)}`;
      const f = `${project.cwd}/${r.pick(project.dirs)}/${r.pick(FILES)}`;
      const kind = r.pick(['bash', 'edit', 'edit', 'write', 'read']);
      if (kind === 'edit' || kind === 'write') {
        const a = kind === 'edit' ? r.int(1, 25) : r.int(3, 90);
        const rm = kind === 'edit' ? r.int(0, 10) : 0;
        const args =
          kind === 'edit'
            ? { path: f, edits: [{ oldText: 'old text '.repeat(rm), newText: 'new text '.repeat(a) }] }
            : { path: f, content: Array.from({ length: a }, (_, i) => `line ${i} ${r.hex(6)}`).join('\n') };
        assistant([{ type: 'toolCall', id: callId, name: kind, arguments: args }], 'toolUse', usage());
        t += r.int(2, 30) * 1000;
        const diff = kind === 'edit' ? patchLines(r, a, rm).join('\n') : undefined;
        const text = diff ? `Successfully replaced 1 block(s) in ${f}.` : `Successfully wrote to ${f}`;
        entry({ type: 'message', message: { role: 'toolResult', toolCallId: callId, toolName: kind, content: [{ type: 'text', text }], isError: false, timestamp: t, details: diff ? { diff } : undefined } });
        exp.linesAdded += a;
        exp.linesRemoved += rm;
        touched.add(f);
      } else if (kind === 'bash') {
        const failed = r.chance(0.12);
        assistant([{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: failed ? 'npm test' : 'npm run build' } }], 'toolUse', usage());
        t += r.int(2, 40) * 1000;
        entry({ type: 'message', message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text: failed ? 'Exit code 1\nFAIL 1 test' : 'built in 4.2s' }], isError: failed, timestamp: t } });
      } else {
        assistant([{ type: 'toolCall', id: callId, name: 'read', arguments: { path: f, limit: 2000 } }], 'toolUse', usage());
        t += r.int(1, 10) * 1000;
        entry({ type: 'message', message: { role: 'toolResult', toolCallId: callId, toolName: 'read', content: [{ type: 'text', text: '1\timport { render } from \'./ui\';' }], isError: false, timestamp: t } });
      }
      t += r.int(1, 10) * 1000;
    }
    if (running && lastTurn) {
      // Still working: the last entry is a tool call without a result.
      t = Date.now() - 20_000;
      assistant([{ type: 'toolCall', id: `call_${r.hex(24)}`, name: 'bash', arguments: { command: 'npm run build' } }], 'toolUse', usage());
      break;
    }
    if (r.chance(0.08) && !lastTurn) {
      entry({ type: 'message', message: { role: 'assistant', content: [], provider, model, usage: zeroUsage, stopReason: 'aborted', timestamp: t, errorMessage: 'Operation aborted' } });
      exp.interrupts++;
      t += r.int(20, 120) * 1000;
      continue;
    }
    if (touched.size && r.chance(0.5)) {
      const sha = r.hex(7);
      const msg = r.pick(['Add calendar view', 'Fix retry handler', 'Paginate list endpoint', 'Speed up augmentation']);
      const commitId = `call_${r.hex(24)}`;
      assistant([{ type: 'toolCall', id: commitId, name: 'bash', arguments: { command: `git add -A && git commit -m "${msg}"` } }], 'toolUse', usage());
      t += r.int(2, 8) * 1000;
      entry({ type: 'message', message: { role: 'toolResult', toolCallId: commitId, toolName: 'bash', content: [{ type: 'text', text: `[${project.branch} ${sha}] ${msg}\n 3 files changed, 12 insertions(+), 4 deletions(-)` }], isError: false, timestamp: t } });
      exp.commits++;
      if (r.chance(0.5)) {
        const pushId = `call_${r.hex(24)}`;
        const upToDate = r.chance(0.3);
        assistant([{ type: 'toolCall', id: pushId, name: 'bash', arguments: { command: 'git push' } }], 'toolUse', usage());
        t += r.int(3, 15) * 1000;
        entry({ type: 'message', message: { role: 'toolResult', toolCallId: pushId, toolName: 'bash', content: [{ type: 'text', text: upToDate ? 'Everything up-to-date' : `To github.com:demo/${path.basename(project.cwd)}.git\n   ${project.branch} -> ${project.branch}` }], isError: false, timestamp: t } });
        exp.pushes++;
      }
    }
    if (k === 3 && r.chance(0.5)) {
      lines.push(JSON.stringify({ type: 'compaction', id: r.hex(8), parentId: parent, timestamp: iso(t), summary: 'Earlier turns were compacted.', firstKeptEntryId: parent, tokensBefore: ctx }));
      parent = null;
      exp.compactions++;
      ctx = r.int(20_000, 40_000);
    }
    assistant([{ type: 'text', text: r.pick(REPLIES) }], 'stop', usage());
    t += r.int(1, 4) * 1000;
    if (k === 0 && r.chance(0.4)) {
      lines.push(JSON.stringify({ type: 'session_info', id: r.hex(8), parentId: parent, timestamp: iso(t), name: prompt.slice(0, 60) }));
    }
    if (!lastTurn) t += r.int(30, 900) * 1000;
  }
  exp.filesChanged = touched.size;
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (running) fs.utimesSync(file, new Date(), new Date());
  else fs.utimesSync(file, new Date(t), new Date(t));
  return exp;
}

function kimiSubagent(r: Rng, sessionDir: string, project: (typeof PROJECTS)[number], start: number, model: string): DemoExpectation {
  const file = path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let t = start;
  const lines: string[] = [];
  const rec = (type: string, body: Record<string, unknown>) => lines.push(JSON.stringify({ type, agentId: 'agent-1', ...body, time: t }));
  lines.push(JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: t }));
  rec('profile.bind', { modelAlias: model, profileName: 'explore', thinkingEffort: 'on', environmentDisclosure: { cwd: project.cwd } });
  rec('turn.prompt', { input: [{ type: 'text', text: 'Find every caller of the old API' }], origin: { kind: 'system_trigger', name: 'subagent' }, turnId: 0 });
  let tokens = 0;
  for (let st = 0; st < 3; st++) {
    t += 4000;
    const call = `call_${r.hex(24)}`;
    rec('context.append_loop_event', { event: { type: 'tool.call', toolCallId: call, name: 'Grep', args: { pattern: 'oldApi' } } });
    const usage = { inputOther: 300, output: 120, inputCacheRead: 9000, inputCacheCreation: 0 };
    tokens += 9420;
    rec('usage.record', { model, usage, usageScope: 'turn' });
    rec('context.append_loop_event', { event: { type: 'tool.result', toolCallId: call, result: { output: 'src/api.ts:12' } } });
  }
  rec('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: 'Found 4 callers.' } } });
  rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 12000 });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, new Date(t), new Date(t));
  return {
    agent: 'kimi', file, sessionId: `${path.basename(sessionDir)}/agent-1`, turns: 1, inputs: 1, tokens, filesChanged: 0, linesAdded: 0, linesRemoved: 0,
    commits: 0, pushes: 0, interrupts: 0, compactions: 0, questions: 0, subagent: true, running: false,
  };
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
    const ts = Date.now();
    let line: Record<string, unknown>;
    if (e.agent === 'claude') {
      line = { parentUuid: null, isSidechain: false, type: 'assistant', uuid: cryptoId(), timestamp: now, cwd: '', sessionId: e.sessionId, message: { model: 'claude-opus-5-5', id: `msg_${cryptoId()}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${cryptoId()}`, name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use', usage: { input_tokens: 3, cache_read_input_tokens: 40000, cache_creation_input_tokens: 800, output_tokens: 150 } } };
    } else if (e.agent === 'kimi') {
      line = { type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.call', toolCallId: `call_${cryptoId()}`, name: 'Bash', args: { command: 'npm test' } }, time: ts };
    } else if (e.agent === 'codex') {
      line = { timestamp: now, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cargo test"}', call_id: `call_${cryptoId()}` } };
    } else {
      line = { type: 'message', id: cryptoId(), parentId: null, timestamp: now, message: { role: 'assistant', content: [{ type: 'toolCall', id: `call_${cryptoId()}`, name: 'bash', arguments: { command: 'npm test' } }], provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input: 3, output: 150, cacheRead: 40000, cacheWrite: 800, totalTokens: 40953, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: ts, api: 'anthropic-messages' } };
    }
    fs.appendFileSync(e.file, JSON.stringify(line) + '\n');
  }
}

function cryptoId(): string {
  return Math.random().toString(16).slice(2, 14);
}
