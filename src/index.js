import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { hostname } from 'node:os';
import { config, validateConfig } from './config.js';
import { ApprovalManager, renderApprovalPrompt } from './approval.js';
import { ClaudeSession } from './claude.js';
import { describeScope } from './guard.js';
import { analyzeBashCommand } from './bash-policy.js';

const log = {
  debug: (...a) => process.env.DEBUG && console.log('[debug]', ...a),
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

validateConfig();

const wsClient = new WSClient({
  botId: config.botId,
  secret: config.botSecret,
  logger: log,
});

const approvals = new ApprovalManager({
  logger: log,
  timeoutMs: config.approvalTimeoutMs,
});

/** chatKey -> ClaudeSession */
const sessions = new Map();

// ---------------------------------------------------------------------------
// 会话键与目标
// ---------------------------------------------------------------------------

function chatKeyOf(frame) {
  const body = frame.body ?? {};
  return body.chattype === 'group' ? `group:${body.chatid}` : `user:${body.from?.userid}`;
}

/**
 * 主动推送的目标：单聊填 userid，群聊填 chatid。
 * 审批提示、命令应答都走这里，避免和流式回复抢同一个 req_id。
 */
function targetOf(frame) {
  const body = frame.body ?? {};
  return body.chattype === 'group' ? body.chatid : body.from?.userid;
}

/** 主动推送一条 Markdown（不依赖 req_id） */
async function push(frame, content) {
  const target = targetOf(frame);
  if (!target) {
    log.warn('缺少推送目标，跳过消息');
    return;
  }
  try {
    await wsClient.sendMessage(target, {
      msgtype: 'markdown',
      markdown: { content },
    });
  } catch (err) {
    log.error('主动推送失败', err?.message ?? err);
  }
}

/** 兜底：用流式通道发一条即时结束的消息 */
async function replyOnce(frame, content) {
  try {
    await wsClient.replyStream(frame, generateReqId('stream'), content, true);
  } catch (err) {
    log.error('流式回复失败，改走主动推送', err?.message ?? err);
    await push(frame, content);
  }
}

// ---------------------------------------------------------------------------
// 流式进度：同一条消息原地刷新
// ---------------------------------------------------------------------------

class ProgressStream {
  constructor(frame) {
    this.frame = frame;
    this.streamId = generateReqId('stream');
    this.lines = [];
    this.started = false;
    this.closed = false;
    this.lastSentAt = 0;
  }

  /** 追加一行进度，节流发送 */
  async push(line) {
    if (this.closed) return;
    if (line) this.lines.push(line);
    const now = Date.now();
    if (this.started && now - this.lastSentAt < 2000) return;
    this.lastSentAt = now;
    this.started = true;
    await this.#send(this.#render(), false);
  }

  /** 结束流式消息，写入最终结果 */
  async finish(finalText) {
    if (this.closed) return;
    this.closed = true;
    const ok = await this.#send(finalText, true);
    if (!ok) {
      // 流式通道失败（例如超时），退回到主动推送
      await push(this.frame, finalText);
    }
  }

  async #send(content, finish) {
    try {
      await wsClient.replyStream(this.frame, this.streamId, content, finish);
      return true;
    } catch (err) {
      log.debug('流式发送失败', err?.message ?? err);
      return false;
    }
  }

  #render() {
    const tail = this.lines.slice(-8).join('\n');
    return `⏳ **执行中…**\n\n${tail}`;
  }
}

// ---------------------------------------------------------------------------
// 工具审批
// ---------------------------------------------------------------------------

