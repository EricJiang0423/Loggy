// Sessions that ran somewhere else: SSH hosts (logs pulled with rsync into the data dir) and
// Codex Cloud tasks (written as small rollout files). Both end up as extra log folders that the
// indexer reads like the local ones.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RemoteView, SyncState } from '../shared/types.js';

export interface RemoteHost {
  /** ssh destination: user@host or an alias from ~/.ssh/config. */
  target: string;
  port?: number;
  identity?: string;
  label?: string;
  /** Where it was found. */
  from: 'claude' | 'codex' | 'manual';
}


/** Folder name of a host under <dataDir>/remote. */
export function hostKey(h: Pick<RemoteHost, 'target' | 'port'>): string {
  return `${h.target}${h.port && h.port !== 22 ? `_${h.port}` : ''}`.replace(/[^\w.@-]/g, '_');
}

/** SSH hosts set up in the Claude and Codex desktop apps. */
export function detectHosts(home = os.homedir()): RemoteHost[] {
  const out: RemoteHost[] = [];
  try {
    const f = path.join(home, 'Library', 'Application Support', 'Claude', 'ssh_configs.json');
    for (const c of JSON.parse(fs.readFileSync(f, 'utf8')).configs ?? []) {
      if (typeof c.sshHost === 'string' && c.sshHost) out.push({ target: c.sshHost, identity: c.sshIdentityFile || undefined, label: c.name || undefined, from: 'claude' });
    }
  } catch {
    // no Claude desktop SSH hosts
  }
  try {
    const f = path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), '.codex-global-state.json');
    for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))['codex-managed-remote-connections'] ?? []) {
      const target = c.alias || c.hostname;
      if (typeof target === 'string' && target) out.push({ target, port: c.sshPort || undefined, identity: c.identity || undefined, label: c.displayName || undefined, from: 'codex' });
    }
  } catch {
    // no Codex SSH hosts
  }
  return out;
}

/** Detected and manual hosts, one per destination (the first one found wins). */
export function allHosts(manual: RemoteHost[] = [], home?: string): RemoteHost[] {
  const seen = new Map<string, RemoteHost>();
  for (const h of [...manual, ...detectHosts(home)]) if (!seen.has(hostKey(h))) seen.set(hostKey(h), h);
  return [...seen.values()];
}

// Remote path (relative to the remote home) -> local path under the host folder.
const PULL: [string, string][] = [
  ['.claude/projects/', 'claude/projects/'],
  ['.codex/sessions/', 'codex/sessions/'],
  ['.codex/archived_sessions/', 'codex/archived_sessions/'],
  ['.codex/session_index.jsonl', 'codex/session_index.jsonl'],
];

/** Pulls the host's Claude and Codex logs into `dir`. Rejects with the first real error. */
export async function syncHost(h: RemoteHost, dir: string): Promise<void> {
  const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (h.port) ssh.push('-p', String(h.port));
  if (h.identity) ssh.push('-i', h.identity.replace(/^~(?=\/)/, os.homedir()));
  const e = ssh.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  for (const [from, to] of PULL) {
    const dest = path.join(dir, to);
    fs.mkdirSync(to.endsWith('/') ? dest : path.dirname(dest), { recursive: true });
    const filters = from.endsWith('/') ? ['--include=*/', '--include=*.jsonl', '--include=*.jsonl.zst', '--exclude=*', '--prune-empty-dirs'] : [];
    try {
      await run('rsync', ['-a', '--timeout=60', '-e', e, ...filters, `${h.target}:${from}`, dest], 30 * 60_000);
    } catch (err) {
      // 23: the path does not exist there (that harness isn't used on the host).
      if ((err as { code?: number }).code !== 23) throw err;
    }
  }
}

interface CloudTask {
  id: string;
  url?: string;
  title?: string;
  status?: string;
  updated_at?: string;
  environment_label?: string;
  summary?: { files_changed?: number; lines_added?: number; lines_removed?: number };
}

/** Writes every Codex Cloud task as a rollout under `dir`/sessions. Returns the number of tasks. */
export async function syncCodexCloud(dir: string, pages = 5): Promise<number> {
  fs.mkdirSync(dir, { recursive: true });
  const tasks: CloudTask[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < pages; i++) {
    const out = await run('codex', ['cloud', 'list', '--json', '--limit', '20', ...(cursor ? ['--cursor', cursor] : [])], 60_000, dir); // it writes error.log where it runs
    const page = JSON.parse(out) as { tasks?: CloudTask[]; cursor?: string | null };
    tasks.push(...(page.tasks ?? []));
    cursor = page.cursor ?? null;
    if (!cursor) break;
  }
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (const t of tasks) writeCloudRollout(sessions, t);
  return tasks.length;
}

