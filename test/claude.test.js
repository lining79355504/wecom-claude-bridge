import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSession } from '../src/claude.js';
import { config } from '../src/config.js';

const partial = { type: 'assistant', message: { content: [{ type: 'text', text: '已检查两个模块，尚待验证。' }] } };
const logger = { info() {}, warn() {} };
const sessionWith = (queryFn, extra = {}) => new ClaudeSession({
  chatKey: 'test', workspace: process.cwd(), logger, maxTurns: 100, queryFn, ...extra,
});

test('会话向 SDK 传入指定轮数，普通会话仍使用工单配置', async () => {
  let actual;
  const queryFn = async function* ({ options }) {
    actual = options.maxTurns;
    yield { type: 'result', subtype: 'success', result: '完成' };
  };
  const scheduled = sessionWith(queryFn, { maxTurns: 150 });
  assert.equal(await scheduled.run('任务'), '完成');
  assert.equal(actual, 150);
  const interactive = sessionWith(queryFn, { maxTurns: undefined });
  await interactive.run('工单');
  assert.equal(actual, config.maxTurns);
});

test('SDK 返回轮数错误结果时保留部分输出且不标记为成功', async () => {
  const session = sessionWith(async function* () {
    yield partial;
    yield { type: 'result', subtype: 'error_max_turns', errors: ['Reached maximum number of turns (100)'] };
  });
  const result = await session.run('任务');
  assert.match(result, /100 轮/);
  assert.match(result, /部分输出（非最终结果）/);
  assert.match(result, /已检查两个模块/);
  assert.equal(session.lastRunSucceeded, false);
  assert.equal(session.lastRunFailure.code, 'error_max_turns');
  assert.equal(session.isBusy(), false);
});

test('SDK 抛出轮数异常时同样保留部分输出，不自动再次调用模型', async () => {
  let calls = 0;
  const session = sessionWith(async function* () {
    calls++;
    yield partial;
    throw new Error('Claude Code returned an error result: Reached maximum number of turns (100)');
  });
  const result = await session.run('任务');
  assert.match(result, /100 轮/);
  assert.match(result, /已检查两个模块/);
  assert.equal(calls, 1);
  assert.equal(session.lastRunSucceeded, false);
  assert.equal(session.isBusy(), false);
});

test('普通 SDK 异常继续抛出，后续成功运行清除旧失败状态', async () => {
  let calls = 0;
  const session = sessionWith(async function* () {
    if (++calls === 1) throw new Error('Authentication failed');
    yield { type: 'result', subtype: 'success', result: '恢复成功' };
  });
  await assert.rejects(session.run('任务'), /Authentication failed/);
  assert.equal(session.isBusy(), false);
  assert.equal(await session.run('任务'), '恢复成功');
  assert.equal(session.lastRunSucceeded, true);
  assert.equal(session.lastRunFailure, null);
});

test('success 子类型仍携带 is_error 时不能作为成功输出', async () => {
  const session = sessionWith(async function* () {
    yield { type: 'result', subtype: 'success', is_error: true, result: 'Reached maximum number of turns (100)' };
  });
  assert.match(await session.run('任务'), /100 轮/);
  assert.equal(session.lastRunSucceeded, false);
  assert.equal(session.lastRunFailure.code, 'error_max_turns');
});

test('定时轮数配置默认 100，独立于普通工单，拒绝无效输入', () => {
  const previous = process.env.SCHEDULE_MAX_TURNS;
  const previousInteractive = process.env.CLAUDE_MAX_TURNS;
  try {
    delete process.env.SCHEDULE_MAX_TURNS;
    process.env.CLAUDE_MAX_TURNS = '30';
    assert.equal(config.scheduleMaxTurns, 100);
    process.env.SCHEDULE_MAX_TURNS = '180';
    assert.equal(config.scheduleMaxTurns, 180);
    assert.equal(config.maxTurns, 30);
    for (const value of ['0', '-1', '1.5', '1001', 'NaN', 'Infinity']) {
      process.env.SCHEDULE_MAX_TURNS = value;
      assert.throws(() => config.scheduleMaxTurns, /SCHEDULE_MAX_TURNS/);
    }
  } finally {
    if (previous === undefined) delete process.env.SCHEDULE_MAX_TURNS;
    else process.env.SCHEDULE_MAX_TURNS = previous;
    if (previousInteractive === undefined) delete process.env.CLAUDE_MAX_TURNS;
    else process.env.CLAUDE_MAX_TURNS = previousInteractive;
  }
});
