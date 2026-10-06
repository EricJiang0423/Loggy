// Keeps an in-memory index of every session, backed by an on-disk cache. Only files whose
// size or mtime changed are parsed again, and growing files are resumed from the last offset.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PARSER_VERSION, computeOutcome, type AccState } from '../core/acc.js';
import type { SummaryResult } from '../core/parse.js';
import { liveStatus } from '../shared/status.js';
import { AGENTS, type Agent, type IndexProgress, type SessionMark, type SessionSummary, type SourceInfo } from '../shared/types.js';
import { ensureDir } from './config.js';
import type { Pool } from './pool.js';
import { readCodexThreads } from './codexstate.js';
import { groupProjects, isUnder, readRemote, type GroupBy, type Place } from './projects.js';

const CACHE_VERSION = 2;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// ponytail: matches the Codex app's default <…>/Codex/YYYY-MM-DD/<slug>; read its state if that moves.
const CODEX_SCRATCH = /^(.*\/Codex)\/\d{4}-\d{2}-\d{2}\//;
const KEEP_STATE_MS = 3 * 86400_000;
const HOT_MS = 20 * 60_000;
const HEAD_BYTES = 256 * 1024;

export interface Entry {
  file: string;
  agent: Agent;
  size: number;
  mtime: number;
  offset: number;
  state?: AccState;
  summary: SessionSummary;
  search: string;
  /** Paths edited in the session (for related sessions). */
  files?: string[];
  gen: number;
}

export interface Sources {
  claudeDirs: string[];
  codexDirs: string[];
  kimiDirs?: string[];
}

interface Discovered {
  file: string;
  agent: Agent;
}

export class Indexer extends EventEmitter {
  readonly entries = new Map<string, Entry>();
  private removed = new Map<string, number>();
  private removedFloor = 0;
  gen = 1;
  progress: IndexProgress = { phase: 'idle', filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, startedAt: 0 };
  sourceInfo: SourceInfo[] = [];
  private inflight = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private scanning: Promise<void> | null = null;
  private rescanAgain = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private watchers: fs.FSWatcher[] = [];
  private gitRoots = new Map<string, string>();
  private places = new Map<string, Place>();
  groupBy: GroupBy = 'smart';
  /** AI summary per session id, attached to the list (kept by the server). */
  aiLite = new Map<string, NonNullable<SessionSummary['ai']>>();
  /** Bookmarks, labels and notes (kept by the server). */
  marks = new Map<string, SessionMark>();
  /** Smart categories (kept by the server). */
  categories?: { sessions: Record<string, string>; projects: Record<string, { category: string }> };
  private known: Discovered[] = [];
  /** Harnesses turned on in Settings; files of the others are not indexed. */
  enabled: Record<Agent, boolean> = { claude: true, codex: true, kimi: true };
  readonly cacheFile: string;

  constructor(
    private readonly sources: Sources,
    private readonly pool: Pool,
    dataDir: string,
  ) {
    super();
    this.cacheFile = path.join(ensureDir(path.join(dataDir, 'cache')), `index-v${CACHE_VERSION}.json`);
  }

  // ---------- cache ----------

