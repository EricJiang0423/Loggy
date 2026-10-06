// Kimi Code session parser (~/.kimi-code/sessions/wd_<dir>_<hash>/session_<id>/agents/<agent>/wire.jsonl).
// Each agent of a session (main, agent-1, ...) writes its own event log; state.json next to the
// agents folder holds the working directory, the title and which agent started which.

import fs from 'node:fs';
import path from 'node:path';
import {
  type AccState,
  DetailSink,
  addCommit,
  addCommitRun,
  addFileChange,
  addModel,
  addSpeed,
  addTool,
  addToolError,
  addUsage,
  beginTurn,
  countLines,
  currentTurn,
  looksLikeQuestion,
  markInterrupted,
  markTurnEnded,
  newState,
  oneLine,
  setKnob,
  touch,
} from './acc.js';
import { indexIn } from './lines.js';

type Json = Record<string, any>;

// ponytail: bounded tool-call window, like the Claude parser; a result rarely comes 256 calls later.
const CALL_WINDOW = 256;

interface KimiCall {
  name: string;
  ts: number;
  path?: string;
  added?: number;
  removed?: number;
  commit?: boolean;
  push?: boolean;
}

interface KimiX {
  calls: Record<string, KimiCall>;
  callOrder: string[];
  lastText?: string;
  /** Open approval or question requests (they put the session in "needs input"). */
  open: string[];
  /** Questions of open AskUserQuestion requests, by request id. */
  asks: Record<string, Json[]>;
}

/** Context window per model alias from the user's config.toml (cached per Kimi home). */
const windows = new Map<string, Map<string, number>>();

function windowsOf(home: string): Map<string, number> {
  let m = windows.get(home);
  if (m) return m;
  m = new Map();
  try {
    let model = '';
    for (const line of fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split('\n')) {
      const head = /^\s*\[models\."([^"]+)"\]/.exec(line);
      if (head) model = head[1];
      else if (/^\s*\[/.test(line)) model = '';
      const size = /^\s*max_context_size\s*=\s*(\d+)/.exec(line);
      if (model && size) m.set(model, Number(size[1]));
    }
  } catch {
    // no config: fall back to the defaults in pricing
  }
  windows.set(home, m);
  return m;
}

export function initKimiState(file: string): AccState {
  const s = newState('kimi', file);
  const agentDir = path.dirname(file);
  const agent = path.basename(agentDir);
  const sessionDir = path.dirname(path.dirname(agentDir));
  const sid = path.basename(sessionDir);
  let state: Json = {};
  try {
    state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  } catch {
    // written a moment later; the cwd also comes with profile.bind
  }
  const session = typeof state.id === 'string' ? state.id : sid;
  if (agent === 'main') s.sessionId = session;
  else {
    const parent = state.agents?.[agent]?.parentAgentId;
    s.isSubagent = true;
    s.sessionId = `${session}/${agent}`;
    s.parentId = typeof parent === 'string' && parent !== 'main' ? `${session}/${parent}` : session;
  }
  if (typeof state.cwd === 'string') s.cwd = state.cwd;
  if (agent === 'main' && typeof state.title === 'string' && state.title.trim()) {
    if (state.isCustomTitle) s.customTitle = state.title.trim();
    else s.aiTitle = state.title.trim();
  }
  // These modes are off until a record says otherwise.
  s.knobCur = { plan: 'off', swarm: 'off', goal: 'off' };
  s.x = { calls: {}, callOrder: [], open: [], asks: {}, home: path.dirname(path.dirname(path.dirname(sessionDir))) } as unknown as Record<string, unknown>;
  return s;
}

// Large records the summary never needs: the UI copy of each message and tool/MCP listings.
const SKIP = ['{"message":', '{"type":"context.append_message"', '{"type":"llm.tools_snapshot"', '{"type":"mcp.tools_discovered"', '{"type":"llm.request"'].map((p) => Buffer.from(p));

/** Summary and detail entry point working on raw line bytes. */
export function kimiLine(s: AccState, buf: Buffer, start: number, end: number, sink?: DetailSink, responses?: Map<number, string>): void {
  for (const p of SKIP) if (indexIn(buf, p, start, Math.min(end, start + p.length)) === start) return;
  let d: Json;
  try {
    d = JSON.parse(buf.toString('utf8', start, end));
  } catch {
    s.badLines++;
    return;
  }
  kimiRecord(s, d, sink, responses);
}

function inputText(input: unknown): { text: string; images: number } {
  let text = '';
  let images = 0;
  for (const p of Array.isArray(input) ? input : []) {
    if (p?.type === 'text' && typeof p.text === 'string') text += (text ? '\n' : '') + p.text;
    else if (p?.type === 'image_url') images++;
  }
  return { text, images };
}

function remember(x: KimiX, id: string, call: KimiCall): void {
  if (!id) return;
  if (!(id in x.calls)) {
    x.callOrder.push(id);
    if (x.callOrder.length > CALL_WINDOW) delete x.calls[x.callOrder.shift()!];
  }
  x.calls[id] = call;
}

