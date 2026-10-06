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
  /** Files were edited after the last commit in this session (or by its parent, for subagents). */
  uncommittedEdits: boolean;
  lastEditTs?: number;
  lastCommitTs?: number;
  /** Git remote recorded in the log (Codex). */
  repo?: string;
  /** Claude: uuid of the first record. A rewind or a continuation copies it into a new file. */
  lineage?: string;
  /** Claude: time of the record this file was forked from (set when the copies were skipped). */
  forkTs?: number;
  /** Number of rewinds (forks) merged into this session. */
  rewinds?: number;
  /** User inputs that a rewind took back. */
  rewoundInputs?: number;
  /** Requests the model refused (safety). */
  refusals?: number;
  /** Context of the latest request: [new input, cache read, cache write] tokens. */
  ctxParts?: [number, number, number];
  /** Estimated output speed per model: [output tokens, ms]. Time runs from the previous record. */
  speed?: Record<string, [number, number]>;
  /** Commits made in the session (full or short sha), newest last. */
  commitShas?: string[];
  /** When `git commit` commands ran ([start, end] ms), to find commits that printed no id. */
  commitRuns?: [number, number][];
  /** Your bookmark, label and note (filled by the server). */
  mark?: SessionMark;
  /** Smart category from the AI classification (filled by the server). */
  category?: string;
  /** Short form of the saved AI summary (filled by the server). */
  ai?: { title: string; type: string; next: string[]; complete: boolean; ts: number };
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

export type MarkLabel = 'discuss' | 'doing' | 'later' | 'done';

export interface SessionMark {
  star?: boolean;
  label?: MarkLabel;
  note?: string;
  ts: number;
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
  /** Taken back by a rewind. */
  rewound?: boolean;
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
  /** Taken back by a rewind. */
  rewound?: boolean;
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

export type WorkType = 'implementation' | 'bugfix' | 'refactor' | 'research' | 'review' | 'docs' | 'ops' | 'other';

/** AI summary. Every summary has the same fields; `format` is the layout version. */
export interface AiSummary {
  id?: string;
  format?: number;
  lang: string;
  model: string;
  createdAt: number;
  /** The session as it was when summarized, to tell whether it changed since. */
  basis?: { end: number; turns: number };
  title: string;
  bullets: string[];
  decisions: string[];
  unverified?: string[];
  concerns?: string[];
  openQuestions?: string[];
  nextSteps?: string[];
  requests: { text: string; kind: 'consult' | 'request' | 'follow_up' | 'polish'; done: boolean }[];
  type: WorkType | string;
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

export interface AiSettingsView {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  baseURL: string;
  model: string;
  auth: 'x-api-key' | 'bearer';
  apiKeyEnv: string;
  headers: Record<string, string>;
  hasKey: boolean;
  auto: boolean;
  lang: 'zh-CN' | 'en';
  /** Where the endpoint in use comes from, if any. */
  source?: 'settings' | 'env';
  /** Last background run. */
  autoStatus?: { running: boolean; lastRun?: number; done: number; pending: number; failed: number; lastError?: string; classifying?: boolean };
  /** Smart categories, in a stable order (their colors follow it). */
  categories?: { name: string; description: string }[];
  categorizedAt?: number;
  /** What each project is doing, from the classification. */
  projectNotes?: Record<string, string>;
}

export interface ServerState {
  version: string;
  demo: boolean;
  progress: IndexProgress;
  sources: SourceInfo[];
  sessions: number;
  aiAvailable: boolean;
  aiModel: string;
  /** Saved AI settings without the key itself. */
  ai: AiSettingsView;
  cacheFile: string;
  generation: number;
  groupBy: 'smart' | 'repo' | 'git' | 'folder';
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