  loadCache(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (raw.v !== CACHE_VERSION || raw.parser !== PARSER_VERSION || !Array.isArray(raw.entries)) return;
      for (const e of raw.entries as Entry[]) {
        e.gen = this.gen;
        this.entries.set(e.file, e);
      }
    } catch {
      // No cache yet, or unreadable: start from scratch.
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 3000);
    this.saveTimer.unref();
  }

  saveNow(): void {
    try {
      const tmp = `${this.cacheFile}.${process.pid}.tmp`;
      const entries = [...this.entries.values()].map(({ gen: _gen, ...rest }) => rest);
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, parser: PARSER_VERSION, savedAt: Date.now(), entries }));
      fs.renameSync(tmp, this.cacheFile);
    } catch (err) {
      console.error('[loggy] could not write cache:', (err as Error).message);
    }
  }

  clearCache(): void {
    this.entries.clear();
    try {
      fs.rmSync(this.cacheFile, { force: true });
    } catch {
      // ignore
    }
    this.gen++;
    this.removedFloor = this.gen;
  }

  // ---------- discovery ----------

  discover(): Discovered[] {
    const out: Discovered[] = [];
    const info: SourceInfo[] = [];
    for (const dir of this.sources.claudeDirs) {
      const projects = path.join(dir, 'projects');
      const before = out.length;
      for (const proj of readdir(projects)) {
        if (!proj.isDirectory()) continue;
        const pdir = path.join(projects, proj.name);
        for (const f of readdir(pdir)) {
          if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(pdir, f.name), agent: 'claude' });
          else if (f.isDirectory()) {
            const sub = path.join(pdir, f.name, 'subagents');
            for (const s of readdir(sub)) {
              if (s.isFile() && s.name.endsWith('.jsonl')) out.push({ file: path.join(sub, s.name), agent: 'claude' });
            }
          }
        }
      }
      info.push({ agent: 'claude', dir: projects, exists: fs.existsSync(projects), files: out.length - before, bytes: 0 });
    }
    for (const dir of this.sources.codexDirs) {
      const before = out.length;
      for (const sub of ['sessions', 'archived_sessions']) walkRollouts(path.join(dir, sub), out, 0);
      info.push({ agent: 'codex', dir, exists: fs.existsSync(path.join(dir, 'sessions')), files: out.length - before, bytes: 0 });
    }
    for (const dir of this.sources.kimiDirs ?? []) {
      // sessions/wd_<dir>_<hash>/session_<id>/agents/<agent>/wire.jsonl
      const sessions = path.join(dir, 'sessions');
      const before = out.length;
      for (const wd of readdir(sessions)) {
        if (!wd.isDirectory() || !wd.name.startsWith('wd_')) continue;
        for (const sess of readdir(path.join(sessions, wd.name))) {
          if (!sess.isDirectory() || !sess.name.startsWith('session_')) continue;
          const agents = path.join(sessions, wd.name, sess.name, 'agents');
          for (const a of readdir(agents)) {
            const file = path.join(agents, a.name, 'wire.jsonl');
            if (a.isDirectory() && fs.existsSync(file)) out.push({ file, agent: 'kimi' });
          }
        }
      }
      info.push({ agent: 'kimi', dir: sessions, exists: fs.existsSync(sessions), files: out.length - before, bytes: 0 });
    }
    // Prefer the plain file when both a .jsonl and its .zst copy exist.
    const plain = new Set(out.filter((d) => !d.file.endsWith('.zst')).map((d) => d.file));
    const result = out.filter((d) => this.enabled[d.agent] && !(d.file.endsWith('.zst') && plain.has(d.file.slice(0, -4))));
    this.sourceInfo = info;
    this.known = result;
    return result;
  }

  // ---------- scanning ----------

  /** Full pass: discover files, parse what changed, drop what disappeared. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescanAgain = true;
      return this.scanning;
    }
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
      if (this.rescanAgain) {
        this.rescanAgain = false;
        void this.scan();
      }
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const started = Date.now();
    this.progress = { phase: 'scanning', filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, startedAt: started };
    this.emit('progress');
    const found = this.discover();
    const seen = new Set<string>();
    const jobs: { file: string; agent: Agent; size: number; mtime: number }[] = [];
    for (const d of found) {
      seen.add(d.file);
      let st: fs.Stats;
      try {
        st = fs.statSync(d.file);
      } catch {
        continue;
      }
      const s = this.sourceInfo.find((i) => i.agent === d.agent && (d.file.startsWith(i.dir) || d.file.startsWith(path.dirname(i.dir))));
      if (s) s.bytes += st.size;
      const e = this.entries.get(d.file);
      if (!e || e.size !== st.size || e.mtime !== st.mtimeMs) jobs.push({ ...d, size: st.size, mtime: st.mtimeMs });
    }
    for (const file of [...this.entries.keys()]) {
      if (!seen.has(file)) this.removeEntry(file);
    }
    jobs.sort((a, b) => b.mtime - a.mtime);
    this.progress = {
      phase: 'parsing',
      filesTotal: jobs.length,
      filesDone: 0,
      bytesTotal: jobs.reduce((n, j) => n + j.size, 0),
      bytesDone: 0,
      startedAt: started,
    };
    this.emit('progress');
    let lastEmit = Date.now();
    await Promise.all(
      jobs.map((j) =>
        this.parse(j.file, j.agent).then(() => {
          this.progress.filesDone++;
          this.progress.bytesDone += j.size;
          if (Date.now() - lastEmit > 250) {
            lastEmit = Date.now();
            this.emit('progress');
            this.emit('update');
          }
        }),
      ),
    );
    this.progress = { ...this.progress, phase: 'ready', finishedAt: Date.now(), lastDurationMs: Date.now() - started };
    this.emit('progress');
    this.emit('update');
    if (jobs.length) this.scheduleSave();
  }

  /** Parses one file (resuming when it only grew). Concurrent requests for a file coalesce. */
  parse(file: string, agent: Agent): Promise<void> {
    const running = this.inflight.get(file);
    if (running) {
      this.dirty.add(file);
      return running;
    }
    const p = this.doParse(file, agent)
      .catch((err) => {
        console.error(`[loggy] failed to parse ${file}: ${(err as Error).message}`);
      })
      .finally(() => {
        this.inflight.delete(file);
        if (this.dirty.delete(file)) void this.parse(file, agent);
      });
    this.inflight.set(file, p);
    return p;
  }

  private async doParse(file: string, agent: Agent): Promise<void> {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.removeEntry(file);
      return;
    }
    const prev = this.entries.get(file);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) return;
    const resume = prev?.state && st.size >= prev.size && prev.offset <= st.size ? { state: prev.state, offset: prev.offset } : undefined;
    const skipFrom = agent === 'claude' && !resume ? this.forkSources(file) : undefined;
    const r = await this.pool.run<SummaryResult>({ kind: 'summary', file, agent, resume, skipFrom });
    const summary = r.summary;
    summary.mtime = st.mtimeMs;
    const keepState = Date.now() - st.mtimeMs < KEEP_STATE_MS && !file.endsWith('.zst');
    const entry: Entry = {
      file,
      agent,
      size: st.size,
      mtime: st.mtimeMs,
      offset: r.offset,
      state: keepState ? r.state : undefined,
      summary,
      search: searchText(summary, r.state),
      files: r.files,
      gen: ++this.gen,
    };
    this.entries.set(file, entry);
    if (summary.parentId) this.bumpParent(summary.parentId);
    this.scheduleSave();
  }

  private bumpParent(parentId: string): void {
    for (const e of this.entries.values()) {
      if (e.summary.id === parentId) {
        e.gen = ++this.gen;
        return;
      }
    }
  }

  private removeEntry(file: string): void {
    const e = this.entries.get(file);
    if (!e) return;
    this.entries.delete(file);
    this.removed.set(e.summary.id, ++this.gen);
    this.scheduleSave();
  }

  // ---------- live updates ----------

  /** Starts fs watchers plus polling of recently active files. */
  watch(): void {
    const roots = [
      ...this.sources.claudeDirs.map((d) => path.join(d, 'projects')),
      ...this.sources.codexDirs.flatMap((d) => [path.join(d, 'sessions'), path.join(d, 'archived_sessions')]),
      ...(this.sources.kimiDirs ?? []).map((d) => path.join(d, 'sessions')),
    ];
    let pending = false;
    const kick = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        void this.pollHot(true);
      }, 80).unref();
    };
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true }, (_ev, name) => {
          if (name && /\.jsonl(\.zst)?$/.test(String(name))) {
            const file = path.join(root, String(name));
            this.hotFiles.add(file);
            kick();
          }
        });
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        // Recursive watching is unsupported here; polling still works.
      }
    }
    this.timers.push(setInterval(() => void this.pollHot(false), 2000));
    this.timers.push(
      setInterval(() => {
        if (!this.scanning) void this.scan();
      }, 30_000),
    );
    for (const t of this.timers) t.unref();
  }

  private hotFiles = new Set<string>();
  private lastLive = '';
  private polling = false;

  private async pollHot(fromWatch: boolean): Promise<void> {
    if (this.polling) {
      if (fromWatch) setTimeout(() => void this.pollHot(true), 100).unref();
      return;
    }
    this.polling = true;
    try {
      const now = Date.now();
      const files = new Set(this.hotFiles);
      this.hotFiles.clear();
      if (!fromWatch) for (const e of this.entries.values()) if (now - e.mtime < HOT_MS) files.add(e.file);
      let changed = false;
      const jobs: Promise<void>[] = [];
      for (const file of files) {
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          if (this.entries.has(file)) {
            this.removeEntry(file);
            changed = true;
          }
          continue;
        }
        const e = this.entries.get(file);
        if (e && e.size === st.size && e.mtime === st.mtimeMs) continue;
        const agent: Agent | undefined = e?.agent ?? this.agentOf(file);
        if (!agent) continue;
        changed = true;
        jobs.push(this.parse(file, agent));
      }
      await Promise.all(jobs);
      // A Claude process can change state (e.g. start waiting for approval) without writing a log line.
      if (!fromWatch) {
        const live = JSON.stringify([...this.liveClaude()].sort());
        if (live !== this.lastLive) {
          const before = new Map<string, string>(JSON.parse(this.lastLive || '[]'));
          const after = new Map<string, string>(JSON.parse(live));
          this.lastLive = live;
          for (const e of this.entries.values()) {
            const sid = e.summary.sessionId;
            if (e.agent === 'claude' && before.get(sid) !== after.get(sid)) {
              e.gen = ++this.gen;
              changed = true;
            }
          }
        }
      }
      if (changed) this.emit('update');
    } finally {
      this.polling = false;
    }
  }

  private agentOf(file: string): Agent | undefined {
    const agent = this.agentOfPath(file);
    return agent && this.enabled[agent] ? agent : undefined;
  }

  private agentOfPath(file: string): Agent | undefined {
    if (this.sources.claudeDirs.some((d) => file.startsWith(path.join(d, 'projects')))) return 'claude';
    if (this.sources.codexDirs.some((d) => file.startsWith(d)) && /rollout-.*\.jsonl(\.zst)?$/.test(file)) return 'codex';
    if ((this.sources.kimiDirs ?? []).some((d) => file.startsWith(path.join(d, 'sessions'))) && path.basename(file) === 'wire.jsonl') return 'kimi';
    return undefined;
  }

  /** Turns harnesses on or off; a harness turned off is dropped from the index and not watched. */
  setHarnesses(h: Partial<Record<Agent, boolean>>, rescan = true): void {
    const next = Object.fromEntries(AGENTS.map((a) => [a, h[a] !== false])) as Record<Agent, boolean>;
    if (AGENTS.every((a) => next[a] === this.enabled[a])) return;
    this.enabled = next;
    if (!rescan) return;
    this.gen++;
    this.removedFloor = this.gen;
    void this.scan();
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    for (const w of this.watchers) w.close();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveNow();
    }
  }

  // ---------- queries ----------

  /** Summaries with live status and subagent roll-ups. */
  summaries(): SessionSummary[] {
    const now = Date.now();
    const groups = this.groups();
    const merged = [...groups.entries()].map(([key, pages]) => {
      const s = pages.length === 1 ? { ...pages[0].summary } : mergePages(pages.map((e) => e.summary), key.startsWith('lineage:'));
      // A mark made before a rewind is kept under the earlier id.
      for (let i = pages.length - 1; i >= 0 && !s.mark; i--) s.mark = this.marks.get(pages[i].summary.id);
      return s;
    });
    // Subagents of an earlier file of a forked conversation belong to the merged session.
    const mergedId = this.mergedIds(groups);
    for (const s of merged) if (s.parentId && mergedId.has(s.parentId)) s.parentId = mergedId.get(s.parentId);
    // The Codex app's own thread names (latest rename) and the projects the user put threads in.
    const app = this.codexThreads();
    for (const s of merged) {
      const name = s.agent === 'codex' ? app.names.get(s.sessionId) : undefined;
      if (name) {
        s.title = name;
        s.titleSource = 'custom';
      }
    }
    for (const s of merged) {
      const t = s.agent === 'kimi' && !s.isSubagent ? this.kimiTitle(s.file) : undefined;
      if (t) {
        s.title = t.title;
        s.titleSource = t.custom ? 'custom' : 'ai';
      }
    }
    // Codex threads are placed by folder like Claude sessions, so both land in the same project:
    // a thread that ran outside its app project's folders counts as in the first one, and the
    // dated folders the app makes for chats without a project count as one folder.
    const home = new Map<string, string>();
    for (const s of merged) {
      if (s.agent !== 'codex' || !s.cwd) continue;
      const roots = app.projects.get(s.sessionId);
      const scratch = CODEX_SCRATCH.exec(s.cwd + '/')?.[1];
      if (roots && !roots.some((r) => isUnder(s.cwd, r))) home.set(s.sessionId, roots[0]);
      else if (!roots && scratch) home.set(s.sessionId, scratch);
    }
    groupProjects(merged, this.groupBy, (cwd) => this.place(cwd), undefined, home);
    if (this.categories) {
      const cats = this.categories;
      const byId = new Map(merged.map((s) => [s.id, s]));
      for (const s of merged) s.category = cats.sessions[s.id] ?? cats.projects[s.projectPath]?.category;
      // Subagents take their parent's category.
      for (const s of merged) if (s.isSubagent && s.parentId) s.category = byId.get(s.parentId)?.category ?? s.category;
    }
    const byId = new Map(merged.map((s) => [s.id, s]));
    for (const s of merged) {
      // A subagent's edits count as committed once its parent commits after them.
      const parent = s.isSubagent && s.uncommittedEdits && s.parentId ? byId.get(s.parentId) : undefined;
      if (parent?.lastCommitTs && s.lastEditTs && parent.lastCommitTs >= s.lastEditTs) {
        s.uncommittedEdits = false;
        s.outcome = computeOutcome(s.turns, s.lastTurn, false, s.pendingBackground);
      }
    }
    // Handoffs: a first prompt that names one other session (Loggy's handoff text, a codex://
    // link, a log path) continues it, across Claude and Codex alike.
    const bySid = new Map<string, string>();
    for (const s of merged) if (!s.isSubagent) bySid.set(s.sessionId.toLowerCase(), s.id);
    for (const s of merged) {
      if (s.isSubagent) continue;
      const named = new Set((s.firstPrompt.match(UUID) ?? []).map((u) => bySid.get(u.toLowerCase())).filter((id) => id && id !== s.id));
      if (named.size === 1) s.continues = [...named][0];
    }
    const kids = new Map<string, { n: number; cost: number }>();
    for (const s of merged) {
      const p = s.parentId;
      if (!p) continue;
      const k = kids.get(p) ?? { n: 0, cost: 0 };
      k.n++;
      k.cost += s.costUSD;
      kids.set(p, k);
    }
    const live = this.liveClaude();
    const out: SessionSummary[] = [];
    for (const s of merged) {
      const k = kids.get(s.id);
      let status = liveStatus(s, now);
      const proc = s.agent === 'claude' && !s.isSubagent ? live.get(s.sessionId) : undefined;
      if (proc === 'busy') status = 'running';
      else if (proc === 'waiting') status = 'needs_input';
      else if (proc === 'idle' && (status === 'running' || status === 'stalled')) status = 'idle';
      out.push({ ...s, status, children: k?.n ?? 0, totalCostUSD: s.costUSD + (k?.cost ?? 0), ai: this.aiLite.get(s.id) });
    }
    return out;
  }

  /** Changes since a generation: full list when the client is too far behind. */
  delta(since: number): { gen: number; full: boolean; sessions: SessionSummary[]; removed: string[] } {
    const all = this.summaries();
    if (!since || since < this.removedFloor) return { gen: this.gen, full: true, sessions: all, removed: [] };
    const changedFiles = new Set<string>();
    const mergedId = this.mergedIds(this.groups());
    for (const e of this.entries.values()) if (e.gen > since) changedFiles.add(mergedId.get(e.summary.id) ?? e.summary.id);
    const removed = [...this.removed.entries()].filter(([, g]) => g > since).map(([id]) => id);
    return { gen: this.gen, full: false, sessions: all.filter((s) => changedFiles.has(s.id)), removed };
  }

  /**
   * Entries grouped into sessions, oldest page first. One session can span files: newer Codex
   * versions continue a thread in a new rollout file with the same thread id, and a Claude
   * rewind forks the conversation into a new file that starts with a copy of the old one.
   */
  private groups(): Map<string, Entry[]> {
    const byId = new Map<string, Entry[]>();
    for (const e of this.entries.values()) {
      const s = e.summary;
      const key = s.agent === 'claude' && !s.isSubagent && s.lineage ? `lineage:${s.lineage}` : s.id;
      const pages = byId.get(key);
      if (!pages) {
        byId.set(key, [e]);
        continue;
      }
      // The same rollout under two roots (e.g. sessions and archived_sessions) is one page.
      const dup = pages.findIndex((p) => path.basename(p.file) === path.basename(e.file));
      if (dup === -1) pages.push(e);
      else if (e.summary.end > pages[dup].summary.end) pages[dup] = e;
    }
    for (const pages of byId.values()) if (pages.length > 1) pages.sort((a, b) => a.summary.start - b.summary.start);
    return byId;
  }

  /** Id of every page -> id of the session it belongs to (the newest page's). */
  private mergedIds(groups: Map<string, Entry[]>): Map<string, string> {
    const out = new Map<string, string>();
    for (const pages of groups.values()) {
      if (pages.length < 2) continue;
      const id = pages[pages.length - 1].summary.id;
      for (const p of pages) out.set(p.summary.id, id);
    }
    return out;
  }

  /** Every page of a session, oldest first; any page's id finds the session. */
  pagesOf(id: string): Entry[] {
    for (const pages of this.groups().values()) if (pages.some((p) => p.summary.id === id)) return pages;
    return [];
  }

  /** Sessions that edited the same files, most shared first. */
  related(id: string, limit = 8): { id: string; shared: number }[] {
    const groups = this.groups();
    const mergedId = this.mergedIds(groups);
    const filesOf = (pages: Entry[]) => new Set(pages.flatMap((p) => p.files ?? []));
    const mine = filesOf(this.pagesOf(id));
    if (!mine.size) return [];
    const self = mergedId.get(id) ?? id;
    const out: { id: string; shared: number }[] = [];
    for (const pages of groups.values()) {
      const gid = pages[pages.length - 1].summary.id;
      if (gid === self || pages[0].summary.isSubagent) continue;
      let shared = 0;
      for (const f of filesOf(pages)) if (mine.has(f)) shared++;
      if (shared) out.push({ id: mergedId.get(gid) ?? gid, shared });
    }
    return out.sort((a, b) => b.shared - a.shared).slice(0, limit);
  }

  search(q: string): string[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const mergedId = this.mergedIds(this.groups());
    const out = new Set<string>();
    const names = this.codexThreads().names;
    for (const e of this.entries.values()) {
      const text = e.agent === 'codex' && names.has(e.summary.sessionId) ? `${e.search}\n${names.get(e.summary.sessionId)!.toLowerCase()}` : e.search;
      if (terms.every((t) => text.includes(t))) out.add(mergedId.get(e.summary.id) ?? e.summary.id);
    }
    return [...out];
  }

  private codexThreads(): { names: Map<string, string>; projects: Map<string, string[]> } {
    const names = new Map<string, string>();
    const projects = new Map<string, string[]>();
    for (const dir of this.sources.codexDirs) {
      const r = readCodexThreads(dir);
      for (const [k, v] of r.names) names.set(k, v);
      for (const [k, v] of r.projects) projects.set(k, v);
    }
    return { names, projects };
  }

  /** Current title of a Kimi Code session (state.json changes on a rename without a log line). */
  private kimiTitles = new Map<string, { mtime: number; title?: string; custom: boolean }>();
  private kimiTitle(file: string): { title: string; custom: boolean } | undefined {
    const state = path.join(path.dirname(path.dirname(path.dirname(file))), 'state.json');
    let mtime = 0;
    try {
      mtime = fs.statSync(state).mtimeMs;
    } catch {
      return undefined;
    }
    let hit = this.kimiTitles.get(state);
    if (!hit || hit.mtime !== mtime) {
      hit = { mtime, custom: false };
      try {
        const d = JSON.parse(fs.readFileSync(state, 'utf8'));
        if (typeof d.title === 'string' && d.title.trim()) hit = { mtime, title: d.title.trim(), custom: !!d.isCustomTitle };
      } catch {
        // being rewritten; keep the parsed title
      }
      this.kimiTitles.set(state, hit);
    }
    return hit.title ? { title: hit.title, custom: hit.custom } : undefined;
  }

  // ---------- live Claude processes ----------

  /** sessionId -> status of running Claude Code processes (~/.claude/sessions/<pid>.json). */
  private liveClaude(): Map<string, string> {
    // A handful of small files; read every time so a new state shows up immediately.
    const value = new Map<string, string>();
    for (const dir of this.sources.claudeDirs) {
      for (const f of readdir(path.join(dir, 'sessions'))) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f.name), 'utf8'));
          if (typeof d.sessionId !== 'string' || typeof d.status !== 'string' || !pidAlive(d.pid)) continue;
          value.set(d.sessionId, d.status);
        } catch {
          // being rewritten; try again next time
        }
      }
    }
    return value;
  }

  // ---------- rewinds ----------

  /** file -> first uuid ('' when none), with the size it was read at. */
  private heads = new Map<string, { size: number; head: string }>();

  /** uuid of the first record of a Claude transcript: forks of one conversation share it. */
  private lineageHead(file: string): string | undefined {
    const parsed = this.entries.get(file)?.summary.lineage;
    if (parsed) return parsed;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return undefined;
    }
    const hit = this.heads.get(file);
    // a miss is final once the whole read window is filled; until then the file may still grow into it
    if (hit && (hit.head || hit.size === size || hit.size >= HEAD_BYTES)) return hit.head || undefined;
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8', 0, n);
    } catch {
      return undefined;
    }
    let head = '';
    for (const line of text.split('\n')) {
      if (!line.includes('"uuid"')) continue;
      try {
        const d = JSON.parse(line);
        if (typeof d.uuid === 'string' && !d.isSidechain) {
          head = d.uuid;
          break;
        }
      } catch {
        // partial line at the end of the read
      }
    }
    this.heads.set(file, { size, head });
    return head || undefined;
  }

  /** Earlier files of the same conversation, oldest first: their records were copied into this one. */
  private forkSources(file: string): string[] | undefined {
    if (file.includes(`${path.sep}subagents${path.sep}`)) return undefined;
    const head = this.lineageHead(file);
    if (!head) return undefined;
    const born = (f: string) => {
      try {
        const st = fs.statSync(f);
        return [st.birthtimeMs || st.mtimeMs, st.mtimeMs];
      } catch {
        return [Infinity, Infinity];
      }
    };
    const mine = born(file);
    const earlier = this.known
      .filter((d) => d.agent === 'claude' && d.file !== file && !d.file.includes(`${path.sep}subagents${path.sep}`) && path.dirname(d.file) === path.dirname(file))
      .filter((d) => this.lineageHead(d.file) === head)
      .map((d) => ({ f: d.file, b: born(d.file) }))
      .filter((x) => x.b[0] < mine[0] || (x.b[0] === mine[0] && x.b[1] < mine[1]))
      .sort((a, b) => a.b[0] - b.b[0] || a.b[1] - b.b[1]);
    return earlier.length ? earlier.map((x) => x.f) : undefined;
  }

  // ---------- helpers ----------

  gitRoot(cwd: string): string {
    if (!cwd) return '';
    const hit = this.gitRoots.get(cwd);
    if (hit !== undefined) return hit;
    let dir = cwd;
    let root = cwd;
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        root = dir;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    this.gitRoots.set(cwd, root);
    return root;
  }

  place(cwd: string): Place {
    let p = this.places.get(cwd);
    if (!p) {
      const root = this.gitRoot(cwd);
      const isGit = fs.existsSync(path.join(root, '.git'));
      p = { root, isGit, remote: isGit ? readRemote(root) : undefined };
      this.places.set(cwd, p);
    }
    return p;
  }

  /** New smart categories: every client gets a full list. */
  setCategories(c: Indexer['categories']): void {
    this.categories = c;
    this.gen++;
    this.removedFloor = this.gen;
    this.emit('update');
  }

  /** Marks a session as changed (e.g. a new AI summary) so clients fetch it again. */
  touch(id: string): void {
    for (const e of this.pagesOf(id)) e.gen = ++this.gen;
    this.emit('update');
  }

  /** Changes how sessions are grouped into projects; clients get a full list next time. */
  setGroupBy(mode: GroupBy): void {
    if (mode === this.groupBy) return;
    this.groupBy = mode;
    this.gen++;
    this.removedFloor = this.gen;
    this.emit('update');
  }

  knownFiles(): number {
    return this.known.length;
  }
}

