import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';
import { ScheduleStore } from '../src/schedule-store.js';
import { Scheduler, parseAdd } from '../src/scheduler.js';
import { parseRule, nextOccurrence } from '../src/schedule-time.js';
import { sendWebhook, splitMarkdown, validateWebhook } from '../src/schedule-delivery.js';

const epoch = Date.parse('2026-11-18T00:00:00Z');
const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function harness(t, options = {}) {
  const tickets = options.tickets ?? new TicketStore(':memory:');
  const store = new ScheduleStore(tickets);
  const sent = [], sessions = [], errors = [], replies = [];
  let now = epoch;
  const config = {
    workspace: process.cwd(), allowedPaths: [process.cwd()], allowedUserIds: ['a', 'b'],
    scheduleTimezone: 'Asia/Shanghai', scheduleConcurrency: 2, scheduleDeliveryConcurrency: 2,
    scheduleMaxTurns: 100,
    scheduleTimeoutMs: 100000, approvalTimeoutMs: 100000, permissionMode: 'auto', readOnlyTools: [],
    ...options.config,
  };
  const scheduler = new Scheduler({
    store, config, now: () => now,
    logger: { error: (...args) => errors.push(args), warn() {} },
    sendChat: options.sendChat ?? (async (target, text) => sent.push({ target, text })),
    isChatReady: options.isChatReady,
    webhookSender: options.webhookSender ?? (async (target, text) => sent.push({ target, text })),
    createSession: (args) => {
      const cancelled = deferred();
      const session = {
        ...args,
        abort() { this.aborted = true; cancelled.resolve(); },
        async run(prompt) {
          this.prompt = prompt;
          args.onSessionId(`session-${args.chatKey}`);
          return Promise.race([
            options.run ? options.run(prompt, this) : Promise.resolve('完成'),
            cancelled.promise.then(() => { throw new Error('aborted'); }),
          ]);
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await scheduler.shutdown();
    tickets.close();
    assert.deepEqual(errors, [], 'background errors');
  });
  const add = (overrides = {}) => store.create({
    chatKey: 'user:a', chatTarget: 'a', userId: 'a', prompt: '汇总', workspace: config.workspace,
    rule: parseRule('every', '1m'), targetType: 'chat', target: 'a', ...overrides,
  }, now);
  const command = (text, chatKey = 'user:a', userId = 'a') => scheduler.handle({
    chatKey, userId, text,
    frame: { body: { from: { userid: userId }, chattype: 'single' } },
    reply: async (_frame, text) => replies.push(text),
  });
  return { tickets, store, scheduler, config, sent, sessions, replies, add, command,
    advance(ms) { now += ms; }, tick() { scheduler.tick(); }, now: () => now };
}

test('同一时刻多个任务并发，慢任务不阻塞其他任务，且遵守并发上限', async (t) => {
  const gate = deferred();
  let live = 0, maximum = 0;
  const h = harness(t, { run: async (_prompt, session) => {
    live++; maximum = Math.max(maximum, live);
    try { if (session.chatKey.includes('/schedule:1/')) await gate.promise; return '完成'; }
    finally { live--; }
  } });
  t.after(() => gate.resolve());
  for (let i = 0; i < 5; i++) h.add();
  h.advance(60000); h.tick();
  await flush();
  assert.equal(maximum, 2);
  assert.equal(h.sessions.length, 5);
  assert.equal(h.store.history(1)[0].state, 'running');
  for (let i = 2; i <= 5; i++) assert.equal(h.store.history(i)[0].state, 'succeeded');
  assert.equal(new Set(h.sessions.map((s) => s.chatKey)).size, 5);
  assert.equal(h.tickets.current('user:a'), undefined);
  gate.resolve(); await flush();
});

test('同任务不重入，漏过的周期合并，不积压补跑', async (t) => {
  const gate = deferred();
  const h = harness(t, { run: () => gate.promise });
  h.add();
  h.advance(60000); h.tick(); h.tick();
  await assert.rejects(h.command('run 1'), /已有排队或执行/);
  h.advance(10 * 60000); h.tick();
  assert.equal(h.store.history(1).length, 1);
  assert.equal(h.store.get(1).next_at, h.now() + 60000);
  gate.resolve('完成'); await flush();
  assert.equal(h.sessions.length, 1);
  h.advance(60000); h.tick(); await flush();
  assert.equal(h.sessions.length, 2);
});

test('慢 Webhook 不占执行槽，其他目标独立推送', async (t) => {
  const gate = deferred();
  const targets = [];
  const h = harness(t, { webhookSender: async (target) => { targets.push(target); await gate.promise; } });
  t.after(() => gate.resolve());
  h.add({ targetType: 'webhook', target: webhook });
  h.add({ target: 'b' });
  h.advance(60000); h.tick(); await flush();
  assert.equal(h.scheduler.active.size, 0);
  assert.equal(h.scheduler.delivering.size, 1);
  assert.equal(targets.length, 1);
  assert.equal(h.sent[0].target, 'b');
  gate.resolve(); await flush();
});

test('失败重试只重发保存结果，校验五次上限和手动重试', async (t) => {
  let calls = 0, succeeds = false;
  const h = harness(t, { webhookSender: async () => { calls++; if (!succeeds) throw new Error('HTTP failure'); } });
  h.add({ targetType: 'webhook', target: webhook });
  await h.command('run 1'); await flush();
  await h.command('pause 1');
  for (let i = 0; i < 4; i++) { h.advance(61000); h.tick(); await flush(); }
  assert.equal(calls, 5);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.store.history(1)[0].delivery_state, 'failed');
  succeeds = true;
  h.advance(61000);
  await assert.rejects(h.command('retry 1', 'user:b', 'b'), /不属于当前聊天/);
  await h.command('retry 1'); await flush();
  assert.equal(calls, 6);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.store.history(1)[0].delivery_state, 'sent');
});

test('同目标长结果按 UTF-8 分段发送并限速，失败从未确认段恢复', async (t) => {
  const content = '中文🙂'.repeat(1300);
  let calls = 0;
  const h = harness(t, { run: async () => content, webhookSender: async () => {
    if (++calls === 2) throw new Error('network');
  } });
  h.add({ targetType: 'webhook', target: webhook });
  await h.command('run 1'); await flush();
  assert.equal(calls, 1);
  h.advance(3000); h.tick(); await flush(); assert.equal(calls, 1);
  h.advance(100); h.tick(); await flush(); assert.equal(calls, 2);
  let row = h.tickets.db.prepare('SELECT * FROM schedule_outbox').get();
  assert.equal(row.cursor, 1);
  h.advance(5000); h.tick(); await flush();
  row = h.tickets.db.prepare('SELECT * FROM schedule_outbox').get();
  assert.equal(row.cursor, 2);
  const parts = JSON.parse(row.chunks);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 3800));
  assert.ok(parts.join('').endsWith(content));
  assert.equal(splitMarkdown(content).join(''), content);
});

