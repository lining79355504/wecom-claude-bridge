/**
 * 启动前自检：不连企微，只验证本地依赖、配置和 Claude SDK 能不能跑通。
 *
 *   npm run check
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

let failed = 0;

console.log('\n[1/4] 配置文件');
if (!existsSync('.env')) {
  bad('.env 不存在，请先 cp .env.example .env 并填写');
  failed++;
} else {
  ok('.env 存在');
}

let config;
let validateConfig;
let describeScope;
try {
  ({ describeScope } = await import('../src/guard.js'));
  ({ config, validateConfig } = await import('../src/config.js'));
  validateConfig();
  ok('配置校验通过');
  ok(`工作目录: ${config.workspace}`);
  ok(`权限模式: ${config.permissionMode}`);
  ok(`白名单人数: ${config.allowedUserIds.length}`);
  ok(`只读放行工具: ${config.readOnlyTools.length} 个`);
  ok(`目录围栏: ${describeScope(config.allowedPaths)}`);
} catch (err) {
  bad(err.message);
  failed++;
}

console.log('\n[2/4] 工作目录');
if (config) {
  if (!existsSync(config.workspace)) {
    bad(`目录不存在: ${config.workspace}`);
    failed++;
  } else if (!statSync(config.workspace).isDirectory()) {
    bad(`不是目录: ${config.workspace}`);
    failed++;
  } else {
    ok('目录存在');
  }
}

console.log('\n[3/4] 依赖');
for (const dep of [
  '@wecom/aibot-node-sdk',
  '@anthropic-ai/claude-agent-sdk',
  'dotenv',
]) {
  try {
    await import(dep);
    ok(dep);
  } catch (err) {
    bad(`${dep} 加载失败: ${err.message}`);
    failed++;
  }
}

console.log('\n[4/4] Claude Code 认证');
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  ok(`claude CLI: ${out}`);
} catch {
  bad('找不到 claude 命令，Claude Code 可能没装或不在 PATH');
  failed++;
}

console.log('');
if (failed > 0) {
  console.log(`检查未通过，共 ${failed} 项问题。\n`);
  process.exit(1);
}
console.log('全部通过，可以 npm start 了。\n');
