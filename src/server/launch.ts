// Hand a session off to a new conversation: write the handoff to a file, then start `claude` or
// `codex` in the session's folder with a first message that names the old session (so the chain
// links) and points at the file. Only runs when you click; nothing here runs on its own.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, SessionSummary } from '../shared/types.js';

export type Target = 'cmux' | 'terminal' | 'app' | 'copy';
export const TARGETS: Target[] = ['cmux', 'terminal', 'app', 'copy'];

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const asq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15_000 }, (err, _out, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve())),
  );
}

export interface Handoff {
  file: string;
  cwd: string;
  /** Shell command that starts the new conversation, run from `cwd`. */
  command: string;
  /** What happened: launched, or what you still have to do. */
  note?: 'cmuxBlocked';
}

export async function handOff(dataDir: string, from: SessionSummary, to: Agent, target: Target, text: string, lang: string): Promise<Handoff> {
  const dir = path.join(dataDir, 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${from.agent}-${from.sessionId}.md`);
  fs.writeFileSync(file, text);
  const cwd = [from.cwd, from.projectPath].find((p) => p && path.isAbsolute(p) && fs.existsSync(p)) ?? os.homedir();
  const prompt =
    lang === 'zh-CN'
      ? `接力 Loggy 会话 ${from.agent}:${from.sessionId}。先读 ${file}，核对当前状态，再接着做。`
      : `Handoff from Loggy session ${from.agent}:${from.sessionId}. Read ${file}, check the current state, then continue.`;
  const command = `${to} ${shq(prompt)}`;
  const out: Handoff = { file, cwd, command };
  if (target === 'copy') return out;
  if (process.platform !== 'darwin') throw new Error('Opening a terminal or app is only supported on macOS; use "copy command".');
  if (target === 'terminal') {
    await run('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script ${asq(`cd ${shq(cwd)} && ${command}`)}\nend tell`]);
  } else if (target === 'app') {
    // ponytail: the desktop apps have no documented "new chat with this message" link; the page
    // copies the handoff and you paste it. Use a deep link here once one exists.
    await run('open', to === 'claude' ? ['-a', 'Claude'] : ['-b', 'com.openai.codex']);
  } else {
    const bin = fs.existsSync(CMUX) ? CMUX : 'cmux';
    try {
      await run(bin, ['new-workspace', '--name', from.title.slice(0, 40) || to, '--cwd', cwd, '--command', command]);
    } catch {
      // cmux only takes commands from processes inside it unless Settings → Automation allows more.
      await run(bin, [cwd]);
      out.note = 'cmuxBlocked';
    }
  }
  return out;
}
