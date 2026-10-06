# Log formats

What Loggy reads and how. Claude Code, Codex and Kimi Code do not document their files and change them between versions, so those parsers ignore unknown record types and fields; Pi does document its format, and its parser follows that document. The notes below come from Claude Code 2.1.156 to 2.1.288, Codex CLI 0.142 to 0.159, Kimi Code 2.0 (wire protocol 1.5) and Pi 0.99.

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
| `pr-link` | `prUrl`, `prRepository`: a pull request the session opened, which also names its repository |
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
- `quotaLimits` on some assistant records carries a quota *status*, not percentages. Loggy doesn't use it.
- **Rewind forks the conversation.** A rewind (and continuing in a new session) creates a new transcript that starts with a copy of the records up to that point: same `uuid` and `timestamp`, the new `sessionId`. The new records continue from the last copy (`parentUuid`). The old file keeps everything, including the turns that were rewound. Files whose first record has the same `uuid` are one conversation; Loggy skips the copies and marks the rewound turns.
- **Running processes** write `~/.claude/sessions/<pid>.json` with `sessionId`, `status` (`busy`, `waiting` for approval or an answer, `idle`), `statusUpdatedAt` and more. The file can outlive the process, so check that the pid is alive.
- Claude Code removes transcripts older than `cleanupPeriodDays` (default 30) at startup. Raise that setting if you want a longer history.

## Codex

**Location:** `$CODEX_HOME` (default `~/.codex`)

- `sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`
- `archived_sessions/`
- Older files may be compressed to `.jsonl.zst`. Loggy reads them with Node's built-in zstd.
- A thread can continue in a new rollout file. Its `session_meta.id` is the thread id (not the id in the file name) and `history_base {thread_id, end_ordinal_exclusive, end_byte_offset}` points to the previous file. Loggy shows all files of a thread as one session.
- `state_<N>.sqlite` is Codex's own index. Loggy doesn't need it.
- `session_index.jsonl`: `{id, thread_name, updated_at}` per line. A rename appends a line, so the latest `updated_at` per id is the current thread name.
- `.codex-global-state.json` (Codex app): `local-projects` (`{id, name, rootPaths}`) and `thread-project-assignments` (`thread id -> {projectId}`) are the projects the user put threads in. Several projects can share a root folder, so the folder alone doesn't tell the project.

**Records:** every line is `{timestamp, type, payload}`. Newer versions also add `ordinal`.

| type / payload.type | used for |
|---|---|
| `session_meta` | `id`, `cwd`, `cli_version`, `originator`, `git.branch`, `git.repository_url`, `forked_from_id`. `source` is a string, or an object holding `parent_thread_id` for subagents. |
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

## Pi

