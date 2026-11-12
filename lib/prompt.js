/** 提示词构造与模型输出归一化。 */

import { clampText, singleLine, stripWrapping } from './text.js';

/** 界面语言 → 让模型书写的语言名。 */
const LANGUAGE_NAMES = Object.freeze({
  zh: '简体中文',
  'zh-cn': '简体中文',
  'zh-tw': '繁體中文',
  'zh-hk': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
});

/** 模型表示「没有值得建议的下一步」时的输出标记。 */
const NO_SUGGESTION_MARKER = 'NONE';

/** 工具摘要最多带多少条给模型。 */
const MAX_TOOL_LINES_IN_PROMPT = 8;

/**
 * 把 locale 标签解析成让模型书写的语言名。
 * @param {string} locale - 界面语言标签。
 * @returns {string} 语言名；未知标签回落 English。
 */
export function languageOf(locale) {
  const key = typeof locale === 'string' ? locale.trim().toLowerCase() : '';
  if (LANGUAGE_NAMES[key] !== undefined) return LANGUAGE_NAMES[key];
  const primary = key.split('-')[0];
  return LANGUAGE_NAMES[primary] ?? LANGUAGE_NAMES.en;
}

/**
 * 渲染工具摘要的文本行。
 * @param {readonly {name: string, target: string, failed: boolean}[]} tools - 工具摘要。
 * @returns {string} 每行一条的结果。
 */
function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '(none)';
  return tools
    .slice(0, MAX_TOOL_LINES_IN_PROMPT)
    .map(tool => `- ${tool.name}${tool.target === '' ? '' : ` ${tool.target}`}${tool.failed ? ' [failed]' : ''}`)
    .join('\n');
}

/**
 * 构造一次「下一步建议」请求。
 * @param {object} input - 输入。
 * @param {string} input.locale - 界面语言。
 * @param {number} input.maxChars - 建议长度上限（码点）。
 * @param {string} input.reasonKind - 本轮结束原因：completed / error / max-tokens / blocked …
 * @param {string} input.userText - 本轮用户请求。
 * @param {string} input.assistantText - 本轮最终回答。
 * @param {readonly {name: string, target: string, failed: boolean}[]} input.tools - 本轮工具调用。
 * @param {string} input.summary - 更早对话的摘要；为空表示没有更早内容。
 * @param {readonly string[]} input.recent - 最近已展示过的建议。
 * @returns {{system: string, user: string}} 两端提示词。
 */
export function buildSuggestionPrompt(input) {
  const language = languageOf(input.locale);
  const latinLimit = Math.round(input.maxChars * 2);
  const failedTurn = input.reasonKind === 'error'
    || input.reasonKind === 'blocked'
    || input.reasonKind === 'max-tokens';
  const system = [
    'You write the ONE next-step suggestion shown as the placeholder of a coding agent\'s empty input box.',
    '',
    'Rules:',
    `- Write in ${language}, single line, plain text: no quotes, no markdown, no "Suggestion:" prefix.`,
    '- Phrase it as something the USER would type next, starting with a verb.',
    '- Be specific to this turn: name the actual file, command, failure, or open decision.',
    `- At most ${input.maxChars} CJK characters (about ${latinLimit} Latin characters). Shorter is better.`,
    '- Do not repeat any suggestion listed under "Recently shown".',
    failedTurn
      ? '- This turn ended abnormally: suggest a concrete retry, diagnosis, or rollback step.'
      : '- Move the task forward: verify, iterate, or take the next obvious chunk of work.',
    `- If nothing meaningful is left to do, output exactly ${NO_SUGGESTION_MARKER}.`,
  ].join('\n');

  const sections = [];
  if (typeof input.summary === 'string' && input.summary.trim() !== '') {
    sections.push(`## Earlier conversation summary\n${input.summary.trim()}`);
  }
  sections.push(`## User request this turn\n${input.userText.trim() || '(not captured)'}`);
  sections.push(`## Final answer this turn\n${input.assistantText.trim() || '(no text answer)'}`);
  sections.push(`## Tool calls this turn\n${renderTools(input.tools)}`);
  sections.push(`## Turn outcome\n${input.reasonKind}`);
  if (Array.isArray(input.recent) && input.recent.length > 0) {
    sections.push(`## Recently shown (do not repeat)\n${input.recent.map(item => `- ${item}`).join('\n')}`);
  }
  return { system, user: sections.join('\n\n') };
}

/**
 * 构造一次「早期对话摘要」请求。
 * @param {object} input - 输入。
 * @param {string} input.locale - 界面语言。
 * @param {number} input.maxChars - 摘要长度上限。
 * @param {string} input.previous - 上一版摘要（增量更新用）。
 * @param {string} input.transcript - 需要并入摘要的转写文本。
 * @returns {{system: string, user: string}} 两端提示词。
 */
export function buildSummaryPrompt(input) {
  const language = languageOf(input.locale);
  const system = [
    'You maintain a compact running summary of a coding-agent conversation so a later call can suggest the next step.',
    '',
    'Rules:',
    `- Write in ${language}.`,
    '- Keep concrete facts: files touched, commands run, failures, decisions, and open questions.',
    '- Drop greetings, restated instructions, and finished trivia.',
    `- At most ${input.maxChars} characters, plain text, no markdown headings.`,
    '- Output only the summary.',
  ].join('\n');
  const user = input.previous.trim() === ''
    ? `## Conversation so far\n${input.transcript}`
    : `## Existing summary\n${input.previous.trim()}\n\n## New events to merge\n${input.transcript}`;
  return { system, user };
}

/**
 * 归一化模型给出的一句建议。
 * @param {string} raw - 模型原始输出。
 * @param {number} maxChars - 长度上限（码点）。
 * @returns {string | null} 单行建议；模型表示「无建议」时返回 null。
 */
export function normalizeSuggestion(raw, maxChars) {
  const cleaned = stripWrapping(typeof raw === 'string' ? raw : '');
  if (cleaned === '') return null;
  if (singleLine(cleaned).toUpperCase() === NO_SUGGESTION_MARKER) return null;
  const line = singleLine(cleaned);
  if (line === '') return null;
  return clampText(line, maxChars);
}

/**
 * 归一化模型给出的摘要文本。
 * @param {string} raw - 模型原始输出。
 * @param {number} maxChars - 长度上限（码点）。
 * @returns {string} 单行摘要；空输出返回空串。
 */
export function normalizeSummary(raw, maxChars) {
  const cleaned = stripWrapping(typeof raw === 'string' ? raw : '');
  if (cleaned === '') return '';
  return clampText(singleLine(cleaned), maxChars);
}
