import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { ApprovalManager, renderApprovalPrompt } from './approval.js';
import { analyzeBashCommand } from './bash-policy.js';
import { isInside } from './guard.js';
import { isTurnLimitError, claudeFailure } from './claude-errors.js';
import { parseRule, describeRule } from './schedule-time.js';
import { validateWebhook, sendWebhook, redactSecrets, splitMarkdown } from './schedule-delivery.js';

export const SCHEDULE_HELP = [
  '**定时 Claude 任务**',
  '`/schedule add every 30m -- 检查仓库并总结`',
  '`/schedule add daily 09:00 --timezone Asia/Shanghai -- 生成日报`',
  '`/schedule add once 2027-01-01T09:00+08:00 -- 检查发布状态`',
  'add 可在 `--` 前加 `--webhook URL` 或 `--workspace "/绝对路径"`。默认推送到当前聊天。',
  '`/schedule list` 查看任务',
  '`/schedule show 编号` 查看详情、下次时间和待审批请求',
  '`/schedule history 编号` 查看最近 10 次执行和推送状态',
  '`/schedule pause 编号` 暂停调度并取消排队，正在执行的本轮继续',
  '`/schedule resume 编号` 恢复后续调度',
  '`/schedule run 编号` 立即运行一次，不改变周期',
  '`/schedule stop 编号` 中止本轮并取消排队，保留后续调度',
  '`/schedule delete 编号` 删除任务并中止执行，保留历史数据库记录',
  '`/schedule retry 运行编号` 重试已耗尽自动重试的推送，不重跑 Claude',
  '`/schedule approve 审批编号` / `/schedule reject 审批编号`',
].join('\n');

function identifier(value) {
  if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('请填写有效编号。');
  return Number(value);
}

export function parseAdd(text, config, now) {
  const separator = /\s+--(?:\s|$)/.exec(text);
  if (!separator) throw new Error('用法：/schedule add every 30m [--webhook URL] -- 任务内容');
  const prompt = text.slice(separator.index + separator[0].length).trim();
  if (!prompt) throw new Error('任务内容不能为空。');
  const prefix = text.slice(0, separator.index);
  const tokens = [];
  const pattern = /\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']+))(?=\s|$)/gy;
  while (pattern.lastIndex < prefix.length) {
    const match = pattern.exec(prefix);
    if (!match) throw new Error('参数格式错误；含空格的路径请用引号包裹。');
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  const [kind, value, ...options] = tokens;
  const settings = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (!['--webhook', '--workspace', '--timezone'].includes(key) || !options[i + 1] || key in settings) {
      throw new Error('可用参数：--webhook URL、--workspace 路径、--timezone 时区；不能重复。');
    }
    settings[key] = options[i + 1];
  }
  const workspace = resolve(settings['--workspace'] ?? config.workspace);
  if (!isInside(workspace, config.allowedPaths)) throw new Error('工作目录不在允许范围内。');
  try { if (!statSync(workspace).isDirectory()) throw new Error(); }
  catch { throw new Error('工作目录不存在或不是目录。'); }
  return {
    prompt, workspace, rule: parseRule(kind, value, settings['--timezone'] ?? config.scheduleTimezone, now),
    webhook: settings['--webhook'] ? validateWebhook(settings['--webhook']) : null,
  };
}

/** Independent Claude workers and a durable outbox; no dependency on the interactive ticket queue. */
export class Scheduler {
  constructor({ store, config, createSession, sendChat, isChatReady = () => true,
    webhookSender = sendWebhook, logger, now = () => Date.now() }) {
    Object.assign(this, { store, config, createSession, sendChat, isChatReady, webhookSender, logger, now });
    this.active = new Map();
    this.delivering = new Map();
    this.stopping = false;
    this.timer = null;
  }

