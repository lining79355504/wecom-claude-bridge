import { nextOccurrence } from './schedule-time.js';
import { splitMarkdown, redactSecrets } from './schedule-delivery.js';

export class ScheduleStore {
  constructor(ticketStore) {
    this.db = ticketStore.db;
    this.transaction = (fn) => ticketStore.transaction(fn);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_key TEXT NOT NULL, chat_target TEXT NOT NULL,
        created_by TEXT NOT NULL, prompt TEXT NOT NULL, workspace TEXT NOT NULL, rule TEXT NOT NULL,
        target_type TEXT NOT NULL, target TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0, next_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, deleted, next_at);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL REFERENCES schedules(id),
        scheduled_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', started_at INTEGER, finished_at INTEGER,
        result TEXT, error TEXT, session_id TEXT,
        UNIQUE(schedule_id, scheduled_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_one_active ON schedule_runs(schedule_id)
        WHERE state IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS schedule_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL UNIQUE REFERENCES schedule_runs(id),
        target_type TEXT NOT NULL, target TEXT NOT NULL, chunks TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_delivery_limits (
        target TEXT PRIMARY KEY, next_at INTEGER NOT NULL
      );
    `);
    // Never silently replay interrupted Claude operations, but retain completed results for delivery.
    for (const run of this.db.prepare("SELECT * FROM schedule_runs WHERE state = 'running'").all()) {
      this.finish(run.id, 'interrupted', '', '进程重启，上次执行已中断；请核查后使用 /schedule run 重试。');
    }
  }

  create({ chatKey, chatTarget, userId, prompt, workspace, rule, targetType, target }, now) {
    const id = this.db.prepare(`INSERT INTO schedules
      (chat_key, chat_target, created_by, prompt, workspace, rule, target_type, target, next_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chatKey, chatTarget, userId, prompt, workspace,
      JSON.stringify(rule), targetType, target, nextOccurrence(rule, now), now).lastInsertRowid;
    return this.get(Number(id));
  }

