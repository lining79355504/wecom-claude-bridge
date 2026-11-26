import { redactSecrets } from './schedule-delivery.js';

/** 截断后仍为有效 UTF-8，防止中文进度超出企微消息限制。 */
export function progressPreview(value, limit) {
  const text = redactSecrets(String(value));
  if (Buffer.byteLength(text) <= limit) return text;
  let result = '', size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > limit - 3) break;
    result += char;
    size += bytes;
  }
  return result + '…';
}

/** 仅展示公开文本、工具调用和工具文本结果，不透传内部思维链。 */
export function formatProgressEvent(event, verbose) {
  if (event.kind === 'assistant_text' && verbose && event.text?.trim()) {
    return progressPreview(`说明：${event.text.trim()}`, 256 * 1024);
  }
  if (event.kind === 'tool_result' && verbose && event.text?.trim()) {
    return progressPreview(`${event.isError ? '工具错误' : '工具结果'}：${event.text}`, 256 * 1024);
  }
  if (event.kind === 'tool_use') {
    const input = event.input;
    const detail = input?.command ?? input?.file_path ?? input?.path ?? '';
    return progressPreview(`${event.toolName}: ${String(detail)}`, verbose ? 256 * 1024 : 180);
  }
  return null;
}

/** 串行更新同一条流式消息，节流期间的新进度在计时结束后补发。 */
export class ProgressStream {
  constructor({ ticketId, streamId, reply, fallback, details, intervalMs = 2000, now = Date.now }) {
    Object.assign(this, { ticketId, streamId, reply, fallback, details, intervalMs, now });
    this.lines = [];
    this.closed = false;
    this.started = false;
    this.lastSentAt = 0;
    this.timer = null;
    this.pending = Promise.resolve();
    this.cardAttempted = false;
  }

  async push(line, { collapsed = false } = {}) {
    if (this.closed) return;
    if (collapsed && this.details) {
      await this.details.push(line);
      // 卡片和正文通过同一 stream_id 发送，不主动推送第二条卡片消息。
      if (!this.cardAttempted && !this.closed) return this.flush();
      return;
    }
    if (line) this.lines.push(progressPreview(line, 600));
    this.lines = this.lines.slice(-8);
    while (this.lines.length > 1 && Buffer.byteLength(this.lines.join('\n\n')) > 3000) this.lines.shift();
    const delay = this.started ? this.intervalMs - (this.now() - this.lastSentAt) : 0;
    if (delay > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.closed) this.flush();
        }, delay);
        this.timer.unref?.();
      }
      return;
    }
    return this.flush();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.started = true;
    this.lastSentAt = this.now();
    // 真正发送时取最新内容；已完成时跳过尚未发送的中间进度。
    this.pending = this.pending.then(async () => {
      if (!this.closed) await this.send(`⏳ **工单 #${this.ticketId} 执行中…**\n\n${this.lines.join('\n\n')}`, false);
    });
    return this.pending;
  }

  async finish(finalText) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.pending;
    const displayed = Buffer.byteLength(finalText) > 3800
      ? progressPreview(finalText, 3650) + '\n\n（结果过长，完整结果已保存在工单记录中。）' : finalText;
    if (!await this.send(displayed, true)) await this.fallback(displayed);
    await this.details?.finish();
  }

  async send(content, finish) {
    try {
      const templateCard = !this.cardAttempted ? this.details?.card() : undefined;
      // 回执失败也不能确定卡片未送达，避免重复附加违反同消息仅一次的限制。
      if (templateCard) this.cardAttempted = true;
      await this.reply(this.streamId, content, finish, templateCard);
      return true;
    } catch { return false; }
  }
}
