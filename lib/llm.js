/**
 * 一次性的辅助模型调用。
 *
 * 刻意不依赖 `@deepseek-ai/dsh-llm` 的 `BlockAssembler`：第三方插件目录里无法解析
 * DSH 内部包名，这里直接按 `StreamChunk` 的公开形状自己拼文本。
 *
 * 容错策略：
 *  - 结束原因为 `stop` / `max-tokens` 才接受输出；
 *  - `error` 视为可重试（上游 5xx、连接中断这类最常见），最多再试一次；
 *  - 超时/外部取消不重试，避免把用户等待时间翻倍；
 *  - 抛出的错误带上游 failure 的 code 与 message，便于排障。
 */

/** 只接受这两种结束原因。 */
const ACCEPTED_FINISH_KINDS = new Set(['stop', 'max-tokens']);
/** 建议生成的输出上限：一句话足够，超出就是在浪费 token。 */
const MAX_OUTPUT_TOKENS = 400;
/** 总尝试次数（首次 + 一次重试）。 */
const MAX_ATTEMPTS = 2;
/** 重试前的等待，避开瞬时的上游抖动。 */
const RETRY_DELAY_MS = 250;

/**
 * 等待一段时间。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 完成后 resolve。
 */
function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * 判断错误是否值得重试：取消/超时不重试。
 * @param {unknown} error - 错误。
 * @returns {boolean} 值得重试返回 true。
 */
function isRetryable(error) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return false;
  if (typeof error?.code === 'string' && error.code === 'CANCELLED') return false;
  return true;
}

/**
 * 执行一次流式调用并拼出文本。
 * @param {{stream: (options: object) => AsyncIterable<object>}} llm - Host 的 `ctx.llm`。
 * @param {object} request - 请求参数。
 * @returns {Promise<string>} 模型输出文本（可能是空串）。
 */
async function streamOnce(llm, request) {
  const signals = [AbortSignal.timeout(request.timeoutMs)];
  if (request.signal !== undefined) signals.push(request.signal);
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];

  let text = '';
  let finishKind = 'stop';
  let failure;
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
      failure = chunk.reason?.failure;
    }
  }
  if (!ACCEPTED_FINISH_KINDS.has(finishKind)) {
    const detail = typeof failure?.message === 'string' && failure.message !== ''
      ? ` (${failure.code ?? 'unknown'}: ${failure.message})`
      : '';
    throw new Error(`suggestion llm call finished with "${finishKind}"${detail}`);
  }
  return text;
}

/**
 * 调一次模型并把文本流拼成字符串（失败时重试一次）。
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
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await streamOnce(llm, request);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= MAX_ATTEMPTS) break;
      if (!isRetryable(error)) break;
      if (request.signal?.aborted === true) break;
      await delay(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}
