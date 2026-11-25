import { downloadImage, MAX_IMAGES } from './images.js';

export function parseMessage(body = {}) {
  if (body.msgtype === 'image') return { text: '', images: [body.image] };
  if (body.msgtype === 'mixed') {
    const items = body.mixed?.msg_item;
    if (!Array.isArray(items)) throw new Error('图文消息格式无效，请重新发送。');
    return {
      text: items.filter((item) => item.msgtype === 'text').map((item) => item.text?.content ?? '').join('\n').trim(),
      images: items.filter((item) => item.msgtype === 'image').map((item) => item.image),
    };
  }
  if (body.msgtype === 'voice') {
    const text = (body.voice?.content ?? body.voice?.text ?? '').trim();
    if (!text) throw new Error('语音转写结果为空，请发送文字或图片。');
    return { text, images: [] };
  }
  return { text: (body.text?.content ?? '').trim(), images: [] };
}

/** 先鉴权再下载；同聊天按接收顺序提交，慢图片不会被后续文字或切换命令越过。 */
export function createMessageHandler({ config, bot, send, logger, download = downloadImage }) {
  const queues = new Map();
  return function handle(frame) {
    const body = frame.body ?? {};
    const userId = body.from?.userid;
    if (!config.allowedUserIds.includes(userId)) {
      logger.warn(`拒绝非白名单用户: ${userId}`);
      return send(frame, '⛔ 你不在这个机器人的白名单里，无法使用。');
    }
    const chatKey = body.chattype === 'group' ? `group:${body.chatid}` : `user:${userId}`;
    // 下载立即开始，不等待聊天队列（短效 URL 五分钟后过期）。
    const prepared = (async () => {
      const message = parseMessage(body);
      if (message.images.length > MAX_IMAGES) throw new Error(`每条消息最多支持 ${MAX_IMAGES} 张图片。`);
      const images = await Promise.all(message.images.map((image) => download(image)));
      return { text: message.text || (images.length ? '请分析收到的图片。' : ''), images };
    })().then((value) => ({ value }), (error) => ({ error }));
    const task = (queues.get(chatKey) ?? Promise.resolve()).then(async () => {
      const { value, error } = await prepared;
      if (error) throw error;
      if (value.text) await bot.handle({ chatKey, userId, frame, ...value });
    }).catch(async (error) => {
      // 不输出原始消息帧、下载链接和密钥。
      logger.warn('处理输入消息失败');
      await send(frame, `❌ ${error.message}`);
    });
    // 即使传输层报错，也不阻断本聊天后面的消息。
    const safe = task.catch(() => {});
    queues.set(chatKey, safe);
    safe.finally(() => { if (queues.get(chatKey) === safe) queues.delete(chatKey); });
    return task;
  };
}