/** One session from the summaries of its pages, oldest first. */
/** User inputs on the final path of a forked conversation (later files replace what came after their fork). */
function keptInputs(pages: SessionSummary[]): number {
  let kept = pages[0].inputTimes;
  for (const p of pages.slice(1)) kept = [...kept.filter((t) => !p.forkTs || t <= p.forkTs), ...p.inputTimes];
  return kept.length;
}

function mergePages(pages: SessionSummary[], forked = false): SessionSummary {
  const first = pages[0];
  const last = pages[pages.length - 1];
  const sum = (k: keyof SessionSummary) => pages.reduce((n, p) => n + (p[k] as number), 0);
  const buckets = new Map<number, number>();
  for (const p of pages) for (const [b, v] of p.buckets) buckets.set(b, (buckets.get(b) ?? 0) + v);
  const named = last.titleSource === 'custom' || last.titleSource === 'ai' ? last : first;
  return {
    ...last,
    title: named.title,
    titleSource: named.titleSource,
    firstPrompt: first.firstPrompt,
    models: [...new Set(pages.flatMap((p) => p.models))],
    start: Math.min(...pages.map((p) => p.start || Infinity)) || last.start,
    end: Math.max(...pages.map((p) => p.end)),
    mtime: Math.max(...pages.map((p) => p.mtime)),
    tokens: {
      input: pages.reduce((n, p) => n + p.tokens.input, 0),
      output: pages.reduce((n, p) => n + p.tokens.output, 0),
      cacheRead: pages.reduce((n, p) => n + p.tokens.cacheRead, 0),
      cacheWrite: pages.reduce((n, p) => n + p.tokens.cacheWrite, 0),
      reasoning: pages.reduce((n, p) => n + p.tokens.reasoning, 0),
    },
    costUSD: sum('costUSD'),
    ctxPeakPct: Math.max(...pages.map((p) => p.ctxPeakPct)),
    maxToolCallsPerTurn: Math.max(...pages.map((p) => p.maxToolCallsPerTurn)),
    turns: sum('turns'),
    userInputs: sum('userInputs'),
    toolCalls: sum('toolCalls'),
    toolErrors: sum('toolErrors'),
    interrupts: sum('interrupts'),
    compactions: sum('compactions'),
    apiErrors: sum('apiErrors'),
    questions: sum('questions'),
    // ponytail: a file edited on two pages counts twice here; the detail view has the exact list.
    filesChanged: sum('filesChanged'),
    linesAdded: sum('linesAdded'),
    linesRemoved: sum('linesRemoved'),
    commits: sum('commits'),
    pushes: sum('pushes'),
    activeMs: sum('activeMs'),
    waitMs: sum('waitMs'),
    badLines: sum('badLines'),
    hasPlan: pages.some((p) => p.hasPlan),
    lastEditTs: Math.max(0, ...pages.map((p) => p.lastEditTs ?? 0)) || undefined,
    lastCommitTs: Math.max(0, ...pages.map((p) => p.lastCommitTs ?? 0)) || undefined,
    repo: pages.find((p) => p.repo)?.repo,
    commitShas: pages.flatMap((p) => p.commitShas ?? []),
    commitRuns: pages.flatMap((p) => p.commitRuns ?? []),
    buckets: [...buckets].sort((a, b) => a[0] - b[0]),
    inputTimes: pages.flatMap((p) => p.inputTimes).slice(-500),
    ...(forked ? { rewinds: pages.length - 1, rewoundInputs: pages.reduce((n, p) => n + p.inputTimes.length, 0) - keptInputs(pages) } : {}),
  };
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readdir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkRollouts(dir: string, out: Discovered[], depth: number): void {
  if (depth > 5) return;
  for (const d of readdir(dir)) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walkRollouts(p, out, depth + 1);
    else if (d.isFile() && /^rollout-.*\.jsonl(\.zst)?$/.test(d.name)) out.push({ file: p, agent: 'codex' });
  }
}

function searchText(s: SessionSummary, state: AccState): string {
  const parts = [s.title, s.firstPrompt, s.cwd, s.branch ?? '', s.models.join(' '), s.sessionId];
  for (const t of state.turns) parts.push(t.prompt);
  return parts.join('\n').toLowerCase().slice(0, 30_000);
}
