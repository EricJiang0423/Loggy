# Changelog

## Unreleased

### Added

- **Claude Code rewind support.** A rewind (or continuing in a new session) forks the conversation into a new file that starts with a copy of the old one. Loggy now shows the files as one session, counts the copied part once, and marks the turns the rewind took back.

- **Automatic AI summaries.** Turn them on in Settings → AI summaries: every session of the last 7 days gets a summary, and a session that changes is summarized again at most once a day (running sessions wait until they stop). The list shows the summary title and the next step.
- **One summary layout** for every model: title, what happened, decisions, not verified, concerns, open questions, next steps, request status, a fixed work type and whether the work is complete, in the language chosen in Settings. Older summaries are replaced on the next run.
- **Timeline views:** all, without intermediate output (your inputs and each turn's last reply), or only your inputs. Inputs are numbered, and question cards mark the chosen answer.

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