test('重启恢复排队和待推送结果，中断的执行不会自动重跑', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite');
  const before = new TicketStore(path);
  const store = new ScheduleStore(before);
  for (let i = 0; i < 3; i++) store.create({
    chatKey: 'user:a', chatTarget: 'a', userId: 'a', prompt: '运行', workspace: process.cwd(),
    rule: parseRule('every', '1h'), targetType: 'chat', target: `target-${i}`,
  }, epoch);
  const done = store.enqueue(1, epoch); store.claim(epoch); store.finish(done, 'succeeded', '持久化结果', '', epoch);
  store.enqueue(2, epoch); store.claim(epoch);
  store.enqueue(3, epoch);
  before.close();
  const h = harness(t, { tickets: new TicketStore(path) });
  assert.equal(h.store.history(2)[0].state, 'interrupted');
  h.tick(); await flush();
  assert.equal(h.sessions.length, 1);
  assert.ok(h.sessions[0].chatKey.includes('/schedule:3/'));
  assert.ok(h.sent.some((s) => s.text.includes('持久化结果')));
  assert.equal(h.store.history(3)[0].state, 'succeeded');
});

test('同聊天多任务审批互不覆盖，跨聊天与旧编号无法批准', async (t) => {
  const decisions = [];
  const h = harness(t, { run: async (_prompt, session) => {
    decisions.push(await session.canUseTool('Bash', { command: 'npm test' }, {}));
    return '完成';
  } });
  h.add(); h.add(); h.advance(60000); h.tick(); await flush();
  const pending = [...h.scheduler.active.values()].map((a) => a.approvals.getPending('user:a').id);
  assert.equal(pending.length, 2); assert.notEqual(pending[0], pending[1]);
  await assert.rejects(h.command(`approve ${pending[0]}`, 'user:b', 'b'), /审批编号无效/);
  await h.command(`approve ${pending[1]}`); await flush();
  assert.equal(h.scheduler.active.size, 1);
  await h.command(`reject ${pending[0]}`); await flush();
  assert.deepEqual(decisions.map((d) => d.behavior), ['allow', 'deny']);
  await assert.rejects(h.command(`approve ${pending[0]}`), /审批编号无效/);
  assert.ok(h.sent.some((s) => s.text.includes('/schedule approve s')));
});

