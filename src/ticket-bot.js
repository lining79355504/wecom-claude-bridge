import { ApprovalManager, renderApprovalPrompt } from './approval.js';
import { analyzeBashCommand } from './bash-policy.js';
import { isInside } from './guard.js';
import { STATUS } from './tickets.js';

const approvalReply = /^(?:y|yes|n|no|同意|拒绝)(?:\s|$)/i;
const label = (ticket) => `#${ticket.id} ${ticket.title}`;

/** 消息路由和串行执行器，传输层与 Claude SDK 可替换，便于离线测试。 */
export class TicketBot {
  constructor({ store, config, send, createProgress, createSession, logger, scheduler, imageService }) {
    Object.assign(this, { store, config, send, createProgress, createSession, logger, scheduler, imageService });
    this.approvals = new ApprovalManager({ logger, timeoutMs: config.approvalTimeoutMs });
    this.sessions = new Map();
    this.frames = new Map();
    this.active = null;
    this.draining = false;
    this.shuttingDown = false;
  }

  async handle({ chatKey, userId, text, frame, images = [] }) {
    try {
      if (this.shuttingDown) return;
      if (text.startsWith('/')) return await this.command(chatKey, userId, text, frame, images);
      if (!images.length && approvalReply.test(text)) {
        const result = this.approvals.settleByReply(chatKey, text);
        const pending = this.approvals.getPending(chatKey);
        await this.send(frame, result === 'approved' ? '✅ 已同意，继续执行。'
          : result === 'denied' ? '❌ 已拒绝。'
            : pending ? `请携带审批编号：\`y ${pending.id}\` 或 \`n ${pending.id}\`。`
              : '当前没有待审批操作，该回复未执行。');
        return;
      }
      let ticket = this.store.current(chatKey);
      if (!ticket || ticket.status === 'closed') {
        ticket = this.store.create(chatKey, userId, text, this.config.workspace);
      }
      await this.submit(ticket, text, frame, images);
    } catch (error) {
      this.logger.error('工单消息处理失败', error);
      await this.send(frame, `❌ ${error.message}`);
    }
  }

