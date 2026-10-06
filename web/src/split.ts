import type { SessionDetail, SessionSummary } from '../../src/shared/types';
import type { Key } from './i18n';

/** Signs that one conversation holds more than one deliverable (the rule: one per conversation). */
export function splitReasons(s: SessionSummary, d?: SessionDetail): [Key, number][] {
  if (s.isSubagent) return [];
  const out: [Key, number][] = [];
  if (s.compactions >= 2) out.push(['split.compacted', s.compactions]);
  else if (s.ctxLastPct >= 80) out.push(['split.ctx', Math.round(s.ctxLastPct)]);
  const t = [...s.inputTimes].sort((a, b) => a - b);
  const overnight = t.filter((x, i) => i > 0 && x - t[i - 1] > 8 * 3600_000).length;
  if (overnight) out.push(['split.resumed', overnight]);
  const tasks = (d?.ai?.requests ?? []).filter((r) => r.kind === 'request').length;
  if (tasks >= 2) out.push(['split.requests', tasks]);
  return out;
}

/** Live conversations the rule says to split now (finished ones are history, not a to-do). */
export const shouldSplitNow = (s: SessionSummary) => s.status !== 'ended' && splitReasons(s).length > 0;

const told = new Set<string>();
let primed = false;

/** A system notification when a live conversation starts needing a split; click opens it. */
export function notifySplits(list: SessionSummary[], title: (s: SessionSummary) => string, body: string): void {
  const now = list.filter(shouldSplitNow);
  // The first list after loading only sets the baseline, so opening Loggy doesn't fire a burst.
  if (!primed) {
    if (list.length) primed = true;
    for (const s of now) told.add(s.id);
    return;
  }
  for (const s of now) {
    if (told.has(s.id)) continue;
    told.add(s.id);
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
    const n = new Notification(title(s), { body, tag: s.id });
    n.onclick = () => {
      window.focus();
      location.hash = `#/sessions/${encodeURIComponent(s.id)}`;
    };
  }
}
