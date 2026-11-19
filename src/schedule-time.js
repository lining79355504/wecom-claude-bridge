/** Deliberately small grammar: intervals, daily wall-clock times, and one-off ISO timestamps. */
export function parseRule(kind, value, timezone = 'Asia/Shanghai', now = Date.now()) {
  if (kind === 'every') {
    const match = /^(\d+)(m|h|d)$/.exec(value);
    const interval = match && Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]];
    if (!Number.isSafeInteger(interval) || interval < 60000 || interval > 366 * 86400000) {
      throw new Error('间隔格式：every 30m / 2h / 1d，范围 1 分钟至 366 天。');
    }
    return { kind, interval };
  }
  if (kind === 'daily') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('每天时间格式：daily 09:00');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
    catch { throw new Error('无效时区，请使用 Asia/Shanghai 等 IANA 时区。'); }
    return { kind, time: value, timezone };
  }
  if (kind === 'once') {
    const at = Date.parse(value);
    const validDate = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && Number.isFinite(at)
      && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
    if (!validDate || at <= now) {
      throw new Error('单次时间须为未来时间且带时区，例如 once 2027-01-01T09:00+08:00');
    }
    return { kind, at };
  }
  throw new Error('时间规则支持 every / daily / once。');
}

export function nextOccurrence(rule, after) {
  if (rule.kind === 'every') return after + rule.interval;
  if (rule.kind === 'once') return rule.at > after ? rule.at : null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: rule.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: rule.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const skipToday = formatter.format(after) >= rule.time;
  const today = dateFormatter.format(after);
  // Walk real minutes so DST gaps are skipped and no machine-local timezone leaks in.
  const start = Math.floor(after / 60000) * 60000 + 60000;
  for (let at = start; at <= start + 50 * 3600000; at += 60000) {
    if (formatter.format(at) === rule.time && (!skipToday || dateFormatter.format(at) !== today)) return at;
  }
  throw new Error('无法计算下次执行时间。');
}

export function describeRule(rule) {
  if (rule.kind === 'every') return `每 ${rule.interval / 60000} 分钟`;
  if (rule.kind === 'daily') return `每天 ${rule.time}（${rule.timezone}）`;
  return new Date(rule.at).toISOString();
}