test('审批超时释放运行，其他任务不受影响', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let decision;
  const h = harness(t, { config: { approvalTimeoutMs: 1000 }, run: async (_prompt, session) => {
    if (session.chatKey.includes('/schedule:1/')) decision = await session.canUseTool('Bash', {}, {});
    return '完成';
  } });
  h.add(); h.add(); h.advance(60000); h.tick(); await flush();
  assert.equal(h.store.history(2)[0].state, 'succeeded');
  t.mock.timers.tick(1000); await flush();
  assert.equal(decision.behavior, 'deny');
  assert.equal(h.scheduler.active.size, 0);
});

test('执行超时中止该会话，释放槽位继续排队任务', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { config: { scheduleConcurrency: 1, scheduleTimeoutMs: 1000 },
    run: async (_prompt, session) => session.chatKey.includes('/schedule:1/') ? new Promise(() => {}) : '完成' });
  h.add(); h.add(); h.advance(60000); h.tick();
  t.mock.timers.tick(1000); await flush();
  assert.equal(h.sessions[0].aborted, true);
  assert.equal(h.store.history(1)[0].state, 'failed');
  assert.equal(h.store.history(1)[0].error, '执行超时');
  assert.equal(h.store.history(2)[0].state, 'succeeded');
});

test('暂停/恢复/手动触发/停止/删除，以及聊天隔离', async (t) => {
  const h = harness(t, { run: () => new Promise(() => {}) });
  await h.command(`add every 30m --webhook ${webhook} -- 汇总状态`);
  assert.ok(h.replies.every((s) => !s.includes('test-secret')));
  for (const action of ['show', 'history', 'pause', 'resume', 'run', 'stop', 'delete']) {
    await assert.rejects(h.command(`${action} 1`, 'user:b', 'b'), /不属于当前聊天/);
  }
  await h.command('pause 1'); assert.equal(h.store.get(1).enabled, 0);
  h.advance(3600000); h.tick(); assert.equal(h.sessions.length, 0);
  await h.command('resume 1'); assert.equal(h.store.get(1).next_at, h.now() + 1800000);
  await h.command('run 1'); assert.equal(h.sessions.length, 1);
  await h.command('stop 1'); await flush();
  assert.equal(h.store.history(1)[0].state, 'cancelled');
  assert.equal(h.store.get(1).enabled, 1);
  await h.command('delete 1');
  assert.equal(h.store.list('user:a').length, 0);
  assert.equal(h.store.history(1).length, 1);
});

test('白名单撤销或目录范围收紧后不再执行，错误仍记录和推送', async (t) => {
  const h = harness(t);
  h.add({ userId: 'removed' });
  h.add({ workspace: '/outside' });
  h.advance(60000); h.tick(); await flush();
  assert.equal(h.sessions.length, 0);
  assert.match(h.store.history(1)[0].error, /白名单/);
  assert.match(h.store.history(2)[0].error, /允许范围/);
});

test('长连接离线不消耗推送重试次数，Webhook 仍可执行发送', async (t) => {
  let ready = false;
  const h = harness(t, { isChatReady: () => ready });
  h.add(); h.add({ targetType: 'webhook', target: webhook });
  h.advance(60000); h.tick(); await flush();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].target, webhook);
  const row = h.tickets.db.prepare("SELECT * FROM schedule_outbox WHERE target_type = 'chat'").get();
  assert.equal(row.attempts, 0);
  ready = true; h.tick(); await flush();
  assert.equal(h.sent.length, 2);
});

test('优雅退出中止执行、保留排队，不启动新任务', async (t) => {
  const h = harness(t, { config: { scheduleConcurrency: 1 }, run: () => new Promise(() => {}) });
  h.add(); h.add(); h.advance(60000); h.tick();
  await h.scheduler.shutdown();
  assert.equal(h.sessions.length, 1);
  assert.equal(h.store.history(1)[0].state, 'interrupted');
  assert.equal(h.store.history(2)[0].state, 'queued');
});

