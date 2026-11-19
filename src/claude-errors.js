/** The SDK can report turn exhaustion as a result subtype or throw an Error. */
export function isTurnLimitError(value) {
  return value?.code === 'error_max_turns' || value?.subtype === 'error_max_turns'
    || /Reached maximum number of turns|error_max_turns/i.test(
      typeof value === 'string' ? value : [value?.message, value?.result, ...(value?.errors ?? [])].filter(Boolean).join('\n'),
    );
}

export function claudeFailure(value, maxTurns) {
  if (isTurnLimitError(value)) {
    return { code: 'error_max_turns', message: `已达到本轮 ${maxTurns} 轮 agent 执行上限，任务尚未完成。` };
  }
  return {
    code: value?.subtype ?? 'error_during_execution',
    message: value?.message || value?.errors?.join('\n') || value?.result
      || `Claude 未正常完成本轮任务（${value?.subtype ?? '未知错误'}）。`,
  };
}
