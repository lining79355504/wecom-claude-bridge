import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { MediaService, MAX_OUTPUT_FILE_BYTES, FILE_TOOL } from '../src/media.js';
import { ClaudeSession, fileSenderTool } from '../src/claude.js';
import { createToolGuard } from '../src/guard.js';
import { TicketBot } from '../src/ticket-bot.js';
import { TicketStore } from '../src/tickets.js';

const logger = { info() {}, warn() {}, error() {} };
const frame = { body: { from: { userid: 'user-a' } } };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'wecom-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploads = [], sent = [];
  const client = {
    uploadMedia: async (buffer, options) => { uploads.push({ buffer, options }); return { media_id: 'uploaded' }; },
    sendMessage: async (...args) => sent.push(args),
  };
  const service = new MediaService({ client, allowedPaths: [root] });
  return { root, client, service, uploads, sent, ticket: { workspace: root } };
}

test('文件发送保留中文、空格和扩展名，单聊群聊均使用正确目标和原始字节', async (t) => {
  const h = await setup(t);
  const content = Buffer.from([0, 1, 128, 255, 10]);
  const filename = '项目 报告.zip';
  await writeFile(join(h.root, filename), content);
  assert.match(await h.service.sendFile(frame, h.ticket, filename), /已发送文件：项目 报告.zip/);
  await h.service.sendFile({ body: { ...frame.body, chattype: 'group', chatid: 'group-a' } }, h.ticket, join(h.root, filename));
  assert.deepEqual(h.uploads[0], { buffer: content, options: { type: 'file', filename } });
  assert.deepEqual(h.sent, [
    ['user-a', { msgtype: 'file', file: { media_id: 'uploaded' } }],
    ['group-a', { msgtype: 'file', file: { media_id: 'uploaded' } }],
  ]);
});

test('文件发送拒绝空文件、目录、缺失文件、空路径和无回复目标', async (t) => {
  const h = await setup(t);
  await writeFile(join(h.root, 'empty.txt'), '');
  for (const [path, expected] of [['empty.txt', /空文件/], ['.', /目录请先打包/], ['missing.pdf', /ENOENT/], ['', /本地文件路径/]]) {
    await assert.rejects(h.service.sendFile(frame, h.ticket, path), expected);
  }
  await assert.rejects(h.service.sendFile({}, h.ticket, 'empty.txt'), /可回复的聊天/);
  assert.equal(h.uploads.length, 0);
});

test('允许恰好 20 MiB 的文件，拒绝超出一字节的文件', async (t) => {
  const h = await setup(t);
  const buffer = Buffer.alloc(MAX_OUTPUT_FILE_BYTES, 42);
  await writeFile(join(h.root, 'limit.bin'), buffer);
  await h.service.sendFile(frame, h.ticket, 'limit.bin');
  assert.deepEqual(h.uploads[0].buffer, buffer);
  await writeFile(join(h.root, 'too-large.bin'), Buffer.alloc(MAX_OUTPUT_FILE_BYTES + 1));
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'too-large.bin'), /20 MiB/);
  assert.equal(h.uploads.length, 1);
});

test('文件发送拒绝越界和符号链接逃逸，允许围栏内的链接且保留发送文件名', async (t) => {
  const h = await setup(t), outside = await setup(t);
  await writeFile(join(outside.root, 'private.txt'), 'private');
  await symlink(outside.root, join(h.root, 'outside'));
  await assert.rejects(h.service.sendFile(frame, h.ticket, join(outside.root, 'private.txt')), /允许目录之外/);
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'outside/private.txt'), /允许目录之外/);
  await writeFile(join(h.root, 'original.txt'), 'allowed');
  await symlink(join(h.root, 'original.txt'), join(h.root, '分享.txt'));
  await h.service.sendFile(frame, h.ticket, '分享.txt');
  assert.equal(h.uploads[0].options.filename, '分享.txt');
  assert.equal(h.uploads.length, 1);
});

test('上传失败或缺少素材标识不发送，发送失败不自动重试且不泄露底层错误', async (t) => {
  const h = await setup(t);
  await writeFile(join(h.root, 'result.pdf'), 'pdf bytes');
  h.client.uploadMedia = async () => { throw new Error('credential=secret'); };
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'result.pdf'), /文件上传失败/);
  h.client.uploadMedia = async () => ({});
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'result.pdf'), /未返回素材标识/);
  assert.equal(h.sent.length, 0);
  h.client.uploadMedia = async () => ({ media_id: 'uploaded' });
  let attempts = 0;
  h.client.sendMessage = async () => { attempts++; throw new Error('credential=secret'); };
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'result.pdf'), (error) => {
    assert.match(error.message, /尚未确认送达/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('发送前取消不会上传，上传期间取消不会继续发送', async (t) => {
  const h = await setup(t), stopped = new AbortController();
  await writeFile(join(h.root, 'report.txt'), 'report');
  stopped.abort();
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'report.txt', { signal: stopped.signal }), /abort/i);
  assert.equal(h.uploads.length, 0);
  const controller = new AbortController();
  h.client.uploadMedia = async () => { controller.abort(); return { media_id: 'uploaded' }; };
  await assert.rejects(h.service.sendFile(frame, h.ticket, 'report.txt', { signal: controller.signal }), /abort/i);
  assert.equal(h.sent.length, 0);
});

