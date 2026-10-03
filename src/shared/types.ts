// Types shared by the server and the web UI. Keep this file free of Node imports.

export type Agent = 'claude' | 'codex';

/** Deterministic outcome of a finished session. */
export type Outcome = 'done' | 'leftover' | 'abandoned' | 'empty';

/** Live status, computed when the summary is served. */
export type LiveStatus = 'running' | 'stalled' | 'needs_input' | 'idle' | 'ended';

export interface TokenTotals {
  /** Non-cached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning/thinking tokens; a subset of output, display only. */
  reasoning: number;
}

export interface LastTurnState {
  ended: boolean;
  interrupted: boolean;
  /** Ended with an unanswered question to the user. */
  awaitingReply: boolean;
  /** Last record is a tool call without a result. */
  pendingTool: boolean;
}

export interface SessionSummary {
  /** Unique key: `${agent}:${sessionId}` (subagent files get their own id). */
  id: string;
  agent: Agent;
  sessionId: string;
  file: string;
  parentId?: string;
  isSubagent: boolean;
  forkedFrom?: string;
  cwd: string;
  /** Git root (or cwd when not a repo); filled by the server. */
  projectPath: string;
  project: string;
  branch?: string;
  title: string;
  titleSource: 'custom' | 'ai' | 'prompt' | 'none';
  firstPrompt: string;
  models: string[];
  version?: string;
  entrypoint?: string;
  start: number;
  end: number;
  turns: number;
  userInputs: number;
  tokens: TokenTotals;
  costUSD: number;
  ctxPeakPct: number;
  ctxLastPct: number;
  toolCalls: number;
  toolErrors: number;
  maxToolCallsPerTurn: number;
  interrupts: number;
  compactions: number;
  apiErrors: number;
  questions: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pushes: number;
  /** Sum of turn durations: the time you waited for the agent. */
  activeMs: number;
  /** Gaps between a turn ending and the next input (< 30 min): the time the agent waited for you. */
  waitMs: number;
  /** [10-minute bucket index (epoch ms / 600000), activity count]. */
  buckets: [number, number][];
  /** Timestamps of user inputs (ms). */
  inputTimes: number[];
  lastTurn: LastTurnState;
  pendingBackground: number;
  /** Files were edited after the last commit in this session. */
  uncommittedEdits: boolean;
  /** Most edited top-level directory relative to cwd. */
  component?: string;
  hasPlan: boolean;
  badLines: number;
  outcome: Outcome;
  /** File mtime, ms. */
  mtime: number;
  status: LiveStatus;
  /** Number of subagent sessions attached to this one (filled by the server). */
  children?: number;
  /** Cost including subagents (filled by the server). */
  totalCostUSD?: number;
}

export interface CommitInfo {
  sha: string;
  ts: number;
  message?: string;
  branch?: string;
  turn: number;
}

export interface FileStat {
  path: string;
  added: number;
  removed: number;
  edits: number;
}

export interface QuestionInfo {
  ts: number;
  turn: number;
  questions: { question: string; options: string[]; answer?: string }[];
}

export interface TurnDetail {
  idx: number;
  start: number;
  end: number;
  prompt: string;
  response: string;
  tokens: number;
  costUSD: number;
  ctxPct: number;
  toolCalls: number;
  toolErrors: number;
  files: string[];
  commits: string[];
  interrupted: boolean;
  ended: boolean;
}

export type TimelineKind = 'user' | 'assistant' | 'tool' | 'result' | 'system' | 'question';

export interface TimelineItem {
  ts: number;
  kind: TimelineKind;
  text: string;
  tool?: string;
  isError?: boolean;
  turn: number;
  /** Number of characters dropped by truncation. */
  cut?: number;
}

export interface CompletionCheck {
  turnEnded: boolean;
  notAwaitingReply: boolean;
  noBackground: boolean;
  /** null when nothing was edited. */
  committed: boolean | null;
  /** null until an AI summary judged it. */
  workComplete: boolean | null;
}

export interface AiSummary {
  lang: string;
  model: string;
  createdAt: number;
  title: string;
  bullets: string[];
  decisions: string[];
  requests: { text: string; kind: 'consult' | 'request' | 'follow_up' | 'polish'; done: boolean }[];
  type: string;
  workComplete: boolean;
}

export interface SessionDetail {
  summary: SessionSummary;
  turns: TurnDetail[];
  commits: CommitInfo[];
  files: FileStat[];
  questions: QuestionInfo[];
  timeline: TimelineItem[];
  timelineTotal: number;
  completion: CompletionCheck;
  ai?: AiSummary;
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number;
}

export interface UsageMeter {
  agent: Agent;
  /** e.g. Codex limit id, or "statusline". */
  label: string;
  ts: number;
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  /** Non-percentage state, e.g. Claude quota status. */
  status?: string;
  /** 5h usage history for sparkline: [ts, percent]. */
  history: [number, number][];
  /** 7d usage history: [ts, percent]. */
  history7?: [number, number][];
  /** Reset time and window type reported with a Claude quota status. */
  quotaResetsAt?: number;
  quotaType?: string;
}

export interface IndexProgress {
  phase: 'idle' | 'scanning' | 'parsing' | 'ready';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  startedAt: number;
  finishedAt?: number;
  lastDurationMs?: number;
}

export interface SourceInfo {
  agent: Agent;
  dir: string;
  exists: boolean;
  files: number;
  bytes: number;
}

export interface ServerState {
  version: string;
  demo: boolean;
  progress: IndexProgress;
  sources: SourceInfo[];
  sessions: number;
  aiAvailable: boolean;
  aiModel: string;
  cacheFile: string;
  generation: number;
}

export interface InstructionFile {
  path: string;
  exists: boolean;
  versions: { sha: string; ts: number; subject: string; added: number; removed: number }[];
}

export interface InstructionsInfo {
  projectPath: string;
  isGit: boolean;
  files: InstructionFile[];
}
