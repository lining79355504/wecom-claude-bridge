/** Group robot webhook keys are credentials: validate strictly and never echo them in errors. */
export function validateWebhook(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Webhook URL 无效。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.port
    || url.pathname !== '/cgi-bin/webhook/send' || url.username || url.password || url.hash
    || !url.searchParams.get('key')?.trim() || url.searchParams.getAll('key').length !== 1
    || [...url.searchParams.keys()].some((key) => key !== 'key')) {
    throw new Error('仅支持 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=... 群机器人地址。');
  }
  return url.href;
}

export function redactSecrets(value) {
  return String(value).replace(/https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?[^\s<>"`]+/gi, '[群 Webhook 已隐藏]');
}

export function splitMarkdown(content, limit = 3800) {
  const chunks = [];
  let part = '', size = 0;
  for (const char of content || '（没有输出）') {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > limit) { chunks.push(part); part = ''; size = 0; }
    part += char;
    size += bytes;
  }
  if (part) chunks.push(part);
  return chunks;
}

export async function sendWebhook(target, content, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = validateWebhook(target);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
  } catch { throw new Error('群 Webhook 网络请求失败或超时。'); }
  if (!response.ok) throw new Error(`群 Webhook HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error('群 Webhook 返回了无效 JSON。'); }
  if (body.errcode !== 0) {
    throw new Error(`群 Webhook 发送失败，错误码 ${Number.isFinite(body.errcode) ? body.errcode : '未知'}`);
  }
}