  start() {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  tick() {
    if (this.stopping) return;
    try {
      this.store.collectDue(this.now());
      while (this.active.size < this.config.scheduleConcurrency) {
        const run = this.store.claim(this.now());
        if (!run) break;
        const active = { run, session: null, cancelled: false, reason: '',
          approvals: new ApprovalManager({ logger: this.logger, timeoutMs: this.config.approvalTimeoutMs }) };
        this.active.set(run.id, active);
        active.promise = this.execute(active).catch((error) => {
          this.logger.error(`定时运行 #${run.id} 保存失败: ${redactSecrets(error.message)}`);
        }).finally(() => {
          this.active.delete(run.id);
          if (!this.stopping) queueMicrotask(() => this.tick());
        });
      }
      // Sending has its own pool, so a slow webhook never occupies a Claude worker.
      const targets = new Set([...this.delivering.values()].map((item) => item.target));
      for (const row of this.store.deliveries(this.now())) {
        if (this.delivering.size >= this.config.scheduleDeliveryConcurrency) break;
        if (targets.has(row.target) || this.delivering.has(row.id)) continue;
        if (row.target_type === 'chat' && !this.isChatReady()) continue;
        this.store.reserveDelivery(row.target, this.now());
        targets.add(row.target);
        const delivery = { target: row.target };
        this.delivering.set(row.id, delivery);
        delivery.promise = this.deliver(row).catch((error) => {
          this.logger.error(`定时推送 #${row.run_id} 保存失败: ${redactSecrets(error.message)}`);
        }).finally(() => this.delivering.delete(row.id));
      }
    } catch (error) {
      this.logger.error(`定时调度失败: ${redactSecrets(error.message)}`);
    }
  }

  async execute(active) {
    const { run } = active;
    const schedule = run.schedule;
    let timer;
    let result = '';
    let error = '';
    let state = 'succeeded';
    try {
      if (schedule.deleted || !this.config.allowedUserIds.includes(schedule.created_by)) {
        throw new Error('定时任务已删除或创建人已不在白名单内。');
      }
      if (!isInside(schedule.workspace, this.config.allowedPaths)) throw new Error('工作目录已不在允许范围内。');
      const session = this.createSession({
        chatKey: `${schedule.chat_key}/schedule:${schedule.id}/run:${run.id}`,
        workspace: schedule.workspace,
        maxTurns: this.config.scheduleMaxTurns,
        onSessionId: (id) => this.store.setSession(run.id, id),
        onEvent: () => {},
        onDenied: (reason) => this.logger.warn(`定时任务 #${schedule.id} 工具已拦截: ${redactSecrets(reason)}`),
        canUseTool: (name, input, opts) => this.permission(active, name, input, opts),
        logger: this.logger,
      });
      active.session = session;
      timer = setTimeout(() => this.abort(active, '执行超时'), this.config.scheduleTimeoutMs);
      timer.unref?.();
      result = await session.run(`这是定时任务 #${schedule.id}，本次运行 #${run.id}。本轮最多 ${this.config.scheduleMaxTurns} 轮 agent 执行，请优先完成核心需求，避免无界探索，并预留轮数输出可直接推送的最终结果。\n\n${schedule.prompt}`);
      if (session.lastRunSucceeded === false) {
        state = 'failed';
        error = isTurnLimitError(session.lastRunFailure) ? this.turnLimitMessage(schedule.id)
          : session.lastRunFailure?.message ?? 'Claude 未正常完成本轮任务。';
      }
    } catch (cause) {
      state = 'failed';
      error = isTurnLimitError(cause) ? this.turnLimitMessage(schedule.id) : cause.message;
    } finally {
      clearTimeout(timer);
      active.approvals.cancel(schedule.chat_key, '本轮执行已结束');
    }
    if (active.cancelled) {
      state = active.reason === '进程退出' ? 'interrupted' : active.reason === '执行超时' ? 'failed' : 'cancelled';
      error = active.reason;
    }
    this.store.finish(run.id, state, result, error, this.now());
  }

  turnLimitMessage(scheduleId) {
    return `${claudeFailure({ subtype: 'error_max_turns' }, this.config.scheduleMaxTurns).message}\n`
      + '可缩小任务范围，或调高 .env 的 SCHEDULE_MAX_TURNS 后重启桥接。'
      + `核查已有操作后，用 /schedule run ${scheduleId} 从新会话重跑；/schedule retry 只会重发保存的结果，不会继续执行。`;
  }

  abort(active, reason) {
    if (active.cancelled) return;
    active.cancelled = true;
    active.reason = reason;
    active.approvals.cancel(active.run.schedule.chat_key, reason);
    active.session?.abort();
    // Keep the worker occupied until the SDK really exits; never overlap the same schedule.
  }

  async permission(active, name, input, opts) {
    const { schedule } = active.run;
    if (active.cancelled || this.stopping || opts?.signal?.aborted) return { behavior: 'deny', message: '任务已中止' };
    if (this.config.permissionMode !== 'auto' && (this.config.readOnlyTools.includes(name)
      || (name === 'Bash' && this.config.autoApproveReadOnlyBash && analyzeBashCommand(input?.command).readOnly))) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (active.approvals.hasPending(schedule.chat_key)) return { behavior: 'deny', message: '本次运行已有待审批操作。' };
    if (!this.isChatReady()) return { behavior: 'deny', message: '企微长连接离线，无法请求审批。' };
    const { id, promise } = active.approvals.request({
      chatKey: schedule.chat_key, ticketId: `s${active.run.id}`, title: name, detail: input,
    });
    const cancel = () => active.approvals.cancel(schedule.chat_key, '任务已中止');
    opts?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const prompt = renderApprovalPrompt(name, input, opts?.title, { id, timeoutMs: this.config.approvalTimeoutMs })
        .replace(`\`y ${id}\``, `\`/schedule approve ${id}\``)
        .replace(`\`n ${id}\``, `\`/schedule reject ${id}\``);
      await this.sendChat(schedule.chat_target, redactSecrets(`**定时任务 #${schedule.id} · 运行 #${active.run.id}**\n${prompt}`));
      const decision = await promise;
      if (active.cancelled || this.stopping) return { behavior: 'deny', message: '任务已中止' };
      return decision.allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
    } catch { return { behavior: 'deny', message: '审批消息发送失败。' }; }
    finally {
      opts?.signal?.removeEventListener('abort', cancel);
      active.approvals.settle(schedule.chat_key, id, false, '审批结束');
    }
  }

