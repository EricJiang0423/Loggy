// Claude Code transcript parser (~/.claude/projects/<encoded-cwd>/<session>.jsonl and
// <session>/subagents/agent-<id>.jsonl).

import path from 'node:path';
import {
  type AccState,
  DetailSink,
  addCommit,
  addFileChange,
  addModel,
  addTool,
  addToolError,
  addUsage,
  beginTurn,
  countDiff,
  countLines,
  currentTurn,
  looksLikeQuestion,
  markInterrupted,
  markTurnEnded,
  newState,
  oneLine,
  touch,
} from './acc.js';
import { parseTs } from './lines.js';

type Json = Record<string, any>;

// ponytail: bounded de-dup window; Claude Code can repeat a message id ~80 records later.
const MSG_WINDOW = 256;
const TOOL_WINDOW = 256;

export function initClaudeState(file: string): AccState {
  const s = newState('claude', file);
  const base = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
  const dir = path.dirname(file);
  if (path.basename(dir) === 'subagents') {
    const parent = path.basename(path.dirname(dir));
    s.isSubagent = true;
    s.parentId = parent;
    s.sessionId = `${parent}/${base}`;
  } else {
    s.sessionId = base;
  }
  s.x = { msg: {}, msgOrder: [], tools: {}, toolOrder: [], cmd: {} };
  return s;
}

interface ClaudeX {
  msg: Record<string, number[]>;
  msgOrder: string[];
  /** tool_use id -> tool name (bounded). */
  tools: Record<string, string>;
  toolOrder: string[];
  /** tool_use id -> commit message guess (bounded via toolOrder). */
  cmd: Record<string, string>;
  lastPromptId?: string;
  lastText?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text;
  }
  return out;
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** Turns `<command-name>/x</command-name><command-args>y</command-args>` into `/x y`. */
function commandText(text: string): string | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '';
  return `${name.trim()} ${args.trim()}`.trim();
}

function rememberTool(x: ClaudeX, id: string, name: string): void {
  if (!id) return;
  if (!(id in x.tools)) {
    x.toolOrder.push(id);
    if (x.toolOrder.length > TOOL_WINDOW) {
      const old = x.toolOrder.shift()!;
      delete x.tools[old];
      delete x.cmd[old];
    }
  }
  x.tools[id] = name;
}

function commitMessageFrom(command: string): string | undefined {
  const m = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command);
  if (m) return (m[1] ?? m[2] ?? '').split('\n')[0].trim() || undefined;
  const heredoc = /<<\s*'?EOF'?\s*\n([^\n]*)/.exec(command);
  if (heredoc) return heredoc[1].trim() || undefined;
  return undefined;
}

function briefInput(name: string, input: Json | undefined): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill;
  if (typeof pick === 'string') return pick;
  if (name === 'TodoWrite' || name === 'TaskCreate') return input.subject ?? '';
  try {
    return JSON.stringify(input).slice(0, 300);
  } catch {
    return '';
  }
}

function resultText(block: Json): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text' ? p.text : p?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function hunkLines(hunks: unknown): [number, number] {
  let a = 0;
  let r = 0;
  if (!Array.isArray(hunks)) return [0, 0];
  for (const h of hunks) {
    if (h && Array.isArray(h.lines)) {
      const [x, y] = countDiff(h.lines);
      a += x;
      r += y;
    }
  }
  return [a, r];
}

export function claudeRecord(s: AccState, d: Json, sink?: DetailSink, responses?: Map<number, string>): void {
  const x = s.x as unknown as ClaudeX;
  const type = d.type;
  const ts = parseTs(d.timestamp);
  if (!s.lineage && typeof d.uuid === 'string' && !d.isSidechain) s.lineage = d.uuid;
  if (typeof d.cwd === 'string' && d.cwd && !s.cwd) s.cwd = d.cwd;
  if (typeof d.gitBranch === 'string' && d.gitBranch && d.gitBranch !== 'HEAD') s.branch = d.gitBranch;
  if (typeof d.version === 'string') s.version = d.version;
  if (typeof d.entrypoint === 'string' && !s.entrypoint) s.entrypoint = d.entrypoint;

  switch (type) {
    case 'user':
      userRecord(s, x, d, ts, sink);
      return;
    case 'assistant':
      assistantRecord(s, x, d, ts, sink, responses);
      return;
    case 'system':
      if (d.subtype === 'compact_boundary') {
        s.compactions++;
        touch(s, ts);
        sink?.item(ts, 'system', 'compact', s.turns.length);
      } else if (d.subtype === 'api_error') {
        if (!d.retryAttempt || d.retryAttempt === 1) s.apiErrors++;
      }
      return;
    case 'custom-title':
      if (typeof d.customTitle === 'string' && d.customTitle.trim()) s.customTitle = d.customTitle.trim();
      return;
    case 'ai-title':
      if (typeof d.aiTitle === 'string' && d.aiTitle.trim()) s.aiTitle = d.aiTitle.trim();
      return;
    case 'summary':
      if (typeof d.summary === 'string' && !s.aiTitle) s.aiTitle = d.summary.trim();
      return;
    case 'pr-link': {
      const repo = typeof d.prUrl === 'string' ? /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\//.exec(d.prUrl)?.[1] : undefined;
      if (repo) s.repo = repo;
      return;
    }
    case 'continued-in':
      // The conversation moved to another session; this one stops here without being cut off.
      markTurnEnded(s, ts, false);
      return;
    case 'queue-operation':
    case 'attachment': {
      // Background-task notifications queued while the agent was busy only show up here.
      const queued = type === 'attachment' ? (d.attachment?.type === 'queued_command' ? d.attachment.prompt : undefined) : d.content;
      if (typeof queued === 'string' && queued.includes('<task-notification>')) clearBackground(s, queued);
      return;
    }
    case 'permission-mode':
      if (d.permissionMode === 'plan' || d.mode === 'plan') s.hasPlan = true;
      return;
    default:
      return;
  }
}

