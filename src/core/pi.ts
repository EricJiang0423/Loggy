// Pi session transcript parser (~/.pi/agent/sessions/--<encoded-cwd>/<timestamp>_<sessionId>.jsonl).
// Pi publishes the record types in its session-format notes; the code below was written against
// version 3 files and ignores every record type it does not know.

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

/** What a tool call needs remembered until its result arrives. */
interface PiTool {
  name: string;
  /** File the call writes to; Pi does not repeat it in the result. */
  path?: string;
  /** Line count of the body a `write` call created. */
  lines?: number;
}

interface PiX {
  tools: Record<string, PiTool>;
  toolOrder: string[];
  /** toolCall id -> commit message taken from a `git commit -m` command. */
  cmd: Record<string, string>;
  /** toolCall id of a `git push` waiting for its result. */
  push?: string;
  lastText?: string;
  /** The header line has been read; the file name is only a fallback for the session id. */
  header?: boolean;
}

// ponytail: bounded de-dup window; a long tool-heavy turn can outrun any fixed window.
const TOOL_WINDOW = 256;

/** The line git prints first after a successful commit: `[main 1a2b3c4] message`. */
const COMMIT_LINE = /^\[([^\s\]|]+)\s+([0-9a-f]{7,40})\]\s*(.*)$/m;

// Pi records no git metadata, so a `git commit` / `git push` subcommand is the only signal.
const GIT_COMMIT = /\bgit\s+commit\b/;
const GIT_PUSH = /\bgit\s+push\b/;

/** `git push` prints one of these when it reached the remote. */
const PUSH_OK = /Everything up-to-date|To \S+|forced update|-> \S+/;

export function initPiState(file: string): AccState {
  const s = newState('pi', file);
  s.sessionId = sessionIdOf(file);
  s.x = { tools: {}, toolOrder: [], cmd: {} } as unknown as Record<string, unknown>;
  return s;
}

/** Session id from `<timestamp>_<id>.jsonl`; a fork names its parent's file, so its id is the parent's. */
function sessionIdOf(file: string): string {
  const base = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
  const i = base.lastIndexOf('_');
  return i > 0 ? base.slice(i + 1) : base;
}

/** Pi keys results by the call id, sometimes with a `|fc_…` suffix for the second attempt. */
function callKey(id: unknown): string {
  return typeof id === 'string' ? id.split('|')[0] : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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

function remember(x: PiX, id: string, tool: PiTool): void {
  if (!id) return;
  if (!(id in x.tools)) {
    x.toolOrder.push(id);
    if (x.toolOrder.length > TOOL_WINDOW) {
      const old = x.toolOrder.shift()!;
      delete x.tools[old];
      delete x.cmd[old];
      if (x.push === old) x.push = undefined;
    }
  }
  x.tools[id] = tool;
}

function commitMessageFrom(command: string): string | undefined {
  const m = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command);
  if (m) return (m[1] ?? m[2] ?? '').split('\n')[0].trim() || undefined;
  const heredoc = /<<\s*'?EOF'?\s*\n([^\n]*)/.exec(command);
  if (heredoc) return heredoc[1].trim() || undefined;
  return undefined;
}

function briefInput(name: string, args: Json): string {
  const pick =
    args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? args.query ?? args.description ?? args.prompt;
  if (typeof pick === 'string') return pick;
  try {
    return JSON.stringify(args).slice(0, 300);
  } catch {
    return '';
  }
}

export function piRecord(s: AccState, d: Json, sink?: DetailSink, responses?: Map<number, string>): void {
  const x = s.x as unknown as PiX;
  const ts = parseTs(d.timestamp);
  switch (d.type) {
    case 'session':
      headerRecord(s, x, d, ts);
      return;
    case 'message': {
      const m = d.message;
      if (!m || typeof m !== 'object') return;
      if (m.role === 'user') userRecord(s, d, ts, sink);
      else if (m.role === 'assistant') assistantRecord(s, x, d, ts, sink, responses);
      else if (m.role === 'toolResult') toolResultRecord(s, x, d, ts, sink);
      // `system` carries the prompt and `custom` an extension's hook message: neither is conversation.
      return;
    }
    case 'session_info':
      if (typeof d.name === 'string' && d.name.trim()) s.customTitle = d.name.trim();
      return;
    case 'model_change':
      addModel(s, typeof d.modelId === 'string' ? d.modelId : undefined);
      return;
    case 'compaction':
      s.compactions++;
      touch(s, ts);
      sink?.item(ts, 'system', 'compact', s.turns.length);
      return;
    case 'branch_summary':
      // `/tree` leaves the branch it walked away from in the file; entries are read in file order.
      sink?.item(ts, 'system', 'branch', s.turns.length);
      return;
    case 'usage':
      // Model-attributed usage that never reached the model context, e.g. a cache warm-up.
      addUsage(s, typeof d.model === 'string' ? d.model : undefined, usageOf(d.usage), num((d.usage as Json | undefined)?.totalTokens));
      touch(s, ts);
      return;
    default:
      // thinking_level_change, context_edit, label, custom: state, not conversation.
      return;
  }
}

