// Performance check on a large synthetic data set.
//   node scripts/perf.mjs [--sessions 1000] [--bulk 12]
// Measures: cold index time, warm start (cache), live update latency after a log append,
// and API response times. Requires `npm run build` first.
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const sessions = arg('--sessions', 1000);
const bulk = arg('--bulk', 12);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-perf-'));

const demoBundle = path.join(tmp, 'demo.mjs');
await build({ entryPoints: [path.join(root, 'src/server/demo.ts')], bundle: true, platform: 'node', format: 'esm', outfile: demoBundle, logLevel: 'error' });
const { generateDemo } = await import(pathToFileURL(demoBundle).href);

let t = Date.now();
const exps = generateDemo(path.join(tmp, 'data'), { sessions, bulk, seed: 3, days: 60 });
const bytes = exps.reduce((n, e) => n + fs.statSync(e.file).size, 0);
console.log(`generated ${exps.length} files, ${(bytes / 1024 / 1024).toFixed(0)} MB in ${((Date.now() - t) / 1000).toFixed(1)}s`);

function startServer() {
  const child = spawn(
    process.execPath,
    [path.join(root, 'dist/cli.mjs'), '--no-open', '--port', '0', '--claude-dir', path.join(tmp, 'data/claude'), '--codex-dir', path.join(tmp, 'data/codex'), '--data-dir', path.join(tmp, 'loggy')],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let buf = '';
    let url;
    const timer = setTimeout(() => reject(new Error(buf)), 600_000);
    child.stdout.on('data', (d) => {
      buf += d;
      url ??= /running at (http:\/\/\S+)/.exec(buf)?.[1];
      const m = /Indexed (\d+) sessions \((\d+) parsed\) in ([\d.]+)s/.exec(buf);
      if (url && m) {
        clearTimeout(timer);
        resolve({ child, url, ms: Date.now() - started, parsed: Number(m[2]), listenMs: undefined });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
  });
}

async function timed(url) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
  const body = await res.arrayBuffer();
  return { ms: performance.now() - t0, kb: body.byteLength / 1024 };
}

const cold = await startServer();
console.log(`cold index: ${cold.parsed} files in ${(cold.ms / 1000).toFixed(2)}s (${((bytes / 1024 / 1024) / (cold.ms / 1000)).toFixed(0)} MB/s)`);
const list = await timed(`${cold.url}/api/sessions`);
console.log(`GET /api/sessions: ${list.ms.toFixed(0)} ms, ${list.kb.toFixed(0)} KB`);
const ids = (await (await fetch(`${cold.url}/api/sessions`)).json()).sessions;
const big = ids.sort((a, b) => b.toolCalls - a.toolCalls)[0];
const d1 = await timed(`${cold.url}/api/session?id=${encodeURIComponent(big.id)}`);
const d2 = await timed(`${cold.url}/api/session?id=${encodeURIComponent(big.id)}`);
console.log(`GET /api/session (largest, ${big.toolCalls} tool calls): first ${d1.ms.toFixed(0)} ms, cached ${d2.ms.toFixed(0)} ms, ${d1.kb.toFixed(0)} KB`);
const s = await timed(`${cold.url}/api/search?q=calendar`);
console.log(`GET /api/search: ${s.ms.toFixed(0)} ms`);

// Live update latency: append to a session file and wait for the generation to change.
const target = exps.find((e) => e.agent === 'claude' && !e.subagent);
const genBefore = (await (await fetch(`${cold.url}/api/state`)).json()).generation;
const line = JSON.stringify({ type: 'user', uuid: 'perf', timestamp: new Date().toISOString(), promptId: 'perf-p', sessionId: target.sessionId, cwd: '/x', isSidechain: false, message: { role: 'user', content: 'live update check' } });
t = performance.now();
fs.appendFileSync(target.file, line + '\n');
let liveMs = -1;
for (let i = 0; i < 400; i++) {
  const g = (await (await fetch(`${cold.url}/api/state`)).json()).generation;
  if (g !== genBefore) {
    liveMs = performance.now() - t;
    break;
  }
  await new Promise((r) => setTimeout(r, 10));
}
console.log(`live update visible after ${liveMs.toFixed(0)} ms`);
cold.child.kill();
await new Promise((r) => setTimeout(r, 500));

const warm = await startServer();
console.log(`warm start (from cache): ${warm.parsed} files parsed, ready in ${(warm.ms / 1000).toFixed(2)}s`);
warm.child.kill();
fs.rmSync(tmp, { recursive: true, force: true });