  target(chatKey, arg) {
    if (arg) {
      if (!/^#?[1-9]\d*$/.test(arg)) throw new Error('请填写有效工单编号，例如 /switch 12。');
      return this.store.require(chatKey, Number(arg.replace('#', '')));
    }
    const current = this.store.current(chatKey);
    if (!current) throw new Error('当前没有工单，请发送 /new 需求描述。');
    return current;
  }

  async command(chatKey, userId, text, frame, images = []) {
    if (images.length && !/^\/new(?:\s|$)/.test(text)) throw new Error('带图片的命令仅支持 /new 需求；也可以直接发送图片或图文作为当前工单补充。');
    if (/^\/schedule(?:\s|$)/.test(text)) {
      if (!this.scheduler) throw new Error('定时服务尚未启用。');
      return this.scheduler.handle({ chatKey, userId, text: text.slice('/schedule'.length), frame, reply: this.send });
    }
    const [command, ...parts] = text.slice(1).split(/\s+/);
    const arg = parts.join(' ').trim();
    if (command === 'new') {
      if (!arg && !images.length) throw new Error('用法：/new 需求描述');
      const request = arg || '请分析收到的图片。';
      const ticket = this.store.create(chatKey, userId, request, this.config.workspace);
      return this.submit(ticket, request, frame, images);
    }
    if (command === 'list') {
      const current = this.store.current(chatKey);
      const rows = this.store.list(chatKey);
      return this.send(frame, rows.length ? '**最近 20 张工单**\n\n' + rows.map((t) =>
        `${t.id === current?.id ? '👉 ' : ''}${label(t)} · ${STATUS[t.status]}`).join('\n')
        : '暂无工单，发送 /new 需求描述 创建。');
    }
    if (['help', '?'].includes(command)) {
      return this.send(frame, [
        '**工单命令**',
        '`/new 需求` 创建并执行新工单',
        '`/list` 查看最近工单',
        '`/switch 编号` 切换当前工单',
        '`/status [编号]` 查看状态和待审批操作',
        '`/history [编号]` 查看最近 10 条记录',
        '`/stop [编号]` 中止执行并取消该工单排队消息（默认停止本聊天正在执行的工单）',
        '`/resume [编号]` 恢复重启前任务或继续处理',
        '`/close [编号]` 验收并关闭',
        '`/reset` 清空当前工单 Claude 上下文，保留记录',
        '`/schedule help` 定时执行 Claude 任务，推送到当前聊天或群 Webhook',
        '',
        '普通消息归入当前工单；忙时补充需求会排队。所有工单串行执行。',
        '支持图片和图文（每条最多 4 张，单张 5 MiB）；可要求识图、修改图片或把本地 PNG/JPEG 发回聊天（单张 2 MiB）。',
        `权限模式：${this.config.permissionMode}。审批请回复提示中的完整编号。`,
      ].join('\n'));
    }
    if (!['switch', 'status', 'history', 'stop', 'resume', 'close', 'reset', 'clear'].includes(command)) {
      throw new Error(`未知命令 /${command}，发送 /help 查看用法。`);
    }
    // 切换工单后，/stop 仍能停止本聊天正在执行的任务；显式编号始终优先。
    const ticket = command === 'stop' && !arg && this.active?.ticket.chat_key === chatKey
      ? this.store.require(chatKey, this.active.ticket.id) : this.target(chatKey, arg);
    if (command === 'switch') {
      if (!arg) throw new Error('用法：/switch 工单编号');
      this.store.select(chatKey, ticket.id);
      return this.send(frame, `已切换到 **${label(ticket)}**（${STATUS[ticket.status]}）。`);
    }
    if (command === 'status') {
      const pending = this.approvals.getPending(chatKey);
      return this.send(frame, [
        `**${label(ticket)}**`,
        `状态：${STATUS[ticket.status]}`,
        `工作目录：\`${ticket.workspace}\``,
        `权限模式：${this.config.permissionMode}`,
        `待处理消息：${this.store.pending(ticket.id).length}`,
        `上下文：${ticket.session_id ? '已保存' : '新会话'}`,
        ...(this.active?.ticket.chat_key === chatKey ? [`本聊天正在执行：#${this.active.ticket.id}`] : []),
        ...(pending ? [`工单 #${pending.ticketId} 待审批：\`y ${pending.id}\` / \`n ${pending.id}\``] : []),
      ].join('\n'));
    }
    if (command === 'history') {
      const rows = this.store.history(ticket.id);
      return this.send(frame, `**${label(ticket)} · 最近记录**\n\n` + (rows.map((m) =>
        `${m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Claude' : '系统'}：${m.content.slice(0, 500)}`).join('\n\n') || '暂无记录。'));
    }
    if (command === 'stop') {
      if (ticket.status === 'closed') throw new Error('工单已关闭。');
      for (const job of this.store.cancelQueued(ticket.id)) this.frames.delete(job.id);
      if (this.active?.ticket.id === ticket.id) {
        this.active.cancelled = true;
        this.approvals.cancel(chatKey, '用户中止工单');
        this.active.session.abort();
      }
      this.store.setStatus(ticket.id, 'stopped');
      this.store.addMessage(ticket.id, 'system', '用户中止执行并取消排队消息。');
      return this.send(frame, `🛑 工单 #${ticket.id} 已请求停止，排队消息已取消。正在执行的操作退出前不会启动下一项。`);
    }
    if (command === 'close') {
      if (this.active?.ticket.id === ticket.id || this.store.pending(ticket.id).length) {
        throw new Error(`工单 #${ticket.id} 尚有任务，请先 /stop ${ticket.id}，等执行退出后再关闭。`);
      }
      this.store.setStatus(ticket.id, 'closed');
      this.store.addMessage(ticket.id, 'system', '用户验收并关闭工单。');
      this.sessions.delete(ticket.id);
      return this.send(frame, `✅ 工单 #${ticket.id} 已关闭，历史记录保留。`);
    }
    if (['reset', 'clear'].includes(command)) {
      if (this.active?.ticket.id === ticket.id || this.store.pending(ticket.id).length) {
        throw new Error('请先停止该工单，等待执行退出后再重置上下文。');
      }
      this.sessions.delete(ticket.id);
      this.store.setSession(ticket.id, null);
      this.store.addMessage(ticket.id, 'system', '用户清空 Claude 上下文。');
      return this.send(frame, `工单 #${ticket.id} 的 Claude 上下文已清空，工单记录保留。`);
    }
    if (command === 'resume') {
      if (ticket.status === 'closed') throw new Error('工单已关闭，请用 /new 创建后续需求。');
      if (this.active?.ticket.id === ticket.id || this.store.pending(ticket.id).some((j) => j.state !== 'paused')) {
        throw new Error('该工单已在执行或排队，请直接发消息补充需求。');
      }
      this.store.select(chatKey, ticket.id);
      const jobs = this.store.resume(ticket.id);
      if (!jobs.length) return this.submit(ticket, '继续处理这张工单。先核查已经完成的工作，避免重复执行。', frame);
      for (const job of jobs) this.frames.set(job.id, frame);
      await this.send(frame, `工单 #${ticket.id} 已恢复 ${jobs.length} 条待处理消息，将先核查上次进度再继续。`);
      this.kick();
    }
  }

  async submit(ticket, text, frame, images = []) {
    if (images.length) text += `\n\n[附带 ${images.length} 张图片]`;
    if (this.store.pending(ticket.id).some((j) => j.state === 'paused')) {
      // 保持先后顺序：重启前的消息未经 /resume，不允许新消息越过它们执行。
      const jobId = this.store.enqueue(ticket.id, text, images);
      this.store.jobState(jobId, 'paused');
      this.store.setStatus(ticket.id, 'stopped');
      await this.send(frame, `工单 #${ticket.id} 的补充已保存。该工单在重启后暂停，请 /resume ${ticket.id} 继续。`);
      return;
    }
    const jobId = this.store.enqueue(ticket.id, text, images);
    this.frames.set(jobId, frame);
    await this.send(frame, `📋 **${label(ticket)}**\n需求已保存，${this.draining ? '已排队，当前操作结束后处理' : '准备执行'}。`);
    this.kick();
  }

  kick() {
    if (this.draining || this.shuttingDown) return;
    this.draining = true;
    let failed = false;
    this.drainPromise = this.drain().catch((error) => {
      failed = true;
      this.logger.error('工单队列异常', error);
    })
      .finally(() => {
        this.draining = false;
        // 最后一项结束与 finally 之间可能又收到消息，不能把它留在队列里。
        if (!failed && !this.shuttingDown && this.store.nextJob()) this.kick();
      });
  }

  async drain() {
    while (!this.shuttingDown) {
      const job = this.store.nextJob();
      if (!job) return;
      const frame = this.frames.get(job.id);
      const ticket = this.store.get(job.ticket_id);
      if (!frame) {
        this.store.jobState(job.id, 'paused');
        this.store.setStatus(ticket.id, 'stopped');
        continue;
      }
      const session = this.getSession(ticket);
      const active = { ticket, session, job, cancelled: false };
      this.active = active;
      session.currentFrame = frame;
      const progress = this.createProgress(frame, ticket);
      session.onEvent = (event) => {
        if (event.kind === 'tool_use') {
          const detail = event.input?.command ?? event.input?.file_path ?? event.input?.path ?? '';
          void progress.push(`${event.toolName}: ${String(detail).slice(0, 150)}`);
        }
      };
      this.store.jobState(job.id, 'running');
      this.store.setStatus(ticket.id, 'running');
      try {
        if (!isInside(ticket.workspace, this.config.allowedPaths)) {
          throw new Error('工单工作目录不在当前允许目录内，请调整 CLAUDE_ALLOWED_PATHS 后重试。');
        }
        await progress.push(`工单 #${ticket.id} 开始处理…`);
        if (active.cancelled || this.shuttingDown) throw new Error('任务已中止');
        const initial = this.store.initialRequest(ticket.id);
        const preface = session.sessionId ? '' : `当前工单：${label(ticket)}\n`
          + (initial && initial !== job.content ? `最初需求：${initial}\n` : '') + '\n';
        const recovery = job.recovered ? '上次执行被中断。先核查已完成的工作，避免重复执行操作。\n\n' : '';
        const storedImages = this.store.images(job.message_id);
        if (storedImages.length && !this.imageService) throw new Error('图片处理服务尚未启用。');
        const images = storedImages.length ? await this.imageService.prepareInput(ticket, storedImages) : [];
        if (active.cancelled || this.shuttingDown) throw new Error('任务已中止');
        const answer = await session.run(preface + recovery + job.content, images);
        if (active.cancelled || this.shuttingDown) throw new Error('任务已中止');
        this.store.addMessage(ticket.id, 'assistant', answer || '（没有输出）');
        this.store.jobState(job.id, session.lastRunSucceeded === false ? 'failed' : 'done');
        this.store.setStatus(ticket.id, session.lastRunSucceeded === false ? 'failed' : 'review');
        if (session.lastRunSucceeded === false) this.pauseRemaining(ticket.id);
        else if (this.store.pending(ticket.id).length) this.store.setStatus(ticket.id, 'queued');
        await progress.finish(`**工单 #${ticket.id} · ${STATUS[this.store.get(ticket.id).status]}**\n\n${answer || '（没有输出）'}`
          + (session.lastRunSucceeded === false ? `\n\n可用 /resume ${ticket.id} 继续处理。` : ''));
      } catch (error) {
        this.store.jobState(job.id, this.shuttingDown ? 'paused' : active.cancelled ? 'cancelled' : 'failed');
        this.store.setStatus(ticket.id, this.shuttingDown || active.cancelled ? 'stopped' : 'failed');
        this.pauseRemaining(ticket.id);
        this.store.addMessage(ticket.id, 'system', error.message);
        await progress.finish(`**工单 #${ticket.id}**\n${active.cancelled ? '🛑 已停止。' : `❌ ${error.message}`}`
          + `\n可用 /resume ${ticket.id} 继续处理。`);
      } finally {
        this.approvals.cancel(ticket.chat_key, '本轮执行已结束');
        session.currentFrame = null;
        session.onEvent = () => {};
        this.frames.delete(job.id);
        this.active = null;
      }
    }
  }

  pauseRemaining(id) {
    for (const job of this.store.pending(id)) {
      if (job.state === 'queued') this.store.jobState(job.id, 'paused');
      this.frames.delete(job.id);
    }
  }

  getSession(ticket) {
    if (!this.sessions.has(ticket.id)) {
      const session = this.createSession({
        chatKey: `${ticket.chat_key}/ticket:${ticket.id}`,
        workspace: ticket.workspace,
        sessionId: ticket.session_id,
        onSessionId: (id) => this.store.setSession(ticket.id, id),
        onDenied: (reason) => this.send(session.currentFrame, `🚫 工单 #${ticket.id} 已拦截：${reason}`),
        canUseTool: (name, input, opts) => this.permission(ticket, session.currentFrame, name, input, opts),
        sendImage: this.imageService ? (path, options) => {
          if (this.active?.session !== session || this.active.cancelled || this.shuttingDown) throw new Error('工单已停止，不能发送图片。');
          return this.imageService.sendImage(session.currentFrame, ticket, path, options);
        } : undefined,
        logger: this.logger,
      });
      this.sessions.set(ticket.id, session);
    }
    return this.sessions.get(ticket.id);
  }

  async permission(ticket, frame, name, input, opts) {
    if (opts?.signal?.aborted || this.active?.cancelled || this.shuttingDown) {
      return { behavior: 'deny', message: '任务已中止' };
    }
    if (this.config.permissionMode !== 'auto' && (this.config.readOnlyTools.includes(name)
      || (name === 'Bash' && this.config.autoApproveReadOnlyBash && analyzeBashCommand(input?.command).readOnly))) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (this.approvals.hasPending(ticket.chat_key)) {
      return { behavior: 'deny', message: '当前工单已有待审批操作，请等待该操作处理后重试。' };
    }
    const { id, promise } = this.approvals.request({
      chatKey: ticket.chat_key, ticketId: ticket.id, title: opts?.title || name, detail: input,
    });
    this.store.setStatus(ticket.id, 'approval');
    const cancel = () => this.approvals.settle(ticket.chat_key, id, false, '任务已中止');
    opts?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.send(frame, renderApprovalPrompt(name, input, opts?.title, {
        id, ticketId: ticket.id, timeoutMs: this.config.approvalTimeoutMs,
      }));
      const decision = await promise;
      this.store.addMessage(ticket.id, 'system', `审批 ${id} ${name}：${decision.reason}`);
      if (!this.active?.cancelled && !this.shuttingDown) this.store.setStatus(ticket.id, 'running');
      return decision.allowed ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: decision.reason };
    } finally {
      opts?.signal?.removeEventListener('abort', cancel);
      this.approvals.settle(ticket.chat_key, id, false, '审批结束');
    }
  }

  evictIdle() {
    for (const [id, session] of this.sessions) {
      if (this.active?.ticket.id !== id && !session.isBusy() && session.idleMs > this.config.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.active) {
      this.approvals.cancel(this.active.ticket.chat_key, '桥接进程退出');
      this.active.session.abort();
    }
  }
}
