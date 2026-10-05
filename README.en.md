# Loggy

[简体中文](README.md) · **English**

Loggy is a local dashboard for your **Claude Code** and **Codex** sessions. It reads the logs both tools already write to disk and shows each session as a bar on a week calendar, with a detail view, a timeline of the conversation, a completion check, and efficiency analytics. You don't need to install hooks, change your config, or put anything in your repositories.

![Week calendar with session detail and timeline](docs/images/calendar-zh.png)

## Features

- **Week calendar.** Each session is a bar from its first to its last activity. Shading shows activity per 10 minutes and dots mark your inputs. Overlapping sessions sit side by side. Bars can be colored by status, agent, project, component or model. Zoom with Ctrl + scroll.
- **Session detail.** Shows the project, branch, models, length, inputs, tokens, API-equivalent cost and peak context, plus:
  - **Completion check:** turn ended · not waiting for your reply · no background work · edits committed · work complete
  - **Outcomes:** commits, changed files with +/− lines, questions the agent asked and your answers
  - **Requests:** every request with its status and the commits made while handling it
  - **Turns:** per-turn tokens, cost, context, tool calls and files
- **Timeline.** The conversation as chat bubbles. Tool calls are optional, and `AskUserQuestion` prompts appear as question cards.
- **Live status.** Running sessions update within about 0.1 s of a new log line. Each session is classified as *running*, *stalled* (a tool call has been open for a while, maybe waiting for approval), *needs input*, *done*, *leftover* or *stopped midway*.
- **Efficiency.** The page covers:
  - spend, agent working time, the time the agent spent waiting for you, sessions, commits, lines changed, cache hit rate and peak parallel sessions, each compared with the previous period
  - daily charts and an hour × weekday heatmap
  - a Claude Code vs Codex comparison and a per-project table
  - a "worth a look" list of sessions that burned money without output, ran close to the context limit, looped on tools, or ended with uncommitted edits
- **Usage limits.** Codex 5-hour / 7-day usage comes from its own logs. Claude's usage is available through an optional status-line command (see below).
- **Projects.** Sessions are grouped by git remote, git root or working folder (Settings). The default, smart grouping, uses the remote when it is known (from git or from the Codex log) and also places sessions whose folder has since been deleted.
- **Instructions & Memory.** The git history of `CLAUDE.md` / `AGENTS.md` in each project, with diffs and the number of sessions that ran under each version.
- **Chinese and English UI**, light and dark themes, keyboard navigation (↑/↓ or j/k in the list).
- **Optional AI summaries.** Click a button to get a title, bullets, decisions and a per-request status. These are generated only when you click and only if `ANTHROPIC_API_KEY` is set.

| Efficiency | Session list (dark) |
|---|---|
| ![Efficiency page with KPIs, daily charts and per-project table](docs/images/efficiency-en.png) | ![Session list with detail and timeline](docs/images/sessions-en-dark.png) |

| Calendar colored by project (dark) | Timeline with tool calls and a question card |
|---|---|
| ![Week calendar colored by project](docs/images/projects-en-dark.png) | ![Session detail with commits, changed files and a timeline of tool calls](docs/images/timeline-en.png) |

Project grouping in Settings:

![Settings: project grouping options](docs/images/settings-zh.png)

## Install and run

Requires **Node.js 22.12+** (22.15+ to read compressed `.jsonl.zst` Codex logs).

```sh
# run once without installing
npx --yes https://github.com/EricJiang0423/Loggy/releases/download/v0.5.1/loggy-0.5.1.tgz

# or install the `loggy` command
npm install -g https://github.com/EricJiang0423/Loggy/releases/download/v0.5.1/loggy-0.5.1.tgz
loggy
```

Loggy opens `http://127.0.0.1:4317` in your browser. The first run indexes every log, which takes a few seconds for several GB. Later runs start from a cache in `~/.loggy`. To try it without your own data, run `loggy --demo`.

From source:

