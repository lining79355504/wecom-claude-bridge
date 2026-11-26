import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { isInside } from './guard.js';

// 桥接层限制：低于 SDK 的 50 MiB 分片上传上限。
export const MAX_OUTPUT_FILE_BYTES = 20 * 1024 * 1024;
export const FILE_TOOL = 'mcp__wecom_files__send_file';

/** 图片和文件共用的路径检查、有界读取与上传发送。 */
export class MediaService {
  constructor({ client, allowedPaths }) {
    Object.assign(this, { client, allowedPaths });
  }

  async checkedPath(path) {
    const canonical = await realpath(path);
    if (this.allowedPaths !== '*') {
      const roots = await Promise.all(this.allowedPaths.map((root) => realpath(root).catch(() => resolve(root))));
      if (!isInside(canonical, roots)) throw new Error('文件路径或符号链接指向允许目录之外。');
    }
    return canonical;
  }

  targetOf(frame) {
    const target = frame?.body?.chattype === 'group' ? frame.body.chatid : frame?.body?.from?.userid;
    if (!target) throw new Error('当前没有可回复的聊天。');
    return target;
  }

  async readLocalFile(workspace, filePath, limit, label, signal) {
    signal?.throwIfAborted();
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请提供本地文件路径。');
    const path = await this.checkedPath(resolve(workspace, filePath));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('只能发送普通文件，目录请先打包。');
      if (stat.size > limit) throw new Error(`发送${label}不能超过 ${limit / 1024 / 1024} MiB，请先压缩或拆分。`);
      // 分块读取且检查实际大小，防止文件在 stat 后增长；小文件无需预分配上限大小。
      const chunks = [];
      let size = 0;
      while (size <= limit) {
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (size > limit) throw new Error(`发送${label}不能超过 ${limit / 1024 / 1024} MiB，请先压缩或拆分。`);
      if (!size) throw new Error('不能发送空文件。');
      return { buffer: Buffer.concat(chunks, size), path };
    } finally { await handle.close(); }
  }

  async uploadAndSend(target, buffer, { type, filename, label, signal }) {
    signal?.throwIfAborted();
    let uploaded;
    try { uploaded = await this.client.uploadMedia(buffer, { type, filename }); }
    catch { throw new Error(`${label}上传失败，请检查企微连接后重试。`); }
    if (!uploaded?.media_id) throw new Error(`${label}上传未返回素材标识。`);
    signal?.throwIfAborted();
    try { await this.client.sendMessage(target, { msgtype: type, [type]: { media_id: uploaded.media_id } }); }
    catch { throw new Error(`${label}发送失败，尚未确认送达，请检查企微连接。`); }
  }

  async sendFile(frame, ticket, filePath, { signal } = {}) {
    signal?.throwIfAborted();
    const target = this.targetOf(frame);
    const { buffer } = await this.readLocalFile(ticket.workspace, filePath, MAX_OUTPUT_FILE_BYTES, '文件', signal);
    // 保留用户路径中的原始文件名（包括中文、空格和扩展名）。
    const filename = basename(filePath);
    await this.uploadAndSend(target, buffer, { type: 'file', filename, label: '文件', signal });
    return `已发送文件：${filename}`;
  }
}
