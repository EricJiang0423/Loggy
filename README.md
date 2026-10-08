# Loggy

**简体中文** · [English](README.en.md)

Loggy 是 **Claude Code**、**Codex**、**Kimi Code** 和 **Pi** 会话的本地看板。它直接读取这些工具本来就写在本机的日志，把每个会话画成周日历上的一根竖条，并提供会话详情、对话时间线、完成判定和效率分析。不用装 hook，不用改配置，也不会往你的仓库里写任何东西。

![周日历、会话详情和时间线](docs/images/calendar-zh.png)

## 功能

- **周日历**：每个会话是一根竖条，从第一次活动画到最后一次活动。
  - 颜色深浅表示每 10 分钟的活跃度，圆点是你的输入。
  - 同时进行的会话并排显示。
  - 可以按状态、agent、项目、AI 分类或模型着色，`Ctrl + 滚轮`缩放。
- **会话详情**：项目、分支、模型、时长、输入次数、token、等价 API 费用、上下文峰值，以及：
  - **完成判定**：回合结束 / 不在等你回复 / 无后台任务 / 改动已提交 / 工作已完成
  - **成果**：提交记录、改动的文件和增删行数、agent 问过你的问题和你的回答
  - **请求进度**：每个请求的状态，以及处理它时产生的提交
  - **回合详情**：每个回合的 token、费用、上下文、工具调用次数和改动的文件
  - **相关会话**：改过同一批文件的其他会话
  - 最近一次请求的上下文构成、估算的输出速度、被拒绝的次数
  - **星标、标记和备注**：可以给会话加星，标成讨论中 / 进行中 / 稍后 / 完成，写一段备注
- **时间线**：对话以气泡形式显示，可以切换「全部 / 隐藏中间输出 / 只看我的输入」，输入带编号；`AskUserQuestion` 显示为提问卡片并标出你选的答案。
- **实时状态**：运行中的会话在日志写入后约 0.1 秒内更新。每个会话会被归为以下几类：
  - 运行中
  - 停滞：工具调用迟迟没有结果，可能在等你确认权限
  - 等你回复
  - 已完成
  - 未完成
  - 中途结束

  Claude Code 运行时会写 `~/.claude/sessions/<pid>.json`，Loggy 读取它，所以等你确认权限或回答问题时会立刻显示「等你回复」。
- **远程主机和云端**：设置里列出 Claude 和 Codex 应用里配置过的 SSH 主机，也可以手动添加；打开后每 2 分钟用 rsync 把主机上的 Claude Code / Codex 日志拉到 `~/.loggy/remote/`，会话标出所在主机。也可以打开 Codex Cloud，每 10 分钟用 `codex cloud list` 读取云端任务（标题、状态、改动行数和链接）。Claude Code 云端会话 teleport 到本机后会被统计。都默认关闭。
- **Pi**：读取 `~/.pi/agent/sessions`（由 @KaiOnCode 贡献），会话、token、改动、提交、压缩、中断和失败的请求都和其他工具一样显示；`/fork` 和 `/clone` 出来的会话和原会话算一个。
- **自动识别本机的 Harness**：检查每个工具的日志目录、命令行工具和桌面应用，只显示本机有的；设置里列出检测到的，其余的只提一句，接力也只给出本机装了的工具。
- **Kimi Code**：读取 `~/.kimi-code/sessions` 里每个会话的事件日志，会话、子代理、token 和等价费用、改动的文件、提交、时间线、提问和等待批准都和另外两个工具一样显示；标题用 Kimi Code 里的会话名（改过名就用最新的）。
- **Harness 设置统计**：记录每一轮在什么设置下运行，以及会话中切换了几次：权限模式（如 default / plan / auto / bypass、Codex 的审批策略、Kimi 的 manual / yolo / auto）、思考强度、模型、Plan 模式、沙箱、多代理 / Swarm、Goal、快速模式和入口（桌面应用或 CLI）。会话详情里有「Harness 设置」卡片和切换记录，效率页按 Harness 汇总各设置的轮次占比，会话列表可以按某个设置筛选。
- **Harness 开关和选择**：会话页和效率页可以多选要看的 Harness；设置里可以关掉某个 Harness，关掉后不再索引、不计入任何统计。
- **Claude Code rewind**：rewind（以及「在新会话里继续」）会把对话分叉到一个新文件，并复制之前的记录。Loggy 把它们显示为一个会话，复制的部分只算一次，被回退掉的轮次会标出来。
- **效率分析**：
  - 等价 API 花费、Agent 工作时间、Agent 等你的时间、会话数、提交数、改动行数、缓存命中率、最多同时进行的会话数，都会和上一周期对比
  - 每天的趋势图，以及「星期 × 小时」热力图
  - 各 Harness 的对比、各 Harness 的设置统计、按项目的统计表、各模型的输出速度（估算）
  - 「值得一看」列表：花了钱却没产出、上下文接近上限、工具调用陷入循环、结束时还有未提交改动的会话