function brief(args: Json): string {
  const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? args.query ?? args.description ?? args.prompt;
  if (typeof pick === 'string') return pick;
  try {
    return JSON.stringify(args).slice(0, 300);
  } catch {
    return '';
  }
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[image]' : '')).join('\n');
  return '';
}

const COMMIT_RE = /\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] ?([^\n]*)/;

/** Applies one wire record. Used by both summary and detail modes. */
export function kimiRecord(s: AccState, d: Json, sink?: DetailSink, responses?: Map<number, string>): void {
  const x = s.x as unknown as KimiX & { home: string };
  const ts = typeof d.time === 'number' ? d.time : 0;
  switch (d.type) {
    case 'profile.bind':
      if (!s.cwd && typeof d.environmentDisclosure?.cwd === 'string') s.cwd = d.environmentDisclosure.cwd;
      setKnob(s, 'effort', d.thinkingEffort);
      return;
    case 'permission.set_mode':
      setKnob(s, 'permission', d.mode);
      return;
    case 'config.update':
      setKnob(s, 'effort', d.thinkingEffort);
      if (typeof d.modelAlias === 'string') addModel(s, d.modelAlias);
      return;
    case 'plan_mode.enter':
      s.hasPlan = true;
      setKnob(s, 'plan', 'on');
      return;
    case 'plan_mode.exit':
      setKnob(s, 'plan', 'off');
      return;
    case 'swarm_mode.enter':
      setKnob(s, 'swarm', 'on');
      return;
    case 'swarm_mode.exit':
      setKnob(s, 'swarm', 'off');
      return;
    case 'goal.create':
      setKnob(s, 'goal', 'on');
      return;
    case 'goal.clear':
      setKnob(s, 'goal', 'off');
      return;
    case 'goal.update':
      if (d.status === 'complete') setKnob(s, 'goal', 'off');
      return;
    case 'turn.prompt': {
      const { text, images } = inputText(d.input);
      const shown = d.origin?.clientMetadata?.[0]?.display_text;
      const prompt = (typeof shown === 'string' && shown.trim() ? shown : text).trim() || (images ? `[${images} image${images > 1 ? 's' : ''}]` : '');
      const kind = d.origin?.kind;
      // Scheduled jobs, finished background tasks and goal continuations start turns on their own.
      const byYou = kind === 'user' || s.isSubagent;
      const label = byYou ? prompt : kind === 'cron_job' ? `[cron] ${prompt}` : kind === 'task' ? '[background task finished]' : `[${d.origin?.name ?? kind ?? 'system'}] ${prompt}`;
      beginTurn(s, ts, oneLine(label), byYou);
      if (sink) sink.item(ts, byYou ? 'user' : 'system', byYou ? prompt : label, s.turns.length, undefined, 8000);
      return;
    }
    case 'turn.steer':
      if (d.origin?.kind !== 'user') return;
      if (ts) s.inputTimes.push(ts);
      touch(s, ts, 2);
      if (sink) sink.item(ts, 'user', inputText(d.input).text, s.turns.length, undefined, 8000);
      return;
    case 'turn.ended':
      touch(s, ts);
      if (d.reason === 'cancelled') {
        markInterrupted(s);
        sink?.item(ts, 'system', 'interrupted', s.turns.length);
      } else if (d.reason === 'failed') {
        s.apiErrors++;
        const t = currentTurn(s);
        if (t) t.ended = t.interrupted = true;
        s.pendingTool = false;
        sink?.item(ts, 'system', `error: ${String(d.error?.message ?? 'failed').slice(0, 200)}`, s.turns.length);
      } else {
        markTurnEnded(s, ts, looksLikeQuestion(x.lastText ?? '') || x.open.length > 0);
        if (responses && x.lastText) responses.set(s.turns.length, x.lastText);
      }
      return;
    case 'usage.record': {
      const u = d.usage ?? {};
      const model = typeof d.model === 'string' ? d.model : s.lastModel;
      if (model) {
        addModel(s, model);
        const w = windowsOf(x.home).get(model);
        if (w) s.ctxWindow = w;
      }
      const input = Number(u.inputOther ?? 0);
      const cacheRead = Number(u.inputCacheRead ?? 0);
      const cacheWrite = Number(u.inputCacheCreation ?? 0);
      // Session-scope records are compaction calls: they cost tokens but are not the context.
      const ctx = d.usageScope === 'turn' ? input + cacheRead + cacheWrite : undefined;
      if (ctx) s.ctxParts = [input, cacheRead, cacheWrite];
      addUsage(s, model, { input, cacheRead, cacheWrite5m: cacheWrite, cacheWrite1h: 0, output: Number(u.output ?? 0) }, ctx);
      touch(s, ts);
      return;
    }
    case 'context.apply_compaction':
      s.compactions++;
      touch(s, ts);
      sink?.item(ts, 'system', 'compact', s.turns.length);
      return;
    case 'context.append_loop_event':
      loopEvent(s, x, d.event ?? {}, ts, sink, responses);
      return;
    case 'interaction.request':
      if (typeof d.id === 'string' && !x.open.includes(d.id)) x.open.push(d.id);
      if (d.kind === 'question' && Array.isArray(d.request?.questions)) x.asks[d.id] = d.request.questions;
      s.awaitingReply = true;
      touch(s, ts);
      return;
    case 'interaction.resolved': {
      x.open = x.open.filter((id) => id !== d.id);
      if (!x.open.length) s.awaitingReply = false;
      const qs = x.asks[d.id];
      delete x.asks[d.id];
      if (qs && sink) {
        const answers = (d.response?.answers ?? {}) as Record<string, unknown>;
        sink.questionList.push({
          ts,
          turn: s.turns.length,
          questions: qs.map((q) => ({
            question: String(q?.question ?? ''),
            options: Array.isArray(q?.options) ? q.options.map((o: Json) => String(o?.label ?? o ?? '')) : [],
            answer: answers[q?.question] !== undefined ? String(answers[q.question]) : undefined,
          })),
        });
      }
      touch(s, ts);
      return;
    }
    case 'task.started':
      if (typeof d.info?.taskId === 'string' && !s.bgPending.includes(d.info.taskId)) s.bgPending.push(d.info.taskId);
      if (s.bgPending.length > 50) s.bgPending = s.bgPending.slice(-50);
      return;
    case 'task.terminated':
      s.bgPending = s.bgPending.filter((id) => id !== d.info?.taskId);
      return;
    default:
      return;
  }
}