async function handleToolPermission(frame, chatKey, toolName, input, opts) {
  // 硬性限制已由 PreToolUse 检查。auto 模式走到这里代表需要人工决定。
  if (config.permissionMode !== 'auto' && config.readOnlyTools.includes(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }

  // 纯只读的 Bash 命令（ls/cat/grep/git status…）同样直接放行；
  // 判定不了的从严，继续走审批。放在路径围栏之后，越界依然先被拦下。
  if (config.permissionMode !== 'auto' && toolName === 'Bash' && config.autoApproveReadOnlyBash) {
    const verdict = analyzeBashCommand(input?.command);
    if (verdict.readOnly) {
      log.debug(`[${chatKey}] 只读命令放行: ${input?.command}`);
      return { behavior: 'allow', updatedInput: input };
    }
    log.debug(`[${chatKey}] 需要审批的命令: ${input?.command}｜原因: ${verdict.reason}`);
  }

  await push(frame, renderApprovalPrompt(toolName, input, opts?.title));

  const { promise } = approvals.request({
    chatKey,
    title: opts?.title || `${toolName} 操作`,
    detail: input,
  });

  // 任务被 /stop 或 /reset 打断时，SDK 会直接中断，但审批 promise 没人 resolve，
  // 这里挂一个监听，保证它跟着一起结算，避免审批条目一直占着会话。
  const onAbort = () => approvals.cancel(chatKey, '任务已中止');
  opts?.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const { allowed, reason } = await promise;
    if (allowed) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `用户未批准该操作（${reason}）` };
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort);
  }
}