function userRecord(s: AccState, x: ClaudeX, d: Json, ts: number, sink?: DetailSink): void {
  const msg = d.message ?? {};
  const content = msg.content;
  if (d.toolUseResult !== undefined || hasToolResult(content)) {
    toolResults(s, x, d, ts, sink);
    return;
  }
  if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
  let text = textOf(content);
  const images = Array.isArray(content) ? content.filter((b: Json) => b?.type === 'image').length : 0;
  if (text.startsWith('[Request interrupted by user')) {
    markInterrupted(s);
    touch(s, ts);
    sink?.item(ts, 'system', 'interrupted', s.turns.length);
    return;
  }
  if (text.includes('<task-notification>')) {
    clearBackground(s, text);
    touch(s, ts);
    return;
  }
  const originKind = d.origin?.kind;
  if (originKind && originKind !== 'human' && !s.isSubagent) return;
  if (/^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(text)) return;
  if (text.startsWith('Caveat: The messages below were generated')) return;
  const cmd = commandText(text);
  if (cmd) text = cmd;
  text = stripReminders(text);
  if (!text && !images) return;
  if (d.isSidechain && !s.isSubagent) return; // older logs inline subagent prompts
  if (d.promptId && d.promptId === x.lastPromptId && s.turns.length) {
    // Same prompt split into several records (e.g. images and text).
    touch(s, ts);
    return;
  }
  x.lastPromptId = d.promptId;
  const prompt = text || `[${images} image${images > 1 ? 's' : ''}]`;
  beginTurn(s, ts, oneLine(prompt));
  sink?.item(ts, 'user', prompt, s.turns.length, undefined, 8000);
}

function clearBackground(s: AccState, text: string): void {
  if (!s.bgPending.length) return;
  s.bgPending = s.bgPending.filter((id) => !text.includes(id));
}

function toolResults(s: AccState, x: ClaudeX, d: Json, ts: number, sink?: DetailSink): void {
  touch(s, ts);
  const content = Array.isArray(d.message?.content) ? d.message.content : [];
  const r = d.toolUseResult;
  let toolName = '';
  for (const b of content) {
    if (!b || b.type !== 'tool_result') continue;
    toolName = x.tools[b.tool_use_id] ?? '';
    if (b.is_error) addToolError(s);
    if (sink) sink.item(ts, 'result', resultText(b), s.turns.length, { tool: toolName, isError: !!b.is_error }, 600);
  }
  s.pendingTool = false;
  const turn = currentTurn(s);
  if (turn && !turn.ended) s.awaitingReply = false;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return;

  if (typeof r.filePath === 'string') {
    let [a, rm] = hunkLines(r.structuredPatch);
    if (a === 0 && rm === 0) {
      if (r.type === 'create' && typeof r.content === 'string') a = countLines(r.content);
      else if (typeof r.newString === 'string' && typeof r.oldString === 'string') {
        a = countLines(r.newString);
        rm = countLines(r.oldString);
      }
    }
    if (a || rm || r.type === 'create' || Array.isArray(r.structuredPatch)) addFileChange(s, r.filePath, a, rm, ts, sink);
  }
  const bed = r.bashEditDiff;
  if (bed && Array.isArray(bed.files)) {
    for (const entry of bed.files) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [p, hunks] of Object.entries(entry)) {
        const [a, rm] = hunkLines(hunks);
        addFileChange(s, p, a, rm, ts, sink);
      }
    }
  }
  const git = r.gitOperation;
  if (git && typeof git === 'object') {
    if (git.commit && typeof git.commit === 'object') {
      const id = content.find((b: Json) => b?.type === 'tool_result')?.tool_use_id as string | undefined;
      addCommit(s, ts, String(git.commit.sha ?? ''), sink, id ? x.cmd[id] : undefined, git.commit.branch);
    }
    if (git.push) s.pushes++;
  }
  if (typeof r.backgroundTaskId === 'string' && !s.bgPending.includes(r.backgroundTaskId)) s.bgPending.push(r.backgroundTaskId);
  if (r.isAsync === true && typeof r.agentId === 'string' && r.status === 'async_launched') s.bgPending.push(r.agentId);
  if (r.task && typeof r.task === 'object' && typeof r.task.task_id === 'string' && r.task.status && r.task.status !== 'running') {
    s.bgPending = s.bgPending.filter((id) => id !== r.task.task_id);
  }
  if (typeof r.task_id === 'string') s.bgPending = s.bgPending.filter((id) => id !== r.task_id);
  if (s.bgPending.length > 50) s.bgPending = s.bgPending.slice(-50);

  if (Array.isArray(r.questions) && r.answers && typeof r.answers === 'object' && sink) {
    const answers = r.answers as Record<string, unknown>;
    sink.questionList.push({
      ts,
      turn: s.turns.length,
      questions: r.questions.map((q: Json) => ({
        question: String(q?.question ?? ''),
        options: Array.isArray(q?.options) ? q.options.map((o: Json) => String(o?.label ?? o ?? '')) : [],
        answer: answers[q?.question] !== undefined ? String(answers[q.question]) : undefined,
      })),
    });
  }
}