function loopEvent(s: AccState, x: KimiX, ev: Json, ts: number, sink?: DetailSink, responses?: Map<number, string>): void {
  switch (ev.type) {
    case 'tool.call': {
      touch(s, ts);
      addTool(s);
      const name = String(ev.name ?? '');
      const args: Json = ev.args && typeof ev.args === 'object' ? ev.args : {};
      const call: KimiCall = { name, ts };
      if (name === 'Edit' && typeof args.path === 'string') Object.assign(call, { path: args.path, added: countLines(args.new_string), removed: countLines(args.old_string) });
      else if (name === 'Write' && typeof args.path === 'string') Object.assign(call, { path: args.path, added: countLines(args.content), removed: 0 });
      else if (name === 'Bash' && typeof args.command === 'string') {
        call.commit = /\bgit\b[^\n]*\bcommit\b/.test(args.command);
        call.push = /\bgit\b[^\n]*\bpush\b/.test(args.command);
      }
      remember(x, String(ev.toolCallId ?? ''), call);
      if (name === 'EnterPlanMode' || name === 'ExitPlanMode') s.hasPlan = true;
      if (name === 'AskUserQuestion') {
        s.questions++;
        if (sink) {
          const qs = Array.isArray(args.questions) ? args.questions : [];
          sink.item(ts, 'question', qs.map((q: Json) => `${q?.question ?? ''}\n${(q?.options ?? []).map((o: Json) => `• ${o?.label ?? ''}`).join('\n')}`).join('\n\n'), s.turns.length, { tool: name });
        }
      } else if (sink) sink.item(ts, 'tool', brief(args), s.turns.length, { tool: name }, 400);
      return;
    }
    case 'tool.result': {
      touch(s, ts);
      s.pendingTool = false;
      const r: Json = ev.result ?? {};
      const call = x.calls[String(ev.toolCallId ?? '')];
      const failed = r.isError === true;
      if (failed) addToolError(s);
      const out = outputText(r.output);
      if (call && !failed) {
        if (call.path) addFileChange(s, call.path, call.added ?? 0, call.removed ?? 0, ts, sink);
        if (call.commit) {
          addCommitRun(s, call.ts, ts);
          const m = COMMIT_RE.exec(out);
          if (m) addCommit(s, ts, m[2], sink, m[3]?.trim() || undefined, m[1]);
        }
        if (call.push) s.pushes++;
      }
      if (sink) sink.item(ts, 'result', out, s.turns.length, { tool: call?.name ?? '', isError: failed }, 600);
      return;
    }
    case 'content.part':
      if (ev.part?.type === 'text' && typeof ev.part.text === 'string' && ev.part.text.trim()) {
        x.lastText = ev.part.text.slice(-400);
        touch(s, ts);
        sink?.item(ts, 'assistant', ev.part.text, s.turns.length, undefined, 8000);
        responses?.set(s.turns.length, ev.part.text);
      }
      return;
    case 'step.end': {
      const out = Number(ev.usage?.output ?? 0);
      if (typeof ev.llmStreamDurationMs === 'number') addSpeed(s, s.lastModel, out, ev.llmStreamDurationMs);
      return;
    }
    default:
      return;
  }
}
