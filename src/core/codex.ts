// Codex rollout parser (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]).
// Rollouts can be very large, so summary mode classifies each line from its first bytes
// and only JSON-parses the records it needs.

import path from 'node:path';
import {
  type AccState,
  DetailSink,
  addCommit,
  addFileChange,
  addModel,
  addSpeed,
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
import { indexIn, parseTs, sniffTimestamp, sniffTypes } from './lines.js';

type Json = Record<string, any>;

interface CodexX {
  /** Running maxima of the cumulative token counters (relative to this file's baseline). */
  tot: number[];
  /** Set once the first token_count of this file has fixed the baseline. */
  totSeen?: boolean;
  /** Time of the last input to the model (user message, tool output), for output speed. */
  lastInputTs?: number;
  turnId?: string;
  lastText?: string;
  cmpTop: number;
  cmpItem: number;
  /** Recent inputs of the open turn as [text key, ts], to drop the same input reported twice. */
  inputsInTurn: [string, number][];
}

const TOOL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call']);
const PARSE_EVENTS = new Set([
  'task_started',
  'task_complete',
  'turn_aborted',
  'token_count',
  'thread_settings_applied',
  'user_message',
  'exec_command_end',
  'patch_apply_end',
]);
const PARSE_ITEMS = new Set(['UserMessage', 'FileChange']);
const GIT = Buffer.from('git');
const FAILED = Buffer.from('"status":"failed"');
const IS_ERROR = Buffer.from('"isError":true');
const MAX_PARSE = 4 * 1024 * 1024;

export function initCodexState(file: string): AccState {
  const s = newState('codex', file);
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i.exec(path.basename(file));
  s.sessionId = m ? m[1] : path.basename(file);
  const x: CodexX = { tot: [0, 0, 0, 0, 0], cmpTop: 0, cmpItem: 0, inputsInTurn: [] };
  s.x = x as unknown as Record<string, unknown>;
  return s;
}

/** Summary-mode entry point working on raw line bytes. */
export function codexLine(s: AccState, buf: Buffer, start: number, end: number): void {
  const types = sniffTypes(buf, start, end, 3);
  const top = types[0];
  const x = s.x as unknown as CodexX;
  if (top === 'response_item') {
    const ts = sniffTimestamp(buf, start, end);
    const pt = types[1];
    if (pt === 'function_call_output' || pt === 'custom_tool_call_output') x.lastInputTs = sniffTimestamp(buf, start, end) || x.lastInputTs;
    if (pt && TOOL_TYPES.has(pt)) {
      touch(s, ts);
      addTool(s);
    } else if (pt === 'message' || pt === 'agent_message') {
      touch(s, ts);
    }
    return;
  }
  if (top === 'compacted') {
    x.cmpTop++;
    touch(s, sniffTimestamp(buf, start, end));
    return;
  }
  // token_usage_record repeats token_count at thread level and can't tell inherited totals apart.
  if (top === 'world_state' || top === 'realtime_item' || top === 'inter_agent_communication_metadata' || top === 'token_usage_record') return;
  if (top === 'event_msg') {
    const pt = types[1];
    if (pt === 'item_completed') {
      const it = types[2];
      const ts = sniffTimestamp(buf, start, end);
      if (it === 'CommandExecution') {
        if (end - start < MAX_PARSE && indexWithin(buf, GIT, start, end)) {
          parseAndApply(s, buf, start, end);
          return;
        }
        touch(s, ts);
        if (indexWithin(buf, FAILED, start, end) || exitCodeNonZero(buf, start, end)) addToolError(s);
        return;
      }
      if (it === 'McpToolCall') {
        touch(s, ts);
        if (indexWithin(buf, IS_ERROR, start, end) || indexWithin(buf, FAILED, start, end)) addToolError(s);
        return;
      }
      if (it === 'ContextCompaction') {
        x.cmpItem++;
        return;
      }
      if (it && PARSE_ITEMS.has(it)) parseAndApply(s, buf, start, end);
      else if (it === 'AgentMessage') touch(s, ts);
      return;
    }
    if (pt && PARSE_EVENTS.has(pt)) parseAndApply(s, buf, start, end);
    return;
  }
  // session_meta, turn_context, token_usage_record and anything unknown.
  parseAndApply(s, buf, start, end);
}

function indexWithin(buf: Buffer, needle: Buffer, start: number, end: number): boolean {
  return indexIn(buf, needle, start, end) !== -1;
}

const EXIT = Buffer.from('"exit_code":');
function exitCodeNonZero(buf: Buffer, start: number, end: number): boolean {
  const rel = buf.subarray(start, end).lastIndexOf(EXIT);
  if (rel === -1) return false;
  const at = start + rel;
  const c = buf[at + EXIT.length];
  return c !== 48 && c !== 110; // not '0' and not 'n'(ull)
}

function parseAndApply(s: AccState, buf: Buffer, start: number, end: number): void {
  let d: Json;
  try {
    d = JSON.parse(buf.toString('utf8', start, end));
  } catch {
    s.badLines++;
    return;
  }
  codexRecord(s, d);
}

function findParent(v: unknown, depth = 0): string | undefined {
  if (!v || typeof v !== 'object' || depth > 6) return undefined;
  const o = v as Json;
  if (typeof o.parent_thread_id === 'string') return o.parent_thread_id;
  for (const k of Object.keys(o)) {
    const r = findParent(o[k], depth + 1);
    if (r) return r;
  }
  return undefined;
}

function userTextOf(item: Json): string {
  const c = item.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p: Json) => (typeof p?.text === 'string' ? p.text : p?.type === 'image' || p?.type === 'local_image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof item.message === 'string') return item.message;
  return '';
}

function agentTextOf(item: Json): string {
  const c = item.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: Json) => (typeof p?.text === 'string' ? p.text : '')).join('');
  if (typeof item.text === 'string') return item.text;
  if (typeof item.message === 'string') return item.message;
  return '';
}

