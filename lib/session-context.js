/**
 * 从会话事件日志里折出「生成一次建议」所需的上下文切片。
 *
 * 只读、纯函数：输入是 `session.events`，输出是纯数据，方便单测。
 * 边界固定在「最后一轮」：最后一个 `turn/end` 及其对应的 `turn/start`。
 */
import { clampText, textOfContent } from './text.js';

/** 单条用户消息最多带多少字符给模型（首字延迟与 token 成本的主要来源之一）。 */
const MAX_USER_CHARS = 2_000;
/** 本轮最终回答最多带多少字符。 */
const MAX_ASSISTANT_CHARS = 2_000;
/** 工具摘要最多列多少条调用。 */
const MAX_TOOL_LINES = 10;
/** 单条工具目标（路径/命令）最多保留多少字符。 */
const MAX_TARGET_CHARS = 100;
/** 早期对话转写文本的总字符上限（超过就交给摘要器压缩）。 */
const MAX_TRANSCRIPT_CHARS = 24_000;

/** 工具参数里能代表「这次调用做了什么」的字段，按优先级排列。 */
const TARGET_ARG_KEYS = [
  'path', 'file_path', 'filePath', 'file', 'command', 'pattern',
  'query', 'url', 'name', 'target', 'notebook_path',
];

/**
 * 找最后一个 `turn/end`。
 * @param {readonly unknown[]} events - 会话事件。
 * @returns {{endIndex: number, reasonKind: string} | undefined} 找不到返回 undefined。
 */
export function lastTurnBoundary(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'turn/end') continue;
    const kind = event.data?.reason?.kind;
    return { endIndex: index, reasonKind: typeof kind === 'string' ? kind : 'unknown' };
  }
  return undefined;
}

/**
 * 找某一轮对应的 `turn/start`。
 * @param {readonly unknown[]} events - 会话事件。
 * @param {number} endIndex - `turn/end` 下标。
 * @returns {number} 找不到返回 -1（按「本轮从日志起点开始」处理）。
 */
function findTurnStart(events, endIndex) {
  const turn = events[endIndex]?.data?.turn;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'turn/start') continue;
    if (event.data?.turn === turn) return index;
  }
  return -1;
}

/**
 * 取工具参数里最有代表性的目标字段。
 * @param {string} argumentsText - 模型产出的原始 JSON 字符串。
 * @returns {string} 目标描述；解析失败返回空串。
 */
function toolTargetOf(argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText.trim() === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object') return '';
  for (const key of TARGET_ARG_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    return clampText(value.trim().replace(/\s+/g, ' '), MAX_TARGET_CHARS);
  }
  return '';
}

/**
 * 折出本轮的工具调用摘要（按调用顺序，失败的标出来）。
 * @param {readonly unknown[]} turnEvents - 本轮事件切片。
 * @returns {readonly {name: string, target: string, failed: boolean}[]} 工具摘要。
 */
export function collectToolSummary(turnEvents) {
  /** @type {Map<string, {name: string, target: string, failed: boolean}>} */
  const calls = new Map();
  const order = [];
  for (const event of turnEvents) {
    if (event?.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '');
      const name = String(event.data?.name ?? 'tool');
      if (callId === '') continue;
      calls.set(callId, { name, target: toolTargetOf(event.data?.arguments), failed: false });
      order.push(callId);
      continue;
    }
    if (event?.type !== 'tool/result') continue;
    const callId = String(event.data?.message?.toolCallId ?? event.data?.callId ?? '');
    const call = calls.get(callId);
    if (call === undefined) continue;
    if (event.data?.message?.isError === true || event.data?.error !== undefined) call.failed = true;
  }
  return Object.freeze(order.slice(0, MAX_TOOL_LINES).map(callId => calls.get(callId)));
}

/**
 * 折出最后一轮的上下文。
 * @param {readonly unknown[]} events - `session.events`。
 * @returns {{
 *   reasonKind: string,
 *   userText: string,
 *   assistantText: string,
 *   tools: readonly {name: string, target: string, failed: boolean}[],
 * } | undefined} 没有结束过任何一轮时返回 undefined。
 */
export function collectTurnContext(events) {
  const boundary = lastTurnBoundary(events);
  if (boundary === undefined) return undefined;
  const { endIndex, reasonKind } = boundary;
  const startIndex = findTurnStart(events, endIndex);
  const sliceStart = startIndex < 0 ? 0 : startIndex;
  const turnEvents = events.slice(sliceStart, endIndex + 1);

  let userText = '';
  let assistantText = '';
  for (const event of turnEvents) {
    if (event?.type === 'user/message' && userText === '') {
      userText = textOfContent(event.data?.content);
      continue;
    }
    if (event?.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content);
      if (text !== '') assistantText = text;
    }
  }

  return {
    reasonKind,
    userText: clampText(userText, MAX_USER_CHARS),
    assistantText: clampText(assistantText, MAX_ASSISTANT_CHARS),
    tools: collectToolSummary(turnEvents),
  };
}

/**
 * 把一段事件渲染成「谁说了什么」的转写，供摘要器压缩。
 * @param {readonly unknown[]} events - 事件切片。
 * @param {{maxChars?: number}} [options] - 字符上限。
 * @returns {string} 转写文本。
 */
export function renderTranscript(events, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : MAX_TRANSCRIPT_CHARS;
  const lines = [];
  for (const event of events) {
    if (event?.type === 'user/message') {
      const text = textOfContent(event.data?.content).trim();
      if (text !== '') lines.push(`用户：${text}`);
      continue;
    }
    if (event?.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content).trim();
      if (text !== '') lines.push(`助手：${text}`);
      continue;
    }
    if (event?.type === 'tool/call') {
      const name = String(event.data?.name ?? 'tool');
      const target = toolTargetOf(event.data?.arguments);
      lines.push(`工具：${name}${target === '' ? '' : ` ${target}`}`);
      continue;
    }
    if (event?.type === 'turn/end') {
      const kind = event.data?.reason?.kind;
      if (kind === 'error') lines.push('回合：错误结束');
      else if (kind === 'aborted') lines.push('回合：被用户中断');
    }
  }
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  // 超出预算时保留尾部：最近的对话对「下一步做什么」最有信息量。
  return joined.slice(joined.length - maxChars);
}

/**
 * 取事件序号，用于摘要缓存的增量边界。
 * @param {unknown} event - 一条会话事件。
 * @returns {number | undefined} 事件 seq。
 */
export function seqOf(event) {
  const seq = event?.seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined;
}
