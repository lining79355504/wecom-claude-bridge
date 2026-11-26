import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgressStream, formatProgressEvent, progressPreview } from '../src/progress.js';

function harness(extra = {}) {
  const sent = [], fallback = [];
  const stream = new ProgressStream({ ticketId: 1, streamId: 'stream-1',
    reply: async (_id, content, finish) => { sent.push({ content, finish }); },
    fallback: async (text) => { fallback.push(text); }, ...extra,
  });
  return { stream, sent, fallback };
}

test('详细进度展示公开说明、工具文本结果和选定工具参数，隐藏 Webhook 密钥且按字节截断', () => {
  assert.equal(formatProgressEvent({ kind: 'assistant_text', text: '检查中' }, false), null);
  assert.equal(formatProgressEvent({ kind: 'thinking', text: 'private' }, false), null);
  assert.equal(formatProgressEvent({ kind: 'thinking', text: 'private' }, true), null);
  assert.equal(formatProgressEvent({ kind: 'tool_result', text: 'test passed' }, true), '工具结果：test passed');
  assert.equal(formatProgressEvent({ kind: 'assistant_text', text: '检查中' }, true), '说明：检查中');
  const line = formatProgressEvent({ kind: 'tool_use', toolName: 'Write', input: { file_path: 'out.txt', content: 'secret-content' } }, true);
  assert.equal(line, 'Write: out.txt');
  assert.doesNotMatch(progressPreview('调用 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key', 600), /secret-key/);
  const long = progressPreview('中文🙂'.repeat(500), 600);
  assert.ok(Buffer.byteLength(long) <= 600);
  assert.ok(long.endsWith('…'));
  assert.doesNotMatch(long, /�/);
});

test('节流窗口内的说明自动补发，无需等待下一次工具调用', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  await h.stream.push('开始处理');
  await h.stream.push('正在检查耗时操作');
  assert.equal(h.sent.length, 1);
  t.mock.timers.tick(2000);
  await h.stream.pending;
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].content, /正在检查耗时操作/);
  await h.stream.finish('完成');
  t.mock.timers.tick(10000);
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].finish, true);
});

test('完成时取消节流刷新，进度发送串行且最终消息最后到达', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const h = harness({ reply: async (_id, content, finish) => {
    if (!finish) await gate;
    sent.push({ content, finish });
  } });
  const first = h.stream.push('开始');
  await Promise.resolve();
  await h.stream.push('等待中的更新');
  const finish = h.stream.finish('最终结果');
  release();
  await Promise.all([first, finish]);
  t.mock.timers.tick(5000);
  await h.stream.push('迟到事件');
  assert.deepEqual(sent.map((item) => item.finish), [false, true]);
  assert.equal(sent.at(-1).content, '最终结果');
});

test('进度缓冲有界，结束发送失败时使用主动推送', async () => {
  const h = harness({ reply: async () => { throw new Error('offline'); } });
  for (let i = 0; i < 100; i++) await h.stream.push('长说明'.repeat(300));
  assert.ok(h.stream.lines.length <= 8);
  assert.ok(Buffer.byteLength(h.stream.lines.join('\n\n')) <= 3000);
  await h.stream.finish('最终结果');
  assert.deepEqual(h.fallback, ['最终结果']);
  await h.stream.finish('重复结果');
  assert.equal(h.fallback.length, 1);
});

test('过程刚产生就完成时，折叠卡片仍附加到最终回复且只出现一次', async () => {
  const messages = [];
  let hasDetails = false;
  const card = { task_id: 'card', card_type: 'button_interaction' };
  const h = harness({ details: {
    push: async () => { hasDetails = true; }, card: () => hasDetails ? card : undefined, finish: async () => {},
  }, reply: async (id, content, finish, templateCard) => messages.push({ id, content, finish, templateCard }) });
  const detail = h.stream.push('执行说明', { collapsed: true });
  const finish = h.stream.finish('完成');
  await Promise.all([detail, finish]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].finish, true);
  assert.deepEqual(messages[0].templateCard, card);
});

test('卡片回执失败不会再次附加，最终回复仍走同一流，超长结果明确截断', async () => {
  const messages = [];
  const h = harness({ details: {
    push: async () => {}, card: () => ({ task_id: 'one-card' }), finish: async () => {},
  }, reply: async (id, content, finish, card) => {
    messages.push({ id, content, finish, card });
    if (card) throw new Error('ack timeout');
  } });
  await h.stream.push('开始');
  await h.stream.finish('中文🙂'.repeat(1500));
  assert.equal(messages.filter((item) => item.card).length, 1);
  assert.equal(messages[0].id, messages[1].id);
  assert.ok(Buffer.byteLength(messages[1].content) <= 3800);
  assert.match(messages[1].content, /结果过长/);
  assert.equal(h.fallback.length, 0);
});
