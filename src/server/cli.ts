// `loggy` command line entry.

import {
  DEFAULT_AI_MODEL,
  DEFAULT_PORT,
  defaultClaudeDirs,
  defaultCodexDirs,
  defaultDataDir,
  defaultPiDirs,
  type Config,
} from './config.js';

declare const __LOGGY_VERSION__: string;
const VERSION = typeof __LOGGY_VERSION__ === 'string' ? __LOGGY_VERSION__ : '0.0.0-dev';

const HELP = `Loggy ${VERSION} - local dashboard for Claude Code, Codex and Pi sessions

Usage
  loggy [options]            start the dashboard (default http://127.0.0.1:${DEFAULT_PORT})

Options
  --port <n>                 port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)
  --host <addr>              interface to bind (default 127.0.0.1)
  --no-open                  do not open the browser
  --claude-dir <dir>         Claude config dir containing projects/ (repeatable;
                             default $CLAUDE_CONFIG_DIR and ~/.claude)
  --codex-dir <dir>          Codex home containing sessions/ (repeatable; default $CODEX_HOME or ~/.codex)
  --pi-dir <dir>             Pi session dir (repeatable; default $PI_CODING_AGENT_SESSION_DIR,
                             $PI_CODING_AGENT_DIR/sessions, or ~/.pi/agent/sessions)
  --data-dir <dir>           where Loggy keeps its cache (default $LOGGY_HOME or ~/.loggy)
  --ai-model <id>            model for optional AI summaries (default ${DEFAULT_AI_MODEL})
  --rebuild                  ignore the cache and parse every log again
  --demo                     run with generated sample data instead of your logs
  -v, --version              print the version
  -h, --help                 show this help

Loggy only reads your logs. It listens on localhost and sends nothing anywhere, except
AI summaries you request explicitly (set up in Settings, or ANTHROPIC_API_KEY).
`;

function parseArgs(argv: string[]): Config & { help: boolean; showVersion: boolean } {
  const cfg: Config & { help: boolean; showVersion: boolean } = {
    port: Number(process.env.LOGGY_PORT ?? DEFAULT_PORT),
    host: '127.0.0.1',
    open: true,
    demo: false,
    rebuild: false,
    claudeDirs: [],
    codexDirs: [],
    piDirs: [],
    dataDir: defaultDataDir(),
    aiModel: process.env.LOGGY_AI_MODEL ?? DEFAULT_AI_MODEL,
    version: VERSION,
    help: false,
    showVersion: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--port':
        cfg.port = Number(next());
        break;
      case '--host':
        cfg.host = next();
        break;
      case '--no-open':
        cfg.open = false;
        break;
      case '--claude-dir':
        cfg.claudeDirs.push(next());
        break;
      case '--codex-dir':
        cfg.codexDirs.push(next());
        break;
      case '--pi-dir':
        cfg.piDirs.push(next());
        break;
      case '--data-dir':
        cfg.dataDir = next();
        break;
      case '--ai-model':
        cfg.aiModel = next();
        break;
      case '--rebuild':
        cfg.rebuild = true;
        break;
      case '--demo':
        cfg.demo = true;
        break;
      case '-h':
      case '--help':
        cfg.help = true;
        break;
      case '-v':
      case '--version':
        cfg.showVersion = true;
        break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error('Invalid --port');
  if (!cfg.claudeDirs.length) cfg.claudeDirs = defaultClaudeDirs();
  if (!cfg.codexDirs.length) cfg.codexDirs = defaultCodexDirs();
  if (!cfg.piDirs.length) cfg.piDirs = defaultPiDirs();
  return cfg;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (cfg.help) {
    process.stdout.write(HELP);
    return;
  }
  if (cfg.showVersion) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const { start } = await import('./app.js');
  await start(cfg);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