- **项目分组**：可以在设置里选择按 git 远程仓库、git 根目录或工作目录分组。默认的智能分组对 Claude 和 Codex 用同一套规则：能识别仓库时（来自 git、Codex 日志或 Claude 的 PR 链接）按仓库分组，否则按目录；在 Codex 应用里放进某个项目、但在项目目录之外运行的对话算作在该项目的目录里，Codex 无项目对话的日期目录（`Codex/YYYY-MM-DD/…`）合成一组。目录已被删除、或中途换过 origin 的会话也能归到对应项目。Codex 的自动审批（guardian）线程算作所审对话的子代理。Codex 会话的标题用 Codex 应用里的对话名（改过名就用最新的）。
- **接力**：会话详情里的「复制接力」生成一段交接提示（概要、决策、未验证项、下一步、提交和改动文件、完整日志路径），粘到新对话里就能接着干，Claude 和 Codex 互相接力都行。新对话的第一条消息只提到一个其他会话时（接力提示、`codex://threads/…` 链接或日志路径），Loggy 会把两者连起来，详情里显示「接力自 / 接力到」。上下文压缩两次以上（或已用 80%）、隔夜续聊、或一个对话里有多个独立任务时，详情会提示该拆了；还在进行的这类会话在列表里标「该拆了」，新出现时弹系统通知，点开直接接力。
- **一键接力到新会话**：选接力给 Claude Code 还是 Codex、在哪打开（cmux 新工作区、系统终端、桌面版、只复制命令），点「接力到新会话」。Loggy 把交接写到 `~/.loggy/handoffs/`，在原会话的目录里启动 `claude` / `codex`，第一条消息指向这份交接和旧会话，所以接力链自动连上。只在你点击时启动，不会自己开会话。cmux 默认只接受它内部进程的命令，这时 Loggy 会在该目录开一个工作区并复制好启动命令；在 cmux 设置 → Automation 里放开后可以直接启动。桌面版没有公开的「带消息新建对话」入口，所以是打开应用、交接内容放进剪贴板，由你粘贴。
- **Git**：自动识别项目对应的本地仓库（包括只在 PR 链接里提到仓库、会话在上级目录里跑的项目），画出所有本地分支的提交图，每个提交按产生它的会话着色；点开提交能看到改动的文件和 diff，以及这个会话每一轮对话分别做了哪些提交。可以搜索提交信息、按路径筛选，还有按目录统计的代码行数趋势。
- **指令与记忆**：查看每个项目里 `CLAUDE.md` / `AGENTS.md` 的 git 历史和每次改动的 diff，以及每个版本生效期间跑了多少个会话。
- **中英文界面**、浅色 / 深色主题、键盘导航（列表里用 ↑/↓ 或 j/k）。
- **可选的 AI 概要和智能分类**：所有摘要用统一的格式（标题、要点、决策、未确认、担忧、待回答的问题、下一步、请求进度、类型、是否完成）。可以手动生成，也可以开启自动：最近 7 天的会话都会生成摘要，有变动的会话每天更新一次，并顺手把会话归纳成几个大类。可以接 Anthropic API，也可以接公司自己部署的模型。摘要和分类都按设置里选的语言写，写错语言会让模型重写一次，还不对就不保存。