  get(id) { return this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id); }
  require(chatKey, id) {
    const schedule = this.get(id);
    if (!schedule || schedule.deleted || schedule.chat_key !== chatKey) throw new Error('定时任务不存在或不属于当前聊天。');
    return schedule;
  }
  list(chatKey) { return this.db.prepare('SELECT * FROM schedules WHERE chat_key = ? AND deleted = 0 ORDER BY id').all(chatKey); }
  pending(id) { return this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND state IN ('queued','running')").get(id); }
  run(id) { return this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id); }
  history(id) {
    return this.db.prepare(`SELECT r.*, o.state AS delivery_state, o.error AS delivery_error FROM schedule_runs r
      LEFT JOIN schedule_outbox o ON o.run_id = r.id WHERE r.schedule_id = ? ORDER BY r.id DESC LIMIT 10`).all(id);
  }

  enqueue(id, at) {
    if (this.pending(id)) throw new Error('该定时任务已有排队或执行中的运行。');
    // Manual triggers can share a millisecond; keep occurrence identities unique.
    while (this.db.prepare('SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND scheduled_at = ?').get(id, at)) at++;
    return Number(this.db.prepare('INSERT INTO schedule_runs(schedule_id, scheduled_at) VALUES (?, ?)').run(id, at).lastInsertRowid);
  }

  collectDue(now) {
    this.transaction(() => {
      const due = this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND deleted = 0 AND next_at <= ? ORDER BY next_at, id').all(now);
      for (const schedule of due) {
        if (!this.pending(schedule.id)) this.enqueue(schedule.id, schedule.next_at);
        // Coalesce missed occurrences; an active run never accumulates a backlog for itself.
        const next = nextOccurrence(JSON.parse(schedule.rule), now);
        this.db.prepare('UPDATE schedules SET next_at = ?, enabled = ? WHERE id = ?').run(next, next === null ? 0 : 1, schedule.id);
      }
    });
  }

  claim(now) {
    return this.transaction(() => {
      const run = this.db.prepare("SELECT * FROM schedule_runs WHERE state = 'queued' ORDER BY id LIMIT 1").get();
      if (!run) return null;
      this.db.prepare("UPDATE schedule_runs SET state = 'running', started_at = ? WHERE id = ?").run(now, run.id);
      return { ...run, state: 'running', schedule: this.get(run.schedule_id) };
    });
  }

  setSession(id, sessionId) { this.db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(sessionId, id); }

  finish(id, state, result = '', error = '', now = Date.now()) {
    const save = () => {
      const run = this.run(id);
      const schedule = this.get(run.schedule_id);
      result = redactSecrets(result);
      error = redactSecrets(error);
      this.db.prepare('UPDATE schedule_runs SET state = ?, result = ?, error = ?, finished_at = ? WHERE id = ?')
        .run(state, result, error, now, id);
      if (schedule.deleted || state === 'cancelled') return;
      const content = `**定时任务 #${schedule.id} · 运行 #${id} · ${state === 'succeeded' ? '完成' : '未完成'}**\n\n${result || error || '（没有输出）'}${result && error ? `\n\n${error}` : ''}`;
      this.db.prepare(`INSERT OR IGNORE INTO schedule_outbox(run_id, target_type, target, chunks, next_at)
        VALUES (?, ?, ?, ?, ?)`).run(id, schedule.target_type, schedule.target, JSON.stringify(splitMarkdown(content)), now);
    };
    this.transaction(save);
  }

  pause(id, deleted = false) {
    this.transaction(() => {
      this.db.prepare('UPDATE schedules SET enabled = 0, deleted = ? WHERE id = ?').run(deleted ? 1 : 0, id);
      this.db.prepare("UPDATE schedule_runs SET state = 'cancelled', finished_at = ? WHERE schedule_id = ? AND state = 'queued'").run(Date.now(), id);
      if (deleted) this.db.prepare(`UPDATE schedule_outbox SET state = 'cancelled' WHERE run_id IN
        (SELECT id FROM schedule_runs WHERE schedule_id = ?) AND state IN ('pending', 'failed')`).run(id);
    });
  }
  resume(id, now) {
    const next = nextOccurrence(JSON.parse(this.get(id).rule), now);
    if (next === null) throw new Error('单次任务时间已过，请用 /schedule run 手动运行或创建新任务。');
    this.db.prepare('UPDATE schedules SET enabled = 1, next_at = ? WHERE id = ?').run(next, id);
  }
  cancelQueued(id, now) {
    this.db.prepare("UPDATE schedule_runs SET state = 'cancelled', finished_at = ? WHERE schedule_id = ? AND state = 'queued'").run(now, id);
  }

  deliveries(now) {
    return this.db.prepare(`SELECT o.* FROM schedule_outbox o LEFT JOIN schedule_delivery_limits l ON l.target = o.target
      WHERE o.state = 'pending' AND o.next_at <= ? AND (l.next_at IS NULL OR l.next_at <= ?) ORDER BY o.id`).all(now, now);
  }
  reserveDelivery(target, now) {
    // At most one chunk per target every 3.1 s, including retries and after restart.
    this.db.prepare(`INSERT INTO schedule_delivery_limits(target, next_at) VALUES (?, ?)
      ON CONFLICT(target) DO UPDATE SET next_at = excluded.next_at`).run(target, now + 3100);
  }
  delivered(row) {
    const cursor = row.cursor + 1;
    this.db.prepare('UPDATE schedule_outbox SET cursor = ?, state = ?, attempts = 0, error = NULL WHERE id = ? AND state = \'pending\'')
      .run(cursor, cursor >= JSON.parse(row.chunks).length ? 'sent' : 'pending', row.id);
  }
  deliveryFailed(row, now, error) {
    const attempts = row.attempts + 1;
    this.db.prepare("UPDATE schedule_outbox SET state = ?, attempts = ?, next_at = ?, error = ? WHERE id = ? AND state = 'pending'")
      .run(attempts >= 5 ? 'failed' : 'pending', attempts, now + Math.min(60000, 5000 * 2 ** (attempts - 1)), redactSecrets(error), row.id);
  }
  retryDelivery(chatKey, runId, now) {
    const run = this.run(runId);
    if (!run) throw new Error('运行记录不存在。');
    this.require(chatKey, run.schedule_id);
    const result = this.db.prepare("UPDATE schedule_outbox SET state = 'pending', attempts = 0, next_at = ?, error = NULL WHERE run_id = ? AND state = 'failed'").run(now, runId);
    if (!result.changes) throw new Error('该运行没有重试耗尽的推送。');
  }
}
