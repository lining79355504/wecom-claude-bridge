import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

const SYSTEM_PROMPT_APPEND = `
## 你正在通过企业微信远程操控

用户不在电脑前，是通过企业微信和你对话的。请遵守：

1. 回复要短。企微聊天窗口不适合长文，先给结论，需要细节再展开。
2. 用 Markdown，但不要用表格（企微渲染不好）。
3. 每次动手前先说一句你打算做什么，让远端的用户知道进展。
4. 涉及删除、强推、改配置这类不可逆操作，先说清楚会发生什么。
5. 用户看不到你的文件读写过程，重要改动要复述改了什么文件。
`;

/**
 * 一次对话会话（对应一个企微聊天）。
 * 用 SDK 的 query() + resume 保持多轮上下文。
 */
export class ClaudeSession {
  constructor({ chatKey, canUseTool, onEvent, logger }) {
    this.chatKey = chatKey;
    this.canUseTool = canUseTool;
    this.onEvent = onEvent;
    this.logger = logger;

    /** @type {string|null} 上一轮的 session_id，用于 resume */
    this.sessionId = null;
    this.lastActive = Date.now();
    this.abortController = null;
    /** 当前正在处理的原始帧，审批回调需要它来定位回复目标 */
    this.currentFrame = null;
  }

  get idleMs() {
    return Date.now() - this.lastActive;
  }

  isBusy() {
    return this.abortController !== null;
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      return true;
    }
    return false;
  }

  /**
   * 跑一轮对话。返回最终文本。
   */
  async run(prompt) {
    this.lastActive = Date.now();
    this.abortController = new AbortController();

    const options = {
      cwd: config.workspace,
      permissionMode: 'default',
      maxTurns: config.maxTurns,
      abortController: this.abortController,
      canUseTool: this.canUseTool,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_PROMPT_APPEND,
      },
      // 让 SDK 输出完整助手消息（含 tool_use / tool_result），用于进度提示
      includePartialMessages: false,
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    let finalText = '';
    let resultText = null;

    try {
      for await (const message of query({ prompt, options })) {
        this.lastActive = Date.now();

        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              this.sessionId = message.session_id ?? this.sessionId;
              this.logger.info(
                `[${this.chatKey}] session=${this.sessionId} model=${message.model}`,
              );
            }
            break;

          case 'assistant': {
            for (const block of message.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                finalText = block.text;
              } else if (block.type === 'tool_use') {
                this.onEvent?.({
                  kind: 'tool_use',
                  toolName: block.name,
                  input: block.input,
                });
              }
            }
            break;
          }

          case 'result': {
            if (message.subtype === 'success') {
              resultText = message.result ?? finalText;
              this.logger.info(
                `[${this.chatKey}] 完成 turns=${message.num_turns} cost=$${message.total_cost_usd?.toFixed(4)}`,
              );
            } else {
              this.logger.warn(
                `[${this.chatKey}] 异常结束 subtype=${message.subtype}`,
              );
              resultText =
                finalText ||
                `执行未正常结束（${message.subtype}）。可以换个说法重试，或发 /reset 开新会话。`;
            }
            break;
          }

          default:
            break;
        }
      }
    } finally {
      this.abortController = null;
      this.lastActive = Date.now();
    }

    return resultText ?? finalText ?? '（没有产生可展示的输出）';
  }

  reset() {
    this.sessionId = null;
  }
}
