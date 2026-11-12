/**
 * 纯函数单测：配置归一化、文本折取、本轮上下文、提示词与输出归一化。
 * 这些函数决定「模型看到什么、输入框最终显示什么」，坏掉时最不容易被发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, normalizeConfig, resolveModelRoute } from '../lib/config.js';
import { clampText, singleLine, stripWrapping, textOfContent } from '../lib/text.js';
import { collectTurnContext, lastTurnBoundary, renderTranscript } from '../lib/session-context.js';
import { buildSuggestionPrompt, languageOf, normalizeSuggestion } from '../lib/prompt.js';

/**
 * 造一条会话事件。
 * @param {number} seq - 事件序号。
 * @param {string} type - 事件类型。
 * @param {object} data - 事件数据。
 * @returns {object} 事件。
 */
function event(seq, type, data) {
  return { seq, type, data };
}

test('normalizeConfig falls back to defaults for junk input', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig('nope'), DEFAULT_CONFIG);
  const parsed = normalizeConfig({
    enabled: 'false',
    timeoutMs: 10,
    maxChars: 5_000,
    provider: ' deepseek ',
    model: '',
  });
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.timeoutMs, 1_000);
  assert.equal(parsed.maxChars, 200);
  assert.equal(parsed.provider, 'deepseek');
  assert.equal(parsed.model, '');
});

test('resolveModelRoute prefers explicit config and needs both fields', () => {
  assert.deepEqual(
    resolveModelRoute({ ...DEFAULT_CONFIG, provider: 'p', model: 'm' }, { provider: 'x', model: 'y' }),
    { provider: 'p', model: 'm' },
  );
  assert.deepEqual(resolveModelRoute(DEFAULT_CONFIG, { provider: 'x', model: 'y' }), { provider: 'x', model: 'y' });
  assert.equal(resolveModelRoute({ ...DEFAULT_CONFIG, provider: 'only-provider' }, undefined), undefined);
  assert.equal(resolveModelRoute(DEFAULT_CONFIG, { provider: 'x' }), undefined);
});

test('text helpers fold content blocks and clamp by code point', () => {
  const content = [
    { type: 'reasoning', text: 'hidden' },
    { type: 'text', text: '第一段' },
    { type: 'tool-call', name: 'bash' },
    { type: 'text', text: '第二段' },
  ];
  assert.equal(textOfContent(content), '第一段\n第二段');
  assert.equal(textOfContent(undefined), '');
  assert.equal(clampText('abcdef', 3), 'abc…');
  assert.equal(clampText('😀😀😀', 2), '😀😀…');
  assert.equal(singleLine('  a\n\n b  '), 'a b');
  assert.equal(stripWrapping('“跑一下测试，把失败项修掉”'), '跑一下测试，把失败项修掉');
  assert.equal(stripWrapping('建议：检查 go test 的失败用例'), '检查 go test 的失败用例');
});

test('collectTurnContext reads only the last turn and summarizes tools', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { content: [{ type: 'text', text: '旧需求' }] }),
    event(3, 'assistant/message', { message: { content: [{ type: 'text', text: '旧回答' }] } }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(5, 'turn/start', { turn: 2 }),
    event(6, 'user/message', { content: [{ type: 'text', text: '跑一下测试' }] }),
    event(7, 'tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"go test ./..."}' }),
    event(8, 'tool/result', { turn: 2, step: 1, message: { toolCallId: 'c1', isError: true } }),
    event(9, 'assistant/message', { message: { content: [{ type: 'text', text: '测试挂了三个用例' }] } }),
    event(10, 'turn/end', { turn: 2, reason: { kind: 'error' } }),
  ];
  assert.deepEqual(lastTurnBoundary(events), { endIndex: 9, reasonKind: 'error' });
  const context = collectTurnContext(events);
  assert.equal(context.reasonKind, 'error');
  assert.equal(context.userText, '跑一下测试');
  assert.equal(context.assistantText, '测试挂了三个用例');
  assert.deepEqual(context.tools, [{ name: 'bash', target: 'go test ./...', failed: true }]);
});

test('renderTranscript keeps recent lines and drops noise', () => {
  const transcript = renderTranscript([
    event(1, 'user/message', { content: [{ type: 'text', text: '甲' }] }),
    event(2, 'assistant/message', { message: { content: [{ type: 'text', text: '乙' }] } }),
    event(3, 'tool/call', { name: 'read', arguments: '{"path":"a.ts"}' }),
    event(4, 'turn/end', { reason: { kind: 'aborted' } }),
  ]);
  assert.equal(transcript, '用户：甲\n助手：乙\n工具：read a.ts\n回合：被用户中断');
});

test('buildSuggestionPrompt states the language, the cap and the recent list', () => {
  const prompts = buildSuggestionPrompt({
    locale: 'zh-CN',
    maxChars: 40,
    reasonKind: 'error',
    userText: '跑测试',
    assistantText: '挂了三个用例',
    tools: [{ name: 'bash', target: 'go test', failed: true }],
    summary: '用户在修登录流程',
    recent: ['看下日志'],
  });
  assert.match(prompts.system, /简体中文/);
  assert.match(prompts.system, /At most 40 CJK characters/);
  assert.match(prompts.system, /ended abnormally/);
  assert.match(prompts.user, /用户在修登录流程/);
  assert.match(prompts.user, /- bash go test \[failed\]/);
  assert.match(prompts.user, /- 看下日志/);
});

test('normalizeSuggestion produces one bounded line or nothing', () => {
  assert.equal(normalizeSuggestion('  "跑一遍 go test 并修掉失败用例"  ', 40), '跑一遍 go test 并修掉失败用例');
  assert.equal(normalizeSuggestion('NONE', 40), null);
  assert.equal(normalizeSuggestion('   ', 40), null);
  assert.equal(normalizeSuggestion('一行\n两行', 40), '一行 两行');
  assert.equal(normalizeSuggestion('a'.repeat(60), 10), 'aaaaaaaaaa…');
});

test('languageOf resolves common tags and falls back to English', () => {
  assert.equal(languageOf('zh-CN'), '简体中文');
  assert.equal(languageOf('en'), 'English');
  assert.equal(languageOf('pt-BR'), 'Português');
  assert.equal(languageOf('xx'), 'English');
  assert.equal(languageOf(undefined), 'English');
});