test('文件工具遵守目录围栏和禁用策略，不自动批准', async () => {
  const policy = { workspace: '/workspace', allowedPaths: ['/workspace'], deniedTools: [] };
  const event = (file_path) => ({ tool_name: FILE_TOOL, tool_input: { file_path } });
  assert.deepEqual(await createToolGuard(policy)(event('report.pdf')), {});
  assert.equal((await createToolGuard(policy)(event('../private.txt'))).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await createToolGuard({ ...policy, deniedTools: [FILE_TOOL] })(event('report.pdf'))).hookSpecificOutput.permissionDecision, 'deny');
});

test('文件 MCP 工具可发现和调用，参数错误与发送失败均报告失败', async (t) => {
  const paths = [];
  const server = createSdkMcpServer({ name: 'wecom_files', tools: [fileSenderTool(async (path) => {
    paths.push(path);
    if (path === 'missing.txt') throw new Error('文件不存在');
    return '已发送文件';
  }, () => undefined)] });
  const client = new Client({ name: 'file-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.instance.close(); });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.equal(tools[0].name, 'send_file');
  assert.deepEqual(tools[0].inputSchema.required, ['file_path']);
  assert.equal((await client.callTool({ name: 'send_file', arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: 'send_file', arguments: { file_path: '' } })).isError, true);
  assert.equal((await client.callTool({ name: 'send_file', arguments: { file_path: 'missing.txt' } })).isError, true);
  assert.match((await client.callTool({ name: 'send_file', arguments: { file_path: '报告.pdf' } })).content[0].text, /已发送文件/);
  assert.deepEqual(paths, ['missing.txt', '报告.pdf']);
});

test('Claude 文字会话注册文件工具，与图片工具共存；定时会话不注入发送工具', async () => {
  for (const mode of ['files', 'both', 'scheduled']) {
    const session = new ClaudeSession({ workspace: '/workspace', chatKey: 'test', logger,
      sendFile: mode !== 'scheduled' ? async () => '已发送' : undefined,
      sendImage: mode === 'both' ? async () => '已发送' : undefined,
      queryFn: async function* ({ prompt, options }) {
        if (mode === 'scheduled') {
          assert.equal(options.mcpServers, undefined);
          assert.equal(typeof prompt, 'string');
          assert.doesNotMatch(options.systemPrompt.append, /send_file/);
        } else {
          assert.ok(options.mcpServers.wecom_files);
          assert.equal(Boolean(options.mcpServers.wecom_images), mode === 'both');
          assert.match(options.systemPrompt.append, /mcp__wecom_files__send_file/);
          const messages = [];
          for await (const message of prompt) messages.push(message);
          assert.equal(messages[0].message.content[0].text, '发送文件');
        }
        yield { type: 'result', subtype: 'success', result: '完成' };
      },
    });
    await session.run('发送文件');
  }
});

test('工单文件发送走审批，拒绝后不发；完成后旧回调不能发送', async (t) => {
  const h = await setup(t), store = new TicketStore(':memory:');
  await writeFile(join(h.root, 'result.txt'), 'result');
  let callback, approved = false;
  const bot = new TicketBot({ store, fileService: h.service, logger,
    config: { workspace: h.root, allowedPaths: [h.root], permissionMode: 'default', readOnlyTools: [], approvalTimeoutMs: 1000 },
    send: async () => {}, createProgress: () => ({ push: async () => {}, finish: async () => {} }),
    createSession: (options) => ({ sessionId: null, abort() {}, async run() {
      callback = options.sendFile;
      const permission = options.canUseTool(FILE_TOOL, { file_path: 'result.txt' }, {});
      const pending = bot.approvals.getPending('user:user-a');
      assert.ok(pending);
      await bot.handle({ chatKey: 'user:user-a', userId: 'user-a', frame, text: `${approved ? 'y' : 'n'} ${pending.id}` });
      if ((await permission).behavior === 'allow') await options.sendFile('result.txt');
      return '完成';
    } }),
  });
  t.after(async () => { bot.shutdown(); await bot.drainPromise; store.close(); });
  const submit = () => bot.handle({ chatKey: 'user:user-a', userId: 'user-a', frame, text: '发送结果文件' });
  await submit();
  await bot.drainPromise;
  assert.equal(h.sent.length, 0);
  approved = true;
  await submit();
  await bot.drainPromise;
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0], 'user-a');
  assert.throws(() => callback('result.txt'), /工单已停止/);
});
