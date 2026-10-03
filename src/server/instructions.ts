// History of agent instruction files (CLAUDE.md, AGENTS.md, ...) from git.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstructionFile, InstructionsInfo } from '../shared/types.js';

const CANDIDATES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.override.md', '.github/copilot-instructions.md'];
const MAX_VERSIONS = 300;
const MAX_TEXT = 400_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function globalInstructionFiles(): string[] {
  const home = os.homedir();
  return [path.join(home, '.claude', 'CLAUDE.md'), path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'AGENTS.md')];
}

export async function instructionsFor(projectPath: string): Promise<InstructionsInfo> {
  const isGit = fs.existsSync(path.join(projectPath, '.git'));
  const files: InstructionFile[] = [];
  for (const rel of CANDIDATES) {
    const abs = path.join(projectPath, rel);
    const exists = fs.existsSync(abs);
    let versions: InstructionFile['versions'] = [];
    if (isGit) {
      try {
        versions = await history(projectPath, rel);
      } catch {
        versions = [];
      }
    }
    if (exists || versions.length) files.push({ path: rel, exists, versions });
  }
  return { projectPath, isGit, files };
}

async function history(repo: string, rel: string): Promise<InstructionFile['versions']> {
  const out = await git(repo, ['log', '--follow', `-n${MAX_VERSIONS}`, '--format=%x1e%H%x09%at%x09%s', '--numstat', '--', rel]);
  const versions: InstructionFile['versions'] = [];
  for (const block of out.split('\x1e')) {
    const lines = block.trim().split('\n');
    if (!lines[0]) continue;
    const [sha, at, ...subject] = lines[0].split('\t');
    let added = 0;
    let removed = 0;
    for (const l of lines.slice(1)) {
      const [a, r] = l.split('\t');
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    versions.push({ sha, ts: Number(at) * 1000, subject: subject.join('\t'), added, removed });
  }
  return versions;
}

/** Content at a version (or the working copy) and the diff that version introduced. */
export async function instructionVersion(projectPath: string, rel: string, sha?: string): Promise<{ content: string; diff: string }> {
  if (!CANDIDATES.includes(rel)) throw new Error('unknown file');
  if (!sha) {
    const abs = path.join(projectPath, rel);
    const content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').slice(0, MAX_TEXT) : '';
    let diff = '';
    try {
      diff = await git(projectPath, ['diff', 'HEAD', '--', rel]);
    } catch {
      // not a repo
    }
    return { content, diff: diff.slice(0, MAX_TEXT) };
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad sha');
  const [content, diff] = await Promise.all([
    git(projectPath, ['show', `${sha}:${rel}`]).catch(() => ''),
    git(projectPath, ['show', '--format=', sha, '--', rel]).catch(() => ''),
  ]);
  return { content: content.slice(0, MAX_TEXT), diff: diff.slice(0, MAX_TEXT) };
}

export function readGlobal(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, MAX_TEXT);
  } catch {
    return '';
  }
}
