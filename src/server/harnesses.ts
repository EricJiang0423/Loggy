// Which harnesses are on this machine: their logs, their command-line tool, their desktop app.
// The UI shows only what is here, so someone without Kimi Code or Pi never sees them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, type Agent, type HarnessInfo } from '../shared/types.js';

const COMMANDS: Record<Agent, string> = { claude: 'claude', codex: 'codex', kimi: 'kimi', pi: 'pi' };
const APPS: Partial<Record<Agent, string[]>> = {
  claude: ['Claude.app'],
  codex: ['Codex.app'],
  kimi: ['Kimi Code.app', 'kimi-code.app'],
};

/** Install folders tools commonly use that a server started from a login item may not have on PATH. */
function commandDirs(): string[] {
  const home = os.homedir();
  return [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'node', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.kimi-code', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean);
}

function findCommand(name: string, dirs: string[]): string | undefined {
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

function findApp(names: string[] | undefined): string | undefined {
  if (process.platform !== 'darwin' || !names) return undefined;
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    for (const n of names) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  }
  return undefined;
}

let cache: { at: number; key: string; value: HarnessInfo[] } | undefined;

/** Detection per harness; `logDirs` are the folders Loggy reads for it. Cached for a minute. */
export function detectHarnesses(logDirs: Record<Agent, string[]>): HarnessInfo[] {
  const key = JSON.stringify(logDirs);
  if (cache && cache.key === key && Date.now() - cache.at < 60_000) return cache.value;
  const dirs = commandDirs();
  const value = AGENTS.map((agent) => {
    const logs = logDirs[agent].some((d) => fs.existsSync(d));
    const command = findCommand(COMMANDS[agent], dirs);
    const app = findApp(APPS[agent]);
    return { agent, installed: logs || !!command || !!app, logs, command: !!command, app: !!app };
  });
  cache = { at: Date.now(), key, value };
  return value;
}