| 效率（深色） | 会话列表（深色） |
|---|---|
| ![效率页：KPI、每日图表和按项目统计](docs/images/efficiency-zh-dark.png) | ![会话列表、详情和时间线](docs/images/sessions-en-dark.png) |

| 按项目着色的日历（深色） | 显示工具调用和问题卡片的时间线 |
|---|---|
| ![按项目着色的周日历](docs/images/projects-en-dark.png) | ![会话详情：提交、改动文件和工具调用时间线](docs/images/timeline-en.png) |

Git 页：提交图、每轮对话的提交和 diff：

![Git 页：提交图、按轮次的提交和 diff](docs/images/git-zh.png)

效率页的 Harness 设置统计（各设置的轮次占比和切换次数）：

![效率页：三个 Harness 的权限模式、Plan 模式、思考强度和模型统计](docs/images/harness-zh.png)

设置里的项目分组方式：

![设置：项目分组方式](docs/images/settings-zh.png)

## 安装和运行

需要 **Node.js 22.12+**（读取压缩过的 Codex 日志 `.jsonl.zst` 需要 22.15+）。

```sh
# 不安装，直接运行一次
npx --yes https://github.com/EricJiang0423/Loggy/releases/download/v0.9.0/loggy-0.9.0.tgz

# 或者安装 loggy 命令
npm install -g https://github.com/EricJiang0423/Loggy/releases/download/v0.9.0/loggy-0.9.0.tgz
loggy
```

启动后会自动在浏览器打开 `http://127.0.0.1:4317`。第一次运行会索引全部日志，几 GB 的日志大约需要几秒；之后从 `~/.loggy` 里的缓存启动。没有自己的数据也可以用 `loggy --demo` 体验。

升级：用新版本的链接再执行一次 `npm install -g …`，然后重启 `loggy`。缓存和设置都在 `~/.loggy`，升级不会丢；解析规则变了的话，新版本启动时会自动重新索引。

从源码运行：

```sh
git clone https://github.com/EricJiang0423/Loggy.git && cd Loggy
npm ci && npm run build && npm start
```

### 参数

```
loggy [--port 4317] [--host 127.0.0.1] [--no-open] [--demo] [--rebuild]
      [--claude-dir <目录>]... [--codex-dir <目录>]... [--kimi-dir <目录>]... [--pi-dir <目录>]...
      [--data-dir <目录>] [--ai-model <模型>]
```

默认读取以下位置：
- Claude Code：`$CLAUDE_CONFIG_DIR` 和 `~/.claude/projects`
- Codex：`$CODEX_HOME`（或 `~/.codex`）下的 `sessions` 和 `archived_sessions`
- Kimi Code：`$KIMI_CODE_HOME`（或 `~/.kimi-code`）下的 `sessions`
- Pi：`$PI_CODING_AGENT_SESSION_DIR`、`$PI_CODING_AGENT_DIR/sessions` 或 `~/.pi/agent/sessions`

有多个账号的话，可以多次传 `--claude-dir` / `--codex-dir` / `--kimi-dir` / `--pi-dir`。

### AI 概要（可选）

在「设置 → AI 概要」里配置，会话详情里就会出现「生成 AI 概要」按钮。可以配置的项：

- **接口格式**：Anthropic Messages（官方 API 或兼容的网关），或 OpenAI 兼容的 `/chat/completions`（大多数公司内部部署的模型和网关都支持）。
- **接口地址**：Anthropic 格式留空就是官方 API；OpenAI 兼容格式填 `/chat/completions` 之前的部分，例如 `https://llm.example.com/v1`。
- **模型**、**API Key**：Key 可以直接保存，也可以写一个环境变量名，让 Loggy 启动时从环境变量读取。不需要 Key 的内网网关可以留空。
- **认证方式**（Anthropic 格式）：`x-api-key` 或 `Authorization: Bearer`。
- **额外请求头**：每行一个 `Name: value`，用于网关要求的租户、项目等字段。

「测试连接」会发一个很小的请求，检查地址、Key 和模型名。设置保存在 `~/.loggy/settings.json`，只有你自己能读。官方 API 用结构化输出，其他接口会要求模型返回 JSON，再做校验。

