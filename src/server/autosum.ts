// Background AI summaries: every recent session gets one, and a session that changed later is
// summarized again at most once a day. Runs only when the user turned it on in Settings.

import type { AiSummary, SessionDetail, SessionSummary } from '../shared/types.js';
import { SUMMARY_FORMAT, aiErrorMessage, readAllAiSummaries, summarizeWithAi, type AiConfig, type AiSettings } from './ai.js';

export { SUMMARY_FORMAT };

const DAY = 86400_000;
export const AUTO_DAYS = 7;

export interface AutoStatus {
  running: boolean;
  lastRun?: number;
  done: number;
  pending: number;
  failed: number;
  lastError?: string;
}

/** Whether a session should be (re)summarized now. */
export function needsSummary(s: Pick<SessionSummary, 'end' | 'turns' | 'status'>, saved: AiSummary | undefined, now: number, lang: string, days: number): boolean {
  if (s.turns === 0 || now - s.end > days * DAY) return false;
  if (s.status === 'running' || s.status === 'needs_input' || s.status === 'stalled') return false; // wait until it stops
  if (!saved || saved.format !== SUMMARY_FORMAT || saved.lang !== lang) return true;
  const changed = !saved.basis || saved.basis.end !== s.end || saved.basis.turns !== s.turns;
  return changed && now - saved.createdAt >= DAY;
}

export class AutoSummarizer {
  status: AutoStatus = { running: false, done: 0, pending: 0, failed: 0 };
  readonly saved: Map<string, AiSummary>;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly o: {
      dataDir: string;
      summaries: () => SessionSummary[];
      detailOf: (id: string) => Promise<Omit<SessionDetail, 'ai'> | undefined>;
      config: () => { ai?: AiConfig; settings?: AiSettings };
      onSaved: (s: AiSummary) => void;
    },
  ) {
    this.saved = readAllAiSummaries(o.dataDir);
  }

  /** Checks every hour (first a minute after start, once indexing is done). */
  start(): void {
    const first = setTimeout(() => void this.run(), 60_000);
    const hourly = setInterval(() => void this.run(), 3600_000);
    this.timers.push(first, hourly);
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  remember(s: AiSummary): void {
    if (s.id) this.saved.set(s.id, s);
    this.o.onSaved(s);
  }

  async run(): Promise<AutoStatus> {
    if (this.status.running) return this.status;
    const { ai, settings } = this.o.config();
    if (!ai || !settings?.auto) return this.status;
    const lang = settings.lang ?? 'en';
    const now = Date.now();
    const todo = this.o
      .summaries()
      .filter((s) => !s.isSubagent && needsSummary(s, this.saved.get(s.id), now, lang, AUTO_DAYS))
      .sort((a, b) => b.end - a.end);
    this.status = { running: true, lastRun: now, done: 0, pending: todo.length, failed: 0 };
    try {
      // ponytail: one at a time; add a small pool if endpoints are fast and the backlog is long.
      for (const s of todo) {
        try {
          const d = await this.o.detailOf(s.id);
          if (d) {
            this.remember(await summarizeWithAi(this.o.dataDir, ai, d, lang));
            this.status.done++;
          }
        } catch (err) {
          this.status.failed++;
          this.status.lastError = aiErrorMessage(err);
          if (this.status.failed >= 3 && this.status.done === 0) break; // endpoint is down or misconfigured
        } finally {
          this.status.pending--;
        }
      }
    } finally {
      this.status.running = false;
    }
    return { ...this.status };
  }
}
