import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TicketStore } from '../src/tickets.js';
import { ProgressCards, MAX_TRANSCRIPT_BYTES } from '../src/progress-cards.js';
import { ProgressStream } from '../src/progress.js';

function harness(t, chatKey = 'user:a') {
  const store = new TicketStore(':memory:'), sent = [], updated = [];
  t.after(() => store.close());
  const client = {
    sendMessage: async (...args) => { sent.push(args); },
    updateTemplateCard: async (...args) => { updated.push(args); },
  };
  const config = { allowedUserIds: ['a', 'b'] };
  const cards = new ProgressCards({ store, client, config, logger: { warn() {} } });
  const ticket = store.create(chatKey, 'a', '检查代码', '/workspace');
  const job = { id: store.enqueue(ticket.id, '检查代码') };
  store.jobState(job.id, 'running');
  return { store, client, config, cards, ticket, job, sent, updated, details: cards.forRun(ticket, job) };
}

function click(card, action = 'expand', user = 'a', chatid) {
  return { headers: { req_id: 'click-request' }, body: {
    from: { userid: user }, chattype: chatid ? 'group' : 'single', chatid,
    event: { task_id: card.task_id, event_key: `progress:${card.task_id}:${action}` },
  } };
}

test('过程默认收起且不主动发新消息，点击展开、刷新和收起更新原卡片', async (t) => {
  const h = harness(t);
  await Promise.all([h.details.push('说明：先检查入口'), h.details.push('Read: src/index.js')]);
  assert.equal(h.sent.length, 0);
  const card = h.details.card();
  assert.equal(card.card_type, 'button_interaction');
  assert.equal(card.quote_area, undefined);
  assert.doesNotMatch(JSON.stringify(card), /先检查入口|src\/index/);
  assert.equal(card.button_list[0].text, '展开过程');
  assert.equal(await h.cards.handle(click(card)), true);
  let expanded = h.updated.at(-1)[1];
  assert.match(expanded.quote_area.quote_text, /先检查入口[\s\S]*Read: src\/index.js/);
  assert.equal(expanded.task_id, card.task_id);
  assert.deepEqual(expanded.button_list.map((button) => button.text), ['刷新', '最新', '收起']);
  await h.details.push('说明：测试已通过');
  h.store.jobState(h.job.id, 'done');
  await h.details.finish();
  await h.cards.handle(click(card));
  expanded = h.updated.at(-1)[1];
  assert.match(expanded.quote_area.quote_text, /测试已通过/);
  assert.match(expanded.sub_title_text, /本轮已结束/);
  await h.cards.handle(click(card, 'collapse'));
  assert.equal(h.updated.at(-1)[1].quote_area, undefined);
  assert.equal(h.updated.at(-1)[1].button_list[0].text, '展开过程');
  assert.equal(h.sent.length, 0);
});

test('兼容企微嵌套的 template_card_event 回调结构', async (t) => {
  const h = harness(t);
  await h.details.push('说明：嵌套回调');
  const card = h.details.card();
  const frame = { headers: { req_id: 'nested' }, body: {
    from: { userid: 'a' }, chattype: 'single',
    event: { eventtype: 'template_card_event', template_card_event: {
      task_id: card.task_id, event_key: `progress:${card.task_id}:expand`,
    } },
  } };
  assert.equal(await h.cards.handle(frame), true);
  assert.match(h.updated.at(-1)[1].quote_area.quote_text, /嵌套回调/);
  assert.deepEqual(h.updated.at(-1)[1].button_list.map((button) => button.text), ['刷新', '最新', '收起']);
});

test('群卡片只更新点击者视图，验证白名单、聊天和任务归属', async (t) => {
  const h = harness(t, 'group:g');
  await h.details.push('群内过程');
  const card = h.details.card();
  assert.equal(await h.cards.handle(click(card, 'expand', 'b', 'g')), true);
  assert.deepEqual(h.updated[0][2], ['b']);
  for (const frame of [
    click(card, 'expand', 'unknown', 'g'), click(card, 'expand', 'a', 'other'), click(card),
    click(card, 'invalid', 'a', 'g'),
    { body: { from: { userid: 'a' }, chattype: 'group', chatid: 'g', event: {
      task_id: 'wrong-task', event_key: `progress:${card.task_id}:expand`,
    } } },
  ]) assert.equal(await h.cards.handle(frame), false);
  h.config.allowedUserIds = [];
  assert.equal(await h.cards.handle(click(card, 'expand', 'b', 'g')), false);
  assert.equal(h.updated.length, 1);
});