function userInput(s: AccState, x: CodexX, ts: number, raw: string, sink?: DetailSink): void {
  if (ts) x.lastInputTs = ts;
  const text = raw.trim();
  if (!text) return;
  const key = text.slice(0, 200);
  const t = currentTurn(s);
  // Newer versions report each input twice (item + event) at the same moment.
  if (t && !t.ended && x.inputsInTurn.some(([k, at]) => k === key && Math.abs(ts - at) < 10_000)) return;
  if (t && !t.ended && !t.prompt) {
    t.prompt = oneLine(text).slice(0, 300);
    if (ts) s.inputTimes.push(ts);
    if (!s.firstPrompt) s.firstPrompt = t.prompt;
    touch(s, ts, 2);
  } else if (t && !t.ended && x.turnId) {
    if (ts) s.inputTimes.push(ts); // steering input while the turn runs
    touch(s, ts, 2);
  } else {
    beginTurn(s, ts, oneLine(text));
    x.inputsInTurn = [];
  }
  x.inputsInTurn.push([key, ts]);
  if (x.inputsInTurn.length > 20) x.inputsInTurn.shift();
  sink?.item(ts, 'user', text, s.turns.length, undefined, 8000);
}

function usageVec(u: Json): number[] {
  return [
    Number(u.input_tokens ?? 0),
    Number(u.cached_input_tokens ?? 0),
    Number(u.cache_write_input_tokens ?? 0),
    Number(u.output_tokens ?? 0),
    Number(u.reasoning_output_tokens ?? 0),
  ];
}

function tokens(s: AccState, x: CodexX, total: Json | undefined, last: Json | undefined, window: unknown, ts = 0): void {
  if (typeof window === 'number' && window > 0) s.ctxWindow = window;
  if (!total || typeof total !== 'object') return;
  const cur = usageVec(total);
  const lastVec = last && typeof last === 'object' ? usageVec(last) : undefined;
  if (!x.totSeen) {
    // Subagents, forks and continued threads start from the parent's totals: only the
    // latest request (last_token_usage) of the first snapshot belongs to this file.
    x.totSeen = true;
    if (lastVec) x.tot = cur.map((v, i) => Math.max(0, v - lastVec[i]));
  } else if (cur[0] + cur[3] < (x.tot[0] + x.tot[3]) / 2) {
    // ponytail: a drop below half is a restarted counter (process resumed); smaller drops are jitter.
    x.tot = [0, 0, 0, 0, 0];
  }
  const delta = cur.map((v, i) => Math.max(0, v - x.tot[i]));
  x.tot = cur.map((v, i) => Math.max(v, x.tot[i]));
  const ctx = lastVec ? lastVec[0] : 0;
  if (lastVec) s.ctxParts = [Math.max(0, lastVec[0] - lastVec[1]), lastVec[1], lastVec[2]];
  if (ts && x.lastInputTs) {
    addSpeed(s, s.lastModel, delta[3], ts - x.lastInputTs);
    x.lastInputTs = ts; // the next request starts from here unless an input comes first
  }
  if (delta.some((v) => v > 0) || ctx) {
    // OpenAI input_tokens include cached tokens.
    const cached = delta[1];
    addUsage(
      s,
      s.lastModel,
      { input: Math.max(0, delta[0] - cached), cacheRead: cached, cacheWrite5m: delta[2], cacheWrite1h: 0, output: delta[3], reasoning: delta[4] },
      ctx,
    );
  }
}

