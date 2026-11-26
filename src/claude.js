import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from './config.js';
import { createToolGuard } from './guard.js';
import { claudeFailure, isTurnLimitError } from './claude-errors.js';

const SYSTEM_PROMPT_APPEND = `
## 你正在通过企业微信远程操控

用户不在电脑前，是通过企业微信和你对话的。请遵守：

1. 回复要短。企微聊天窗口不适合长文，先给结论，需要细节再展开。
2. 用 Markdown，但不要用表格（企微渲染不好）。
3. 每次动手前先说一句你打算做什么，让远端的用户知道进展。
4. 涉及删除、强推、改配置这类不可逆操作，先说清楚会发生什么。
5. 用户看不到你的文件读写过程，重要改动要复述改了什么文件。
请把执行计划、发现和下一步用简短的面向用户的说明表达；这些说明可能作为进度展示。不要输出内部思维链。
`;

const IMAGE_INSTRUCTIONS = `
6. 用户可以发送图片。图片内容直接附在输入中，同时提供本地副本路径，方便使用现有工具裁剪、标注或转换格式。不要修改收到的原图副本，处理结果另存文件。
7. 用户要求发送图片或截图时，先生成或找到实际图片文件，再调用 mcp__wecom_images__send_image。仅支持 PNG/JPEG，最大 2 MiB；必要时先缩小或压缩。工具成功才表示已发送，不要用本地 Markdown 图片路径冒充发送成功。
8. 截图、图像编辑依赖本机已有工具及系统授权，仍遵守工具审批和目录限制。没有可用的截图或编辑工具时明确说明。
`;

const FILE_INSTRUCTIONS = `
用户要求发送本地文件、报告、代码或压缩包时，先生成或找到实际文件，再调用 mcp__wecom_files__send_file 发回当前聊天。支持非空普通文件，单个最大 20 MiB，保留原始文件名。目录需先打包，超限文件需压缩或拆分；相关操作遵守工具审批和目录限制。
只有发送工具返回成功才表示文件已发送，不要用本地路径或 Markdown 链接冒充附件。发送失败时明确告知，送达状态不明时不要自动重复发送。此工具用于发出文件，不表示可以接收企微文件附件。
`;

