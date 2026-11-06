# wecom-claude-bridge

用企业微信智能机器人的长连接，远程操控本机的 Claude Code 写代码。

你在企微里发一句话，本机 Claude Code 在指定仓库里干活，过程实时流式回吐到聊天窗口。

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

先留空 `WECOM_ALLOWED_USER_IDS`，直接启动（会启动失败，这是故意的），或者用默认值先跑一次——日志里会打出：

```
[warn] 拒绝非白名单用户: wo_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

把这串填进白名单。**这一步别跳过**，否则任何能给机器人发消息的人都能在你电脑上执行代码。

**3. 工作目录**

`CLAUDE_WORKSPACE` 填你想让 Claude 操作的仓库绝对路径，比如 `/Users/mort/`。必须是具体目录，不能用 `~` 或 `/`。

## 自检 + 启动

```bash
npm run check   # 检查配置、依赖、工作目录、claude CLI
npm start
```

看到 `认证成功` 就可以在企微里发消息了。

## 用法

直接发消息就是对话，支持多轮（靠 `resume` 保持上下文）：

| 消息 | 效果 |
|---|---|
| `看一下 scv 里 XxxService 干嘛的` | Claude 读代码并解释 |
| `给 AdMediaService 加个按 adMediaId 查询的方法` | 会先发审批，`y` 后才改 |
| `/reset` | 清空上下文开新会话 |
| `/stop` | 打断当前任务 |
| `/status` | 看工作目录、会话状态、待审批 |
| `/help` | 命令列表 |

## 权限模型

「只读优先 + 改文件二次确认」，分三层：

**第一层 · 目录围栏**（自动，无审批机会）

Claude 只能在 `CLAUDE_WORKSPACE`（或 `CLAUDE_ALLOWED_PATHS`）范围内读写。越界操作直接拒绝并通知你：

```
🚫 已拦截：/Users/mort/.ssh/id_rsa 不在允许的目录范围内
```

这层拦住的是「模型跑偏到别的仓库」或「顺手改了点不该改的」，不是沙箱。`Bash` 命令里的绝对路径也会检查，但只能拦住明显的越界（比如 `~` 不会展开，就抓不到）。

**第二层 · 只读放行**

`READ_ONLY_TOOLS` 里的工具（Read / Glob / Grep / WebSearch 等）不打扰你，直接执行。

**第三层 · 逐次审批**

其余一切（Write / Edit / Bash / 未知工具）都会把工具名和参数发到企微，你回 `y` 或 `n`：

```
**Claude 请求执行操作**

`Bash`

git push origin master --force

回复 y 同意，n 拒绝（5 分钟无响应自动拒绝）。
```

- 5 分钟不回复 = 自动拒绝。
- 有待审批时，你的下一条消息优先当作 `y`/`n` 答复，不会误触发新任务。
- 发 `/stop` 会同时打断执行和取消审批。

调整严格程度改 `.env` 即可，不用动代码：

| 想要 | 怎么配 |
|---|---|
| 更严格（连读文件也审批） | `READ_ONLY_TOOLS=` （留空） |
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
├── index.js       # 长连接、事件分发、流式进度、命令
├── claude.js      # Claude Agent SDK 封装（query + resume + abort）
├── approval.js    # 审批队列与提示渲染
├── guard.js       # 路径围栏
└── config.js      # .env 解析与校验
scripts/
└── check.js       # 启动前自检
```

## 已知限制

- 只能处理文本和语音（语音用企微自带的转写结果）；发图片/文件会被忽略。
- 群聊里所有人共享一个 Claude 会话上下文。
- 单轮默认最多 30 个 agent 圈数，超了会中断。
