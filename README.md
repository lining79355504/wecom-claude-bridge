# wecom-claude-bridge

用企业微信智能机器人的长连接，远程操控本机的 Claude Code 写代码。

你在企微里发一句话，本机 Claude Code 在指定仓库里干活，过程实时流式回吐到聊天窗口。

完整功能、安装配置、命令说明和故障排查见 [功能与使用手册](docs/功能与使用手册.md)。

```
企微 App  ──▶  aibot_msg_callback (WebSocket 长连接，免公网)
                     │
                     ▼
              wecom-claude-bridge（本机 Node 进程）
                     │  query() + resume
                     ▼
              Claude Code（cwd = 你的仓库）
                     │  replyStream / sendMessage
                     ▼
企微 App  ◀──  进度 + 结果
```

## 安装

需要 Node.js >= 22.13（推荐 Node.js 24），使用内置 SQLite，无需安装数据库服务。

```bash
cd ~/Downloads/wecom-claude-bridge
npm install
cp .env.example .env
```

## 填 `.env`

需要三样东西：

**1. Bot ID 和 Secret**

企业微信管理后台 → 应用管理 → **智能机器人** → 选中你的机器人 → 开发设置。

> ⚠️ 要的是「智能机器人」的 Secret，不是自建应用的 Secret。两者不通用。
> 注意：`wecom-cli` 存在 `~/.config/wecom/credentials.enc` 里的凭证是加密的、不对外暴露，所以这里得你手动填一次。

**2. 你的 userid**

`WECOM_ALLOWED_USER_IDS` 为空时会在连接前拒绝启动。若暂时不知道自己的标识，可先填入不对应真实成员的占位值 `bootstrap-deny-all`，配好其他必填项后启动，再给机器人发一条文字消息。真实用户仍会被拒绝，日志会打出：

```
[warn] 拒绝非白名单用户: wo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

将日志中的实际标识填进白名单，删除占位值，然后重启。只加入可信成员；获准成员可以通过机器人驱动本机 Claude。

**3. 工作目录**

`CLAUDE_WORKSPACE` 填你想让 Claude 操作的仓库绝对路径，比如 `/Users/mort/`。必须是具体目录，不能用 `~` 或 `/`。

## 自检 + 启动

```bash
npm run check   # 检查配置、依赖、工作目录、claude CLI
npm start
```

看到 `认证成功` 就可以在企微里发消息了。

## 内部工单模式

每张工单有独立的 Claude 会话、消息记录和状态。没有当前工单时，普通消息自动创建工单；已有工单时，普通消息归入当前工单。

```text
/new 修复登录接口超时
# 创建工单 #1 并执行

只改后端，不动前端
# 补充到当前工单；执行中则保存并排队

/new 给订单接口加缓存
# 创建并切换到工单 #2，排队执行

/switch 1
/status
/history
/close
```

| 命令 | 效果 |
|---|---|
| `/new 需求描述` | 创建、选中并执行新工单 |
| `/list` | 当前聊天最近 20 张工单，标记当前选中项 |
| `/switch 编号` | 切换后续消息的归属，不中断正在执行的工单 |
| `/status [编号]` | 查看状态、工作目录、队列及待审批编号 |
| `/history [编号]` | 最近 10 条记录，每条最多展示 500 字符，数据库保存全文 |
| `/stop [编号]` | 停止执行并取消该工单排队消息；不填编号时优先停止本聊天正在执行的工单 |
| `/resume [编号]` | 恢复暂停消息，或让 Claude 核查进度后继续处理 |
| `/close [编号]` | 用户验收并关闭；有未完成任务时须先停止并等待退出 |
| `/reset` / `/clear` | 清空当前工单 Claude 会话，保留工单、最初需求和历史记录；须先停止任务 |
| `/help` | 查看命令 |

除 `/stop` 的上述行为外，可选编号省略时均指当前工单。关闭后再发普通需求会新建工单。

状态包括：待处理、排队中、执行中、待审批、待验收、已中止、执行失败、已关闭。Claude 成功回复后进入待验收，只有用户 `/close` 才会关闭。

**执行与隔离：**交互工单共用本机工作区，因此交互工单队列串行执行；下文的定时任务使用独立并发池。工单之间隔离对话上下文，不隔离文件修改。补充消息按提交顺序执行，不会插入正在运行的一轮；需要立即改变方向时先 `/stop`，等待退出后再补充需求。单聊之间、群聊之间不能操作彼此的工单；同一群聊的白名单成员共享工单和当前选中项。

**保存与重启：**默认数据库在项目 `data/tickets.sqlite`，可用 `TICKET_DB_PATH` 指定路径，已加入 Git 忽略。工单绑定创建时的工作目录，后续修改 `CLAUDE_WORKSPACE` 只影响新工单；原工单仍须符合当前允许目录配置。会话 ID 在 Claude 初始化时保存，内存回收和桥接重启不会清空工单上下文。恢复还依赖本机 Claude 会话文件，请保留这些文件。

重启前的执行中和排队任务会暂停，旧审批失效，不自动重放；发送 `/resume 编号` 才继续，并提示 Claude 先核查已完成的操作。中断时已经发生的文件修改不会回滚。执行失败时，同工单后续消息暂停，其他工单继续排队执行。`/stop` 会取消该工单未执行的补充消息，消息历史仍保留，需要时重新提交。

工单模式默认开启；启动一个桥接进程即可。原来仅存在内存里的聊天上下文不会自动迁移为工单。

## 定时执行与推送

定时运行 Claude 任务，完成后推送到创建任务的聊天，或指定的企业微信群机器人 Webhook。任务、执行历史、完整结果和待发送消息均保存在 `TICKET_DB_PATH` 指定的同一个 SQLite 数据库里，无需 Redis 或额外服务。重启桥接即可使用，不需要额外安装依赖。

在企微给桥接机器人发送：

```text
/schedule add every 30m -- 检查仓库状态，汇总最近提交和未提交修改

