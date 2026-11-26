import { randomUUID } from 'node:crypto';
import { progressPreview } from './progress.js';
import { splitMarkdown } from './schedule-delivery.js';

export const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const TRUNCATED = '（本轮过程已达 256 KiB 上限，后续过程不再保存。）';

/** 每轮公开输出分页存储；卡片作为流式回复的一部分，仅点击时更新。 */
export class ProgressCards {
  constructor({ store, client, config, logger }) {
    Object.assign(this, { store, client, config, logger });
    store.db.exec(`CREATE TABLE IF NOT EXISTS progress_cards (
      id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      lines TEXT NOT NULL DEFAULT '[]'
    )`);
  }

  get(id) {
    const row = this.store.db.prepare(`SELECT p.*, t.chat_key, j.state FROM progress_cards p
      JOIN tickets t ON t.id = p.ticket_id JOIN jobs j ON j.id = p.job_id WHERE p.id = ?`).get(id);
    return row ? { ...row, lines: JSON.parse(row.lines) } : null;
  }

  render(row, expanded = false, requestedPage = 0) {
    const pages = splitMarkdown(row.lines.join('\n\n') || '暂无过程记录。', 900);
    const page = Math.max(0, Math.min(requestedPage, pages.length - 1));
    const running = ['queued', 'running'].includes(row.state);
    const button = (text, action) => ({ text, key: `progress:${row.id}:${action}` });
    const card = {
      card_type: 'button_interaction', task_id: row.id,
      main_title: { title: `工单 #${row.ticket_id} · 执行过程`, desc: '执行说明、工具调用与文本结果' },
      sub_title_text: expanded
        ? `${running ? '执行中' : '本轮已结束或暂停'} · 第 ${page + 1}/${pages.length} 页`
        : '过程已收起，点击展开查看。',
      button_list: expanded ? [
        ...(page > 0 ? [button('上一页', `page-${page - 1}`)] : []),
        ...(page < pages.length - 1 ? [button('下一页', `page-${page + 1}`)] : []),
        button('刷新', `page-${page}`), button('最新', 'latest'), button('收起', 'collapse'),
      ] : [button('展开过程', 'expand')],
    };
    if (expanded) card.quote_area = { type: 0, title: '过程记录', quote_text: pages[page] };
    return card;
  }

  forRun(ticket, job) {
    let id = null;
    return {
      push: async (line) => {
        if (!id) {
          id = `progress-${randomUUID()}`;
          this.store.db.prepare('INSERT INTO progress_cards (id, ticket_id, job_id) VALUES (?, ?, ?)')
            .run(id, ticket.id, job.id);
        }
        const row = this.get(id);
        if (row.lines.at(-1) === TRUNCATED) return;
        const used = Buffer.byteLength(row.lines.join('\n\n'));
        const remaining = MAX_TRANSCRIPT_BYTES - used - Buffer.byteLength(TRUNCATED) - 4;
        const text = progressPreview(line, MAX_TRANSCRIPT_BYTES);
        if (Buffer.byteLength(text) <= remaining) row.lines.push(text);
        else {
          if (remaining > 3) row.lines.push(progressPreview(text, remaining));
          row.lines.push(TRUNCATED);
        }
        this.store.db.prepare('UPDATE progress_cards SET lines = ? WHERE id = ?').run(JSON.stringify(row.lines), id);
      },
      card: () => id ? this.render(this.get(id)) : undefined,
      finish: async () => {},
    };
  }

  async handle(frame) {
    const body = frame.body ?? {}, event = body.event ?? {};
    // 同时兼容实际嵌套回调和 SDK 声明的顶层格式。
    const data = event.template_card_event ?? event;
    const match = /^progress:(progress-[a-f0-9-]{36}):(expand|collapse|latest|page-\d{1,6})$/.exec(data.event_key ?? '');
    if (!match) return false;
    const userId = body.from?.userid;
    if (!this.config.allowedUserIds.includes(userId) || data.task_id !== match[1]) return false;
    const row = this.get(match[1]);
    const chatKey = body.chattype === 'group' ? `group:${body.chatid}` : `user:${userId}`;
    if (!row || row.chat_key !== chatKey) return false;
    const action = match[2];
    const page = action === 'latest' ? Infinity : action.startsWith('page-') ? Number(action.slice(5)) : 0;
    try {
      await this.client.updateTemplateCard(frame, this.render(row, action !== 'collapse', page), [userId]);
    } catch {
      this.logger.warn('更新过程卡片失败，请重新点击');
    }
    return true;
  }
}
