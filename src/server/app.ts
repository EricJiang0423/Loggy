import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Price } from '../core/pricing.js';
import { ensureDir, type Config } from './config.js';
import { generateDemo, makeDemoRepos, tickDemo } from './demo.js';
import { Indexer } from './indexer.js';
import { Pool } from './pool.js';
import { readSettings } from './settings.js';
import { createServer } from './server.js';

export interface Running {
  url: string;
  close: () => Promise<void>;
  indexer: Indexer;
}

export async function start(cfg: Config, opts: { quiet?: boolean; workerUrl?: URL | null; autoSummaries?: boolean } = {}): Promise<Running> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.join(here, 'web');
  ensureDir(cfg.dataDir);
  let demoTimer: NodeJS.Timeout | undefined;
  if (cfg.demo) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-demo-'));
    const projectsRoot = path.join(root, 'work');
    const exps = generateDemo(root, { projectsRoot });
    makeDemoRepos(projectsRoot, exps);
    cfg.claudeDirs = [path.join(root, 'claude')];
    cfg.codexDirs = [path.join(root, 'codex')];
    cfg.kimiDirs = [path.join(root, 'kimi')];
    cfg.dataDir = ensureDir(path.join(root, 'data'));
    demoTimer = setInterval(() => tickDemo(exps), 4000);
    demoTimer.unref();
  }
  const workerUrl = opts.workerUrl === null ? undefined : (opts.workerUrl ?? new URL('./worker.mjs', import.meta.url));
  const pool = new Pool(workerUrl);
  const prices = loadPrices(cfg.dataDir);
  if (prices) await pool.broadcast({ kind: 'prices', table: prices });
  const indexer = new Indexer({ claudeDirs: cfg.claudeDirs, codexDirs: cfg.codexDirs, kimiDirs: cfg.kimiDirs ?? [] }, pool, cfg.dataDir);
  const saved = readSettings(cfg.dataDir);
  indexer.groupBy = saved.groupBy ?? 'smart';
  indexer.setHarnesses(saved.harnesses ?? {}, false);
  if (cfg.rebuild) indexer.clearCache();
  else indexer.loadCache();

  const server = createServer(cfg, indexer, pool, webDir, { autoSummaries: opts.autoSummaries });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : cfg.port;
  const url = `http://${cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host}:${port}`;
  const log = (m: string) => {
    if (!opts.quiet) console.log(m);
  };
  log(`Loggy ${cfg.version} running at ${url}${cfg.demo ? '  (demo data)' : ''}`);
  if (!cfg.demo) {
    for (const d of cfg.claudeDirs) log(`  Claude Code logs: ${path.join(d, 'projects')}${fs.existsSync(path.join(d, 'projects')) ? '' : '  (not found)'}`);
    for (const d of cfg.codexDirs) log(`  Codex logs:       ${path.join(d, 'sessions')}${fs.existsSync(path.join(d, 'sessions')) ? '' : '  (not found)'}`);
    for (const d of cfg.kimiDirs ?? []) if (fs.existsSync(path.join(d, 'sessions'))) log(`  Kimi Code logs:   ${path.join(d, 'sessions')}`);
  }
  log('  Press Ctrl+C to stop.');

  const scanStart = Date.now();
  indexer.once('progress', () => undefined);
  void indexer.scan().then(() => {
    const p = indexer.progress;
    log(`  Indexed ${indexer.entries.size} sessions (${p.filesTotal} parsed) in ${((Date.now() - scanStart) / 1000).toFixed(1)}s`);
  });
  indexer.watch();
  if (cfg.open) openBrowser(url);

  const close = async () => {
    if (demoTimer) clearInterval(demoTimer);
    indexer.close();
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.(); // an open page keeps its event stream (and the server) alive
    await closed;
    await pool.close();
  };
  const onSignal = () => {
    void close().finally(() => process.exit(0));
  };
  if (!opts.quiet) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  return { url, close, indexer };
}

function loadPrices(dataDir: string): Record<string, Price> | undefined {
  const file = path.join(dataDir, 'pricing.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[loggy] ignoring ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No browser available; the URL is printed above.
  }
}
