import { decryptFile } from '@wecom/aibot-node-sdk';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { MediaService } from './media.js';

export const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_OUTPUT_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_TOOL = 'mcp__wecom_images__send_image';

export function inspectImage(buffer, limit = MAX_INPUT_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片内容为空。');
  if (buffer.length > limit) throw new Error(`图片不能超过 ${limit / 1024 / 1024} MiB。`);
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mediaType: 'image/png', extension: 'png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mediaType: 'image/jpeg', extension: 'jpg' };
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return { mediaType: 'image/gif', extension: 'gif' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mediaType: 'image/webp', extension: 'webp' };
  throw new Error('不支持的图片格式，请使用 PNG、JPEG、GIF 或 WebP。');
}

/** 不记录短效下载链接或 AES 密钥；在解密前限制网络响应大小。 */
export async function downloadImage(image, { fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(image?.url); } catch { throw new Error('图片下载地址无效，请重新发送。'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('图片下载地址必须是 HTTPS。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const encryptedLimit = MAX_INPUT_IMAGE_BYTES + 1024;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('download failed');
    if (Number(response.headers.get('content-length')) > encryptedLimit) throw new Error('too large');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > encryptedLimit) throw new Error('too large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const buffer = image.aeskey ? decryptFile(raw, image.aeskey) : raw;
    return { buffer, ...inspectImage(buffer) };
  } catch {
    throw new Error('图片下载、解密或格式校验失败（单张上限 5 MiB），请重新发送 PNG、JPEG、GIF 或 WebP 图片。');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export class ImageService extends MediaService {
  /** SQLite 保存原图；每次执行为本地编辑工具提供独立副本。 */
  async prepareInput(ticket, images) {
    if (!images.length) return [];
    // 保留工作目录的路径写法，使本地副本也能通过现有工具的词法目录围栏。
    const workspace = resolve(ticket.workspace);
    await this.checkedPath(workspace);
    const root = join(workspace, '.wecom-bridge-media');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.checkedPath(root);
    const directory = await mkdtemp(join(root, `ticket-${ticket.id}-`));
    return Promise.all(images.map(async (image, index) => {
      const buffer = Buffer.from(image.buffer);
      const { mediaType, extension } = inspectImage(buffer);
      const path = join(directory, `${index + 1}.${extension}`);
      await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
      return { buffer, mediaType, path };
    }));
  }

  async sendImage(frame, ticket, filePath, { signal } = {}) {
    signal?.throwIfAborted();
    const target = this.targetOf(frame);
    const { buffer, path } = await this.readLocalFile(ticket.workspace, filePath, MAX_OUTPUT_IMAGE_BYTES, '图片', signal);
    const { mediaType, extension } = inspectImage(buffer, MAX_OUTPUT_IMAGE_BYTES);
    if (!['image/png', 'image/jpeg'].includes(mediaType)) throw new Error('发送图片仅支持 PNG、JPEG，请先转换格式。');
    await this.uploadAndSend(target, buffer, { type: 'image', filename: `image.${extension}`, label: '图片', signal });
    return `已发送图片：${basename(path)}`;
  }
}