function headerRecord(s: AccState, x: PiX, d: Json, ts: number): void {
  if (x.header) return;
  x.header = true;
  // The header carries the session's own start time; no other record can be earlier.
  touch(s, ts);
  if (typeof d.cwd === 'string' && d.cwd) s.cwd = d.cwd;
  if (typeof d.version === 'number') s.version = String(d.version);
  if (typeof d.id === 'string' && d.id) s.sessionId = d.id;
  // `/fork` and `/clone` continue the parent's thread, so both files count as one session.
  if (typeof d.parentSession === 'string' && d.parentSession) {
    s.forkedFrom = sessionIdOf(d.parentSession);
    s.sessionId = s.forkedFrom;
  }
}

function userRecord(s: AccState, d: Json, ts: number, sink?: DetailSink): void {
  const content = d.message?.content;
  const text = textOf(content);
  const images = Array.isArray(content) ? content.filter((b: Json) => b?.type === 'image').length : 0;
  if (!text && !images) return;
  const prompt = text || `[${images} image${images > 1 ? 's' : ''}]`;
  beginTurn(s, ts, oneLine(prompt));
  sink?.item(ts, 'user', prompt, s.turns.length, undefined, 8000);
}

function usageOf(u: unknown): { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } {
  const o = (u ?? {}) as Json;
  return {
    input: num(o.input),
    output: num(o.output),
    cacheRead: num(o.cacheRead),
    // Pi reports one cache-write figure; it is priced like a 5-minute write.
    cacheWrite5m: num(o.cacheWrite),
    cacheWrite1h: 0,
  };
}

function assistantRecord(s: AccState, x: PiX, d: Json, ts: number, sink?: DetailSink, responses?: Map<number, string>): void {
  const m: Json = d.message ?? {};
  touch(s, ts);
  const model = typeof m.model === 'string' ? m.model : undefined;
  if (model) addModel(s, model);

  if (m.usage && typeof m.usage === 'object') {
    // Per-request counts, not cumulative, so nothing has to be de-duplicated.
    addUsage(s, model, usageOf(m.usage), num(m.usage.totalTokens));
  }

  const blocks: Json[] = Array.isArray(m.content) ? m.content : [];
  let text = '';
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    else if (b.type === 'toolCall') toolCall(s, x, b, ts, sink);
  }
  if (text) {
    x.lastText = text.slice(-400);
    sink?.item(ts, 'assistant', text, s.turns.length, undefined, 8000);
    if (responses) responses.set(s.turns.length, text);
  }

  switch (m.stopReason) {
    case 'stop':
      markTurnEnded(s, ts, looksLikeQuestion(text || x.lastText || ''));
      return;
    case 'aborted':
      markInterrupted(s);
      return;
    case 'error':
      // A failed request (rate limit, connection). Pi retries inside the same turn, so the turn is
      // left open: a reply that arrives later ends it normally, and one that never arrives keeps
      // the turn unfinished, which is what makes the session count as abandoned.
      s.apiErrors++;
      return;
    case 'toolUse':
      s.pendingTool = true;
      return;
    default:
      // 'pending' is a streaming placeholder Pi does not persist, 'length' means the reply was cut
      // off at the output limit and 'deferred' awaits retrieval: all three leave the turn open.
      return;
  }
}

function toolCall(s: AccState, x: PiX, b: Json, ts: number, sink?: DetailSink): void {
  const name = String(b.name ?? '');
  const id = callKey(b.id);
  const args = (b.arguments && typeof b.arguments === 'object' ? b.arguments : {}) as Json;
  const tool: PiTool = { name };
  if (typeof args.path === 'string') tool.path = args.path;
  else if (typeof args.file_path === 'string') tool.path = args.file_path;
  if (name === 'write') tool.lines = countLines(args.content);
  remember(x, id, tool);
  addTool(s);
  if (name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (GIT_COMMIT.test(command)) {
      // An empty message is kept: the commit line git prints still names the branch and sha.
      x.cmd[id] = commitMessageFrom(command)?.slice(0, 200) ?? '';
    }
    if (GIT_PUSH.test(command)) x.push = id;
  }
  sink?.item(ts, 'tool', briefInput(name, args), s.turns.length, { tool: name }, 400);
}

function toolResultRecord(s: AccState, x: PiX, d: Json, ts: number, sink?: DetailSink): void {
  const m: Json = d.message ?? {};
  const id = callKey(m.toolCallId);
  const tool = id ? x.tools[id] : undefined;
  touch(s, ts);
  if (m.isError === true) addToolError(s);
  const text = textOf(m.content);
  if (sink) sink.item(ts, 'result', text, s.turns.length, { tool: tool?.name, isError: m.isError === true }, 600);
  s.pendingTool = false;
  const turn = currentTurn(s);
  if (turn && !turn.ended) s.awaitingReply = false;

  const path = tool?.path;
  const diff = typeof (m.details as Json | undefined)?.diff === 'string' ? (m.details as Json).diff : undefined;
  if (path) {
    if (diff) {
      const [added, removed] = countDiff(diff);
      if (added || removed) addFileChange(s, path, added, removed, ts, sink);
    } else if (tool?.lines) {
      // `write` reports success without a diff, so the body from the call is the line count.
      addFileChange(s, path, tool.lines, 0, ts, sink);
    }
  }

  const expected = id && id in x.cmd ? x.cmd[id] : undefined;
  if (expected !== undefined) {
    const hit = COMMIT_LINE.exec(text);
    if (hit) {
      addCommit(s, ts, hit[2], sink, expected || hit[3].trim() || undefined, hit[1]);
      delete x.cmd[id];
    }
  }
  if (x.push === id) {
    if (m.isError !== true && PUSH_OK.test(text)) s.pushes++;
    x.push = undefined;
  }
}