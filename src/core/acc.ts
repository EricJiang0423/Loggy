// Agent-independent accumulator. Parsers feed it records in file order; the state is a
// plain JSON object so it can be cached and resumed when a log file grows.

import type {
  Agent,
  CommitInfo,
  CompletionCheck,
  FileStat,
  Outcome,
  QuestionInfo,
  SessionSummary,
  TimelineItem,
  TimelineKind,
  TurnDetail,
} from '../shared/types.js';
import { contextWindowFor, costOf, type UsageForCost } from './pricing.js';

export const PARSER_VERSION = 4;
const BUCKET_MS = 600_000;
const WAIT_CAP_MS = 30 * 60_000;
const IDLE_SPLIT_MS = 30 * 60_000;

export interface TurnAcc {
  start: number;
  end: number;
  prompt: string;
  tokens: number;
  cost: number;
  ctx: number;
  tools: number;
  errors: number;
  interrupted: boolean;
  ended: boolean;
  commits: number;
}

export interface AccState {
  v: number;
  agent: Agent;
  file: string;
  sessionId: string;
  parentId?: string;
  isSubagent: boolean;
  forkedFrom?: string;
  cwd: string;
  branch?: string;
  repo?: string;
  version?: string;
  entrypoint?: string;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt: string;
  models: string[];
  lastModel?: string;
  start: number;
  end: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  ctxTokensMax: number;
  ctxTokensLast: number;
  ctxWindow: number;
  /** Peak context % measured against the window in effect at each request (when the log states it). */
  ctxPctMax?: number;
  toolCalls: number;
  toolErrors: number;
  interrupts: number;
  compactions: number;
  apiErrors: number;
  questions: number;
  files: Record<string, [number, number, number]>;
  commits: number;
  pushes: number;
  lastCommitTs: number;
  lastEditTs: number;
  buckets: Record<string, number>;
  inputTimes: number[];
  turns: TurnAcc[];
  pendingTool: boolean;
  awaitingReply: boolean;
  bgPending: string[];
  hasPlan: boolean;
  badLines: number;
  /** Agent-specific scratch space (must stay JSON-serializable and bounded). */
  x: Record<string, unknown>;
}

export function newState(agent: Agent, file: string): AccState {
  return {
    v: PARSER_VERSION,
    agent,
    file,
    sessionId: '',
    isSubagent: false,
    cwd: '',
    firstPrompt: '',
    models: [],
    start: 0,
    end: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    ctxTokensMax: 0,
    ctxTokensLast: 0,
    ctxWindow: 0,
    toolCalls: 0,
    toolErrors: 0,
    interrupts: 0,
    compactions: 0,
    apiErrors: 0,
    questions: 0,
    files: {},
    commits: 0,
    pushes: 0,
    lastCommitTs: 0,
    lastEditTs: 0,
    buckets: {},
    inputTimes: [],
    turns: [],
    pendingTool: false,
    awaitingReply: false,
    bgPending: [],
    hasPlan: false,
    badLines: 0,
    x: {},
  };
}

/** Optional collector for the session detail view. */
export class DetailSink {
  timeline: TimelineItem[] = [];
  timelineTotal = 0;
  turnDetails: TurnDetail[] = [];
  commitList: CommitInfo[] = [];
  questionList: QuestionInfo[] = [];
  private turnFiles = new Map<number, Set<string>>();
  constructor(private readonly maxItems = 20000) {}

  item(ts: number, kind: TimelineKind, text: string, turn: number, extra?: Partial<TimelineItem>, limit = 4000): void {
    this.timelineTotal++;
    if (this.timeline.length >= this.maxItems) return;
    const clean = text ?? '';
    const cut = clean.length > limit ? clean.length - limit : 0;
    this.timeline.push({ ts, kind, text: cut ? clean.slice(0, limit) : clean, turn, ...(cut ? { cut } : {}), ...extra });
  }