function assistantRecord(s: AccState, x: ClaudeX, d: Json, ts: number, sink?: DetailSink, responses?: Map<number, string>): void {
  const msg = d.message ?? {};
  const model: string | undefined = msg.model;
  touch(s, ts);
  if (d.isApiErrorMessage) {
    // Claude Code gave up (rate limit, overload, auth): the turn is over but did not finish.
    s.apiErrors++;
    const t = currentTurn(s);
    if (t) t.ended = t.interrupted = true;
    s.pendingTool = false;
    return;
  }
  if (model && model !== '<synthetic>') addModel(s, model);
  if (s.isSubagent && !s.turns.length) beginTurn(s, ts, '(subagent)');

  const u = msg.usage;
  if (u && model !== '<synthetic>') {
    const id: string = msg.id || d.uuid || '';
    const cc = u.cache_creation ?? {};
    const cwTotal = Number(u.cache_creation_input_tokens ?? 0);
    const cw1 = Math.min(cwTotal, Number(cc.ephemeral_1h_input_tokens ?? 0));
    const cw5 = cwTotal - cw1;
    const now = [Number(u.input_tokens ?? 0), Number(u.cache_read_input_tokens ?? 0), cw5, cw1, Number(u.output_tokens ?? 0), Number(u.output_tokens_details?.thinking_tokens ?? 0)];
    let prev = x.msg[id];
    if (!prev) {
      prev = [0, 0, 0, 0, 0, 0];
      x.msgOrder.push(id);
      if (x.msgOrder.length > MSG_WINDOW) delete x.msg[x.msgOrder.shift()!];
    }
    const max = now.map((v, i) => Math.max(v || 0, prev![i]));
    const delta = max.map((v, i) => v - prev![i]);
    x.msg[id] = max;
    if (delta.some((v) => v > 0)) {
      addUsage(s, model, { input: delta[0], cacheRead: delta[1], cacheWrite5m: delta[2], cacheWrite1h: delta[3], output: delta[4], reasoning: delta[5] }, max[0] + max[1] + max[2] + max[3]);
    }
  }

  const blocks: Json[] = Array.isArray(msg.content) ? msg.content : [];
  const turn = currentTurn(s);
  if (turn?.ended && blocks.some((b) => b?.type === 'tool_use')) {
    // Work resumed after the turn ended (e.g. on a background-task notification).
    turn.ended = turn.interrupted = false;
  }
  let text = '';
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += (text ? '\n' : '') + b.text;
    } else if (b.type === 'tool_use') {
      const name = String(b.name ?? '');
      rememberTool(x, b.id, name);
      addTool(s);
      const input = b.input ?? {};
      if (name === 'Bash' && typeof input.command === 'string' && /\bgit\b[^\n]*\bcommit\b/.test(input.command)) {
        const m = commitMessageFrom(input.command);
        if (m) x.cmd[b.id] = m.slice(0, 200);
      }
      if (name === 'ExitPlanMode') s.hasPlan = true;
      if (name === 'AskUserQuestion') {
        s.questions++;
        s.awaitingReply = true;
        if (sink) {
          const qs = Array.isArray(input.questions) ? input.questions : [];
          sink.item(ts, 'question', qs.map((q: Json) => `${q?.question ?? ''}\n${(q?.options ?? []).map((o: Json) => `• ${o?.label ?? ''}`).join('\n')}`).join('\n\n'), s.turns.length, { tool: name });
        }
      } else if (sink) {
        sink.item(ts, 'tool', briefInput(name, input), s.turns.length, { tool: name }, 400);
      }
    }
  }
  if (text) {
    x.lastText = text.slice(-400);
    sink?.item(ts, 'assistant', text, s.turns.length, undefined, 8000);
    if (responses) responses.set(s.turns.length, text);
  }
  const subagentDone = s.isSubagent && !msg.stop_reason && text && !blocks.some((b) => b?.type === 'tool_use');
  if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence' || msg.stop_reason === 'refusal' || subagentDone) {
    // Subagent transcripts often end with a reply that never gets its stop_reason.
    markTurnEnded(s, ts, looksLikeQuestion(text || x.lastText || ''));
  } else if (msg.stop_reason === 'tool_use') {
    s.pendingTool = true;
  }
}
