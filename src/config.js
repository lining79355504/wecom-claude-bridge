import 'dotenv/config';
import { resolve } from 'node:path';

/**
 * 配置按需校验：字段第一次被读取时才检查，这样单个模块可以脱离完整 .env
 * 单独测试，同时启动时一读到必填项就会 fail-fast。
 */
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `缺少必填配置 ${name}，请在 .env 中填写（参考 .env.example）`,
    );
  }
  return value.trim();
}

function list(name, fallback = '') {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`配置 ${name} 必须是 true/false，当前值: ${raw}`);
}

function num(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`配置 ${name} 必须是正数，当前值: ${raw}`);
  }
  return parsed;
}

const READ_ONLY_DEFAULT = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
].join(',');

export const config = {
  // 企微智能机器人：管理后台 → 智能机器人 → 开发设置
  get botId() {
    return required('WECOM_BOT_ID');
  },
  get botSecret() {
    return required('WECOM_BOT_SECRET');
  },

  // 只有这些 userid 能驱动 Claude；为空则拒绝所有人（fail-closed）
  get allowedUserIds() {
    return list('WECOM_ALLOWED_USER_IDS');
  },

  // Claude Code 的工作目录，必须是明确配置的仓库目录。
  // 故意不回退到 process.cwd()——静默用错目录会让 Claude 改错仓库。
  get workspace() {
    return resolve(required('CLAUDE_WORKSPACE'));
  },

  // 单次对话最多允许的 agent 轮数，防止死循环烧钱
  get maxTurns() {
    return num('CLAUDE_MAX_TURNS', 30);
  },

  get permissionMode() {
    const mode = process.env.CLAUDE_PERMISSION_MODE?.trim() || 'default';
    if (!['default', 'acceptEdits', 'auto'].includes(mode)) {
      throw new Error('CLAUDE_PERMISSION_MODE 必须是 default、acceptEdits 或 auto');
    }
    return mode;
  },

  // 单个会话空闲多久后丢弃上下文（毫秒），默认 30 分钟
  get sessionTtlMs() {
    return num('SESSION_TTL_MS', 30 * 60 * 1000);
  },

  // 审批等待超时（毫秒），超时按拒绝处理
  get approvalTimeoutMs() {
    return num('APPROVAL_TIMEOUT_MS', 5 * 60 * 1000);
  },

  // 白名单工具：这些不需要审批，直接放行（只读/低风险）
  get readOnlyTools() {
    return list('READ_ONLY_TOOLS', READ_ONLY_DEFAULT);
  },

  // 明确禁止的工具，任何情况下都不执行
  get deniedTools() {
    return list('DENIED_TOOLS');
  },

  // Bash 里判定为纯只读的命令（ls/cat/grep/git status…）直接放行，不再弹审批。
  // 判定不了一律回落到人工审批，见 src/bash-policy.js。
  get autoApproveReadOnlyBash() {
    return bool('BASH_READONLY_AUTO_APPROVE', true);
  },

  // 允许读写的目录白名单。默认只有工作目录本身；
  // 想放开到父目录（比如同时操作 某个目录 下多个仓库）就显式配置。
  // 设为 "*" 表示不限制（不推荐）。
  get allowedPaths() {
    const raw = process.env.CLAUDE_ALLOWED_PATHS;
    if (raw && raw.trim() === '*') return '*';
    const extra = list('CLAUDE_ALLOWED_PATHS');
    return extra.length > 0
      ? extra.map((p) => resolve(p))
      : [config.workspace];
  },
};

export function validateConfig() {
  // 依次触发必填项校验
  config.botId;
  config.botSecret;
  config.workspace;
  config.maxTurns;
  config.permissionMode;
  config.sessionTtlMs;
  config.approvalTimeoutMs;

  if (config.allowedUserIds.length === 0) {
    throw new Error(
      'WECOM_ALLOWED_USER_IDS 为空。为了避免任何人都能操作你的电脑，这里必须填写白名单 userid。',
    );
  }
}
