import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUS = {
  open: '待处理', queued: '排队中', running: '执行中', approval: '待审批',
  review: '待验收', stopped: '已中止', failed: '执行失败', closed: '已关闭',
};

/** 单个桥接进程使用的持久化工单库。队列不保存过期的企微请求帧。 */
export class TicketStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL, title TEXT NOT NULL, workspace TEXT NOT NULL,
        created_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tickets_chat ON tickets(chat_key, id);
      CREATE TABLE IF NOT EXISTS selections (
        chat_key TEXT PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_id, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        message_id INTEGER NOT NULL REFERENCES messages(id), state TEXT NOT NULL DEFAULT 'queued',
        recovered INTEGER NOT NULL DEFAULT 0
      );
    `);
    // 不自动重放重启前的操作。用户 /resume 后才恢复，旧审批一律失效。
    this.transaction(() => {
      this.db.exec("UPDATE jobs SET state = 'paused', recovered = 1 WHERE state IN ('queued', 'running')");
      this.db.prepare("UPDATE tickets SET status = 'stopped', updated_at = ? WHERE status IN ('running', 'approval', 'queued')")
        .run(Date.now());
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  create(chatKey, userId, title, workspace) {
    return this.transaction(() => {
      const now = Date.now();
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO tickets
        (chat_key, created_by, title, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(chatKey, userId, title.replace(/\s+/g, ' ').slice(0, 80), workspace, now, now);
      return this.select(chatKey, Number(lastInsertRowid));
    });
  }

  get(id) { return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }

  require(chatKey, id) {
    const ticket = this.get(id);
    if (!ticket || ticket.chat_key !== chatKey) throw new Error('工单不存在或不属于当前聊天。');
    return ticket;
  }

  current(chatKey) {
    return this.db.prepare(`SELECT t.* FROM selections s JOIN tickets t ON t.id = s.ticket_id
      WHERE s.chat_key = ? AND t.chat_key = ?`).get(chatKey, chatKey);
  }

  select(chatKey, id) {
    const ticket = this.require(chatKey, id);
    this.db.prepare(`INSERT INTO selections (chat_key, ticket_id) VALUES (?, ?)
      ON CONFLICT(chat_key) DO UPDATE SET ticket_id = excluded.ticket_id`).run(chatKey, id);
    return ticket;
  }

  list(chatKey) {
    return this.db.prepare('SELECT * FROM tickets WHERE chat_key = ? ORDER BY id DESC LIMIT 20').all(chatKey);
  }

  setStatus(id, status) {
    if (!STATUS[status]) throw new Error(`未知工单状态: ${status}`);
    this.db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  setSession(id, sessionId) {
    this.db.prepare('UPDATE tickets SET session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, Date.now(), id);
  }

  addMessage(id, role, content) {
    return Number(this.db.prepare('INSERT INTO messages (ticket_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(id, role, content, Date.now()).lastInsertRowid);
  }

  history(id, limit = 10) {
    return this.db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id DESC LIMIT ?').all(id, limit).reverse();
  }

  initialRequest(id) {
    return this.db.prepare("SELECT content FROM messages WHERE ticket_id = ? AND role = 'user' ORDER BY id LIMIT 1")
      .get(id)?.content;
  }

  enqueue(id, content) {
    return this.transaction(() => {
      const messageId = this.addMessage(id, 'user', content);
      const jobId = Number(this.db.prepare('INSERT INTO jobs (ticket_id, message_id) VALUES (?, ?)').run(id, messageId).lastInsertRowid);
      if (!['running', 'approval'].includes(this.get(id).status)) this.setStatus(id, 'queued');
      return jobId;
    });
  }

  nextJob() {
    return this.db.prepare(`SELECT j.*, m.content FROM jobs j JOIN messages m ON m.id = j.message_id
      WHERE j.state = 'queued' ORDER BY j.id LIMIT 1`).get();
  }

  jobState(id, state) {
    this.db.prepare("UPDATE jobs SET state = ?, recovered = CASE WHEN ? = 'paused' THEN 1 ELSE recovered END WHERE id = ?")
      .run(state, state, id);
  }

  pending(id) {
    return this.db.prepare("SELECT id, state FROM jobs WHERE ticket_id = ? AND state IN ('queued', 'running', 'paused') ORDER BY id").all(id);
  }

  cancelQueued(id) {
    const jobs = this.pending(id).filter((j) => j.state !== 'running');
    this.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE ticket_id = ? AND state IN ('queued', 'paused')").run(id);
    return jobs;
  }

  resume(id) {
    const jobs = this.pending(id).filter((j) => j.state === 'paused');
    this.db.prepare("UPDATE jobs SET state = 'queued' WHERE ticket_id = ? AND state = 'paused'").run(id);
    if (jobs.length) this.setStatus(id, 'queued');
    return jobs;
  }

  close() { this.db.close(); }
}