/schedule add daily 09:00 --timezone Asia/Shanghai -- 总结昨天的代码提交

/schedule add daily 18:00 --webhook https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=替换成群机器人密钥 -- 生成今天的项目日报

/schedule add once 2027-01-01T09:00+08:00 -- 检查新年发布状态

/schedule add every 2h --workspace "/Users/mort/projects/my project" -- 检查这个项目并汇总
```

`--` 后是交给 Claude 的任务全文，支持多行；其前面是时间规则和可选参数。Webhook 地址不会放入 Claude 的任务提示词。`--workspace` 必须存在且位于 `CLAUDE_ALLOWED_PATHS` 允许范围内，省略时绑定创建任务时的 `CLAUDE_WORKSPACE`。

时间规则：

| 规则 | 含义 |
|---|---|
| `every 30m` / `2h` / `1d` | 从创建/恢复时刻起按间隔执行，最短 1 分钟、最长 366 天 |
| `daily 09:00` | 每天指定时刻，默认时区由 `SCHEDULE_TIMEZONE` 指定，初始为 `Asia/Shanghai` |
| `once 2027-01-01T09:00+08:00` | 未来的单次时间，必须明确时区偏移或 `Z` |

`daily` 可通过 `--timezone America/Chicago` 单独指定时区。夏令时跳过的时刻当天不执行，回拨时重复的小时只执行一次。详情中的下次时间使用 ISO UTC（`Z`）展示，规则中显示设置的时区。

| 命令 | 效果 |
|---|---|
| `/schedule help` | 命令说明 |
| `/schedule list` | 当前聊天的定时任务 |
| `/schedule show 编号` | 内容、时间、目录、推送方式、运行及审批状态 |
| `/schedule history 编号` | 最近 10 次执行与发送状态，结果预览最多 500 字符；SQLite 保存全文 |
| `/schedule pause 编号` | 停止后续触发并取消尚未执行的排队项，正在执行的本轮继续 |
| `/schedule resume 编号` | 恢复后续触发；已过期的单次任务需手动运行或重新创建 |
| `/schedule run 编号` | 立即排队运行一次，暂停中的任务也可使用，不改变后续周期 |
| `/schedule stop 编号` | 中止本轮及排队项，后续周期仍保留 |
| `/schedule delete 编号` | 停止调度、中止执行并取消尚未发送的结果，数据库历史保留；已经在途的发送可能完成 |
| `/schedule retry 运行编号` | 重试自动重试已耗尽的推送，复用已保存结果，不重新执行 Claude |
| `/schedule approve 审批编号` / `/schedule reject 审批编号` | 同意/拒绝某次定时运行的工具审批 |

**多任务并发：**定时任务不进入普通工单串行队列，也不改变当前选中的工单。默认最多同时执行 4 个定时任务，超出部分按入队顺序等待；一个任务慢、失败或等待审批，其他空闲执行槽仍可工作。每次运行使用新的独立 Claude 会话。同一任务最多一项排队或执行中的运行，跨过多个周期时合并遗漏触发，不积累多轮补跑。配置：

```dotenv
SCHEDULE_CONCURRENCY=4
SCHEDULE_MAX_TURNS=100
SCHEDULE_DELIVERY_CONCURRENCY=4
SCHEDULE_TIMEOUT_MS=1800000
SCHEDULE_TIMEZONE=Asia/Shanghai
```

并发上限为 1–32，单次执行默认 30 分钟超时（含审批等待）。超时或停止会请求 SDK 中止，等待它真正退出后才释放槽位，避免同一任务重叠。并发任务的对话隔离不等于文件隔离；涉及同时修改文件时，用 `--workspace` 指向各自的仓库或事先准备的独立 worktree，避免与其他定时任务、交互工单修改同一份文件。

定时任务每次默认最多 100 轮 agent 执行，通过 `SCHEDULE_MAX_TURNS` 单独设置（1–1000），普通工单仍由 `CLAUDE_MAX_TURNS` 控制，默认 30 轮。若提示达到轮数上限，任务会标记失败，并保存已收到的部分输出。可缩小任务范围，或提高上限后重启；核查已发生的操作后使用 `/schedule run 编号` 从新会话重跑。提高上限可能增加执行时间和模型用量；时间超时限制仍然生效。`/schedule retry` 只重发保存的结果。

**权限与审批：**只有白名单成员能创建和管理任务；同一群聊的白名单成员共享任务，其他聊天不能查看或操作。每次执行重新检查创建人白名单和目录权限，并沿用现有 Claude 权限模式与工具围栏。人工审批发送到创建任务的桥接聊天，使用 `/schedule approve` 或 `/schedule reject`；每次运行有独立审批，不与其他定时任务或工单争用。群 Webhook 只接收结果，不用于接收审批回复。长连接离线时，无法人工审批的工具操作直接拒绝。

**推送与失败：**发送使用独立并发池，慢 Webhook 不占 Claude 槽位。默认按每个目标至少间隔 3.1 秒发送（包括重试），长结果按 UTF-8 字节分段，群 Webhook 每段不超过 3800 字节。发送失败指数退避，每段最多自动尝试 5 次；耗尽后可用 `/schedule retry 运行编号` 重发。已经确认成功的分段不会重新发送。Webhook 检查 HTTP 状态与企微 `errcode`，只接受官方 HTTPS 群机器人地址且禁止重定向；单次请求 10 秒超时。群机器人的其他发送方仍会共享平台频率额度。

执行状态和发送状态分开记录：Claude 执行成功但推送失败时，结果仍保存在数据库里；不会为了重发重新执行 Claude。网络超时或进程在远端已接收、但本地尚未记账时退出，重试仍可能导致重复消息，外部接口没有提供可依赖的幂等保证。

**重启与离线：**已排队但未开始的定时运行会继续；已开始但中断的运行标记为 `interrupted`，不会自动重跑这次操作，其后正常周期继续。已生成结果的待发送消息恢复发送；错过多个触发时刻最多补一次。长连接离线时，发往当前聊天的结果保留且不消耗重试次数，Webhook 仍可发送。需要准点执行时，机器必须保持运行；休眠期间不会执行。一个数据库只运行一个桥接进程。

Webhook 密钥在 SQLite 中保存以供重启后使用，查询消息和日志会隐藏 URL；数据库文件和备份应按凭证管理。修改目标或任务内容时，暂停/删除旧任务后重新创建。

## 权限模型

在 `.env` 中设置 `CLAUDE_PERMISSION_MODE`，重启桥接生效：

- `default`（未配置时的默认值）：只读优先，其余操作人工审批。
- `acceptEdits`：由 Claude 自动接受文件编辑，其余操作按权限规则判断。
- `auto`：由 Claude 原生分类器自动批准或拒绝操作，无法决定时仍通过企微请求 `y/n` 审批。可用性取决于模型、账号及组织策略。

目录围栏和 `DENIED_TOOLS` 在所有模式下都通过 `PreToolUse` 钩子先行检查；通过检查不会直接批准操作。钩子失败会阻止执行。`auto` 的人工审批回退不会再被本地只读名单自动放行。

以下三层说明适用于 `default` 模式：

**第一层 · 目录围栏**（自动，无审批机会）

Claude 只能在 `CLAUDE_WORKSPACE`（或 `CLAUDE_ALLOWED_PATHS`）范围内读写。越界操作直接拒绝并通知你：

```
🚫 已拦截：/Users/mort/.ssh/id_rsa 不在允许的目录范围内
```

这层拦住的是「模型跑偏到别的仓库」或「顺手改了点不该改的」，不是沙箱。`Bash` 命令里的绝对路径也会检查，但只能拦住明显的越界（比如 `~` 不会展开，就抓不到）。

**第二层 · 只读放行**

`READ_ONLY_TOOLS` 里的工具（Read / Glob / Grep / WebSearch 等）不打扰你，直接执行。

`Bash` 也按命令内容区分：**纯只读命令**（`ls` / `cat` / `grep` / `find` / `git status` / `npm ls` …）直接放行，不弹审批。判定不了的一律回落到第三层审批——宁可多问一次，也不放行没看懂的命令。

```
✅ 直接执行: ls -la
✅ 直接执行: grep -rn "foo" src && wc -l src/index.js
✅ 直接执行: git log --oneline -5
⏸ 需要审批: rm -rf build          （未识别的命令）
⏸ 需要审批: cat a.txt > b.txt     （重定向）
⏸ 需要审批: echo $(whoami)        （命令替换）
⏸ 需要审批: find . -name "*.js" -delete   （带 -delete）
```

只读判定有两道硬约束：
- 重定向、子 shell、变量展开和命令替换会回退到权限判断；管道、`;`、`&&` 等组合命令按段检查，所有分段均被判定为只读时才自动放行。
- `find -exec`、`sort -o`、`tail -f`、`git --output`、`git branch <新分支>`、`git config <key> <value>` 这类「看起来只读、实际会写」的参数单独拉黑。

规则在 `src/bash-policy.js`，要恢复「所有 Bash 都审批」就把 `.env` 里的 `BASH_READONLY_AUTO_APPROVE` 设为 `false`。

**第三层 · 逐次审批**

需要人工审批时，把工单编号、工具名和参数发到企微，回复提示中的完整审批编号：

```
**Claude 请求执行操作**
工单 #1

