import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageService, downloadImage, inspectImage, MAX_INPUT_IMAGE_BYTES, MAX_OUTPUT_IMAGE_BYTES, IMAGE_TOOL } from '../src/images.js';
import { createMessageHandler, parseMessage } from '../src/incoming.js';
import { createToolGuard } from '../src/guard.js';
import { imageSenderTool, ClaudeSession } from '../src/claude.js';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const logger = { info() {}, warn() {}, error() {} };
const frame = (msgtype, extra = {}, user = 'a') => ({ body: { msgtype, from: { userid: user }, ...extra } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'wecom-images-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('按文件内容识别格式，拒绝伪装文件和超限图片', () => {
  assert.equal(inspectImage(png).mediaType, 'image/png');
  assert.equal(inspectImage(Buffer.from('ffd8ffe000', 'hex')).mediaType, 'image/jpeg');
  assert.equal(inspectImage(Buffer.from('GIF89a')).mediaType, 'image/gif');
  assert.equal(inspectImage(Buffer.from('RIFFxxxxWEBP')).mediaType, 'image/webp');
  assert.throws(() => inspectImage(Buffer.from('<svg/>')), /不支持/);
  assert.throws(() => inspectImage(Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1)), /5 MiB/);
  assert.throws(() => inspectImage(Buffer.alloc(0)), /为空/);
});

test('下载按企微协议 AES 解密，禁重定向，失败信息不暴露 URL 或密钥', async () => {
  const key = randomBytes(32);
  const pad = 32 - png.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([png, Buffer.alloc(pad, pad)])), cipher.final()]);
  const image = { url: 'https://example.test/image?secret=download-token', aeskey: key.toString('base64') };
  const actual = await downloadImage(image, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return new Response(encrypted);
  } });
  assert.deepEqual(actual.buffer, png);
  await assert.rejects(downloadImage(image, { fetchImpl: async () => { throw new Error(image.url + image.aeskey); } }), (error) => {
    assert.match(error.message, /下载、解密/);
    assert.ok(!error.message.includes('download-token') && !error.message.includes(image.aeskey));
    return true;
  });
  await assert.rejects(downloadImage({ url: 'file:///etc/passwd' }), /HTTPS/);
});

test('下载校验 HTTP 状态、响应长度和无长度头的流式上限', async () => {
  const image = { url: 'https://example.test/image' };
  for (const response of [
    new Response('expired', { status: 403 }),
    new Response(png, { headers: { 'content-length': String(MAX_INPUT_IMAGE_BYTES + 1025) } }),
    new Response(Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1025)),
    new Response('<html>not an image</html>'),
  ]) {
    await assert.rejects(downloadImage(image, { fetchImpl: async () => response }), /图片下载、解密或格式校验失败/);
  }
});

test('图文保留文字与图片顺序，语音转写兼容', () => {
  const a = { url: 'a' }, b = { url: 'b' };
  assert.deepEqual(parseMessage({ msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '比较两张图' } },
    { msgtype: 'image', image: a }, { msgtype: 'image', image: b },
    { msgtype: 'text', text: { content: '说明差异' } },
  ] } }), { text: '比较两张图\n说明差异', images: [a, b] });
  assert.equal(parseMessage({ msgtype: 'voice', voice: { text: '转写' } }).text, '转写');
});

test('鉴权先于图片下载，坏图和超张数给出反馈且不影响后续文字', async () => {
  const sent = [], calls = [];
  let downloads = 0;
  const handle = createMessageHandler({ config: { allowedUserIds: ['a'] }, logger,
    send: async (_frame, text) => sent.push(text), bot: { handle: async (input) => calls.push(input) },
    download: async () => { downloads++; throw new Error('图片已过期'); },
  });
  await handle(frame('image', { image: {} }, 'unauthorized'));
  assert.equal(downloads, 0);
  await handle(frame('mixed', { mixed: { msg_item: Array.from({ length: 5 }, () => ({ msgtype: 'image', image: {} })) } }));
  assert.equal(downloads, 0);
  await handle(frame('image', { image: {} }));
  await handle(frame('text', { text: { content: '继续' } }));
  assert.equal(calls.length, 1);
  assert.match(sent.join('\n'), /白名单[\s\S]*最多支持 4[\s\S]*图片已过期/);
});