function fileChanges(s: AccState, changes: Json, ts: number, sink?: DetailSink): void {
  for (const [p, ch] of Object.entries(changes)) {
    if (!ch || typeof ch !== 'object') continue;
    const c = ch as Json;
    let a = 0;
    let r = 0;
    const kind = c.type ?? (c.add ? 'add' : c.delete ? 'delete' : c.update ? 'update' : '');
    if (kind === 'add') a = countLines(c.content ?? c.add?.content);
    else if (kind === 'delete') r = countLines(c.content ?? c.delete?.content);
    else [a, r] = countDiff(String(c.unified_diff ?? c.update?.unified_diff ?? ''));
    addFileChange(s, typeof c.move_path === 'string' && c.move_path ? c.move_path : p, a, r, ts, sink);
  }
}

const COMMIT_RE = /\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] ?([^\n]*)/;

function commandItem(s: AccState, item: Json, ts: number, sink?: DetailSink): void {
  const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
  const ok = item.status !== 'failed' && (item.exit_code === 0 || item.exit_code === undefined || item.exit_code === null);
  const out = String(item.aggregated_output ?? item.output ?? '');
  if (ok && /\bgit\b[^\n]*\bcommit\b/.test(cmd)) {
    const m = COMMIT_RE.exec(out);
    if (m) addCommit(s, ts, m[2], sink, m[3]?.trim() || undefined, m[1]);
  }
  if (ok && /\bgit\b[^\n]*\bpush\b/.test(cmd)) s.pushes++;
}

/** Applies one parsed rollout record. Used by both summary and detail modes. */
export function codexRecord(s: AccState, d: Json, sink?: DetailSink, responses?: Map<number, string>): void {
  const x = s.x as unknown as CodexX;
  const ts = parseTs(d.timestamp);
  const p: Json = d.payload ?? {};
  switch (d.type) {
    case 'session_meta': {
      if (s.x && (s.x as Json).metaSeen) return;
      (s.x as Json).metaSeen = true;
      if (typeof p.id === 'string') s.sessionId = p.id;
      if (typeof p.cwd === 'string') s.cwd = p.cwd;
      if (typeof p.cli_version === 'string') s.version = p.cli_version;
      if (typeof p.originator === 'string') s.entrypoint = p.originator;
      if (p.git?.branch) s.branch = p.git.branch;
      if (typeof p.git?.repository_url === 'string') s.repo = p.git.repository_url;
      if (typeof p.forked_from_id === 'string') s.forkedFrom = p.forked_from_id;
      // Guardian (auto-approval review) threads keep the parent at the top level, not in source.
      const parent = findParent(p.source) ?? (typeof p.parent_thread_id === 'string' ? p.parent_thread_id : undefined);
      if (parent) {
        s.parentId = parent;
        s.isSubagent = true;
      }
      if (!s.start && ts) s.start = ts;
      return;
    }
    case 'turn_context':
      if (typeof p.model === 'string') addModel(s, p.model);
      if (!s.cwd && typeof p.cwd === 'string') s.cwd = p.cwd;
      return;
    case 'compacted':
      x.cmpTop++;
      sink?.item(ts, 'system', 'compact', s.turns.length);
      return;
    case 'event_msg':
      eventMsg(s, x, p, ts, sink, responses);
      return;
    case 'response_item':
      responseItem(s, p, ts, sink, responses);
      return;
    default:
      return;
  }
}

