/** 纯文本工具：折内容块、按码点截断、压成单行。 */

/** 省略号：截断时统一追加，便于客户端判断文案是否被裁过。 */
const ELLIPSIS = '…';

/**
 * 把一个消息的内容块折成纯文本，跳过推理与工具调用块。
 * @param {unknown} content - `ContentBlock[]`；未知形状返回空串。
 * @returns {string} 拼接后的文本。
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 按码点截断文本（不切坏代理对），超长时追加省略号。
 * @param {string} text - 原始文本。
 * @param {number} maxChars - 上限（码点数）。
 * @returns {string} 截断结果。
 */
export function clampText(text, maxChars) {
  if (typeof text !== 'string') return '';
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) return text;
  return `${codePoints.slice(0, maxChars).join('')}${ELLIPSIS}`;
}

/**
 * 压成单行：折叠换行与连续空白，去掉首尾空白。
 * @param {string} text - 原始文本。
 * @returns {string} 单行文本。
 */
export function singleLine(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 去掉模型偶尔自带的包裹符号：成对的引号、反引号、代码块围栏、列表前缀。
 * @param {string} text - 模型原始输出。
 * @returns {string} 清理后的文本。
 */
export function stripWrapping(text) {
  let value = singleLine(text);
  if (value === '') return '';
  value = value.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  const pairs = [
    ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['《', '》'],
  ];
  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (value.startsWith(open) && value.endsWith(close) && value.length > 2) {
        value = value.slice(open.length, value.length - close.length).trim();
        changed = true;
      }
    }
    if (value.startsWith('`') && value.endsWith('`') && value.length > 2) {
      value = value.slice(1, -1).trim();
      changed = true;
    }
  }
  value = value.replace(/^(?:建议|suggestion)\s*[:：]\s*/i, '');
  return value.trim();
}