没有在设置里配置时，Loggy 会沿用 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 环境变量。默认模型是 `claude-haiku-4-5`，可以用 `--ai-model` 或 `LOGGY_AI_MODEL` 更换。

**自动摘要**：勾选「自动为最近 7 天的会话生成摘要」后，后台每小时检查一次：最近 7 天里还没有摘要的会话会补上，之后有变动的会话每天最多更新一次，正在运行的会话等它停下来再生成。摘要语言在设置里统一指定，所有摘要都是同一个格式，换模型也一样；旧格式或写错语言的摘要会在下次运行时被替换。模型没按要求的语言写时会被要求重写一次，仍然不对就记为失败，一天后再试。

**智能分类**：每次自动摘要跑完（每天最多一次），Loggy 先让模型用一句话概括每个项目在做什么，再归纳出 4–8 个大类，最后把每个会话归到一类。已有的分类名会传给模型优先沿用，颜色因此保持稳定。日历可以按「AI 分类」着色，设置页可以查看分类说明或手动重新分类。结果存在 `~/.loggy/categories.json`。

发送给模型的只是会话的精简记录：你的请求、agent 的最终回复、工具名、文件路径和提交信息；分类时只发会话标题和项目名。摘要缓存在 `~/.loggy/summaries`。

### 价格

费用是按内置价格表估算的**等价 API 费用**，订阅用户实际不按 token 计费。价格表收录了 Claude、OpenAI、GLM、DeepSeek、Kimi 和 MiMo 模型的官方标价（按短上下文价格；DeepSeek 按高峰价）。没有公开价格的 OpenAI 模型（如 `codex-auto-review`）按估算价计算，表里没有的模型按 Sonnet 价格计算。要覆盖价格，可以创建 `~/.loggy/pricing.json`，例如 `{ "gpt-5.5-codex": { "input": 1.25, "output": 10, "cacheRead": 0.125 } }`，单位是美元 / 百万 token。键名会和模型名精确匹配或做子串匹配。

## 工作原理

- **多线程解析**：日志在 worker 线程里解析，读几千个文件时界面也不卡。Codex 的 rollout 文件可能很大，所以每行先看开头几个字节判断类型，只有需要的记录才做 JSON 解析。
- **增量更新**：文件变长时，从上次读到的位置接着解析，并恢复当时的解析状态；没变的文件直接用缓存。文件监听（fs.watch）加轮询，更新通过 SSE 推送到浏览器。
- **日志格式**：三种日志的格式和坑写在 [docs/log-formats.md](docs/log-formats.md)，比如：
  - Claude Code 会把同一条回复按内容块拆成多行，每行都带同一份 `usage`，所以要按 `message.id` 去重；
  - Codex 的 token 是累计值，而且偶尔会变小；
  - Pi 不写 git 信息，提交和分支要从命令和仓库里推断；
  - 子代理的日志在单独的文件里。
- **隐私**：只监听 `127.0.0.1`，拒绝其他 `Host` 头。除了你配置的 AI 概要和分类，不发任何网络请求。Git 页和指令页只运行只读的 git 命令（`log`、`show`、`diff`、`ls-tree`、`cat-file`），不会改动你的仓库。

性能（一台 Mac，1,033 个合成会话，共 524 MB）：
- 首次索引：2.2 秒
- 从缓存启动：0.2 秒
- 会话列表：约 0.4 秒（2 MB）
- 新写入的日志出现在界面上：约 0.1 秒
- 打开会话详情：0.1–0.2 秒（最大的会话有 1,200 多次工具调用）

可以用 `npm run perf` 复现。

## 开发

```sh
npm run dev          # 改动后自动重新构建服务端
npx vite web         # 界面开发服务器，支持热更新（/api 代理到 :4317）
npm run typecheck && npm test
npm run build && npm run e2e   # 用 Chromium 跑端到端检查，截图在 artifacts/
npm run perf         # 用生成的数据做性能测试
```

测试只用 `src/server/demo.ts` 生成的数据，仓库里没有任何真实的对话记录。

## 致谢

灵感来自 [@tokkyo](https://x.com/tokkyo) 在 X 上展示的会话日历工具。Loggy 是独立实现的。

## 许可证

[MIT](LICENSE)