function eventMsg(s: AccState, x: CodexX, p: Json, ts: number, sink?: DetailSink, responses?: Map<number, string>): void {
  switch (p.type) {
    case 'task_started': {
      x.lastInputTs = ts;
      if (typeof p.model_context_window === 'number') s.ctxWindow = p.model_context_window;
      // started_at can be hours off the record time, so the record time is used.
      x.turnId = p.turn_id;
      x.inputsInTurn = [];
      beginTurn(s, ts, '', false);
      return;
    }
    case 'task_complete': {
      const text = typeof p.last_agent_message === 'string' ? p.last_agent_message : x.lastText ?? '';
      touch(s, ts);
      markTurnEnded(s, ts, looksLikeQuestion(text));
      if (responses && text) responses.set(s.turns.length, text);
      x.turnId = undefined;
      return;
    }
    case 'turn_aborted':
      touch(s, ts);
      markInterrupted(s);
      sink?.item(ts, 'system', `interrupted${p.reason ? `: ${p.reason}` : ''}`, s.turns.length);
      x.turnId = undefined;
      return;
    case 'token_count':
      tokens(s, x, p.info?.total_token_usage, p.info?.last_token_usage, p.info?.model_context_window, ts);
      return;
    case 'thread_settings_applied':
      if (typeof p.thread_settings?.model === 'string') addModel(s, p.thread_settings.model);
      return;
    case 'user_message':
      userInput(s, x, ts, String(p.message ?? ''), sink);
      return;
    case 'agent_message':
      if (typeof p.message === 'string') {
        x.lastText = p.message.slice(-400);
        touch(s, ts);
        sink?.item(ts, 'assistant', p.message, s.turns.length, undefined, 8000);
        responses?.set(s.turns.length, p.message);
      }
      return;
    case 'exec_command_end':
      if (typeof p.exit_code === 'number' && p.exit_code !== 0) addToolError(s);
      return;
    case 'patch_apply_end':
      if (p.success !== false && p.changes && typeof p.changes === 'object') fileChanges(s, p.changes, ts, sink);
      return;
    case 'item_completed':
      itemCompleted(s, x, p.item ?? {}, ts, sink, responses);
      return;
    default:
      return;
  }
}

function itemCompleted(s: AccState, x: CodexX, item: Json, ts: number, sink?: DetailSink, responses?: Map<number, string>): void {
  switch (item.type) {
    case 'UserMessage':
      userInput(s, x, ts, userTextOf(item), sink);
      return;
    case 'AgentMessage': {
      const text = agentTextOf(item);
      if (text) {
        x.lastText = text.slice(-400);
        touch(s, ts);
        sink?.item(ts, 'assistant', text, s.turns.length, undefined, 8000);
        responses?.set(s.turns.length, text);
      }
      return;
    }
    case 'FileChange':
      touch(s, ts);
      if (item.status === 'completed' && item.changes && typeof item.changes === 'object') fileChanges(s, item.changes, ts, sink);
      else if (item.status && item.status !== 'completed') addToolError(s);
      if (sink) sink.item(ts, 'result', Object.keys(item.changes ?? {}).join('\n'), s.turns.length, { tool: 'apply_patch', isError: item.status !== 'completed' }, 600);
      return;
    case 'CommandExecution': {
      if (ts) x.lastInputTs = ts;
      touch(s, ts);
      const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      if (failed) addToolError(s);
      commandItem(s, item, ts, sink);
      if (sink) {
        const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
        sink.item(ts, 'result', `$ ${cmd}\n${String(item.aggregated_output ?? '')}`, s.turns.length, { tool: 'shell', isError: failed }, 600);
      }
      return;
    }
    case 'McpToolCall':
      touch(s, ts);
      if (item.status === 'failed' || item.result?.isError === true) addToolError(s);
      return;
    case 'ContextCompaction':
      x.cmpItem++;
      return;
    default:
      return;
  }
}

function responseItem(s: AccState, p: Json, ts: number, sink?: DetailSink, _responses?: Map<number, string>): void {
  if (TOOL_TYPES.has(p.type)) {
    touch(s, ts);
    addTool(s);
    if (sink) {
      const name = String(p.name ?? p.type);
      let brief = '';
      if (typeof p.arguments === 'string') {
        try {
          const a = JSON.parse(p.arguments);
          brief = a.cmd ?? a.command ?? a.path ?? a.query ?? p.arguments;
          if (Array.isArray(brief)) brief = brief.join(' ');
        } catch {
          brief = p.arguments;
        }
      } else if (typeof p.input === 'string') brief = p.input;
      else if (p.action?.query) brief = p.action.query;
      sink.item(ts, 'tool', String(brief), s.turns.length, { tool: name }, 400);
    }
    return;
  }
  if (p.type === 'message' || p.type === 'agent_message') touch(s, ts);
}

export function codexFinalizeExtras(s: AccState): void {
  const x = s.x as unknown as CodexX;
  s.compactions = Math.max(x.cmpTop, x.cmpItem);
}
