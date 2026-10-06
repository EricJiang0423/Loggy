// Local HTTP server: JSON API, server-sent events and the built web UI.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { completionOf } from '../core/acc.js';
import { AGENTS, type Agent, type SessionDetail, type ServerState } from '../shared/types.js';
import { aiErrorMessage, readAiSummary, resolveAi, summarizeWithAi, testAi, type AiSettings } from './ai.js';
import { AutoSummarizer } from './autosum.js';
import type { AiSummary, SessionMark } from '../shared/types.js';
import type { Config } from './config.js';
import type { Indexer } from './indexer.js';
import { gitLines, gitLog, gitShow, linkCommits } from './git.js';
import { findGitProjects, type GitProject } from './gitprojects.js';
import { handOff, TARGETS, type Target } from './launch.js';
import { globalInstructionFiles, instructionVersion, instructionsFor, readGlobal } from './instructions.js';
import type { Pool } from './pool.js';
import { GROUP_BY, type GroupBy } from './projects.js';
import { readMarks, readSettings, writeMarks, writeSettings } from './settings.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

interface DetailCacheEntry {
  key: string;
  detail: Omit<SessionDetail, 'ai'>;
}

export function createServer(cfg: Config, indexer: Indexer, pool: Pool, webDir: string, opts: { autoSummaries?: boolean } = {}): http.Server {
  const clients = new Set<http.ServerResponse>();
  const detailCache = new Map<string, DetailCacheEntry>();
  const allowedHosts = new Set<string>();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  indexer.on('update', () => broadcast('update', { gen: indexer.gen }));
  indexer.on('progress', () => broadcast('progress', indexer.progress));
  const heartbeat = setInterval(() => broadcast('ping', { t: Date.now() }), 20_000);
  heartbeat.unref();

  const state = (): ServerState => ({
    version: cfg.version,
    demo: cfg.demo,
    progress: indexer.progress,
    sources: indexer.sourceInfo,
    sessions: indexer.entries.size,
    ...aiState(),
    cacheFile: indexer.cacheFile,
    generation: indexer.gen,
    groupBy: indexer.groupBy,
    harnesses: indexer.enabled,
  });

  /** Projects whose folder is a git repository. */
  // Looking for clones walks a few folders, so the list is kept for a minute.
  let gitCache: { at: number; list: GitProject[] } | undefined;
  function gitProjects(): GitProject[] {
    if (gitCache && Date.now() - gitCache.at < 60_000) return gitCache.list;
    gitCache = { at: Date.now(), list: findGitProjects(indexer.summaries(), (cwd) => indexer.place(cwd)) };
    return gitCache.list;
  }

  function currentAi() {
    return resolveAi(readSettings(cfg.dataDir).ai, process.env, cfg.aiModel);
  }

  function aiState(): Pick<ServerState, 'aiAvailable' | 'aiModel' | 'ai'> {
    const saved = readSettings(cfg.dataDir).ai ?? {};
    const c = currentAi();
    return {
      aiAvailable: Boolean(c),
      aiModel: c?.model ?? cfg.aiModel,
      ai: {
        enabled: saved.enabled !== false,
        provider: saved.provider ?? 'anthropic',
        baseURL: saved.baseURL ?? '',
        model: saved.model ?? '',
        auth: saved.auth ?? 'x-api-key',
        apiKeyEnv: saved.apiKeyEnv ?? '',
        headers: saved.headers ?? {},
        hasKey: Boolean(saved.apiKey),
        auto: saved.auto === true,
        lang: saved.lang ?? 'en',
        source: c?.source,
        autoStatus: auto.status,
        categories: auto.categories?.categories,
        categorizedAt: auto.categories?.updatedAt,
        projectNotes: auto.categories ? Object.fromEntries(Object.entries(auto.categories.projects).map(([k, v]) => [k, v.description])) : undefined,
      },
    };
  }

  const lite = (a: AiSummary) => ({ title: a.title, type: a.type, next: a.nextSteps ?? [], complete: a.workComplete, ts: a.createdAt });
  const auto = new AutoSummarizer({
    dataDir: cfg.dataDir,
    summaries: () => indexer.summaries(),
    detailOf: (id) => detailOf(id),
    config: () => ({ ai: currentAi(), settings: readSettings(cfg.dataDir).ai }),
    onSaved: (a) => {
      if (!a.id) return;
      indexer.aiLite.set(a.id, lite(a));
      indexer.touch(a.id);
    },
    onCategories: (c) => indexer.setCategories(c),
  });
  if (auto.categories) indexer.setCategories(auto.categories);
  for (const [id, a] of auto.saved) indexer.aiLite.set(id, lite(a));
  indexer.marks = readMarks(cfg.dataDir);
  if (opts.autoSummaries !== false) auto.start();

  async function detailOf(id: string): Promise<Omit<SessionDetail, 'ai'> | undefined> {
    const pages = indexer.pagesOf(id);
    const e = pages.at(-1);
    if (!e) return undefined;
    const key = pages.map((p) => `${p.file}:${p.size}:${p.mtime}`).join('|');
    const hit = detailCache.get(id);
    const detail = hit && hit.key === key ? hit.detail : await pool.run<Omit<SessionDetail, 'ai'>>({ kind: 'detail', files: pages.map((p) => p.file), agent: e.agent }, true);
    if (detail !== hit?.detail) {
      detailCache.set(id, { key, detail });
      if (detailCache.size > 30) detailCache.delete(detailCache.keys().next().value!);
    }
    // Status, project and roll-ups change without the file changing, so the summary is always fresh.
    detail.summary = indexer.summaries().find((s) => s.id === id) ?? detail.summary;
    return detail;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!isAllowedHost(host, allowedHosts, cfg.host)) {
        res.writeHead(403).end('Forbidden host');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      if (p.startsWith('/api/')) {
        if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') {
          res.writeHead(403).end();
          return;
        }
        await api(p, url, req, res);
        return;
      }
      serveStatic(webDir, p, req, res);
    } catch (err) {
      sendJson(req, res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  async function api(p: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    switch (p) {
      case '/api/state':
        return sendJson(req, res, state());
      case '/api/sessions':
        return sendJson(req, res, indexer.delta(Number(url.searchParams.get('since') ?? 0)));
      case '/api/session': {
        const id = url.searchParams.get('id') ?? '';
        const d = await detailOf(id);
        if (!d) return sendJson(req, res, { error: 'not found' }, 404);
        const ai = readAiSummary(cfg.dataDir, id);
        return sendJson(req, res, { ...d, ai, completion: completionOf(d.summary, ai ? ai.workComplete : null) });
      }
      case '/api/mark': {
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        const body = await readJson(req);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!body || !indexer.pagesOf(id).length) return sendJson(req, res, { error: 'unknown session' }, 400);
        if (body.label !== undefined && body.label !== null && !['discuss', 'doing', 'later', 'done'].includes(body.label as string)) return sendJson(req, res, { error: 'unknown label' }, 400);
        const cur = indexer.marks.get(id) ?? { ts: 0 };
        const next = {
          star: body.star === undefined ? cur.star : body.star === true || undefined,
          label: body.label === undefined ? cur.label : (body.label as SessionMark['label']) || undefined,
          note: body.note === undefined ? cur.note : String(body.note).slice(0, 20_000) || undefined,
          ts: Date.now(),
        };
        if (next.star || next.label || next.note) indexer.marks.set(id, next);
        else indexer.marks.delete(id);
        writeMarks(cfg.dataDir, indexer.marks);
        indexer.touch(id);
        return sendJson(req, res, { mark: indexer.marks.get(id) ?? null });
      }
      case '/api/handoff': {
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        const body = await readJson(req);
        const from = indexer.summaries().find((s) => s.id === body?.id && !s.isSubagent);
        if (!from) return sendJson(req, res, { error: 'unknown session' }, 400);
        if (body!.to !== 'claude' && body!.to !== 'codex') return sendJson(req, res, { error: 'unknown agent' }, 400);
        if (!TARGETS.includes(body!.target as Target)) return sendJson(req, res, { error: 'unknown target' }, 400);
        try {
          return sendJson(req, res, await handOff(cfg.dataDir, from, body!.to, body!.target as Target, String(body!.text ?? '').slice(0, 100_000), String(body!.lang ?? 'en')));
        } catch (err) {
          return sendJson(req, res, { error: (err as Error).message }, 500);
        }
      }
      case '/api/git/projects':
        return sendJson(req, res, { projects: gitProjects().map(({ path: p, name }) => ({ path: p, name })) });
      case '/api/git/log':
      case '/api/git/show':
      case '/api/git/lines': {
        const project = url.searchParams.get('project') ?? '';
        const repo = gitProjects().find((p) => p.path === project);
        if (!repo) return sendJson(req, res, { error: 'unknown project' }, 400);
        try {
          if (p === '/api/git/show') return sendJson(req, res, await gitShow(project, url.searchParams.get('sha') ?? ''));
          if (p === '/api/git/lines') return sendJson(req, res, await gitLines(project, cfg.dataDir));
          const commits = await gitLog(project, { q: url.searchParams.get('q') || undefined, path: url.searchParams.get('path') || undefined, cacheDir: path.join(cfg.dataDir, 'cache', 'git') });
          const owner = linkCommits(commits, indexer.summaries(), project, repo.groups);
          return sendJson(req, res, { commits: commits.map((c) => ({ ...c, session: owner.get(c.sha) })) });
        } catch (err) {
          return sendJson(req, res, { error: (err as Error).message }, 500);
        }
      }
      case '/api/related':
        return sendJson(req, res, { related: indexer.related(url.searchParams.get('id') ?? '') });
      case '/api/search':
        return sendJson(req, res, { ids: indexer.search(url.searchParams.get('q') ?? '') });
      case '/api/instructions': {
        const project = url.searchParams.get('project') ?? '';
        if (!isKnownProject(project)) return sendJson(req, res, { error: 'unknown project' }, 400);
        const info = await instructionsFor(project);
        const globals = globalInstructionFiles().map((f) => ({ path: f, exists: fs.existsSync(f) }));
        return sendJson(req, res, { ...info, globals });
      }
      case '/api/instructions/version': {
        const project = url.searchParams.get('project') ?? '';
        const file = url.searchParams.get('file') ?? '';
        if (url.searchParams.get('global') === '1') {
          if (!globalInstructionFiles().includes(file)) return sendJson(req, res, { error: 'unknown file' }, 400);
          return sendJson(req, res, { content: readGlobal(file), diff: '' });
        }
        if (!isKnownProject(project)) return sendJson(req, res, { error: 'unknown project' }, 400);
        const sha = url.searchParams.get('sha') || undefined;
        return sendJson(req, res, await instructionVersion(project, file, sha));
      }
      case '/api/summarize': {
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        const aiCfg = currentAi();
        if (!aiCfg) return sendJson(req, res, { error: 'AI summaries are not set up. Configure them in Settings.' }, 400);
        const id = url.searchParams.get('id') ?? '';
        const lang = readSettings(cfg.dataDir).ai?.lang ?? url.searchParams.get('lang') ?? 'en';
        const d = await detailOf(id);
        if (!d) return sendJson(req, res, { error: 'not found' }, 404);
        try {
          const ai = await summarizeWithAi(cfg.dataDir, aiCfg, d, lang);
          auto.remember(ai);
          return sendJson(req, res, { ai });
        } catch (err) {
          return sendJson(req, res, { error: aiErrorMessage(err) }, 502);
        }
      }
      case '/api/settings': {
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        const harness = url.searchParams.get('harness') as Agent;
        if (harness) {
          if (!AGENTS.includes(harness)) return sendJson(req, res, { error: 'unknown harness' }, 400);
          const harnesses = { ...indexer.enabled, [harness]: url.searchParams.get('on') !== '0' };
          indexer.setHarnesses(harnesses);
          writeSettings(cfg.dataDir, { harnesses });
          return sendJson(req, res, state());
        }
        const groupBy = url.searchParams.get('groupBy') as GroupBy;
        if (!GROUP_BY.includes(groupBy)) return sendJson(req, res, { error: 'unknown groupBy' }, 400);
        indexer.setGroupBy(groupBy);
        writeSettings(cfg.dataDir, { groupBy });
        return sendJson(req, res, state());
      }
      case '/api/ai/classify':
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        if (url.searchParams.get('wait') === '1') await auto.classify(true);
        else void auto.classify(true);
        return sendJson(req, res, { ...auto.status, categories: auto.categories?.categories ?? [] });
      case '/api/ai/auto/run':
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        if (url.searchParams.get('wait') === '1') return sendJson(req, res, await auto.run());
        void auto.run();
        return sendJson(req, res, auto.status);
      case '/api/settings/ai':
      case '/api/ai/test': {
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        const body = await readJson(req);
        if (!body) return sendJson(req, res, { error: 'JSON body required' }, 400);
        const next = mergeAi(readSettings(cfg.dataDir).ai, body);
        if (p === '/api/ai/test') {
          const c = resolveAi(next, process.env, cfg.aiModel);
          return sendJson(req, res, c ? await testAi(c) : { ok: false, model: next.model ?? '', ms: 0, error: 'Not enough settings: give an address or a key.' });
        }
        writeSettings(cfg.dataDir, { ai: next });
        return sendJson(req, res, state());
      }
      case '/api/rescan': {
        if (req.method !== 'POST') return sendJson(req, res, { error: 'POST required' }, 405);
        if (url.searchParams.get('full') === '1') indexer.clearCache();
        void indexer.scan();
        return sendJson(req, res, { ok: true });
      }
      case '/api/events': {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ gen: indexer.gen, progress: indexer.progress })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      default:
        return sendJson(req, res, { error: 'not found' }, 404);
    }
  }

  function isKnownProject(project: string): boolean {
    if (!project) return false;
    return indexer.summaries().some((s) => s.projectPath === project);
  }

  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      for (const h of ['localhost', '127.0.0.1', '[::1]']) allowedHosts.add(`${h}:${addr.port}`);
    }
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    auto.stop();
  });
  return server;
}

