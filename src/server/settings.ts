// Loggy's own settings in the data dir (settings.json). The file can hold an API key, so it
// is readable by the owner only.

import fs from 'node:fs';
import path from 'node:path';
import type { Agent, SessionMark } from '../shared/types.js';
import type { AiSettings } from './ai.js';
import { GROUP_BY, type GroupBy } from './projects.js';

export interface Settings {
  groupBy?: GroupBy;
  ai?: AiSettings;
  /** Harnesses turned off in Settings are not indexed. */
  harnesses?: Partial<Record<Agent, boolean>>;
}

export function readSettings(dataDir: string): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    return {
      groupBy: GROUP_BY.includes(s.groupBy) ? s.groupBy : undefined,
      ai: s.ai && typeof s.ai === 'object' ? s.ai : undefined,
      harnesses: s.harnesses && typeof s.harnesses === 'object' ? s.harnesses : undefined,
    };
  } catch {
    return {};
  }
}

/** Merges `patch` into the stored settings. */
export function writeSettings(dataDir: string, patch: Settings): Settings {
  const next = { ...readSettings(dataDir), ...patch };
  const file = path.join(dataDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return next;
}

/** Bookmarks, labels and notes per session id (marks.json). */
export function readMarks(dataDir: string): Map<string, SessionMark> {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(dataDir, 'marks.json'), 'utf8'))));
  } catch {
    return new Map();
  }
}

export function writeMarks(dataDir: string, marks: Map<string, SessionMark>): void {
  fs.writeFileSync(path.join(dataDir, 'marks.json'), JSON.stringify(Object.fromEntries(marks), null, 2));
}
