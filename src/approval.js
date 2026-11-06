import { randomUUID } from 'node:crypto';

/**
 * 审批队列：Claude 想执行危险操作时挂起，等用户在企微里回 y/n。
 *
 * 同一时间一个会话只允许一个待审批请求——Claude 本身是串行执行工具的，
 * 多个待审批只会让人分不清在回哪一条。
 */
export class ApprovalManager {
  /**
   * @param {object} opts
   * @param {{warn: Function}} opts.logger
   * @param {number} opts.timeoutMs 等待超时，超时按拒绝处理
   */
  constructor({ logger, timeoutMs = 5 * 60 * 1000 }) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, Pending>} chatKey -> pending */
    this.pending = new Map();
  }

  /**
   * 创建一条待审批请求，返回一个 promise，用户回复后 resolve。
   * @returns {{ id: string, promise: Promise<boolean> }}
   */
  request({ chatKey, title, detail }) {
    // 同一会话已有待审批：先拒绝旧的，避免队列堆积
    this.cancel(chatKey, '被新的审批请求取代');

    const id = randomUUID().slice(0, 8);
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    const timer = setTimeout(() => {
      this.logger.warn(`审批超时，按拒绝处理: ${title}`);
      this.settle(chatKey, id, false, '审批超时');
    }, this.timeoutMs);
    timer.unref?.();

    this.pending.set(chatKey, {
      id,
      title,
      detail,
      resolve: resolveFn,
      timer,
      createdAt: Date.now(),
    });

    return { id, promise };
  }

  hasPending(chatKey) {
    return this.pending.has(chatKey);
  }

  getPending(chatKey) {
    return this.pending.get(chatKey) ?? null;
  }

  /**
   * 用用户回复的内容结算待审批请求。
   * @returns {'approved'|'denied'|'unrecognized'|null}
   */
  settleByReply(chatKey, text) {
    const pending = this.pending.get(chatKey);
    if (!pending) return null;

    const answer = text.trim().toLowerCase();
    if (['y', 'yes', '是', '好', '同意', '可以', 'ok', '1'].includes(answer)) {
      this.settle(chatKey, pending.id, true, '用户同意');
      return 'approved';
    }
    if (['n', 'no', '否', '不', '不要', '拒绝', '取消', '0'].includes(answer)) {
      this.settle(chatKey, pending.id, false, '用户拒绝');
      return 'denied';
    }
    return 'unrecognized';
  }

  /** 用户想中止当前任务 */
  cancel(chatKey, reason) {
    this.settle(chatKey, null, false, reason);
  }

  settle(chatKey, id, allowed, reason) {
    const pending = this.pending.get(chatKey);
    if (!pending) return;
    if (id !== null && pending.id !== id) return;
    clearTimeout(pending.timer);
    this.pending.delete(chatKey);
    pending.resolve({ allowed, reason });
  }
}

/** 把工具调用渲染成企微里能看懂的一段文字 */
export function renderApprovalPrompt(toolName, input, title) {
  const lines = [];
  lines.push(`**Claude 请求执行操作**`);
  if (title) lines.push(title);
  lines.push('');
  lines.push(`\`${toolName}\``);

  const preview = renderToolInput(toolName, input);
  if (preview) {
    lines.push('');
    lines.push('```');
    lines.push(preview);
    lines.push('```');
  }

  lines.push('');
  lines.push('回复 `y` 同意，`n` 拒绝（5 分钟无响应自动拒绝）。');
  return lines.join('\n');
}

function truncate(s, max = 1200) {
  const text = String(s);
  return text.length > max ? `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）` : text;
}

function renderToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';

  if (toolName === 'Bash') {
    return truncate(input.command ?? '');
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const path = input.file_path ?? input.path ?? '';
    const body =
      toolName === 'Write'
        ? input.content
        : input.old_string !== undefined
          ? `${input.old_string}\n  →\n${input.new_string}`
          : '';
    return truncate(`${path}\n\n${body ?? ''}`);
  }
  if (toolName === 'WebFetch') return truncate(input.url ?? '');
  return truncate(JSON.stringify(input, null, 2));
}