/** One cloud task as a rollout file (rewritten only when the task changed). */
export function writeCloudRollout(sessions: string, t: CloudTask): void {
  if (!t.id) return;
  const ts = t.updated_at && Date.parse(t.updated_at) ? new Date(t.updated_at).toISOString() : new Date().toISOString();
  const env = t.environment_label ?? '';
  const repo = /^[\w.-]+\/[\w.-]+$/.test(env) ? `https://github.com/${env}` : undefined;
  const s = t.summary ?? {};
  const info = [`Codex Cloud · ${t.status ?? 'unknown'}`, s.files_changed ? `${s.files_changed} files +${s.lines_added ?? 0} −${s.lines_removed ?? 0}` : '', t.url ?? ''].filter(Boolean).join('\n');
  const line = (type: string, payload: object) => JSON.stringify({ timestamp: ts, type, payload });
  const ev = (payload: object) => line('event_msg', payload);
  const lines = [
    line('session_meta', { id: t.id, timestamp: ts, cwd: `/codex-cloud/${env || 'default'}`, originator: 'Codex Cloud', source: 'cloud', ...(repo ? { git: { repository_url: repo } } : {}) }),
    ev({ type: 'task_started' }),
    ev({ type: 'user_message', message: t.title ?? t.id }),
    ev({ type: 'agent_message', message: info }),
    // A task still running in the cloud has no end yet.
    ...(t.status === 'pending' ? [] : [ev({ type: 'task_complete', last_agent_message: info })]),
  ];
  const text = lines.join('\n') + '\n';
  const file = path.join(sessions, `rollout-cloud-${t.id.replace(/[^\w-]/g, '_')}.jsonl`);
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch {
    // new task
  }
  fs.writeFileSync(file, text);
  const at = Date.parse(ts) / 1000;
  fs.utimesSync(file, at, at);
}

export interface RemoteSettings {
  /** Hosts added by hand. */
  hosts?: RemoteHost[];
  /** Host key -> on/off. Detected hosts start off, hosts added by hand start on. */
  on?: Record<string, boolean>;
  cloud?: boolean;
}

export interface ExtraDir {
  claude?: string;
  codex?: string;
  /** Shown on the sessions read from it. */
  host: string;
}

const HOST_EVERY = 2 * 60_000;
const CLOUD_EVERY = 10 * 60_000;

/** Keeps the enabled hosts and Codex Cloud synced and tells the indexer where their logs are. */
export class RemoteSync {
  private hosts = new Map<string, SyncState>();
  private cloud: SyncState & { tasks?: number } = {};
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataDir: string,
    private readonly settings: () => RemoteSettings,
    private readonly setExtra: (dirs: ExtraDir[]) => void,
    private readonly onSynced: () => void,
    private readonly home?: string,
  ) {}

  private enabled(): { key: string; host: RemoteHost }[] {
    const s = this.settings();
    return allHosts(s.hosts, this.home)
      .map((host) => ({ key: hostKey(host), host }))
      .filter(({ key, host }) => s.on?.[key] ?? host.from === 'manual');
  }

  /** Re-reads the settings: hands the indexer the folders and syncs what is due. */
  apply(): void {
    const dirs: ExtraDir[] = this.enabled().map(({ key, host }) => {
      const root = path.join(this.dataDir, 'remote', key);
      return { claude: path.join(root, 'claude'), codex: path.join(root, 'codex'), host: host.label ?? host.target };
    });
    if (this.settings().cloud) dirs.push({ codex: path.join(this.dataDir, 'cloud', 'codex'), host: 'Codex Cloud' });
    // Made now, so the scan that follows doesn't list them as missing before the first sync.
    for (const d of dirs) {
      if (d.claude) fs.mkdirSync(path.join(d.claude, 'projects'), { recursive: true });
      if (d.codex) fs.mkdirSync(path.join(d.codex, 'sessions'), { recursive: true });
    }
    this.setExtra(dirs);
    void this.tick(true);
  }

  start(): void {
    this.apply();
    this.timer = setInterval(() => void this.tick(false), HOST_EVERY);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: boolean): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const { key, host } of this.enabled()) {
      const st = this.hosts.get(key) ?? {};
      this.hosts.set(key, st);
      if (st.running || (!now && st.lastSync && Date.now() - st.lastSync < HOST_EVERY - 5000)) continue;
      st.running = true;
      jobs.push(
        syncHost(host, path.join(this.dataDir, 'remote', key))
          .then(
            () => void (st.error = undefined),
            (err: Error) => void (st.error = err.message),
          )
          .finally(() => {
            st.running = false;
            st.lastSync = Date.now();
          }),
      );
    }
    const c = this.cloud;
    if (this.settings().cloud && !c.running && (!c.lastSync || Date.now() - c.lastSync >= CLOUD_EVERY || now)) {
      c.running = true;
      jobs.push(
        syncCodexCloud(path.join(this.dataDir, 'cloud', 'codex'))
          .then(
            (n) => void ((c.tasks = n), (c.error = undefined)),
            (err: Error) => void (c.error = err.message),
          )
          .finally(() => {
            c.running = false;
            c.lastSync = Date.now();
          }),
      );
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    this.onSynced();
  }

  view(): RemoteView {
    const s = this.settings();
    const on = new Set(this.enabled().map((e) => e.key));
    return {
      hosts: allHosts(s.hosts, this.home).map((h) => ({ key: hostKey(h), target: h.target, port: h.port, label: h.label, from: h.from, on: on.has(hostKey(h)), ...this.hosts.get(hostKey(h)) })),
      cloud: { on: !!s.cloud, ...this.cloud },
    };
  }
}

function run(cmd: string, args: string[], timeout: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr).trim().split('\n').pop() || err.message), { code: err.code }));
      else resolve(stdout);
    });
  });
}