export function imageSenderTool(sendImage, getSignal) {
  return tool('send_image', '把本地 PNG/JPEG 图片发送到本工单的当前企业微信聊天，最大 2 MiB。仅在用户要求发图时调用。',
    { file_path: z.string().min(1).describe('图片文件路径，相对路径以工单工作目录为准') },
    async ({ file_path }) => {
      try {
        const result = await sendImage(file_path, { signal: getSignal() });
        return { content: [{ type: 'text', text: result }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    }, { alwaysLoad: true });
}

export function fileSenderTool(sendFile, getSignal) {
  return tool('send_file', '把本地文件发送到本工单的当前企业微信聊天，保留文件名，最大 20 MiB。仅在用户要求发文件时调用。',
    { file_path: z.string().min(1).describe('本地文件路径，相对路径以工单工作目录为准；不能是目录或 URL') },
    async ({ file_path }) => {
      try {
        const result = await sendFile(file_path, { signal: getSignal() });
        return { content: [{ type: 'text', text: result }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    }, { alwaysLoad: true });
}

async function* userMessage(text, images, sessionId) {
  const content = [{ type: 'text', text }];
  for (const [index, image] of images.entries()) {
    content.push({ type: 'text', text: `图片 ${index + 1}（本地副本：${image.path}）` });
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.buffer.toString('base64') } });
  }
  yield { type: 'user', session_id: sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content } };
}

/**
 * 一次对话会话（对应一张工单）。
 * 用 SDK 的 query() + resume 保持多轮上下文。
 */
export class ClaudeSession {
  constructor({ chatKey, canUseTool, onEvent, onDenied, onSessionId, workspace = config.workspace, sessionId = null,
    maxTurns = config.maxTurns, queryFn = query, logger, sendImage, sendFile }) {
    this.chatKey = chatKey;
    this.canUseTool = canUseTool;
    this.onEvent = onEvent;
    this.logger = logger;
    this.workspace = workspace;
    this.onSessionId = onSessionId;
    this.maxTurns = maxTurns;
    this.query = queryFn;
    this.sendImage = sendImage;
    this.sendFile = sendFile;
    this.toolGuard = createToolGuard({
      get deniedTools() { return config.deniedTools; },
      get allowedPaths() { return config.allowedPaths; },
      workspace,
    }, async (reason) => {
      this.logger.warn(`[${this.chatKey}] 工具拦截: ${reason}`);
      await onDenied?.(reason);
    });

    /** @type {string|null} 上一轮的 session_id，用于 resume */
    this.sessionId = sessionId;
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
      return true;
    }
    return false;
  }

  /**
   * 跑一轮对话。返回最终文本。
   */
  async run(prompt, images = []) {
    if (this.isBusy()) throw new Error('当前工单仍在执行');
    this.lastActive = Date.now();
    this.lastRunSucceeded = false;
    this.lastRunFailure = null;
    this.abortController = new AbortController();

    const options = {
      cwd: this.workspace,
      permissionMode: config.permissionMode,
      hooks: {
        PreToolUse: [{ hooks: [this.toolGuard], onFailure: 'block' }],
      },
      maxTurns: this.maxTurns,
      abortController: this.abortController,
      canUseTool: this.canUseTool,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_PROMPT_APPEND + (this.sendImage ? IMAGE_INSTRUCTIONS : '') + (this.sendFile ? FILE_INSTRUCTIONS : ''),
      },
      // 让 SDK 输出完整助手消息（含 tool_use / tool_result），用于进度提示
      includePartialMessages: false,
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }
    if (this.sendImage) {
      options.mcpServers = { wecom_images: createSdkMcpServer({
        name: 'wecom_images', tools: [imageSenderTool(this.sendImage, () => this.abortController?.signal)],
      }) };
    }
    if (this.sendFile) {
      options.mcpServers = { ...options.mcpServers, wecom_files: createSdkMcpServer({
        name: 'wecom_files', tools: [fileSenderTool(this.sendFile, () => this.abortController?.signal)],
      }) };
    }

    let finalText = '';
    let resultText = null;

    try {
      const input = images.length || this.sendImage || this.sendFile ? userMessage(prompt, images, this.sessionId) : prompt;
      for await (const message of this.query({ prompt: input, options })) {
        this.lastActive = Date.now();

        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              this.sessionId = message.session_id ?? this.sessionId;
              this.onSessionId?.(this.sessionId);
              this.logger.info(
                `[${this.chatKey}] session=${this.sessionId} model=${message.model}`,
              );
            }
            break;

          case 'assistant': {
            for (const block of message.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                finalText = block.text;
                this.onEvent?.({ kind: 'assistant_text', text: block.text });
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

          case 'user': {
            if (message.isReplay) break;
            for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
              if (block.type !== 'tool_result') continue;
              const text = typeof block.content === 'string' ? block.content
                : (Array.isArray(block.content) ? block.content : [])
                  .filter((item) => item.type === 'text').map((item) => item.text).join('\n');
              if (text) this.onEvent?.({ kind: 'tool_result', text, isError: Boolean(block.is_error) });
            }
            break;
          }

          case 'result': {
            if (message.subtype === 'success' && !message.is_error) {
              this.lastRunSucceeded = true;
              resultText = message.result ?? finalText;
              this.logger.info(
                `[${this.chatKey}] 完成 turns=${message.num_turns} cost=$${message.total_cost_usd?.toFixed(4)}`,
              );
            } else {
              this.lastRunSucceeded = false;
              this.lastRunFailure = claudeFailure(message, this.maxTurns);
              this.logger.warn(
                `[${this.chatKey}] 异常结束 subtype=${message.subtype}`,
              );
              resultText = [this.lastRunFailure.message, finalText ? `**中断前的部分输出（非最终结果）**\n${finalText}` : ''].filter(Boolean).join('\n\n');
            }
            break;
          }

          default:
            break;
        }
      }
    } catch (error) {
      this.lastRunSucceeded = false;
      this.lastRunFailure = claudeFailure(error, this.maxTurns);
      if (!isTurnLimitError(error)) throw error;
      resultText = [this.lastRunFailure.message, finalText ? `**中断前的部分输出（非最终结果）**\n${finalText}` : ''].filter(Boolean).join('\n\n');
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
