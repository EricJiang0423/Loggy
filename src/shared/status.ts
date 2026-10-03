import type { LiveStatus, SessionSummary } from './types.js';

const RUNNING_MS = 2 * 60_000;
const STALLED_MS = 30 * 60_000;
const NEEDS_INPUT_MS = 12 * 3600_000;
const IDLE_MS = 10 * 60_000;

/** Live status from the last-turn state and how long ago the log file changed. */
export function liveStatus(s: Pick<SessionSummary, 'lastTurn' | 'mtime' | 'end' | 'turns'>, now: number): LiveStatus {
  const last = Math.max(s.mtime || 0, s.end || 0);
  const age = now - last;
  if (s.turns === 0) return 'ended';
  if (!s.lastTurn.ended && !s.lastTurn.interrupted) {
    if (s.lastTurn.awaitingReply && age < NEEDS_INPUT_MS) return 'needs_input';
    if (age < RUNNING_MS) return 'running';
    if (age < STALLED_MS) return 'stalled';
    return 'ended';
  }
  if (s.lastTurn.awaitingReply && age < NEEDS_INPUT_MS) return 'needs_input';
  if (age < IDLE_MS) return 'idle';
  return 'ended';
}
