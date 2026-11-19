import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(t, run = async () => '已处理', store = new TicketStore(':memory:')) {
  const sent = [];
  const calls = [];
  const sessions = [];
  const bot = new TicketBot({
    store,
    config: {
      workspace: '/workspace', allowedPaths: ['/workspace'], permissionMode: 'auto',
      approvalTimeoutMs: 10000, sessionTtlMs: 1, readOnlyTools: [],
    },
    logger: { error() {}, warn() {} },
    send: async (frame, text) => { sent.push({ frame, text }); },
    createProgress: (frame) => ({
      push: async () => {}, finish: async (text) => { sent.push({ frame, text }); },
    }),
    createSession: (options) => {
      const session = {
        ...options, idleMs: 100, busy: false, aborted: false,
        isBusy() { return this.busy; },
        abort() { this.aborted = true; return this.busy; },
        async run(prompt) {
          this.busy = true;
          this.sessionId ||= `session-${sessions.length}`;
          options.onSessionId(this.sessionId);
          calls.push({ prompt, session: this, options });
          try { return await run(prompt, this, options); }
          finally { this.busy = false; }
        },
      };
      sessions.push(session);
      return session;
    },
  });
  const send = (text, chatKey = 'user:a') => bot.handle({ text, chatKey, userId: chatKey, frame: { chatKey } });
  t.after(async () => {
    bot.shutdown();
    await bot.drainPromise;
    store.close();
  });
  return { bot, store, send, sent, calls, sessions };
}

test('工单各自保存上下文，切换与内存回收后仍恢复原会话', async (t) => {
  const h = harness(t);
  await h.send('/new 修复登录');
  await h.bot.drainPromise;
  const firstSession = h.store.get(1).session_id;
  await h.send('/new 订单缓存');
  await h.bot.drainPromise;
  assert.notEqual(h.store.get(2).session_id, firstSession);
  h.bot.evictIdle();
  assert.equal(h.bot.sessions.size, 0);
  await h.send('/switch 1');
  await h.send('只修改后端');
  await h.bot.drainPromise;
  assert.equal(h.calls[2].session.sessionId, firstSession);
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.history(1).filter((m) => m.role === 'user').length, 2);
  assert.equal(h.store.history(2).filter((m) => m.role === 'user').length, 1);
});

test('执行中新增工单和补充需求全部串行，消息归属提交时的工单', async (t) => {
  const gate = deferred();
  let count = 0;
  const h = harness(t, async () => { if (++count === 1) await gate.promise; return '完成'; });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('/new B');
  await h.send('B 的补充');
  await h.send('/switch 1');
  await h.send('A 的补充');
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 4);
  assert.match(h.calls[1].prompt, /B/);
  assert.equal(h.calls[2].prompt, 'B 的补充');
  assert.equal(h.calls[3].prompt, 'A 的补充');
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.get(2).status, 'review');
});

test('工单按聊天隔离，其他聊天不能查看、切换、关闭或停止', async (t) => {
  const h = harness(t);
  await h.send('/new 私有需求');
  await h.bot.drainPromise;
  for (const command of ['switch', 'status', 'history', 'close', 'stop', 'resume', 'reset']) {
    await h.send(`/${command} 1`, 'user:b');
    assert.match(h.sent.at(-1).text, /不属于当前聊天/);
  }
  await h.send('/list', 'user:b');
  assert.doesNotMatch(h.sent.at(-1).text, /私有需求/);
  assert.equal(h.store.get(1).status, 'review');
});

test('审批绑定工单与随机编号，切换后裸 y、错号和跨聊天回复均不能批准', async (t) => {
  const entered = deferred();
  const h = harness(t, async (_prompt, session) => {
    if (!session.chatKey.endsWith('ticket:1')) return '完成';
    const result = session.canUseTool('Bash', { command: 'npm test' }, {});
    entered.resolve();
    const decision = await result;
    assert.equal(decision.behavior, 'allow');
    return '已执行';
  });
  await h.send('/new 测试审批');
  await entered.promise;
  const pending = h.bot.approvals.getPending('user:a');
  assert.match(pending.id, /^1-/);
  assert.equal(h.store.get(1).status, 'approval');
  await h.send('/new 另一个工单');
  for (const reply of ['y', 'y 1-old', `y ${pending.id} extra`]) {
    await h.send(reply);
    assert.ok(h.bot.approvals.hasPending('user:a'));
  }
  await h.send(`y ${pending.id}`, 'user:b');
  assert.ok(h.bot.approvals.hasPending('user:a'));
  await h.send(`y ${pending.id}`);
  await h.bot.drainPromise;
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.get(2).status, 'review');
  const count = h.calls.length;
  await h.send(`y ${pending.id}`);
  assert.equal(h.calls.length, count);
  assert.match(h.sent.at(-1).text, /没有待审批/);
});

