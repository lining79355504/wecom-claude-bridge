import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 判断 target 是否落在 allowedRoots 之内（含根本身）。
 * 用 path.relative 而不是字符串前缀匹配，避免 /foo/barbaz 被 /foo/bar 误判为子路径。
 */
export function isInside(target, allowedRoots) {
  if (allowedRoots === '*') return true;
  const abs = resolve(target);
  return allowedRoots.some((root) => {
    const rel = relative(resolve(root), abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** 从工具入参里提取涉及的路径字段 */
function extractPaths(toolName, input) {
  if (!input || typeof input !== 'object') return [];

  const paths = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) paths.push(v);
  };

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookRead':
    case 'NotebookEdit':
      push(input.file_path);
      push(input.path);
      push(input.notebook_path);
      break;

    case 'Glob':
    case 'Grep':
      push(input.path);
      break;

    case 'LS':
      push(input.path);
      break;

    default:
      break;
  }

  return paths;
}

/**
 * 路径围栏。返回 null 表示放行，否则返回拒绝原因。
 *
 * 注意：`..` 会被 resolve 归一化，符号链接不在此处理范围内——
 * 这一层防的是「模型跑偏到别的仓库」，不是防恶意逃逸。
 */
export function checkPathScope(toolName, input, allowedRoots, cwd) {
  if (allowedRoots === '*') return null;

  const paths = extractPaths(toolName, input);
  for (const p of paths) {
    // 相对路径在 Claude 眼里是相对于它的 cwd，按同样规则解析
    const abs = cwd && !isAbsolute(p) ? resolve(cwd, p) : p;
    if (!isInside(abs, allowedRoots)) {
      return `${p} 不在允许的目录范围内`;
    }
  }
  return null;
}

/**
 * Bash 命令的目录检查：命令里出现的绝对路径同样要在允许范围内。
 * 这是尽力而为的检查，不是沙箱——只能拦住明显的越界。
 */
export function checkBashScope(command, allowedRoots) {
  if (allowedRoots === '*') return null;
  if (typeof command !== 'string') return null;

  // 抓取看起来像绝对路径的 token
  const candidates = command.match(/(?:^|[\s"'=<>|;(&])(\/[^\s"'|;&)<>]+)/g) ?? [];
  for (const raw of candidates) {
    const p = raw.replace(/^[\s"'=<>|;(&]+/, '').replace(/[,:]+$/, '');
    // 放行系统目录的只读访问（Claude 需要 /usr/bin、/tmp 等）
    if (isCommonSystemPath(p)) continue;
    if (!isInside(p, allowedRoots)) {
      return `命令涉及目录 ${p}，不在允许的范围内`;
    }
  }
  return null;
}

const SYSTEM_PREFIXES = [
  '/usr/',
  '/bin/',
  '/sbin/',
  '/opt/homebrew/',
  '/etc/',
  '/var/',
  '/private/var/',
  '/dev/',
  '/tmp/',
  '/private/tmp/',
];

function isCommonSystemPath(p) {
  return SYSTEM_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

/** 路径是否在某个根目录下（供日志展示用） */
export function describeScope(allowedRoots) {
  return allowedRoots === '*' ? '不限制' : allowedRoots.join(', ');
}

export { extractPaths, sep };
