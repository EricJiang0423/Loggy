# Changelog

## 0.9.0 - 2026-10-08

### Added

- **SSH hosts.** Settings → Remote hosts & cloud lists the SSH hosts set up in the Claude and Codex desktop apps, and you can add your own (`user@host` or an ssh alias). A host you turn on is pulled with rsync every 2 minutes (Claude Code `projects/`, Codex `sessions/`, `archived_sessions/` and thread names) into `~/.loggy/remote/<host>/`, indexed like local logs, and each session shows the host it ran on. The host must accept your key without a password; a failed sync shows its error next to the host. Detected hosts start off.
- **Codex Cloud tasks.** Turned on in the same card, Loggy reads `codex cloud list` every 10 minutes with your Codex login and shows each task as a session: title, status, changed lines and link, grouped with the local clone when the environment is named `owner/repo`. A failed request is tried twice more.
- Sessions the Claude app keeps a local copy of while running over SSH (`projects/ssh-<id>`) are labeled SSH, or with the host's name once that host is synced.

### Fixed

- Pasting a `codex://threads/<id>` link or a log path into the search box finds that session (it searches by the id inside).

## 0.8.0 - 2026-10-07

### Added

- **Pi sessions** (contributed by @KaiOnCode, #2). Loggy reads `~/.pi/agent/sessions` (or `$PI_CODING_AGENT_SESSION_DIR`) next to the other harnesses: `--pi-dir` points at another session directory. Turns, tokens, models, tool calls, diffs, compactions, interrupts and failed requests come from the session entries; `session_info` gives the title. Since Pi writes no git metadata, commits come from the `[branch sha] message` line a `git commit` prints and the branch is read from the repository on disk. A session made with `/fork` or `/clone` is shown as one session with its parent, the way continued Codex threads are. Agent filters, the calendar legend, the comparison table, the demo data and `docs/log-formats.md` cover Pi as well. Pi sessions also record their thinking level as a harness setting, match quiet commits by time, and resume with `pi --session <id>`.
- **Only the harnesses on this machine.** Loggy checks for each harness's logs, its command-line tool and its desktop app. Settings lists only those it found (and names the others once), and the handoff only offers tools that are installed; filters and comparisons already follow the sessions there are.
- **Hand off to a new conversation in one click** and split hints for long sessions (see the README).

## 0.7.0 - 2026-10-07

### Added

- **Kimi Code support.** Loggy reads the event logs in `~/.kimi-code/sessions` (or `$KIMI_CODE_HOME`, or `--kimi-dir`): sessions and subagents, tokens and equivalent cost (context windows from Kimi's `config.toml`), edited files, commits, the timeline, questions, interrupts and compactions. A session with an open approval or question shows *needs input*. Titles follow renames in Kimi Code, and the detail view offers `kimi --resume`.
- **Harness settings.** Every turn records the settings it ran with: permission mode, reasoning effort, model, plan mode, sandbox (Codex), multi-agent (Codex), swarm mode and goal (Kimi Code), fast mode (Claude Code) and where it was started. The session detail shows them with a log of switches, the efficiency page sums them up per harness (share of turns, number of switches), and the session list can be filtered by any setting.
- **Choose your harnesses.** The sessions and efficiency pages take any combination of Claude Code, Codex and Kimi Code. Settings → Data sources can turn a harness off; it is then not indexed or counted anywhere.
- **Git page finds repositories on its own.** Besides projects whose folder is a repository, it lists the local clone of a project grouped by its remote (for example sessions started in a parent folder that only named the repo in a PR link): Loggy looks for a repository with that remote in and up to two levels below the folders the sessions ran in. Commits are matched to every session of the project.
- **Handoffs between conversations.** *Copy handoff* writes a prompt to continue a session in a new conversation in Claude Code or Codex. A first prompt that names exactly one other session links the two, and the detail suggests splitting after two compactions, an overnight resume or several tasks.

### Changed

- **Summaries in the chosen language.** The language rule is part of the system prompt and repeated after the transcript; an answer in another language is asked for once more and never saved if it is still wrong. Summaries saved earlier in the wrong language are redone, and smart category names are checked the same way. A session whose summary failed is retried after a day instead of every hour.
- The comparison on the efficiency page covers every harness.
- Smart grouping places Codex threads by folder like Claude sessions: a thread run outside its Codex app project's folders counts as in the first one, and the dated folders of project-less chats form one group. Codex auto-approval review threads are subagents of the thread they review.

### Fixed

- Sessions started in a plain folder that holds several repositories (for example a work folder with two project clones below it) keep the repository they recorded instead of all joining the last one.
- The Git page no longer fails on a repository with a broken branch name (such as an iCloud conflict copy `main 2`) or with objects that are not on disk (partial clones, files still in iCloud): it never fetches from the network, shows the list without line counts when they cannot be read in 15 s, and caches the list until a branch moves.

## 0.6.1 - 2026-10-07

### Fixed

- **Git page: commits made with `git commit -q` now show the session that made them.** A quiet commit prints no commit id, so Loggy could not tell which session made it and the commit graph stayed gray on real repositories. Loggy now also records when each session ran `git commit` and matches commits in the same repository by time. The per-turn list puts these commits under the turn that was running.

## 0.6.0 - 2026-10-06

### Added

- **Claude Code rewind support.** A rewind (or continuing in a new session) forks the conversation into a new file that starts with a copy of the old one. Loggy now shows the files as one session, counts the copied part once, and marks the turns the rewind took back.

- **Automatic AI summaries.** Turn them on in Settings → AI summaries: every session of the last 7 days gets a summary, and a session that changes is summarized again at most once a day (running sessions wait until they stop). The list shows the summary title and the next step.
- **One summary layout** for every model: title, what happened, decisions, not verified, concerns, open questions, next steps, request status, a fixed work type and whether the work is complete, in the language chosen in Settings. Older summaries are replaced on the next run.
- **Timeline views:** all, without intermediate output (your inputs and each turn's last reply), or only your inputs. Inputs are numbered, and question cards mark the chosen answer.

- **Smart categories (AI).** After the automatic summaries, the model says what each project is doing, groups the projects into 4–8 categories and puts every recent session in one, reusing earlier names so colors stay stable. Color the calendar by *AI category* (it replaces *Component*, which overlapped with projects).
- **Codex app names and projects.** Codex sessions use the thread name from the Codex app (the latest rename), and smart grouping puts a thread in the project you chose for it in the Codex app.
- **Session detail:** category and refusal badges, the make-up of the last request's context, an estimated output speed, and *Related sessions* (sessions that edited the same files). The efficiency page lists output speed per model.

- **Stars, labels and notes.** Star a session, label it discussing / in progress / later / done, and keep a note; filter by them in *Options*. Kept in `~/.loggy/marks.json`.
- **Instant live status for Claude Code.** Loggy reads `~/.claude/sessions/<pid>.json`, so a session waiting for approval or an answer shows *needs input* right away instead of *stalled* after two minutes.

- **Git page** (Dev → Git): the commit graph of all local branches, each commit's dot in the color of the session that made it. Select a commit to see its message, changed files and diff, and that session turn by turn with the commits each turn made. Search by message, filter by path, and see lines of code per top-level folder over time (cached per file content).

### Fixed

- The AI summary no longer disappears and comes back while a running session updates.
- Coloring by project gives colors to the busiest projects of the week shown, so most of the week is no longer gray.
- The session list and detail no longer take seconds to load when session folders sit on a slow or network mount (folder checks during project grouping are done once per folder), and indexing no longer stalls on transcripts whose first record is very large.
- Ctrl+C no longer hangs while a browser tab has Loggy open.

### Removed

- Usage meters (Codex and Claude 5h / 7d), the `/api/usage` endpoint and the `loggy statusline` command.

## 0.5.2 - 2026-10-06

### Added

- **AI summary settings** (Settings → AI summaries): Anthropic Messages or OpenAI-compatible format, address, model, API key (stored, or read from a named environment variable), bearer or x-api-key auth, extra headers, and a *Test connection* button. This lets you use a model your company deploys. Settings are saved in `~/.loggy/settings.json` with owner-only permissions, and the key is never sent back to the browser.

### Changed

- **Flatter, tidier UI.** No rounded corners; sections are set apart by headings and spacing instead of boxes. Switches, status filters and navigation share one underlined style; selects size to their content; the two rarely used session filters moved into an *Options* menu; the calendar header is grouped into week navigation, color-by and zoom (with the zoom level shown).
- The default README is now Chinese (`README.md`); the English one is `README.en.md`.

## 0.5.1 - 2026-10-05

Fixes found by running Loggy on a full set of real Claude Code and Codex logs.

### Added

- **Project grouping options** in Settings: smart (default), repository, git root or folder.
  - Smart grouping uses the git remote when it is known, from the repository on disk, the Codex log or a Claude PR link, so clones and worktrees of one repository are one project.
  - Sessions whose folder was deleted join the project of the same folder or a parent folder, and subagents follow their parent.
  - Projects that share a name show their owner or parent folder.
- **Prices** for GLM, DeepSeek, Kimi, MiMo and current OpenAI models, from their official price lists. Before, these models were priced as Claude Sonnet or as a generic GPT estimate.

### Fixed

- **Codex token counts and costs:**
  - Subagents, forks and continued threads no longer count the totals they inherit from the parent thread. On the test machine these had inflated Codex tokens by about 40%.
  - A token counter that restarts after a resume is no longer undercounted.
  - `token_usage_record` is no longer mixed with `token_count`.
- **Codex threads continued in a new rollout file** show up as one session with all their turns. Before, only the newest file was shown.
- **Codex times:** turn start comes from the record time. `task_started.started_at` can be hours off and pushed sessions into the future.
- **Codex inputs:** the same message sent twice in a long turn counts as two inputs.
- **Codex peak context** is measured against the window of the model that made each request, not the last model's window.
- **Claude background tasks** finished while the agent was busy are recognized. Before, most sessions with background work were marked *leftover*.
- **Claude live status:**
  - a request that ends in an API error (rate limit, overload, login) ends the turn instead of showing *running* / *stalled*
  - work that resumes after the turn ended (for example on a task notification) shows as *running* again
  - a `refusal` ends the turn
- **Claude outcomes:** subagents whose last reply has no `stop_reason`, and sessions continued in another session, are no longer *stopped midway*.
- **Subagent outcomes:** a subagent's edits that its parent session committed afterwards no longer mark the subagent *leftover*.
- **Session detail** always shows the current live status and project, even when the detail itself comes from the cache.
- **Claude tokens:** a `message.id` that reappears much later is no longer counted twice.
- **Context %:** Opus 5, Sonnet 5 and Fable sessions are measured against 1M tokens even when they stayed below 200K.
- **Efficiency page:** changes are compared with the previous period only when the logs cover all of it, and empty sessions no longer stretch *All time* back to 1970.
- **Calendar legend:** projects without their own color share one *Other* entry, so the legend no longer pushes the calendar down.

## 0.5.0 - 2026-10-03

First public release.

### Added

- Local web dashboard for Claude Code and Codex sessions, read straight from their logs. No hooks or configuration changes are needed.
- **Sessions:** week calendar (canvas, 10-minute activity shading, input dots, color by status, agent, project, component or model), a virtualized list, filters, search, and keyboard navigation.
- **Session detail:**
  - completion check: turn ended, not waiting for a reply, no background work, committed, work complete
  - commits, changed files with line counts, questions and answers
  - per-request status and a per-turn table
  - efficiency block and a copy button for the resume command
- **Timeline** of the conversation, with optional tool calls.
- **Live updates:** file watching plus incremental parsing that resumes from the last offset, pushed to the browser over server-sent events.
- **Efficiency page:**
  - KPIs compared with the previous period
  - daily spend by agent, agent working time vs. time it waited for you, an hour × weekday heatmap, and peak parallel sessions
  - Claude Code vs. Codex comparison, a per-project table, and a list of sessions worth a look
- **Usage limits:** Codex 5h / 7d from the rollout logs; Claude through the optional `loggy statusline` command.
- **Instructions & Memory:** git history and diffs of `CLAUDE.md` / `AGENTS.md`.
- **Optional AI summaries** (Anthropic API, generated on request and cached locally).
- Chinese and English UI, light and dark themes.
- `--demo` mode with generated data, an end-to-end browser check (`npm run e2e`) and a performance benchmark (`npm run perf`).