`Bash`

git push origin master --force

回复 y 1-a1b2c3d4 同意，n 1-a1b2c3d4 拒绝（默认 300 秒无响应自动拒绝）。
```

- 5 分钟不回复 = 自动拒绝。
- 审批编号包含工单 ID 和随机标识。裸 `y/n`、错误编号、过期编号和其他聊天的回复不会批准操作。普通补充需求仍保存到当前工单队列。
- 发 `/stop` 会同时打断本聊天正在执行的工单并取消其审批；也可显式指定工单编号。

调整严格程度改 `.env` 即可，不用动代码：

| 想要 | 怎么配 |
|---|---|
| 更严格（连读文件也审批） | `READ_ONLY_TOOLS=` （留空） |
| Bash 一律审批（不做只读识别） | `BASH_READONLY_AUTO_APPROVE=false` |
| 绝对禁止某工具 | `DENIED_TOOLS=Bash` |
| 放开到多个仓库 | `CLAUDE_ALLOWED_PATHS=/a,/b` |
| 完全不限制路径 | `CLAUDE_ALLOWED_PATHS=*`（不推荐） |

## 安全须知

这个进程等于**把整台 Mac 的代码执行权挂在一个 IM 窗口后面**。几个硬约束：

- 白名单为空时程序拒绝启动（fail-closed）。
- 只建议放你本人。加同事 = 给同事你电脑的执行权。
- 跑在你自己电脑上，合盖/休眠会断线，长连接会自动重连（指数退避，最长 30s 一次）。
- 一个机器人同一时间只能挂一条长连接，新连接会踢掉旧连接。`wecom-cli` 走 HTTP 出站，不冲突。

## 目录结构

```
src/
├── index.js       # 长连接、白名单验证、流式进度
├── ticket-bot.js  # 工单命令、串行队列与审批路由
├── tickets.js     # SQLite 工单、消息及队列持久化
├── scheduler.js   # /schedule 命令、独立并发执行池与审批
├── schedule-store.js # SQLite 定时任务、运行记录与推送队列
├── schedule-time.js  # 间隔、每日时区与单次触发规则
├── schedule-delivery.js # 群 Webhook 校验、发送和消息分段
├── claude.js      # Claude Agent SDK 封装（query + resume + abort）
├── approval.js    # 审批队列与提示渲染
├── guard.js       # 路径围栏
└── config.js      # .env 解析与校验
scripts/
└── check.js       # 启动前自检
```

## 已知限制

- 只能处理文本和语音（语音用企微自带的转写结果）；发图片/文件会被忽略。
- 同一群聊的白名单成员共享工单列表及当前选中工单；每张工单有独立的 Claude 上下文。
- 普通工单单轮默认最多 30 个 agent 圈数；定时任务默认 100 轮，达到上限会中断。

## 本地验证

`npm test` 验证工单会话隔离、排队、停止、审批编号和重启恢复，以及定时任务并发、防重入、独立审批、时区/夏令时、超时、SQLite 恢复、推送限速/分段/重试和 Webhook 响应处理。测试使用模拟 Claude 和消息发送，不连接企业微信或调用模型。`npm run check` 检查本地配置和依赖。
