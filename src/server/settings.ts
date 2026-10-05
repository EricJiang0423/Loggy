// Loggy's own settings in the data dir (settings.json). The file can hold an API key, so it
// is readable by the owner only.

import fs from 'node:fs';
import path from 'node:path';
import type { AiSettings } from './ai.js';
import { GROUP_BY, type GroupBy } from './projects.js';

export interface Settings {
  groupBy?: GroupBy;
  ai?: AiSettings;
}

export function readSettings(dataDir: string): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    return { groupBy: GROUP_BY.includes(s.groupBy) ? s.groupBy : undefined, ai: s.ai && typeof s.ai === 'object' ? s.ai : undefined };
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
