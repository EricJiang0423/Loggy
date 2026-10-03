# Changelog

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
