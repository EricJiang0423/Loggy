// What the Codex app knows about its threads, read-only: the current thread names
// (session_index.jsonl keeps every rename; the latest wins) and the projects the user put
// threads in (.codex-global-state.json), as that project's folders.

import fs from 'node:fs';
import path from 'node:path';

export interface CodexThreads {
  names: Map<string, string>;
  /** thread id -> folders of the Codex app project the user put it in */
  projects: Map<string, string[]>;
}

const cache = new Map<string, { key: string; value: CodexThreads }>();

function stamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

export function readCodexThreads(codexHome: string): CodexThreads {
  const index = path.join(codexHome, 'session_index.jsonl');
  const state = path.join(codexHome, '.codex-global-state.json');
  const key = `${stamp(index)}|${stamp(state)}`;
  const hit = cache.get(codexHome);
  if (hit && hit.key === key) return hit.value;

  const names = new Map<string, string>();
  const latest = new Map<string, number>();
  try {
    for (const line of fs.readFileSync(index, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const at = Date.parse(d.updated_at) || 0;
        if (typeof d.id === 'string' && typeof d.thread_name === 'string' && d.thread_name.trim() && at >= (latest.get(d.id) ?? -1)) {
          names.set(d.id, d.thread_name.trim());
          latest.set(d.id, at);
        }
      } catch {
        // skip a broken line
      }
    }
  } catch {
    // no index
  }

  const projects = new Map<string, string[]>();
  try {
    const g = JSON.parse(fs.readFileSync(state, 'utf8'));
    const local = g['local-projects'] ?? {};
    for (const [thread, a] of Object.entries<{ projectId?: string }>(g['thread-project-assignments'] ?? {})) {
      const roots = a?.projectId ? local[a.projectId]?.rootPaths : undefined;
      if (Array.isArray(roots) && typeof roots[0] === 'string') projects.set(thread, roots);
    }
  } catch {
    // no app state
  }

  const value = { names, projects };
  cache.set(codexHome, { key, value });
  return value;
}
