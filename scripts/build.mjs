// Builds the server bundle (dist/cli.mjs, dist/worker.mjs) and the web UI (dist/web).
import { build, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const serverOnly = process.argv.includes('--server-only');

const options = {
  entryPoints: { cli: path.join(root, 'src/server/cli.ts'), worker: path.join(root, 'src/server/worker.ts') },
  outdir: path.join(root, 'dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  chunkNames: '[name]-[hash]',
  sourcemap: false,
  minify: true,
  legalComments: 'linked',
  define: { __LOGGY_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
};

for (const f of fs.existsSync(path.join(root, 'dist')) ? fs.readdirSync(path.join(root, 'dist')) : []) {
  if (f.endsWith('.mjs') || f.endsWith('.LEGAL.txt')) fs.rmSync(path.join(root, 'dist', f));
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching server sources...');
} else {
  await build(options);
  const cli = path.join(root, 'dist/cli.mjs');
  fs.writeFileSync(cli, '#!/usr/bin/env node\n' + fs.readFileSync(cli, 'utf8'));
  fs.chmodSync(cli, 0o755);
  if (!serverOnly) await viteBuild({ configFile: path.join(root, 'web/vite.config.ts'), logLevel: 'warn' });
  console.log('built dist/');
}
