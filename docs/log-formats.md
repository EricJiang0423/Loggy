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
| `queue-operation`, `attachment` (`queued_command`) | input queued while the agent was busy, including background-task notifications |
| `continued-in` | `continuedInSessionId`: the conversation moved to another session |
| `last-prompt`, `mode`, `permission-mode`, `file-history-*`, `bridge-session`, `pr-link`, other `attachment` types, … | metadata, mostly ignored |

**Quirks**

- **One API response becomes several lines**, one per content block, and each line repeats `usage`. Sometimes the repeated values differ as streaming updates arrive, and a `message.id` can reappear dozens of records later. Loggy keeps, per `message.id`, the maximum of each usage component and counts the increase.
- Subagent transcripts often end with a text reply whose `stop_reason` is never filled in.
- When Claude Code gives up on a request (rate limit, overload, expired login) it writes an assistant record with `isApiErrorMessage: true`, model `<synthetic>` and the error text. The turn ends there.
- The context window is not recorded. In Claude Code the Opus 5, Sonnet 5 and Fable models run with 1M tokens; `compact_boundary.compactMetadata.preTokens` shows where auto-compaction kicked in.
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
  - Completion arrives later as a `<task-notification>` text: as a user record when the agent was idle, otherwise only in `queue-operation` (`content`) and `attachment` / `queued_command` (`prompt`) records.
- `quotaLimits` on some assistant records carries a quota *status*, not percentages. The 5h / 7d percentages are only available to the status line command (`rate_limits.five_hour.used_percentage`, …).
- Claude Code removes transcripts older than `cleanupPeriodDays` (default 30) at startup. Raise that setting if you want a longer history.

## Codex

**Location:** `$CODEX_HOME` (default `~/.codex`)

- `sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`
- `archived_sessions/`
- Older files may be compressed to `.jsonl.zst`. Loggy reads them with Node's built-in zstd.
- A thread can continue in a new rollout file. Its `session_meta.id` is the thread id (not the id in the file name) and `history_base {thread_id, end_ordinal_exclusive, end_byte_offset}` points to the previous file. Loggy shows all files of a thread as one session.
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
| `token_usage_record` | `thread_token_usage` (cumulative), newer versions. Repeats `token_count`, so Loggy doesn't count it. |
| `response_item` | `message`, `reasoning` (encrypted), `function_call` / `custom_tool_call`, outputs |
| `compacted`, `world_state` | compaction marker, environment snapshot |

**Quirks**

- Token counters are **cumulative**:
  - Subagents, forks and continued threads start from the parent's totals. Only `last_token_usage` of the first `token_count` in a file belongs to that file.
  - After a resume the counter can restart near zero. Loggy treats a drop below half as a restart and keeps counting from there.
  - Smaller drops are noise. Loggy keeps a running maximum per component and counts only the increases.
- `task_started.started_at` can be hours away from the record's own `timestamp`. Loggy uses the record time.
- Newer versions report each input twice, as a `UserMessage` item and a `user_message` event at the same moment. The same text sent again later is a new input.
- `model_context_window` changes when the model changes, so the peak context % is measured per request.
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
