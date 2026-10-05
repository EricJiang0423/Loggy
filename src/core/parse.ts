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
import { claudeQuota, claudeRecord, initClaudeState } from './claude.js';
import { codexFinalizeExtras, codexLine, codexRateHistory, codexRateLimits, codexRecord, initCodexState } from './codex.js';
import { indexIn, scanLines, sniffTypes } from './lines.js';

export interface SummaryResult {
  summary: SessionSummary;
  state: AccState;
  offset: number;
  size: number;
  quota?: Record<string, unknown>;
  rate?: Record<string, Record<string, unknown>>;
  rateHist?: [number, number | null, number | null][];
}

const ATTACHMENT = Buffer.from('"attachment":{');
const QUEUED_COMMAND = Buffer.from('"attachment":{"type":"queued_command"');
const FILE_HISTORY = Buffer.from('"type":"file-history');

function skipClaude(buf: Buffer, start: number, end: number): boolean {
  // Queued commands are small and can carry background-task notifications.
  if (indexIn(buf, QUEUED_COMMAND, start, Math.min(end, start + 200)) !== -1) return false;
  return indexIn(buf, ATTACHMENT, start, Math.min(end, start + 120)) !== -1 || indexIn(buf, FILE_HISTORY, start, Math.min(end, start + 60)) !== -1;
}

export function summarizeFile(file: string, agent: Agent, resume?: { state: AccState; offset: number }): SummaryResult {
  const canResume = resume && resume.state.v === PARSER_VERSION && !file.endsWith('.zst');
  const state: AccState = canResume ? resume!.state : agent === 'claude' ? initClaudeState(file) : initCodexState(file);
  const from = canResume ? resume!.offset : 0;
  let scan;
  if (agent === 'claude') {
    scan = scanLines(file, from, (buf, start, end) => {
      if (skipClaude(buf, start, end)) return;
      let d;
      try {
        d = JSON.parse(buf.toString('utf8', start, end));
      } catch {
        state.badLines++;
        return;
      }
      claudeRecord(state, d);
    });
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
    quota: agent === 'claude' ? claudeQuota(state) : undefined,
    rate: agent === 'codex' ? codexRateLimits(state) : undefined,
    rateHist: agent === 'codex' ? codexRateHistory(state) : undefined,
  };
}

/** Detail of one session; a Codex thread continued across rollout files passes all its pages, oldest first. */
export function detailFile(files: string | string[], agent: Agent): Omit<SessionDetail, 'ai'> {
  const pages = typeof files === 'string' ? [files] : files;
  const state = agent === 'claude' ? initClaudeState(pages[0]) : initCodexState(pages[0]);
  const sink = new DetailSink();
  const responses = new Map<number, string>();
  for (const file of pages) scanLines(file, 0, (buf, start, end) => {
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
    if (agent === 'claude') claudeRecord(state, d, sink, responses);
    else codexRecord(state, d, sink, responses);
  });
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