test('停止必须等旧运行退出才启动下一工单，关闭和重置不能越过活动任务', async (t) => {
  const gate = deferred();
  const h = harness(t, async (_prompt, session) => {
    if (session.chatKey.endsWith('ticket:1')) await gate.promise;
    return '完成';
  });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('待取消的补充');
  await h.send('/close');
  assert.match(h.sent.at(-1).text, /尚有任务/);
  await h.send('/new B');
  await h.send('/stop');
  assert.equal(h.sessions[0].aborted, true);
  await h.send('/reset 1');
  assert.match(h.sent.at(-1).text, /等待执行退出/);
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.get(1).status, 'stopped');
  await h.send('/close 1');
  assert.equal(h.store.get(1).status, 'closed');
  await h.send('/switch 1');
  await h.send('新的需求');
  await h.bot.drainPromise;
  assert.equal(h.store.current('user:a').id, 3);
});

test('重启保留会话和消息，暂停未完成任务，只有 /resume 才恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tickets.sqlite');
  const before = new TicketStore(path);
  const ticket = before.create('user:a', 'a', '重启恢复', '/workspace');
  before.setSession(ticket.id, 'persisted-session');
  const first = before.enqueue(ticket.id, '原始需求');
  before.jobState(first, 'running');
  before.setStatus(ticket.id, 'approval');
  before.enqueue(ticket.id, '排队补充');
  before.close();
  const store = new TicketStore(path);
  const h = harness(t, undefined, store);
  assert.equal(store.current('user:a').id, ticket.id);
  assert.equal(store.get(ticket.id).status, 'stopped');
  assert.equal(store.nextJob(), undefined);
  await h.send('重启后的补充');
  assert.equal(h.calls.length, 0);
  await h.send('/resume');
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0].session.sessionId, 'persisted-session');
  assert.match(h.calls[0].prompt, /先核查已完成/);
  assert.match(h.calls[0].prompt, /原始需求/);
  assert.match(h.calls[2].prompt, /重启后的补充/);
  assert.equal(store.get(ticket.id).status, 'review');
});

test('失败不会标为待验收，同工单补充暂停，其他工单仍可继续', async (t) => {
  const gate = deferred();
  const h = harness(t, async (_prompt, session) => {
    if (session.chatKey.endsWith('ticket:1')) {
      await gate.promise;
      session.lastRunSucceeded = false;
      return '超过轮数上限';
    }
    return '完成';
  });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('A 补充');
  await h.send('/new B');
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.store.get(1).status, 'failed');
  assert.equal(h.store.pending(1)[0].state, 'paused');
  assert.equal(h.store.get(2).status, 'review');
});

test('进程退出保存未完成任务为暂停，绝不启动下一工单', async (t) => {
  const gate = deferred();
  const h = harness(t, async () => { await gate.promise; return '停止后的迟到结果'; });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('/new B');
  h.bot.shutdown();
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.get(1).status, 'stopped');
  assert.equal(h.store.pending(1)[0].state, 'paused');
  assert.equal(h.store.pending(2)[0].state, 'queued');
  assert.ok(h.store.get(1).session_id);
});

test('并发审批不取代已有请求，超时拒绝且旧编号不再生效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred();
  let firstDecision;
  const h = harness(t, async (_prompt, session) => {
    const first = session.canUseTool('Bash', { command: 'npm test' }, {});
    const second = await session.canUseTool('Bash', { command: 'npm run build' }, {});
    assert.equal(second.behavior, 'deny');
    entered.resolve();
    firstDecision = await first;
    return '操作已拒绝';
  });
  await h.send('/new 审批超时');
  await entered.promise;
  const id = h.bot.approvals.getPending('user:a').id;
  t.mock.timers.tick(10000);
  await h.bot.drainPromise;
  assert.equal(firstDecision.behavior, 'deny');
  assert.equal(firstDecision.message, '审批超时');
  await h.send(`y ${id}`);
  assert.match(h.sent.at(-1).text, /没有待审批/);
});

test('队列刚结束时到达的新消息也会启动，不需要下一条消息唤醒', async (t) => {
  const h = harness(t);
  h.bot.kick(); // 空队列已经返回，但 finally 尚未执行。
  await h.send('/new 刚好到达');
  // kick 的 finally 可以接续一个新的 drainPromise。
  while (h.bot.draining) await h.bot.drainPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.get(1).status, 'review');
});