test('时间规则含显式时区、单次任务、夏令时跳过和重复小时去重', () => {
  assert.equal(nextOccurrence(parseRule('daily', '09:00'), epoch), Date.parse('2026-11-18T01:00:00Z'));
  assert.equal(nextOccurrence(parseRule('daily', '09:00'), Date.parse('2026-11-18T01:00:00Z')), Date.parse('2026-11-19T01:00:00Z'));
  const spring = parseRule('daily', '02:30', 'America/Chicago');
  assert.equal(nextOccurrence(spring, Date.parse('2026-03-08T06:00:00Z')), Date.parse('2026-03-09T07:30:00Z'));
  const fall = parseRule('daily', '01:30', 'America/Chicago');
  assert.equal(nextOccurrence(fall, Date.parse('2026-11-01T06:30:00Z')), Date.parse('2026-11-02T07:30:00Z'));
  const once = parseRule('once', '2027-01-01T09:00+08:00', undefined, epoch);
  assert.equal(nextOccurrence(once, once.at), null);
  assert.throws(() => parseRule('every', '0m'));
  assert.throws(() => parseRule('daily', '25:00'));
  assert.throws(() => parseRule('daily', '09:00', 'fake'));
  assert.throws(() => parseRule('once', '2027-01-01T09:00', undefined, epoch));
  assert.throws(() => parseRule('once', '2027-02-30T09:00Z', undefined, epoch));
});

test('单次任务触发后停用，恢复不会隐式补跑', async (t) => {
  const h = harness(t);
  h.add({ rule: parseRule('once', '2026-11-18T00:01Z', undefined, epoch) });
  h.advance(60000); h.tick(); await flush();
  assert.equal(h.store.get(1).enabled, 0);
  assert.equal(h.sessions.length, 1);
  await assert.rejects(h.command('resume 1'), /单次任务时间已过/);
  h.advance(3600000); h.tick(); await flush();
  assert.equal(h.sessions.length, 1);
});

test('参数解析支持多行提示词和带空格路径，Webhook 不进入 Claude 提示词', async (t) => {
  const h = harness(t);
  const parsed = parseAdd(`daily 09:00 --workspace "${process.cwd()}" --timezone Asia/Shanghai --webhook ${webhook} -- 第一行\n第二行`, h.config, epoch);
  assert.equal(parsed.prompt, '第一行\n第二行');
  assert.equal(parsed.webhook, webhook);
  assert.throws(() => parseAdd('every 1m --webhook bad -- 内容', h.config, epoch), /Webhook/);
  assert.throws(() => parseAdd('every 1m --unknown x -- 内容', h.config, epoch), /可用参数/);
  await h.command(`add every 1m --webhook ${webhook} -- 测试`);
  await h.command('run 1'); await flush();
  assert.ok(h.replies.every((s) => !s.includes('test-secret')));
  assert.ok(!h.sessions[0].prompt.includes('test-secret'));
});