test('慢图片不会被同聊天文字越过，其他聊天仍能独立提交', async () => {
  const gate = deferred(), calls = [];
  const handle = createMessageHandler({ config: { allowedUserIds: ['a', 'b'] }, logger,
    send: async () => {}, bot: { handle: async (input) => calls.push(input) },
    download: async () => { await gate.promise; return { buffer: png }; },
  });
  const first = handle(frame('image', { image: {} }));
  const second = handle(frame('text', { text: { content: '/switch 2' } }));
  await handle(frame('text', { text: { content: '另一聊天' } }, 'b'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatKey, 'user:b');
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(calls[1].images.length, 1);
  assert.equal(calls[2].text, '/switch 2');
});

test('图片工具发送到来源单聊或群聊，上传失败不继续发送', async (t) => {
  const root = await workspace(t), sent = [], uploads = [];
  await writeFile(join(root, 'picture.png'), png);
  const client = {
    uploadMedia: async (buffer, options) => { uploads.push({ buffer, options }); return { media_id: 'test-media' }; },
    sendMessage: async (...args) => sent.push(args),
  };
  const service = new ImageService({ client, allowedPaths: [root] });
  const ticket = { workspace: root };
  await service.sendImage(frame('text'), ticket, 'picture.png');
  await service.sendImage(frame('text', { chattype: 'group', chatid: 'group-a' }), ticket, 'picture.png');
  assert.deepEqual(sent.map(([target]) => target), ['a', 'group-a']);
  assert.deepEqual(sent[0][1], { msgtype: 'image', image: { media_id: 'test-media' } });
  assert.deepEqual(uploads[0].buffer, png);
  client.uploadMedia = async () => { throw new Error('network'); };
  await assert.rejects(service.sendImage(frame('text'), ticket, 'picture.png'), /上传失败/);
  assert.equal(sent.length, 2);
  client.uploadMedia = async () => ({ media_id: 'test' });
  client.sendMessage = async () => { throw new Error('network'); };
  await assert.rejects(service.sendImage(frame('text'), ticket, 'picture.png'), /尚未确认送达/);
});

test('发送图片拒绝越界、符号链接逃逸、目录、伪图片、超限和未转换的 GIF', async (t) => {
  const root = await workspace(t), outside = await workspace(t);
  await writeFile(join(outside, 'secret.png'), png);
  await symlink(join(outside, 'secret.png'), join(root, 'link.png'));
  await writeFile(join(root, 'fake.png'), 'not an image');
  await writeFile(join(root, 'large.png'), Buffer.concat([png, Buffer.alloc(MAX_OUTPUT_IMAGE_BYTES)]));
  await writeFile(join(root, 'animated.gif'), 'GIF89a');
  let uploads = 0;
  const service = new ImageService({ allowedPaths: [root], client: { uploadMedia: async () => { uploads++; } } });
  for (const path of [join(outside, 'secret.png'), 'link.png', '.', 'fake.png', 'large.png', 'animated.gif']) {
    await assert.rejects(service.sendImage(frame('text'), { workspace: root }, path));
  }
  assert.equal(uploads, 0);
});

test('上传期间停止工单会阻止发送，发送工具报告失败而非伪成功', async (t) => {
  const root = await workspace(t), controller = new AbortController();
  await writeFile(join(root, 'image.png'), png);
  let sends = 0;
  const service = new ImageService({ allowedPaths: [root], client: {
    uploadMedia: async () => { controller.abort(); return { media_id: 'test' }; },
    sendMessage: async () => sends++,
  } });
  const sender = imageSenderTool((path, options) => service.sendImage(frame('text'), { workspace: root }, path, options), () => controller.signal);
  const result = await sender.handler({ file_path: 'image.png' });
  assert.equal(result.isError, true);
  assert.equal(sends, 0);
});

test('图片发送工具遵守路径钩子和禁用配置，不抢先批准', async () => {
  const policy = { workspace: '/workspace', allowedPaths: ['/workspace'], deniedTools: [] };
  const event = (file_path) => ({ tool_name: IMAGE_TOOL, tool_input: { file_path } });
  assert.deepEqual(await createToolGuard(policy)(event('image.png')), {});
  assert.equal((await createToolGuard(policy)(event('../secret.png'))).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await createToolGuard({ ...policy, deniedTools: [IMAGE_TOOL] })(event('image.png'))).hookSpecificOutput.permissionDecision, 'deny');
});

test('SDK 多模态输入包含真实图片数据、本地编辑路径和恢复会话，文字会话可发图', async () => {
  let calls = 0;
  const session = new ClaudeSession({ workspace: '/workspace', chatKey: 'a', logger, sessionId: 'saved-session',
    sendImage: async () => '已发送',
    queryFn: async function* ({ prompt, options }) {
      assert.equal(options.resume, 'saved-session');
      assert.ok(options.mcpServers.wecom_images);
      const messages = [];
      for await (const message of prompt) messages.push(message);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].session_id, 'saved-session');
      const content = messages[0].message.content;
      if (calls++ === 0) {
        assert.match(content[1].text, /\/workspace\/input.png/);
        assert.equal(content[2].source.media_type, 'image/png');
        assert.deepEqual(Buffer.from(content[2].source.data, 'base64'), png);
      } else assert.equal(content.length, 1);
      yield { type: 'result', subtype: 'success', result: '已处理' };
    },
  });
  await session.run('分析图片', [{ buffer: png, mediaType: 'image/png', path: '/workspace/input.png' }]);
  await session.run('把截图发给我');
  assert.equal(calls, 2);
});