```sh
git clone https://github.com/EricJiang0423/Loggy.git && cd Loggy
npm ci && npm run build && npm start
```

### Options

```
loggy [--port 4317] [--host 127.0.0.1] [--no-open] [--demo] [--rebuild]
      [--claude-dir <dir>]... [--codex-dir <dir>]... [--data-dir <dir>] [--ai-model <id>]
loggy statusline
```

By default Loggy reads `$CLAUDE_CONFIG_DIR` and `~/.claude/projects`, and `$CODEX_HOME` or `~/.codex/sessions` plus `archived_sessions`. Pass `--claude-dir` / `--codex-dir` more than once to include several accounts.

### Claude 5-hour / 7-day usage (optional)

Claude Code doesn't write its usage limits into the transcripts. It does pass them to the status line command, so you can make Loggy your status line in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "loggy statusline" } }
```

It prints a short line (`Opus 5.5 · 5h 23% · 7d 41%`) and records the numbers in `~/.loggy/statusline.jsonl`, where the dashboard picks them up.

### AI summaries (optional)

Start Loggy with `ANTHROPIC_API_KEY` set to enable the **Generate AI summary** button. Only the session you click is sent, as a compact transcript: your requests, the agent's final replies, tool names, file paths and commit messages. Results are cached in `~/.loggy/summaries`. The default model is `claude-haiku-4-5`; change it with `--ai-model` or `LOGGY_AI_MODEL`.

### Prices

Costs are **API-equivalent estimates** from a built-in price table. Subscription plans are not billed per token. The table uses list prices for Claude, OpenAI, GLM, DeepSeek, Kimi and MiMo models (short-context rates; DeepSeek at its peak rate). OpenAI models without a published price, such as `codex-auto-review`, use an estimate, and models it doesn't know use Sonnet rates. To override prices, create `~/.loggy/pricing.json`, for example `{ "gpt-5.5-codex": { "input": 1.25, "output": 10, "cacheRead": 0.125 } }`, in USD per million tokens. Keys match model names exactly or by substring.

## How it works

```
~/.claude/projects/**.jsonl ─┐                       ┌─ /api/sessions (deltas)
~/.codex/sessions/**.jsonl ──┼─> worker threads ───> index (memory + ~/.loggy cache) ─┼─ /api/session (detail)
fs.watch + polling ──────────┘   parse, resume                                        └─ SSE "update" ─> browser
```

- **Parsing** runs in worker threads, so the UI stays responsive while thousands of files are read. Codex rollouts can be very large, so each line is classified from its first bytes and only the records Loggy needs are JSON-parsed.
- **Incremental.** A file that grew is parsed from its previous end offset using the saved parser state. Unchanged files come from the cache.
- **Log formats.** The notes in [docs/log-formats.md](docs/log-formats.md) cover several real quirks:
  - Claude Code writes one line per content block with the same `usage`, so Loggy de-duplicates by `message.id`.
  - Codex token counters are cumulative and can go backwards.
  - Subagent logs live in their own files.
- **Privacy.** The server listens on `127.0.0.1` only, rejects foreign `Host` headers, and makes no network requests except AI summaries you ask for.

Measured on a 4-core container with 1,116 synthetic sessions (523 MB): a cold index took 3.9 s, a warm start 0.35 s, a new log line showed up in the UI 0.1 s after it was written, and a session detail loaded in 50 ms. Run `npm run perf` to reproduce.

## Development

```sh
npm run dev          # rebuild the server on change
npx vite web         # UI dev server with hot reload (proxies /api to :4317)
npm run typecheck && npm test
npm run build && npm run e2e   # Chromium end-to-end check with screenshots in artifacts/
npm run perf         # performance check on generated data
```

Tests use generated logs only (`src/server/demo.ts`). No real transcripts are stored in this repository.

## Credits

Inspired by a session calendar that [@tokkyo](https://x.com/tokkyo) showed on X. Loggy is an independent implementation.

## License

[MIT](LICENSE)