  async deliver(row) {
    try {
      const content = JSON.parse(row.chunks)[row.cursor];
      if (row.target_type === 'webhook') await this.webhookSender(row.target, content);
      else await this.sendChat(row.target, content);
      this.store.delivered(row);
    } catch (error) {
      const detail = error?.message ?? (Number.isFinite(error?.errcode)
        ? `企微错误 ${error.errcode}：${error.errmsg ?? ''}` : '推送失败');
      this.store.deliveryFailed(row, this.now(), detail);
    }
  }

  async handle({ chatKey, userId, text, frame, reply }) {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const action = match?.[1] ?? 'help';
    const arg = match?.[2]?.trim() ?? '';
    const send = async (content) => {
      for (const chunk of splitMarkdown(redactSecrets(content))) await reply(frame, chunk);
    };
    if (this.stopping) throw new Error('定时服务正在退出。');
    if (action === 'help') return send(SCHEDULE_HELP);
    if (action === 'add') {
      const parsed = parseAdd(arg, this.config, this.now());
      const body = frame?.body;
      const chatTarget = body?.chattype === 'group' ? body.chatid : body?.from?.userid;
      if (!chatTarget) throw new Error('无法识别当前聊天推送目标。');
      const schedule = this.store.create({ ...parsed, chatKey, chatTarget, userId,
        targetType: parsed.webhook ? 'webhook' : 'chat', target: parsed.webhook ?? chatTarget }, this.now());
      return send(`已创建定时任务 #${schedule.id}\n${this.describe(schedule)}`);
    }
    if (action === 'list') {
      const schedules = this.store.list(chatKey);
      return send(schedules.length ? schedules.map((s) => `#${s.id} · ${s.enabled ? '启用' : '暂停/已到期'} · ${describeRule(JSON.parse(s.rule))}\n${s.prompt.slice(0, 100)}`).join('\n\n') : '暂无定时任务，使用 /schedule help 查看用法。');
    }
    if (['approve', 'reject'].includes(action)) {
      for (const active of this.active.values()) {
        if (active.run.schedule.chat_key !== chatKey) continue;
        const pending = active.approvals.getPending(chatKey);
        if (pending?.id === arg) {
          active.approvals.settle(chatKey, arg, action === 'approve', action === 'approve' ? '用户同意' : '用户拒绝');
          return send(action === 'approve' ? '已同意，继续执行。' : '已拒绝。');
        }
      }
      throw new Error('审批编号无效、已过期或不属于当前聊天。');
    }
    if (action === 'retry') {
      this.store.retryDelivery(chatKey, identifier(arg), this.now());
      this.tick();
      return send('已重新排队推送保存的结果，不会重跑 Claude。');
    }
    if (!['show', 'history', 'pause', 'resume', 'run', 'stop', 'delete'].includes(action)) {
      throw new Error('未知定时命令，使用 /schedule help 查看用法。');
    }
    const schedule = this.store.require(chatKey, identifier(arg));
    if (action === 'show') return send(this.describe(schedule));
    if (action === 'history') {
      const rows = this.store.history(schedule.id);
      return send(rows.length ? rows.map((r) => `运行 #${r.id} · ${new Date(r.scheduled_at).toISOString()}\n执行：${r.state}；推送：${r.delivery_state ?? '尚无结果'}${r.error ? `\n${r.error}` : ''}${r.delivery_error ? `\n${r.delivery_error}` : ''}\n${(r.result ?? '').slice(0, 500)}`).join('\n\n') : '暂无执行记录。');
    }
    if (action === 'pause' || action === 'delete') this.store.pause(schedule.id, action === 'delete');
    if (action === 'resume') this.store.resume(schedule.id, this.now());
    if (action === 'stop' || action === 'delete') {
      this.store.cancelQueued(schedule.id, this.now());
      for (const active of this.active.values()) {
        if (active.run.schedule.id === schedule.id) this.abort(active, '用户中止');
      }
    }
    if (action === 'run') {
      const runId = this.store.enqueue(schedule.id, this.now());
      this.tick();
      return send(`定时任务 #${schedule.id} 已加入执行队列，运行 #${runId}。`);
    }
    return send(`定时任务 #${schedule.id}：${{ pause: '已暂停，正在执行的本轮继续', resume: '已恢复后续调度', stop: '已请求中止本轮，后续调度保留', delete: '已删除并请求中止执行' }[action]}。`);
  }

  describe(schedule) {
    const pending = this.store.pending(schedule.id);
    const approval = pending && this.active.get(pending.id)?.approvals.getPending(schedule.chat_key);
    return [
      `任务 #${schedule.id}：${schedule.prompt}`, `规则：${describeRule(JSON.parse(schedule.rule))}`,
      `状态：${schedule.enabled ? '启用' : '暂停/已到期'}`,
      `下次执行：${schedule.enabled && schedule.next_at ? new Date(schedule.next_at).toISOString() : '无'}`,
      `工作目录：${schedule.workspace}`, `推送：${schedule.target_type === 'webhook' ? '群 Webhook（地址隐藏）' : '当前聊天'}`,
      `单次上限：${this.config.scheduleMaxTurns} 轮；${Math.ceil(this.config.scheduleTimeoutMs / 60000)} 分钟（含审批）`,
      ...(pending ? [`当前运行 #${pending.id}：${pending.state}`] : []),
      ...(approval ? [`待审批：/schedule approve ${approval.id} 或 /schedule reject ${approval.id}`] : []),
    ].join('\n');
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const active of this.active.values()) this.abort(active, '进程退出');
    await Promise.allSettled([...this.active.values(), ...this.delivering.values()].map((item) => item.promise));
  }
}