test('SDK 内置 MCP 服务能列出并调用图片工具，拒绝缺失路径的请求', async (t) => {
  const paths = [];
  const server = createSdkMcpServer({ name: 'wecom_images', tools: [imageSenderTool(async (path) => {
    paths.push(path);
    return '已发送图片';
  }, () => undefined)] });
  const client = new Client({ name: 'image-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.instance.close(); });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.equal(tools[0].name, 'send_image');
  assert.deepEqual(tools[0].inputSchema.required, ['file_path']);
  const invalid = await client.callTool({ name: 'send_image', arguments: {} });
  assert.equal(invalid.isError, true);
  const result = await client.callTool({ name: 'send_image', arguments: { file_path: 'image.png' } });
  assert.match(result.content[0].text, /已发送图片/);
  assert.deepEqual(paths, ['image.png']);
});

test('原有数据库兼容加表；图片入队、重启暂停、恢复后仍能分析和发送', async (t) => {
  const root = await workspace(t), db = join(root, 'tickets.sqlite');
  let store = new TicketStore(db);
  const ticket = store.create('user:a', 'a', '分析截图', root);
  // 模拟没有图片表的旧版本数据库。
  store.db.exec('DROP TABLE message_images');
  store.close();
  store = new TicketStore(db);
  store.enqueue(ticket.id, '分析截图', [{ buffer: png }]);
  store.close();
  store = new TicketStore(db);
  const sent = [], sdkInputs = [], callbacks = [];
  const service = new ImageService({ allowedPaths: [root], client: {
    uploadMedia: async () => ({ media_id: 'test' }), sendMessage: async (...args) => sent.push(args),
  } });
  const bot = new TicketBot({ store, imageService: service,
    config: { workspace: root, allowedPaths: [root], permissionMode: 'default', readOnlyTools: [], approvalTimeoutMs: 1000 },
    logger, send: async () => {}, createProgress: () => ({ push: async () => {}, finish: async () => {} }),
    createSession: (options) => {
      callbacks.push(options);
      return { sessionId: null, abort() {},
        run: async (text, images) => {
          sdkInputs.push({ text, images });
          assert.deepEqual(await readFile(images[0].path), png);
          await options.sendImage(images[0].path);
          return '图片已发送';
        },
      };
    },
  });
  t.after(async () => { bot.shutdown(); await bot.drainPromise; store.close(); });
  assert.equal(store.nextJob(), undefined);
  // 重启后收到的新图也必须暂停保存，不能越过旧消息。
  await bot.handle({ chatKey: 'user:a', userId: 'a', text: '再分析这张图', images: [{ buffer: png }], frame: frame('image') });
  assert.equal(sdkInputs.length, 0);
  await bot.handle({ chatKey: 'user:a', userId: 'a', text: '/resume', frame: frame('text') });
  await bot.drainPromise;
  assert.equal(sdkInputs.length, 2);
  assert.deepEqual(sdkInputs[0].images[0].buffer, png);
  assert.match(sdkInputs[0].text, /先核查已完成/);
  assert.equal(sent.length, 2);
  assert.equal(store.get(ticket.id).status, 'review');
  assert.throws(() => callbacks[0].sendImage('image.png'), /工单已停止/);
});

test('图片本地副本位于工单目录，并拒绝被替换到围栏外的缓存目录', async (t) => {
  const root = await workspace(t), outside = await workspace(t);
  const service = new ImageService({ allowedPaths: [root] });
  const [image] = await service.prepareInput({ workspace: root, id: 1 }, [{ buffer: png }]);
  assert.deepEqual(await readFile(image.path), png);
  const guard = createToolGuard({ workspace: root, allowedPaths: [root], deniedTools: [] });
  assert.deepEqual(await guard({ tool_name: 'Read', tool_input: { file_path: image.path } }), {});
  await rm(join(root, '.wecom-bridge-media'), { recursive: true });
  await symlink(outside, join(root, '.wecom-bridge-media'));
  await assert.rejects(service.prepareInput({ workspace: root, id: 1 }, [{ buffer: png }]), /符号链接/);
});
