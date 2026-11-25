import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { hostname } from 'node:os';
import { config, validateConfig } from './config.js';
import { ClaudeSession } from './claude.js';
import { TicketStore } from './tickets.js';
import { TicketBot } from './ticket-bot.js';
import { ScheduleStore } from './schedule-store.js';
import { Scheduler } from './scheduler.js';
import { redactSecrets } from './schedule-delivery.js';
import { ImageService } from './images.js';
import { createMessageHandler } from './incoming.js';

const safeLog = (args) => args.map((value) => typeof value === 'string' ? redactSecrets(value)
  : value instanceof Error ? redactSecrets(value.stack || value.message) : value);

const log = {
  debug: (...a) => process.env.DEBUG && console.log('[debug]', ...safeLog(a)),
  info: (...a) => console.log('[info]', ...safeLog(a)),
  warn: (...a) => console.warn('[warn]', ...safeLog(a)),
  error: (...a) => console.error('[error]', ...safeLog(a)),
};

validateConfig();

const wsClient = new WSClient({
  botId: config.botId,
  secret: config.botSecret,
  logger: log,
});

const store = new TicketStore(config.ticketDbPath);
let chatReady = false;
const scheduler = new Scheduler({
  store: new ScheduleStore(store), config, logger: log,
  createSession: (options) => new ClaudeSession(options),
  sendChat: sendTo, isChatReady: () => chatReady,
});
const bot = new TicketBot({
  store,
  config,
  logger: log,
  send: push,
  createProgress: (frame, ticket) => new ProgressStream(frame, ticket.id),
  createSession: (options) => new ClaudeSession(options),
  scheduler,
  imageService: new ImageService({ client: wsClient, allowedPaths: config.allowedPaths }),
});

// ---------------------------------------------------------------------------
// 会话键与目标
// ---------------------------------------------------------------------------

/**
 * 主动推送的目标：单聊填 userid，群聊填 chatid。
 * 审批提示、命令应答都走这里，避免和流式回复抢同一个 req_id。
 */
function targetOf(frame) {
  const body = frame?.body ?? {};
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

/** Scheduled delivery must observe send failures so the durable outbox can retry. */
async function sendTo(target, content) {
  if (!chatReady) throw new Error('企微长连接尚未认证。');
  await wsClient.sendMessage(target, { msgtype: 'markdown', markdown: { content } });
}

// ---------------------------------------------------------------------------
// 流式进度：同一条消息原地刷新
// ---------------------------------------------------------------------------

class ProgressStream {
  constructor(frame, ticketId) {
    this.frame = frame;
    this.ticketId = ticketId;
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
    return `⏳ **工单 #${this.ticketId} 执行中…**\n\n${tail}`;
  }
}

// 白名单校验覆盖所有输入，图片下载发生在鉴权之后。
const dispatch = createMessageHandler({ config, bot, send: push, logger: log });

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

wsClient.on('connected', () => log.info('WebSocket 已连接'));
wsClient.on('authenticated', () => {
  chatReady = true;
  log.info(`认证成功｜工作目录 ${config.workspace}｜白名单 ${config.allowedUserIds.length} 人`);
  scheduler.tick();
});
wsClient.on('disconnected', (reason) => {
  chatReady = false;
  log.warn(`连接断开: ${reason}`);
});
wsClient.on('reconnecting', (attempt) => log.warn(`第 ${attempt} 次重连…`));
wsClient.on('error', (err) => log.error('连接错误', err?.message ?? err));

for (const type of ['text', 'voice', 'image', 'mixed']) {
  wsClient.on(`message.${type}`, (frame) => {
    dispatch(frame).catch(() => log.error('处理消息异常'));
  });
}

wsClient.on('event.enter_chat', async (frame) => {
  try {
    await wsClient.replyWelcome(frame, {
      msgtype: 'text',
      text: {
        content: `你好，我是 ${hostname()} 上的 Claude Code 桥。发送 /new 需求 创建工单，发 /help 看命令。`,
      },
    });
  } catch (err) {
    log.warn('欢迎语发送失败', err?.message ?? err);
  }
});

// 只回收内存缓存，工单和 Claude sessionId 保留在数据库中。
setInterval(() => bot.evictIdle(), 60 * 1000).unref();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log.info('正在停止工单执行并断开连接…');
  bot.shutdown();
  const scheduledShutdown = scheduler.shutdown();
  // SDK 正常退出后关闭数据库；卡住时由下次启动恢复未完成队列。
  const timeout = setTimeout(() => process.exit(0), 10000);
  await Promise.all([bot.drainPromise, scheduledShutdown]);
  clearTimeout(timeout);
  wsClient.disconnect();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => log.error('未处理的 Promise 拒绝', err));

log.info(`正在连接企业微信长连接…｜工作目录 ${config.workspace}`);
wsClient.connect();
scheduler.start();