function toolLine(toolName, input) {
  const path = input?.file_path ?? input?.path ?? input?.url ?? '';
  if (toolName === 'Bash' && input?.command) {
    return `$ ${String(input.command).slice(0, 120)}`;
  }
  if (path) return `${toolName}: ${String(path).slice(0, 120)}`;
  return toolName;
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

async function handleUserText(frame) {
  const body = frame.body ?? {};
  const userId = body.from?.userid;
  const text = (body.text?.content ?? '').trim();

  if (!config.allowedUserIds.includes(userId)) {
    log.warn(`拒绝非白名单用户: ${userId}`);
    await push(frame, '⛔ 你不在这个机器人的白名单里，无法使用。');
    return;
  }

  if (!text) return;

  const chatKey = chatKeyOf(frame);

  // 命令
  if (text.startsWith('/')) {
    await handleCommand(frame, chatKey, text);
    return;
  }

  // 有待审批时，先把这句话当作对审批的答复
  if (approvals.hasPending(chatKey)) {
    const result = approvals.settleByReply(chatKey, text);
    if (result === 'approved') {
      await push(frame, '✅ 已同意，继续执行…');
      return;
    }
    if (result === 'denied') {
      await push(frame, '❌ 已拒绝。');
      return;
    }
    const pending = approvals.getPending(chatKey);
    await push(
      frame,
      `还有一条待审批操作：\n\n**${pending?.title ?? '未知操作'}**\n\n请回复 \`y\` 同意或 \`n\` 拒绝。`,
    );
    return;
  }

  const session = getSession(chatKey);
  if (session.isBusy()) {
    await push(frame, '⏳ 上一轮还在跑，发 `/stop` 可以打断。');
    return;
  }

  const progress = new ProgressStream(frame);
  await progress.push('已收到，开始处理…');

  // currentFrame 必须覆盖整轮运行——同一次运行里可能连续触发多次审批，
  // 每次都要能找回推送目标。
  session.currentFrame = frame;
  const prevOnEvent = session.onEvent;
  session.onEvent = (evt) => {
    if (evt.kind === 'tool_use') {
      progress.push(toolLine(evt.toolName, evt.input));
    }
  };

  log.info(`[${chatKey}] 输入: ${text.slice(0, 200)}`);

  try {
    const answer = await session.run(text);
    await progress.finish(answer || '（没有输出）');
  } catch (err) {
    log.error('执行失败', err);
    await progress.finish(`❌ 执行失败：${err?.message ?? String(err)}`);
  } finally {
    session.onEvent = prevOnEvent;
    session.currentFrame = null;
  }
}

async function handleCommand(frame, chatKey, text) {
  const [cmd] = text.slice(1).split(/\s+/);
  const session = getSession(chatKey);

  switch (cmd) {
    case 'reset':
    case 'clear': {
      const wasBusy = session.abort();
      approvals.cancel(chatKey, '用户重置会话');
      session.reset();
      await push(
        frame,
        wasBusy ? '🛑 已打断并开启新会话。' : '🧹 已开启新会话，之前的上下文已清空。',
      );
      return;
    }
    case 'stop': {
      const stopped = session.abort();
      approvals.cancel(chatKey, '用户主动中止');
      await push(frame, stopped ? '🛑 已请求停止当前任务。' : '当前没有正在执行的任务。');
      return;
    }
    case 'status': {
      await push(
        frame,
        [
          '**状态**',
          `- 工作目录：\`${config.workspace}\``,
          `- 权限模式：\`${config.permissionMode}\``,
          `- 会话：${session.sessionId ? '已有上下文' : '新会话'}`,
          `- 运行中：${session.isBusy() ? '是' : '否'}`,
          `- 待审批：${approvals.hasPending(chatKey) ? '有' : '无'}`,
        ].join('\n'),
      );
      return;
    }
    case 'help':
    case '?': {
      await push(
        frame,
        [
          '**可用命令**',
          '`/reset` 清空上下文，开新会话',
          '`/stop` 打断当前任务',
          '`/status` 查看当前状态',
          '`/help` 显示本帮助',
          '',
          `当前权限模式：${config.permissionMode}。需要人工审批时会发提示，回复 \`y\` / \`n\`。`,
        ].join('\n'),
      );
      return;
    }
    default:
      await push(frame, `未知命令 \`/${cmd}\`，发 \`/help\` 查看可用命令。`);
  }
}

function getSession(chatKey) {
  let session = sessions.get(chatKey);
  if (!session) {
    session = new ClaudeSession({
      chatKey,
      logger: log,
      onDenied: (reason) =>
        push(session.currentFrame, `🚫 **已拦截**：${reason}\n\n允许的目录：\`${describeScope(config.allowedPaths)}\``),
      canUseTool: (toolName, input, opts) =>
        handleToolPermission(session.currentFrame, chatKey, toolName, input, opts),
      onEvent: () => {},
    });
    sessions.set(chatKey, session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

wsClient.on('connected', () => log.info('WebSocket 已连接'));
wsClient.on('authenticated', () =>
  log.info(`认证成功｜工作目录 ${config.workspace}｜白名单 ${config.allowedUserIds.length} 人`),
);
wsClient.on('disconnected', (reason) => log.warn(`连接断开: ${reason}`));
wsClient.on('reconnecting', (attempt) => log.warn(`第 ${attempt} 次重连…`));
wsClient.on('error', (err) => log.error('连接错误', err?.message ?? err));

/** 事件入口：会话由 handleUserText 负责在整轮运行期间维护 currentFrame */
async function dispatch(frame) {
  await handleUserText(frame);
}

wsClient.on('message.text', (frame) => {
  dispatch(frame).catch((err) => log.error('处理消息异常', err));
});

wsClient.on('message.voice', async (frame) => {
  const body = frame.body ?? {};
  const converted = body.voice?.content ?? body.voice?.text ?? '';
  if (!converted) {
    await push(frame, '暂时只支持文字消息，语音转写结果为空。');
    return;
  }
  const synthetic = {
    ...frame,
    body: { ...body, text: { content: converted }, msgtype: 'text' },
  };
  await dispatch(synthetic);
});

wsClient.on('event.enter_chat', async (frame) => {
  try {
    await wsClient.replyWelcome(frame, {
      msgtype: 'text',
      text: {
        content: `你好，我是 ${hostname()} 上的 Claude Code 桥。直接发需求就行，发 /help 看命令。`,
      },
    });
  } catch (err) {
    log.warn('欢迎语发送失败', err?.message ?? err);
  }
});

// 回收空闲会话
setInterval(() => {
  for (const [key, session] of sessions) {
    if (!session.isBusy() && session.idleMs > config.sessionTtlMs) {
      sessions.delete(key);
      log.info(`回收空闲会话 ${key}`);
    }
  }
}, 60 * 1000).unref();

process.on('SIGINT', () => {
  log.info('收到中断信号，正在断开…');
  wsClient.disconnect();
  process.exit(0);
});
process.on('unhandledRejection', (err) => log.error('未处理的 Promise 拒绝', err));

log.info(`正在连接企业微信长连接…｜工作目录 ${config.workspace}`);
wsClient.connect();
