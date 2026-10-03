import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  open: boolean;
  demo: boolean;
  rebuild: boolean;
  /** Claude config directories (each containing projects/). */
  claudeDirs: string[];
  /** Codex homes (each containing sessions/ and archived_sessions/). */
  codexDirs: string[];
  dataDir: string;
  aiModel: string;
  version: string;
}

export const DEFAULT_PORT = 4317;

export function defaultClaudeDirs(): string[] {
  const dirs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  dirs.add(path.join(os.homedir(), '.claude'));
  return [...dirs];
}

export function defaultCodexDirs(): string[] {
  return [process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')];
}

export function defaultDataDir(): string {
  return process.env.LOGGY_HOME ? path.resolve(process.env.LOGGY_HOME) : path.join(os.homedir(), '.loggy');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEFAULT_AI_MODEL = 'claude-haiku-4-5';
