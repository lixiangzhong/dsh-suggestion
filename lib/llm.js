/**
 * 一次性的辅助模型调用。
 *
 * 刻意不依赖 `@deepseek-ai/dsh-llm` 的 `BlockAssembler`：第三方插件目录里无法解析
 * DSH 内部包名，这里直接按 `StreamChunk` 的公开形状自己拼文本。
 */

/** 只接受这两种结束原因；其余（error / aborted / tool-calls）都按失败处理。 */
const ACCEPTED_FINISH_KINDS = new Set(['stop', 'max-tokens']);

/** 建议生成的输出上限：一句话足够，超出就是在浪费 token。 */
const MAX_OUTPUT_TOKENS = 400;

/**
 * 调一次模型并把文本流拼成字符串。
 * @param {{stream: (options: object) => AsyncIterable<object>}} llm - Host 的 `ctx.llm`。
 * @param {object} request - 请求参数。
 * @param {string} request.provider - provider 路由。
 * @param {string} request.model - 模型 id。
 * @param {string} request.system - system 提示词。
 * @param {string} request.user - 单条 user 输入。
 * @param {number} request.timeoutMs - 超时时间。
 * @param {AbortSignal} [request.signal] - 外部取消信号。
 * @param {number} [request.maxTokens] - 输出 token 上限。
 * @returns {Promise<string>} 模型输出文本（可能是空串）。
 */
export async function complete(llm, request) {
  const signals = [AbortSignal.timeout(request.timeoutMs)];
  if (request.signal !== undefined) signals.push(request.signal);
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];

  let text = '';
  let finishKind = 'stop';
  const stream = llm.stream({
    provider: request.provider,
    model: request.model,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    maxTokens: request.maxTokens ?? MAX_OUTPUT_TOKENS,
    signal,
  });
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text;
      continue;
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind;
      finishKind = typeof kind === 'string' ? kind : 'stop';
    }
  }
  if (!ACCEPTED_FINISH_KINDS.has(finishKind)) {
    throw new Error(`suggestion llm call finished with "${finishKind}"`);
  }
  return text;
}
