# Log formats

What Loggy reads and how. Neither tool documents these files, and both change them between versions, so the parsers ignore unknown record types and fields. The notes below come from Claude Code 2.1.156 to 2.1.288 and Codex CLI 0.142 to 0.159.

## Claude Code

**Location**

- Main transcripts: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. `$CLAUDE_CONFIG_DIR` replaces `~/.claude` when it is set.
- Subagents: `~/.claude/projects/<encoded-cwd>/<parentSessionId>/subagents/agent-<agentId>.jsonl`. These records also carry `isSidechain: true`.
- The directory name replaces every non-alphanumeric character of the cwd with `-` and can't be reversed. Loggy uses the `cwd` field inside the records instead.

**Records** (one JSON object per line, `type` field):

| type | used for |
|---|---|
| `user` | Human input, injected context (`isMeta`, `isCompactSummary`), or tool results (`toolUseResult`, `tool_result` blocks). Only human input starts a turn. Records that share a `promptId` belong to the same input. |
| `assistant` | `message.id`, `model`, `stop_reason`, `usage`, content blocks (`text`, `thinking`, `tool_use`) |
| `system` | `compact_boundary` (context compaction), `api_error`, `stop_hook_summary`, `turn_duration`, … |
| `custom-title`, `ai-title` | session names |
| `queue-operation`, `last-prompt`, `attachment`, `mode`, `permission-mode`, `file-history-*`, `bridge-session`, `pr-link`, … | metadata, mostly ignored |

**Quirks**

- **One API response becomes several lines**, one per content block, and each line repeats `usage`. Sometimes the repeated values differ as streaming updates arrive. Loggy keeps, per `message.id`, the maximum of each usage component and counts the increase.
- `usage.cache_creation` splits cache writes into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, which have different prices.
- Interrupts appear as a user text starting with `[Request interrupted by user`.
- File changes appear in `toolUseResult`:
  - Edit / Write: `filePath`, `structuredPatch` (hunks with `+`/`-` lines), `type: "create"` and `content` for new files.
  - Bash: `bashEditDiff.files` lists changes made through shell commands.
- Git operations are in `toolUseResult.gitOperation`: `commit {sha, kind, branch?}`, `push {branch}`, `branch`, `pr`.
- `AskUserQuestion`: the questions are in the `tool_use` input; the answers are in `toolUseResult.answers`.
- Background work:
  - Bash results carry `backgroundTaskId`.
  - Agent results carry `isAsync` with `agentId`.
  - Completion arrives later as a `<task-notification>` text.
- `quotaLimits` on some assistant records carries a quota *status*, not percentages. The 5h / 7d percentages are only available to the status line command (`rate_limits.five_hour.used_percentage`, …).
- Claude Code removes transcripts older than `cleanupPeriodDays` (default 30) at startup. Raise that setting if you want a longer history.

## Codex

**Location:** `$CODEX_HOME` (default `~/.codex`)

- `sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`
- `archived_sessions/`
- Older files may be compressed to `.jsonl.zst`. Loggy reads them with Node's built-in zstd.
- `state_<N>.sqlite` is Codex's own index. Loggy doesn't need it.

**Records:** every line is `{timestamp, type, payload}`. Newer versions also add `ordinal`.

| type / payload.type | used for |
|---|---|
| `session_meta` | `id`, `cwd`, `cli_version`, `originator`, `git.branch`, `forked_from_id`. `source` is a string, or an object holding `parent_thread_id` for subagents. |
| `turn_context`, `event_msg/thread_settings_applied` | model |
| `event_msg/task_started` · `task_complete` · `turn_aborted` | turn boundaries (`turn_id`), `model_context_window`, `last_agent_message` |
| `event_msg/item_completed` | `UserMessage`, `AgentMessage`, `FileChange` (`changes` with `unified_diff` or `content`), `CommandExecution` (`command`, `exit_code`, `status`, `aggregated_output`), `McpToolCall`, `ContextCompaction` |
| `event_msg/user_message`, `agent_message` | older equivalents of the items above |
| `event_msg/token_count` | `info.total_token_usage` (cumulative), `last_token_usage`, `rate_limits.primary/secondary {used_percent, window_minutes, resets_at}` |
| `token_usage_record` | `thread_token_usage` (cumulative), newer versions |
| `response_item` | `message`, `reasoning` (encrypted), `function_call` / `custom_tool_call`, outputs |
| `compacted`, `world_state` | compaction marker, environment snapshot |

**Quirks**

- Token counters are **cumulative and sometimes go backwards**, and two record types carry them. Loggy keeps a running maximum per component and counts only the increases.
- `input_tokens` already includes `cached_input_tokens`.
- `primary` is not always the 5-hour window. Identify windows by `window_minutes` (300 or 10080).
- `response_item` messages with role `user` include injected context such as environment and AGENTS.md text. Real user input comes from `UserMessage` items, or `user_message` in older versions.
- Start and end events don't always pair up, because of forks, resumes and interrupted runs. A missing `task_complete` does not by itself mean the session is still running. Loggy also checks how recently the file changed.
- Waiting-for-approval events are not persisted.

## Derived values

| value | definition |
|---|---|
| turn | starts at a human input and ends at the agent's final reply, an interrupt, or the next input |
| agent working time | sum of turn durations |
| waiting for you | gap between the end of a turn and your next input, counted only when under 30 minutes |
| context % | input tokens of the latest request (including cache) ÷ context window |
| cache hit rate | cache reads ÷ (input + cache reads + cache writes) |
| outcome | *stopped midway*: last turn interrupted or unfinished; *leftover*: ended with a question for you, uncommitted edits or pending background work; *done*: otherwise |
| live status | *running*: a turn is open and the file changed in the last 2 minutes; *stalled*: the turn is still open but the file hasn't changed for 2 to 30 minutes; *needs input*: waiting for your answer; *idle*: ended less than 10 minutes ago |
