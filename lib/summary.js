/**
 * 早期对话的增量摘要。
 *
 * 设计目标：**永远不让摘要挡在用户前面**。
 *  - 生成建议时只读已有摘要（可能是上一轮之后的版本），不发起调用；
 *  - 建议返回之后，再在后台把「到本轮结束为止」的历史增量并进摘要，
 *    供下一轮使用。所以建议的等待时间始终只有一次模型调用。
 *
 * 摘要只是派生缓存：进程重启或首次请求时没有摘要，最坏情况是少一点背景信息，
 * 不会多一次同步调用，也不会报错。
 */

import { clampText, singleLine } from './text.js';
import { renderTranscript, seqOf } from './session-context.js';
import { buildSummaryPrompt, normalizeSummary } from './prompt.js';
import { complete } from './llm.js';

/** 转写短于这个长度就直接把原文当摘要缓存，不做模型调用。 */
const SHORT_HISTORY_CHARS = 1_800;
/** 参与摘要的历史转写上限（超出按尾部截断）。 */
const MAX_TRANSCRIPT_CHARS = 16_000;

/**
 * 创建按会话的摘要缓存。
 * @returns {{get: (id: string) => {seq: number, text: string} | undefined, set: Function, forget: Function, clear: Function}} 缓存门面。
 */
export function createSummaryCache() {
  /** @type {Map<string, {seq: number, text: string}>} */
  const entries = new Map();
  return {
    get: sessionId => entries.get(sessionId),
    set: (sessionId, value) => {
      entries.set(sessionId, value);
    },
    forget: sessionId => {
      entries.delete(sessionId);
    },
    clear: () => {
      entries.clear();
    },
  };
}

/**
 * 读已有摘要，不触发任何调用。
 * @param {{get: Function}} cache - 摘要缓存。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 摘要文本；没有缓存时返回空串。
 */
export function readSummary(cache, sessionId) {
  const entry = cache.get(sessionId);
  return typeof entry?.text === 'string' ? entry.text : '';
}

/**
 * 后台刷新：把 `events[0, uptoIndex)` 并进该会话的滚动摘要。
 * 调用方应当 fire-and-forget，不要 await 在用户路径上。
 * @param {object} deps - 依赖。
 * @param {object} deps.llm - `ctx.llm`。
 * @param {object} deps.cache - 摘要缓存。
 * @param {number} deps.maxChars - 摘要长度上限。
 * @param {(message: string, error?: unknown) => void} deps.warn - 诊断日志。
 * @param {object} input - 输入。
 * @param {string} input.sessionId - 会话 id。
 * @param {readonly unknown[]} input.events - 会话事件。
 * @param {number} input.uptoIndex - 摘要覆盖到哪个事件（不含）为止。
 * @param {{provider: string, model: string}} input.route - 模型路由。
 * @param {string} input.locale - 界面语言。
 * @param {number} input.timeoutMs - 单次调用超时。
 * @returns {Promise<string>} 刷新后的摘要（失败时回落到旧摘要）。
 */
export async function refreshSummary(deps, input) {
  const history = input.events.slice(0, input.uptoIndex);
  if (history.length === 0) return readSummary(deps.cache, input.sessionId);

  const lastSeq = seqOf(history[history.length - 1]) ?? history.length;
  const cached = deps.cache.get(input.sessionId);
  if (cached !== undefined && cached.seq >= lastSeq) return cached.text;

  const transcript = renderTranscript(history, { maxChars: MAX_TRANSCRIPT_CHARS });
  if (transcript.trim() === '') return cached?.text ?? '';

  // 短历史不花调用：直接用原文当摘要，下一次请求就能读到。
  if (transcript.length <= SHORT_HISTORY_CHARS) {
    deps.cache.set(input.sessionId, { seq: lastSeq, text: transcript });
    return transcript;
  }

  const previous = cached?.text ?? '';
  const delta = cached === undefined
    ? transcript
    : renderTranscript(history.filter(event => (seqOf(event) ?? 0) > cached.seq), {
      maxChars: MAX_TRANSCRIPT_CHARS,
    });
  if (delta.trim() === '') return previous;

  const prompts = buildSummaryPrompt({
    locale: input.locale,
    maxChars: deps.maxChars,
    previous,
    transcript: delta,
  });
  try {
    const raw = await complete(deps.llm, {
      provider: input.route.provider,
      model: input.route.model,
      system: prompts.system,
      user: prompts.user,
      timeoutMs: input.timeoutMs,
    });
    const text = normalizeSummary(raw, deps.maxChars);
    if (text === '') {
      deps.warn('summary call returned no text; keeping the previous summary', undefined);
      return previous;
    }
    deps.cache.set(input.sessionId, { seq: lastSeq, text });
    return text;
  } catch (error) {
    deps.warn('summary refresh failed; the next suggestion will use the previous summary', error);
    return clampText(singleLine(previous), deps.maxChars);
  }
}