function isAllowedHost(host: string, allowed: Set<string>, bindHost: string): boolean {
  if (allowed.has(host)) return true;
  // When the user explicitly binds to another interface, accept any host header.
  return bindHost !== '127.0.0.1' && bindHost !== 'localhost' && bindHost !== '::1';
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, body: unknown, status = 200): void {
  const json = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const gz = json.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (gz) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(json, { level: 4 }));
  } else {
    res.writeHead(status, headers);
    res.end(json);
  }
}

const staticCache = new Map<string, { body: Buffer; gz?: Buffer; type: string }>();

function serveStatic(webDir: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(webDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(webDir)) {
    res.writeHead(403).end();
    return;
  }
  let hit = staticCache.get(file);
  if (!hit) {
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = fs.readFileSync(file);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    hit = { body, type, gz: /text|javascript|json|svg/.test(type) && body.length > 1024 ? zlib.gzipSync(body) : undefined };
    staticCache.set(file, hit);
  }
  const immutable = rel.startsWith('/assets/');
  const headers: Record<string, string> = {
    'Content-Type': hit.type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (hit.type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";
    headers['Referrer-Policy'] = 'no-referrer';
  }
  if (hit.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers).end(hit.gz);
  } else {
    res.writeHead(200, headers).end(hit.body);
  }
}

/** Applies a settings form: an omitted apiKey keeps the saved one, null or '' clears it. */
export function mergeAi(saved: AiSettings | undefined, body: Record<string, unknown>): AiSettings {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === 'object') {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (/^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string') headers[k] = v;
    }
  }
  const next: AiSettings = {
    enabled: body.enabled !== false,
    provider: body.provider === 'openai' ? 'openai' : 'anthropic',
    baseURL: str(body.baseURL) || undefined,
    model: str(body.model) || undefined,
    auth: body.auth === 'bearer' ? 'bearer' : 'x-api-key',
    apiKeyEnv: str(body.apiKeyEnv) || undefined,
    headers,
    apiKey: body.apiKey === undefined ? saved?.apiKey : str(body.apiKey) || undefined,
    auto: body.auto === undefined ? saved?.auto : body.auto === true,
    lang: body.lang === 'zh-CN' || body.lang === 'en' ? body.lang : saved?.lang,
  };
  if (next.baseURL && !/^https?:\/\//i.test(next.baseURL)) throw new Error('The address must start with http:// or https://');
  return next;
}

/** Reads a small JSON body; only application/json, which browsers can't send cross-site without CORS. */
function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}