Pi documents this format in `docs/session-format.md` of [earendil-works/pi](https://github.com/earendil-works/pi); the parser follows that document and ignores record types it does not know.

**Location**

- `~/.pi/agent/sessions/--<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. `$PI_CODING_AGENT_DIR` moves the whole agent directory and `$PI_CODING_AGENT_SESSION_DIR` (or `--session-dir`) the session directory.
- The directory name replaces every non-alphanumeric character of the cwd with `-`, the same scheme Claude Code uses. Loggy reads the `cwd` of the header record instead.

**Records**: one JSON object per line, all of them a tree of entries linked by `id` / `parentId`.

| type | used for |
|---|---|
| `session` | the header line: `id`, `cwd`, `version`, and `parentSession` for a session made by `/fork` or `/clone` |
| `message` | `role` is `user` (human input), `assistant` (`model`, `provider`, `usage`, `stopReason`, `text` / `thinking` / `toolCall` blocks), `toolResult` (`toolCallId`, `toolName`, `isError`, `details`), or `system` / `custom` (prompt state, not conversation) |
| `model_change`, `thinking_level_change` | the selected model |
| `compaction` | context compaction, `tokensBefore` |
| `session_info` | `name`, the title set by `/name`; the last one wins |
| `branch_summary` | `/tree` switched away from a branch; the branch stays in the file |
| `usage` | model-attributed usage outside the conversation, e.g. `kind: "cache_warm"` |
| `context_edit`, `label`, `custom`, `custom_message` | ignored |

**Quirks**

- `usage` is per request, not cumulative, so nothing has to be de-duplicated. `totalTokens` is the context of that request and `cost` is what Pi itself paid; Loggy keeps its own price table so all agents stay comparable.
- `stopReason` decides how a turn ends: `stop` is a finished reply, `toolUse` leaves the turn open, `aborted` is the user pressing escape, and `error` is a failed request (rate limit, connection). An `error` ends the turn unfinished, the way a Claude API error does.
- A `/fork` or `/clone` session writes a new file whose header points at the parent's file, so both files are shown as one session, the way continued Codex threads are.
- Entries form a tree: `/tree` leaves the abandoned branch in the file and Loggy reads entries in file order, so a session that branched shows both paths.
- Pi writes no git metadata, so Loggy falls back to the text around the command:
  - a commit is a `git commit` call whose output starts with `[branch sha] message`; the message is taken from `-m`;
  - a push counts when `git push` printed that it reached the remote;
  - the branch is read from the repository on disk, so it is the branch that is checked out now, not the one the session ran on.
- `edit` results carry `details.diff`, which gives the added and removed lines. `write` has no diff, so the line count comes from the body in the call.
- Files changed by a shell command are not visible; Claude Code reports those, Pi does not.
## Kimi Code

**Location**

- `~/.kimi-code/sessions/wd_<folder>_<hash>/session_<id>/` per session; `$KIMI_CODE_HOME` replaces `~/.kimi-code`.
- `state.json` in that folder: `id`, `cwd`, `createdAt`, `title` (with `isCustomTitle` / `titleKind`: `custom`, `generated`, `replaceable`), and `agents` (`main`, plus `agent-<n>` with `parentAgentId` for subagents). A rename only changes this file, so Loggy reads the title from it each time.
- Every agent writes its own event log: `agents/<agent>/wire.jsonl` (`main` and `agent-<n>`).
- `config.toml` next to `sessions/` lists `max_context_size` per model alias; Loggy uses it for the context %.
- Resume with `cd <cwd> && kimi --resume <session id>`.

**Records** (one JSON object per line, `type` plus `time` in epoch ms)

- `turn.prompt` starts a turn: `input` (text and image parts), `origin.kind` = `user`, `cron_job` (a scheduled job), `task` (a background task finished), `system_trigger` (`origin.name` = `subagent` for a subagent's prompt, `goal_continuation`). Only `user` prompts are your inputs; the others start turns on their own. `turn.steer` with `origin.kind: user` is an input sent while a turn runs.
- `turn.ended` closes it: `reason` = `completed`, `cancelled` (interrupted) or `failed` (an API error, with `error`).
- `usage.record` is the token source: `model` (alias), `usage` = `inputOther`, `inputCacheRead`, `inputCacheCreation`, `output`. `usageScope: turn` records are requests; `usageScope: session` records are compaction calls, which cost tokens but are not the context. `step.end` and the UI copies of messages repeat the same usage.
- `context.append_loop_event` carries the agent loop: `tool.call` (`name`, `args`), `tool.result` (`output`, `isError`), `content.part` (text the agent wrote), `step.begin` / `step.end` (`usage`, `llmStreamDurationMs`, used for output speed).
- File edits come from `Edit` (`path`, `old_string`, `new_string`) and `Write` (`path`, `content`) calls whose result is not an error. Commits come from `Bash` commands with `git commit`; the id is read from the output when git printed one.
- `interaction.request` (`kind`: `approval` or `question`) is open until `interaction.resolved`; while one is open the session needs your input.
- `task.started` / `task.terminated` track background processes and agents.
- `context.apply_compaction` is a compaction.
- `agent.message.appended` (the UI's copy of each message, with full tool outputs and images), `context.append_message`, `llm.request`, `llm.tools_snapshot` and `mcp.tools_discovered` are skipped.

**Harness settings**

- `permission.set_mode` (`mode`: `manual`, `yolo` = ask when needed, `auto` = never ask), `config.update` and `profile.bind` (`thinkingEffort`: `off`, `on`, `high`, `max`; `modelAlias`), `plan_mode.enter` / `.exit`, `swarm_mode.enter` / `.exit`, `goal.create` / `goal.update` (`status: complete`) / `goal.clear`.

## Harness settings

Loggy records, for every turn, the settings in effect and counts how often each was changed.

| setting | Claude Code | Codex | Kimi Code |
|---|---|---|---|
| permission | `permissionMode` on inputs and `permission-mode` records | `turn_context.approval_policy` | `permission.set_mode` |
| plan | permission mode `plan` | `turn_context.collaboration_mode.mode` = `plan` | `plan_mode.enter` / `.exit` |
| effort | `effort` (or `perTurnEffort`) on replies | `turn_context.effort` | `thinkingEffort` |
| model | `message.model` | `turn_context.model` | `usage.record.model` |
| sandbox | | `turn_context.sandbox_policy.type` | |
| multiAgent / swarm / goal | | `multi_agent_version` | swarm mode, goal |
| speed | `message.usage.speed` (`fast` in fast mode) | | |
| surface | `entrypoint` | `session_meta.originator` | |

A mode switched on and off again within one turn counts as on for that turn.

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