test('过程卡片跨重启保留，使用对应轮次的摘要', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wecom-cards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'tickets.sqlite'), sent = [], updated = [];
  const options = { config: { allowedUserIds: ['a'] }, logger: { warn() {} }, client: {
    sendMessage: async (_target, body) => sent.push(body.template_card),
    updateTemplateCard: async (_frame, card) => updated.push(card),
  } };
  let store = new TicketStore(path), cards = new ProgressCards({ store, ...options });
  const ticket = store.create('user:a', 'a', '任务', root);
  const first = { id: store.enqueue(ticket.id, '第一轮') };
  const firstDetails = cards.forRun(ticket, first);
  await firstDetails.push('第一轮的过程');
  sent.push(firstDetails.card());
  const second = { id: store.enqueue(ticket.id, '第二轮') };
  const secondDetails = cards.forRun(ticket, second);
  await secondDetails.push('第二轮的过程');
  sent.push(secondDetails.card());
  store.close();
  store = new TicketStore(path);
  t.after(() => store.close());
  cards = new ProgressCards({ store, ...options });
  await cards.handle(click(sent[0]));
  assert.match(updated[0].quote_area.quote_text, /第一轮/);
  assert.doesNotMatch(updated[0].quote_area.quote_text, /第二轮/);
  assert.match(updated[0].sub_title_text, /暂停/);
});

test('正文、过程卡片和最终结果使用同一流，卡片只附加一次', async (t) => {
  const h = harness(t), messages = [];
  const stream = new ProgressStream({ ticketId: h.ticket.id, streamId: 'same-stream', details: h.details,
    reply: async (id, text, finish, card) => messages.push({ id, text, finish, card }), fallback: async () => {},
  });
  await stream.push('开始处理');
  await stream.push('说明：详细检查步骤', { collapsed: true });
  await stream.push('工具结果：测试通过', { collapsed: true });
  h.store.jobState(h.job.id, 'done');
  await stream.finish('最终结果');
  assert.ok(messages.every((message) => message.id === 'same-stream'));
  assert.equal(messages.filter((message) => message.card).length, 1);
  assert.doesNotMatch(JSON.stringify(messages), /详细检查步骤|工具结果/);
  assert.equal(messages.at(-1).text, '最终结果');
  assert.equal(messages.at(-1).finish, true);
  assert.equal(h.sent.length, 0);
  await h.cards.handle(click(h.details.card()));
  assert.match(h.updated[0][1].quote_area.quote_text, /详细检查步骤/);
});

test('过程分页保留早期和中间输出，翻页、最新与收起无需发送新消息', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 20; i++) await h.details.push(`步骤 ${i}：${'文本🙂'.repeat(100)}`);
  const row = h.cards.get(h.details.card().task_id);
  assert.equal(row.lines.length, 20);
  const first = h.cards.render(row, true);
  assert.match(first.quote_area.quote_text, /步骤 0/);
  assert.ok(first.button_list.some((button) => button.text === '下一页'));
  await h.cards.handle(click(h.details.card(), 'page-2'));
  assert.match(h.updated.at(-1)[1].sub_title_text, /第 3\//);
  await h.cards.handle(click(h.details.card(), 'latest'));
  assert.match(h.updated.at(-1)[1].quote_area.quote_text, /文本/);
  const pages = [];
  for (let page = 0; ; page++) {
    const card = h.cards.render(row, true, page);
    assert.ok(Buffer.byteLength(card.quote_area.quote_text) <= 900);
    pages.push(card.quote_area.quote_text);
    if (!card.button_list.some((button) => button.text === '下一页')) break;
  }
  assert.equal(pages.join(''), row.lines.join('\n\n'));
  assert.equal(h.sent.length, 0);
});

test('256 KiB 上限明确标记截断，卡片更新失败不抛异常', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 100; i++) await h.details.push(`步骤 ${i}：${'说明'.repeat(500)}`);
  const row = h.cards.get(h.details.card().task_id);
  assert.ok(Buffer.byteLength(row.lines.join('\n\n')) <= MAX_TRANSCRIPT_BYTES);
  assert.match(row.lines.at(-1), /上限/);
  const previous = row.lines;
  await h.details.push('超限之后');
  assert.deepEqual(h.cards.get(row.id).lines, previous);
  h.client.updateTemplateCard = async () => { throw new Error('expired'); };
  assert.equal(await h.cards.handle(click(h.details.card())), true);
});