test('Webhook 严格验证地址、禁止重定向、检查 HTTP 和业务错误，异常不泄露密钥', async () => {
  for (const url of ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
    'https://example.com/?key=x', 'https://qyapi.weixin.qq.com@127.0.0.1/cgi-bin/webhook/send?key=x',
    webhook + '&url=http://127.0.0.1', webhook + '&key=other', webhook + '#fragment']) {
    assert.throws(() => validateWebhook(url));
  }
  await sendWebhook(webhook, '结果', { fetchImpl: async (url, options) => {
    assert.equal(url, webhook); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { msgtype: 'markdown', markdown: { content: '结果' } });
    return { ok: true, json: async () => ({ errcode: 0 }) };
  } });
  await assert.rejects(sendWebhook(webhook, '结果', { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(sendWebhook(webhook, '结果', { fetchImpl: async () => ({ ok: true, json: async () => ({ errcode: 93000, errmsg: webhook }) }) }), /错误码 93000/);
  await assert.rejects(sendWebhook(webhook, '结果', { fetchImpl: async () => { throw new Error(webhook); } }), (e) => !e.message.includes('test-secret'));
});

test('/schedule 路由不创建工单，也不改当前工单', async (t) => {
  const h = harness(t);
  const ticket = h.tickets.create('user:a', 'a', '现有工单', process.cwd());
  const bot = new TicketBot({
    store: h.tickets, config: h.config, scheduler: h.scheduler,
    send: async (_frame, text) => h.replies.push(text), logger: { error() {}, warn() {} },
  });
  await bot.handle({ chatKey: 'user:a', userId: 'a', text: '/schedule add every 1m -- 汇总',
    frame: { body: { from: { userid: 'a' } } } });
  assert.equal(h.store.list('user:a').length, 1);
  assert.equal(h.tickets.current('user:a').id, ticket.id);
  assert.equal(h.tickets.list('user:a').length, 1);
});

test('群聊任务推送到来源群，其他群无法查看，群成员可管理', async (t) => {
  const h = harness(t);
  await h.scheduler.handle({ chatKey: 'group:one', userId: 'a', text: 'add every 1m -- 群汇总',
    frame: { body: { chattype: 'group', chatid: 'group-target', from: { userid: 'a' } } }, reply: async () => {} });
  await assert.rejects(h.command('show 1', 'group:two', 'a'), /不属于当前聊天/);
  await h.command('run 1', 'group:one', 'b'); await flush();
  assert.equal(h.sent[0].target, 'group-target');
  assert.equal(h.store.history(1)[0].state, 'succeeded');
});

test('停止必须等 SDK 真正退出，取消中不能启动同一任务的新运行', async (t) => {
  const gate = deferred();
  const h = harness(t, { run: () => gate.promise });
  h.add(); await h.command('run 1');
  h.sessions[0].abort = () => { h.sessions[0].aborted = true; };
  await h.command('stop 1');
  assert.equal(h.scheduler.active.size, 1);
  await assert.rejects(h.command('run 1'), /已有排队或执行/);
  gate.resolve('退出'); await flush();
  assert.equal(h.scheduler.active.size, 0);
  assert.equal(h.store.history(1)[0].state, 'cancelled');
});

test('删除取消尚未发送的结果，不重新发送；保留运行历史', async (t) => {
  const h = harness(t, { isChatReady: () => false });
  h.add(); await h.command('run 1'); await flush();
  assert.equal(h.store.history(1)[0].delivery_state, 'pending');
  await h.command('delete 1');
  assert.equal(h.store.history(1)[0].delivery_state, 'cancelled');
  assert.equal(h.store.history(1)[0].state, 'succeeded');
  assert.equal(h.store.deliveries(h.now()).length, 0);
});

test('企微 SDK 的对象形式错误回执保留业务错误信息', async (t) => {
  const h = harness(t, { sendChat: async () => { throw { errcode: 123, errmsg: '发送被拒绝' }; } });
  h.add(); await h.command('run 1'); await flush();
  assert.match(h.store.history(1)[0].delivery_error, /123.*发送被拒绝/);
  assert.equal(h.store.history(1)[0].state, 'succeeded');
});

test('轮数耗尽保存失败原因和恢复说明，释放并发槽继续其他任务', async (t) => {
  const h = harness(t, { config: { scheduleConcurrency: 1, scheduleMaxTurns: 120 },
    run: async (_prompt, session) => {
      assert.equal(session.maxTurns, 120);
      if (session.chatKey.includes('/schedule:1/')) {
        throw new Error('Claude Code returned an error result: Reached maximum number of turns (120)');
      }
      return '完成';
    } });
  h.add(); h.add(); h.advance(60000); h.tick(); await flush();
  const failed = h.store.history(1)[0];
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /120 轮/);
  assert.match(failed.error, /SCHEDULE_MAX_TURNS/);
  assert.match(failed.error, /\/schedule run 1/);
  assert.match(failed.error, /新会话重跑/);
  assert.equal(h.store.history(2)[0].state, 'succeeded');
  assert.equal(h.sessions.length, 2);
  assert.ok(h.sent.some((s) => s.text.includes('SCHEDULE_MAX_TURNS')));
});

test('Claude 返回轮数失败标记时推送保留部分输出和恢复提示', async (t) => {
  const h = harness(t, { run: async (_prompt, session) => {
    session.lastRunSucceeded = false;
    session.lastRunFailure = { code: 'error_max_turns', message: '达到上限' };
    return '中断前的部分输出（非最终结果）：已检查文件';
  } });
  h.add(); await h.command('run 1'); await flush();
  const run = h.store.history(1)[0];
  assert.equal(run.state, 'failed');
  assert.match(run.result, /已检查文件/);
  assert.match(run.error, /100 轮/);
  assert.ok(h.sent.some((s) => s.text.includes('已检查文件') && s.text.includes('/schedule run 1')));
});