  file(turn: number, path: string): void {
    let set = this.turnFiles.get(turn);
    if (!set) this.turnFiles.set(turn, (set = new Set()));
    set.add(path);
  }

  filesOf(turn: number): string[] {
    return [...(this.turnFiles.get(turn) ?? [])];
  }
}

export function touch(s: AccState, ts: number, weight = 1): void {
  if (!ts) return;
  if (!s.start || ts < s.start) s.start = ts;
  if (ts > s.end) s.end = ts;
  const b = Math.floor(ts / BUCKET_MS);
  s.buckets[b] = (s.buckets[b] ?? 0) + weight;
  const t = s.turns[s.turns.length - 1];
  if (t && ts > t.end) t.end = ts;
}

export function beginTurn(s: AccState, ts: number, prompt: string, isInput = true): TurnAcc {
  const prev = s.turns[s.turns.length - 1];
  if (prev && !prev.ended && !prev.interrupted) {
    // A new input arrived while the previous turn had not finished cleanly.
    prev.ended = true;
  }
  const turn: TurnAcc = {
    start: ts,
    end: ts,
    prompt: prompt.slice(0, 300),
    tokens: 0,
    cost: 0,
    ctx: 0,
    tools: 0,
    errors: 0,
    interrupted: false,
    ended: false,
    commits: 0,
  };
  s.turns.push(turn);
  if (ts && isInput) s.inputTimes.push(ts);
  if (!s.firstPrompt && prompt) s.firstPrompt = prompt.slice(0, 300);
  s.awaitingReply = false;
  s.pendingTool = false;
  touch(s, ts, 2);
  return turn;
}

export function currentTurn(s: AccState): TurnAcc | undefined {
  return s.turns[s.turns.length - 1];
}

export function addModel(s: AccState, model: string | undefined): void {
  if (!model || model === '<synthetic>') return;
  s.lastModel = model;
  if (!s.models.includes(model)) s.models.push(model);
}

/** Adds token usage (already de-duplicated by the caller). */
export function addUsage(s: AccState, model: string | undefined, u: UsageForCost & { reasoning?: number }, contextTokens?: number): number {
  const cost = costOf(model, u);
  s.input += u.input;
  s.output += u.output;
  s.cacheRead += u.cacheRead;
  s.cacheWrite += u.cacheWrite5m + u.cacheWrite1h;
  s.reasoning += u.reasoning ?? 0;
  s.cost += cost;
  const t = currentTurn(s);
  if (t) {
    t.tokens += u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    t.cost += cost;
  }
  if (contextTokens && contextTokens > 0) {
    s.ctxTokensLast = contextTokens;
    if (contextTokens > s.ctxTokensMax) s.ctxTokensMax = contextTokens;
    if (t && contextTokens > t.ctx) t.ctx = contextTokens;
    if (s.ctxWindow) s.ctxPctMax = Math.max(s.ctxPctMax ?? 0, (contextTokens / s.ctxWindow) * 100);
  }
  return cost;
}

export function addTool(s: AccState): void {
  s.toolCalls++;
  s.pendingTool = true;
  const t = currentTurn(s);
  if (t) t.tools++;
}

export function addToolError(s: AccState): void {
  s.toolErrors++;
  const t = currentTurn(s);
  if (t) t.errors++;
}

export function addFileChange(s: AccState, path: string, added: number, removed: number, ts: number, sink?: DetailSink): void {
  if (!path) return;
  const f = s.files[path] ?? (s.files[path] = [0, 0, 0]);
  f[0] += added;
  f[1] += removed;
  f[2] += 1;
  if (ts > s.lastEditTs) s.lastEditTs = ts;
  sink?.file(s.turns.length, path);
}

export function addCommit(s: AccState, ts: number, sha: string, sink?: DetailSink, message?: string, branch?: string): void {
  s.commits++;
  if (ts > s.lastCommitTs) s.lastCommitTs = ts;
  const t = currentTurn(s);
  if (t) t.commits++;
  sink?.commitList.push({ sha, ts, message, branch, turn: s.turns.length });
}

