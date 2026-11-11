import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { createToolGuard } from '../src/guard.js';

const policy = {
  workspace: '/workspace/project',
  allowedPaths: ['/workspace/project'],
  deniedTools: ['WebFetch'],
};
const event = (tool_name, tool_input) => ({
  hook_event_name: 'PreToolUse', tool_name, tool_input,
});

test('权限模式：兼容默认值、支持 auto 和 acceptEdits、拒绝无效值', () => {
  const previous = process.env.CLAUDE_PERMISSION_MODE;
  try {
    delete process.env.CLAUDE_PERMISSION_MODE;
    assert.equal(config.permissionMode, 'default');
    for (const mode of ['auto', 'acceptEdits', 'default']) {
      process.env.CLAUDE_PERMISSION_MODE = mode;
      assert.equal(config.permissionMode, mode);
    }
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
    assert.throws(() => config.permissionMode, /CLAUDE_PERMISSION_MODE/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PERMISSION_MODE;
    else process.env.CLAUDE_PERMISSION_MODE = previous;
  }
});

test('合法编辑和命令不抢先批准，留给原生权限判断', async () => {
  const guard = createToolGuard(policy);
  assert.deepEqual(await guard(event('Edit', { file_path: 'src/app.js' })), {});
  assert.deepEqual(await guard(event('Bash', { command: 'npm test' })), {});
});

test('禁用工具、相对路径越界、相似前缀和 Bash 绝对路径均拒绝', async () => {
  const notices = [];
  const guard = createToolGuard(policy, (reason) => notices.push(reason));
  const cases = [
    event('WebFetch', { url: 'https://example.com' }),
    event('Edit', { file_path: '../private/file' }),
    event('Read', { file_path: '/workspace/project-other/file' }),
    event('Bash', { command: 'cat /workspace/private/file' }),
  ];
  for (const input of cases) {
    const result = await guard(input);
    assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(result.hookSpecificOutput.permissionDecisionReason);
  }
  assert.equal(notices.length, cases.length);
});

test('路径不限时仍禁止禁用工具', async () => {
  const guard = createToolGuard({ ...policy, allowedPaths: '*' });
  assert.deepEqual(await guard(event('Read', { file_path: '/elsewhere/file' })), {});
  const result = await guard(event('WebFetch', {}));
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
});

test('钩子异常不返回放行，交由 SDK 的 onFailure:block 阻止执行', async () => {
  const guard = createToolGuard(policy, () => { throw new Error('通知失败'); });
  await assert.rejects(guard(event('WebFetch', {})), /通知失败/);
});
