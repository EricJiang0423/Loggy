// Entry points used by the worker threads: summarize a file (optionally resuming from a
// cached state) and build the full detail of one session.

import type { Agent, SessionDetail, SessionSummary } from '../shared/types.js';
import {
  type AccState,
  DetailSink,
  PARSER_VERSION,
  buildTurnDetails,
  completionOf,
  fileStats,
  finalize,
} from './acc.js';
import { claudeRecord, initClaudeState } from './claude.js';
import { codexFinalizeExtras, codexLine, codexRecord, initCodexState } from './codex.js';
import { initKimiState, kimiLine } from './kimi.js';
import { indexIn, scanLines, sniffTypes } from './lines.js';

export interface SummaryResult {
  summary: SessionSummary;
  state: AccState;
  offset: number;
  size: number;
  /** Paths edited in the session (for related sessions). */
  files: string[];
}

const ATTACHMENT = Buffer.from('"attachment":{');
const QUEUED_COMMAND = Buffer.from('"attachment":{"type":"queued_command"');
const FILE_HISTORY = Buffer.from('"type":"file-history');

function skipClaude(buf: Buffer, start: number, end: number): boolean {
  // Queued commands are small and can carry background-task notifications.
  if (indexIn(buf, QUEUED_COMMAND, start, Math.min(end, start + 200)) !== -1) return false;
  return indexIn(buf, ATTACHMENT, start, Math.min(end, start + 120)) !== -1 || indexIn(buf, FILE_HISTORY, start, Math.min(end, start + 60)) !== -1;
}

const UUID_RE = /"uuid":"([^"]+)"/g;

/** Every record uuid in a Claude transcript, with its timestamp. */
export function claudeUuids(file: string, into = new Map<string, number>()): Map<string, number> {
  scanLines(file, 0, (buf, start, end) => {
    const line = buf.toString('utf8', start, end);
    const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
    UUID_RE.lastIndex = 0;
    for (let m = UUID_RE.exec(line); m; m = UUID_RE.exec(line)) if (!into.has(m[1])) into.set(m[1], ts ? Date.parse(ts) : 0);
  });
  return into;
}

/**
 * Claude Code's rewind (and "continue in a new session") starts a new file with a copy of the
 * records up to that point. Those copies keep their uuid, so records already seen in an earlier
 * file of the same conversation are skipped; the first new record marks the fork.
 */
class ForkFilter {
  private lastSkippedTs = 0;
  private forked = false;
  constructor(private readonly seen: Map<string, number>) {}

  /** True when the record is a copy. Sets lineage and fork time on the state. */
  skip(state: AccState, d: Record<string, any>, onFork?: (forkTs: number, at: number) => void): boolean {
    if (typeof d.uuid !== 'string' || d.isSidechain) return false;
    const copy = !this.forked && this.seen.has(d.uuid);
    if (copy) {
      if (!state.lineage) state.lineage = d.uuid;
      this.lastSkippedTs = this.seen.get(d.uuid) ?? this.lastSkippedTs;
      return true;
    }
    if (!this.forked) {
      this.forked = true;
      if (this.lastSkippedTs) {
        const forkTs = (typeof d.parentUuid === 'string' && this.seen.get(d.parentUuid)) || this.lastSkippedTs;
        state.forkTs = forkTs;
        onFork?.(forkTs, Date.parse(d.timestamp) || forkTs);
      }
    }
    return false;
  }
}

function initState(agent: Agent, file: string): AccState {
  return agent === 'claude' ? initClaudeState(file) : agent === 'kimi' ? initKimiState(file) : initCodexState(file);
}

export function summarizeFile(file: string, agent: Agent, resume?: { state: AccState; offset: number }, opts: { skipFrom?: string[] } = {}): SummaryResult {
  const canResume = resume && resume.state.v === PARSER_VERSION && !file.endsWith('.zst');
  const state: AccState = canResume ? resume!.state : initState(agent, file);
  const from = canResume ? resume!.offset : 0;
  let scan;
  if (agent === 'claude') {
    // Copies are a prefix of the file, so a resumed parse is already past them.
    let fork: ForkFilter | undefined;
    if (!canResume && opts.skipFrom?.length) {
      const seen = new Map<string, number>();
      for (const f of opts.skipFrom) claudeUuids(f, seen);
      fork = new ForkFilter(seen);
    }
    scan = scanLines(file, from, (buf, start, end) => {
      if (skipClaude(buf, start, end)) return;
      let d;
      try {
        d = JSON.parse(buf.toString('utf8', start, end));
      } catch {
        state.badLines++;
        return;
      }
      if (fork?.skip(state, d)) return;
      claudeRecord(state, d);
    });
  } else if (agent === 'kimi') {
    scan = scanLines(file, from, (buf, start, end) => kimiLine(state, buf, start, end));
  } else {
    scan = scanLines(file, from, (buf, start, end) => codexLine(state, buf, start, end));
    codexFinalizeExtras(state);
  }
  const summary = finalize(state);
  return {
    summary,
    state,
    offset: scan.endOffset,
    size: scan.size,
    files: Object.keys(state.files).slice(0, 500),
  };
}

/**
 * Detail of one session. A session can span files, oldest first: a Codex thread continued in a
 * new rollout, or a Claude conversation forked by a rewind (the copies are skipped and the turns
 * the rewind took back are marked).
 */
export function detailFile(files: string | string[], agent: Agent): Omit<SessionDetail, 'ai'> {
  const pages = typeof files === 'string' ? [files] : files;
  const state = initState(agent, pages[0]);
  const sink = new DetailSink();
  const responses = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const [i, file] of pages.entries()) {
    const fork = agent === 'claude' && i > 0 ? new ForkFilter(new Map(seen)) : undefined;
    const onFork = (forkTs: number, at: number) => {
      for (const it of sink.timeline) if (it.ts > forkTs) it.rewound = true;
      for (const t of state.turns) if (t.start > forkTs) t.rewound = true;
      sink.item(at, 'system', 'rewind', state.turns.length);
    };
    if (agent === 'kimi') {
      scanLines(file, 0, (buf, start, end) => kimiLine(state, buf, start, end, sink, responses));
      continue;
    }
    scanLines(file, 0, (buf, start, end) => {
      if (agent === 'claude' && skipClaude(buf, start, end)) return;
      if (agent === 'codex') {
        const [top, sub] = sniffTypes(buf, start, end, 2);
        if (top === 'world_state' || (top === 'response_item' && (sub === 'reasoning' || sub === 'function_call_output' || sub === 'custom_tool_call_output'))) return;
      }
      let d;
      try {
        d = JSON.parse(buf.toString('utf8', start, end));
      } catch {
        state.badLines++;
        return;
      }
      if (agent === 'claude') {
        if (typeof d.uuid === 'string' && !seen.has(d.uuid)) seen.set(d.uuid, Date.parse(d.timestamp) || 0);
        if (fork?.skip(state, d, onFork)) return;
        claudeRecord(state, d, sink, responses);
      } else codexRecord(state, d, sink, responses);
    });
  }
  if (agent === 'codex') codexFinalizeExtras(state);
  const summary = finalize(state);
  return {
    summary,
    turns: buildTurnDetails(state, sink, responses),
    commits: sink.commitList,
    files: fileStats(state),
    questions: sink.questionList,
    timeline: sink.timeline,
    timelineTotal: sink.timelineTotal,
    completion: completionOf(summary, null),
  };
}