export function markInterrupted(s: AccState): void {
  s.interrupts++;
  const t = currentTurn(s);
  if (t) {
    t.interrupted = true;
    t.ended = true;
  }
  s.pendingTool = false;
}

export function markTurnEnded(s: AccState, ts: number, awaitingReply: boolean): void {
  const t = currentTurn(s);
  if (t) {
    t.ended = true;
    if (ts > t.end) t.end = ts;
  }
  s.awaitingReply = awaitingReply;
  s.pendingTool = false;
}

/** Heuristic: the final text ends with a question addressed to the user. */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.trim().slice(-200);
  if (!tail) return false;
  return /[?？]\s*(\*\*)?\s*$/.test(tail);
}

const CONTAINER_DIRS = new Set(['src', 'packages', 'apps', 'app', 'lib', 'libs', 'internal', 'pkg', 'cmd', 'services', 'crates', 'modules']);

function topDirOf(path: string, cwd: string): string | undefined {
  let rel = path;
  if (cwd && path.startsWith(cwd)) rel = path.slice(cwd.length).replace(/^[\\/]+/, '');
  else if (path.startsWith('/') || /^[A-Za-z]:\\/.test(path)) return undefined;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return '.';
  if (parts.length > 2 && CONTAINER_DIRS.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

export function finalize(s: AccState): SessionSummary {
  const turns = s.turns;
  let activeMs = 0;
  let waitMs = 0;
  let maxTools = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    activeMs += Math.max(0, Math.min(t.end - t.start, 6 * 3600_000));
    if (t.tools > maxTools) maxTools = t.tools;
    const next = turns[i + 1];
    if (next && t.end && next.start > t.end) {
      const gap = next.start - t.end;
      if (gap < WAIT_CAP_MS) waitMs += gap;
    }
  }
  const last = turns[turns.length - 1];
  const fileEntries = Object.entries(s.files);
  let added = 0;
  let removed = 0;
  const dirCounts = new Map<string, number>();
  for (const [path, [a, r, e]] of fileEntries) {
    added += a;
    removed += r;
    const d = topDirOf(path, s.cwd);
    if (d) dirCounts.set(d, (dirCounts.get(d) ?? 0) + e);
  }
  let component: string | undefined;
  let best = 0;
  for (const [d, c] of dirCounts) if (c > best) [component, best] = [d, c];

  const uncommittedEdits = s.lastEditTs > 0 && s.lastEditTs > s.lastCommitTs;
  const lastTurn = {
    ended: last ? last.ended : true,
    interrupted: last ? last.interrupted : false,
    awaitingReply: s.awaitingReply,
    pendingTool: s.pendingTool,
  };
  const outcome = computeOutcome(s.turns.length, lastTurn, uncommittedEdits, s.bgPending.length);
  const window = s.ctxWindow || contextWindowFor(s.lastModel, s.ctxTokensMax);
  const title = s.customTitle || s.aiTitle || s.firstPrompt;
  const buckets = Object.entries(s.buckets)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  return {
    id: `${s.agent}:${s.sessionId}`,
    agent: s.agent,
    sessionId: s.sessionId,
    file: s.file,
    parentId: s.parentId ? `${s.agent}:${s.parentId}` : undefined,
    isSubagent: s.isSubagent,
    forkedFrom: s.forkedFrom ? `${s.agent}:${s.forkedFrom}` : undefined,
    cwd: s.cwd,
    projectPath: s.cwd,
    project: '',
    branch: s.branch,
    title: oneLine(title).slice(0, 200),
    titleSource: s.customTitle ? 'custom' : s.aiTitle ? 'ai' : s.firstPrompt ? 'prompt' : 'none',
    firstPrompt: s.firstPrompt,
    models: s.models,
    version: s.version,
    entrypoint: s.entrypoint,
    start: s.start,
    end: s.end,
    turns: turns.length,
    userInputs: s.inputTimes.length,
    tokens: { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, reasoning: s.reasoning },
    costUSD: s.cost,
    ctxPeakPct: s.ctxPctMax !== undefined ? Math.min(100, s.ctxPctMax) : window ? Math.min(100, (s.ctxTokensMax / window) * 100) : 0,
    ctxLastPct: window ? Math.min(100, (s.ctxTokensLast / window) * 100) : 0,
    toolCalls: s.toolCalls,
    toolErrors: s.toolErrors,
    maxToolCallsPerTurn: maxTools,
    interrupts: s.interrupts,
    compactions: s.compactions,
    apiErrors: s.apiErrors,
    questions: s.questions,
    filesChanged: fileEntries.length,
    linesAdded: added,
    linesRemoved: removed,
    commits: s.commits,
    pushes: s.pushes,
    activeMs,
    waitMs,
    buckets,
    inputTimes: s.inputTimes.slice(-500),
    lastTurn,
    pendingBackground: s.bgPending.length,
    uncommittedEdits,
    lastEditTs: s.lastEditTs || undefined,
    lastCommitTs: s.lastCommitTs || undefined,
    repo: s.repo,
    component,
    hasPlan: s.hasPlan,
    badLines: s.badLines,
    outcome,
    mtime: 0,
    status: 'ended',
  };
}

export function computeOutcome(
  turns: number,
  last: { ended: boolean; interrupted: boolean; awaitingReply: boolean; pendingTool: boolean },
  uncommittedEdits: boolean,
  bgPending: number,
): Outcome {
  if (turns === 0) return 'empty';
  if (last.interrupted) return 'abandoned';
  if (last.awaitingReply) return 'leftover';
  if (!last.ended) return 'abandoned';
  if (uncommittedEdits || bgPending > 0) return 'leftover';
  return 'done';
}

export function completionOf(sum: SessionSummary, workComplete: boolean | null): CompletionCheck {
  return {
    turnEnded: sum.lastTurn.ended && !sum.lastTurn.interrupted,
    notAwaitingReply: !sum.lastTurn.awaitingReply,
    noBackground: sum.pendingBackground === 0,
    committed: sum.filesChanged === 0 ? null : !sum.uncommittedEdits,
    workComplete,
  };
}

export function buildTurnDetails(s: AccState, sink: DetailSink, responses: Map<number, string>): TurnDetail[] {
  const window = s.ctxWindow || contextWindowFor(s.lastModel, s.ctxTokensMax);
  return s.turns.map((t, i) => ({
    idx: i + 1,
    start: t.start,
    end: t.end,
    prompt: t.prompt,
    response: (responses.get(i + 1) ?? '').slice(0, 600),
    tokens: t.tokens,
    costUSD: t.cost,
    ctxPct: window ? Math.min(100, (t.ctx / window) * 100) : 0,
    toolCalls: t.tools,
    toolErrors: t.errors,
    files: sink.filesOf(i + 1),
    commits: sink.commitList.filter((c) => c.turn === i + 1).map((c) => c.sha),
    interrupted: t.interrupted,
    ended: t.ended,
  }));
}

export function fileStats(s: AccState): FileStat[] {
  return Object.entries(s.files)
    .map(([path, [added, removed, edits]]) => ({ path, added, removed, edits }))
    .sort((a, b) => b.added + b.removed - (a.added + a.removed));
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Counts +/- lines in unified diff text or hunk line arrays. */
export function countDiff(lines: string[] | string): [number, number] {
  const arr = typeof lines === 'string' ? lines.split('\n') : lines;
  let a = 0;
  let r = 0;
  for (const l of arr) {
    if (typeof l !== 'string') continue;
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) a++;
    else if (l.startsWith('-')) r++;
  }
  return [a, r];
}

export function countLines(text: unknown): number {
  if (typeof text !== 'string' || !text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith('\n')) n--;
  return n;
}

export { IDLE_SPLIT_MS, BUCKET_MS };
