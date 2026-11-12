/**
 * 服务层单测：用假的 ctx（会话 + LLM 流）验证编排逻辑。
 * 覆盖：路由解析、轮次去重、跳过规则、摘要触发、失败降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { createSuggestionService } from '../lib/service.js';

/**
 * 造一条会话事件。
 * @param {number} seq - 序号。
 * @param {string} type - 类型。
 * @param {object} data - 数据。
 * @returns {object} 事件。
 */
function event(seq, type, data) {
  return { seq, type, data };
}

/**
 * 造一个「已结束一轮」的会话事件流。
 * @param {{userText?: string, answer?: string, reason?: string, prefix?: object[]}} [options] - 覆盖项。
 * @returns {object[]} 事件数组。
 */
function baseEvents(options = {}) {
  const prefix = options.prefix ?? [];
  const base = prefix.length === 0 ? 1 : prefix[prefix.length - 1].seq + 1;
  return [
    ...prefix,
    event(base, 'turn/start', { turn: 9 }),
    event(base + 1, 'user/message', { content: [{ type: 'text', text: options.userText ?? '跑一下测试' }] }),
    event(base + 2, 'tool/call', { turn: 9, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"go test ./..."}' }),
    event(base + 3, 'tool/result', { turn: 9, step: 1, message: { toolCallId: 'c1', isError: true } }),
    event(base + 4, 'assistant/message', { message: { content: [{ type: 'text', text: options.answer ?? '三个用例失败' }] } }),
    event(base + 5, 'turn/end', { turn: 9, reason: { kind: options.reason ?? 'error' } }),
  ];
}

/**
 * 造一个按调用顺序返回固定文本的假 LLM。
 * @param {string[]} replies - 每次调用的文本输出。
 * @returns {{llm: object, calls: object[]}} 假 llm 与调用记录。
 */
function fakeLlm(replies) {
  const calls = [];
  let index = 0;
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        const text = replies[Math.min(index, replies.length - 1)] ?? '';
        index += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    },
  };
}

/**
 * 造一个假 ctx。
 * @param {object[]} events - 会话事件。
 * @param {object} llm - 假 LLM。
 * @param {{header?: object, route?: object}} [options] - 覆盖项。
 * @returns {object} 假 ctx。
 */
function fakeCtx(events, llm, options = {}) {
  const session = {
    id: 'session-1',
    header: options.header ?? {},
    // 真实 Session 只暴露 snapshotEvents()，这里保持一致以免测出假通过。
    // 闭包读事件数组，测试可以就地追加下一轮。
    snapshotEvents: () => events,
    requestHeader: () => (options.route === undefined ? undefined : { config: options.route }),
  };
  return {
    llm,
    sessions: { get: id => (id === 'session-1' ? session : undefined) },
  };
}

/** 静默诊断，避免测试输出噪音。 */
const WARN = () => {};

test('generates one suggestion per turn and reuses it', async () => {
  const { llm, calls } = fakeLlm(['"跑一遍 go test 并修掉失败用例"']);
  const ctx = fakeCtx(baseEvents(), llm, { route: { provider: 'p', model: 'm' } });
  const service = createSuggestionService({ ctx, config: normalizeConfig({}), warn: WARN });

  const first = await service.suggest({ sessionId: 'session-1', locale: 'zh' });
  assert.equal(first, '跑一遍 go test 并修掉失败用例');
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content[0].text, /## User request this turn\n跑一下测试/);
  assert.match(calls[0].messages[0].content[0].text, /- bash go test \.\/\.\.\. \[failed\]/);

  const second = await service.suggest({ sessionId: 'session-1', locale: 'zh' });
  assert.equal(second, first);
  assert.equal(calls.length, 1, 'the same turn must not call the model twice');
});

test('returns null for missing sessions, aborted turns and subagent sessions', async () => {
  const { llm } = fakeLlm(['x']);
  const ctx = fakeCtx(baseEvents({ reason: 'aborted' }), llm, { route: { provider: 'p', model: 'm' } });
  const service = createSuggestionService({ ctx, config: normalizeConfig({}), warn: WARN });

  assert.equal(await service.suggest({ sessionId: 'other', locale: 'zh' }), null);
  assert.equal(await service.suggest({ sessionId: 'session-1', locale: 'zh' }), null);

  const subagentCtx = fakeCtx(baseEvents(), llm, {
    route: { provider: 'p', model: 'm' },
    header: { origin: 'subagent' },
  });
  const subagentService = createSuggestionService({
    ctx: subagentCtx,
    config: normalizeConfig({}),
    warn: WARN,
  });
  assert.equal(await subagentService.suggest({ sessionId: 'session-1', locale: 'zh' }), null);
});

test('returns null without a usable model route', async () => {
  const { llm, calls } = fakeLlm(['x']);
  const ctx = fakeCtx(baseEvents(), llm);
  const service = createSuggestionService({ ctx, config: normalizeConfig({}), warn: WARN });
  assert.equal(await service.suggest({ sessionId: 'session-1', locale: 'zh' }), null);
  assert.equal(calls.length, 0);
});

test('uses explicit provider/model from config over the session route', async () => {
  const { llm, calls } = fakeLlm(['ok']);
  const ctx = fakeCtx(baseEvents(), llm, { route: { provider: 'session-provider', model: 'session-model' } });
  const service = createSuggestionService({
    ctx,
    config: normalizeConfig({ provider: 'cheap', model: 'small' }),
    warn: WARN,
  });
  assert.equal(await service.suggest({ sessionId: 'session-1', locale: 'zh' }), 'ok');
  assert.equal(calls[0].provider, 'cheap');
  assert.equal(calls[0].model, 'small');
});

test('the summary never blocks the suggestion and is refreshed afterwards', async () => {
  const longHistory = [];
  for (let index = 0; index < 40; index += 1) {
    longHistory.push(event(index * 2 + 1, 'user/message', {
      content: [{ type: 'text', text: `第 ${index} 轮需求：${'补细节'.repeat(20)}` }],
    }));
    longHistory.push(event(index * 2 + 2, 'assistant/message', {
      message: { content: [{ type: 'text', text: `第 ${index} 轮回答：${'已处理'.repeat(20)}` }] },
    }));
    longHistory.push(event(index * 2 + 3, 'turn/end', { turn: index, reason: { kind: 'completed' } }));
  }
  const events = baseEvents({ prefix: longHistory });
  // 第一次调用是建议（此时还没有摘要），第二次是建议返回后的后台摘要刷新。
  const { llm, calls } = fakeLlm(['接着补第 41 轮的用例', '滚动摘要', '补上缺失的断言']);
  const ctx = fakeCtx(events, llm, { route: { provider: 'p', model: 'm' } });
  const service = createSuggestionService({ ctx, config: normalizeConfig({}), warn: WARN });

  const text = await service.suggest({ sessionId: 'session-1', locale: 'zh' });
  assert.equal(text, '接着补第 41 轮的用例');
  // 第一条必须是建议本身：它的 prompt 里不该出现「早期对话摘要」，
  // 也不该等任何摘要调用（摘要只在建议返回后才开始刷新）。
  assert.match(calls[0].messages[0].content[0].text, /## User request this turn/);
  assert.doesNotMatch(calls[0].messages[0].content[0].text, /Earlier conversation summary/);

  // 等后台摘要刷新落定。
  await new Promise(resolve => { setImmediate(resolve); });
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(calls.length, 2, 'the summary refresh happens after the suggestion');
  assert.match(calls[1].messages[0].content[0].text, /Conversation so far/);

  // 下一轮：prompt 里应该带上刚才后台刷出来的摘要。
  const nextSeq = events[events.length - 1].seq + 1;
  events.push(
    event(nextSeq, 'turn/start', { turn: 10 }),
    event(nextSeq + 1, 'user/message', { content: [{ type: 'text', text: '继续' }] }),
    event(nextSeq + 2, 'assistant/message', { message: { content: [{ type: 'text', text: '已补齐用例' }] } }),
    event(nextSeq + 3, 'turn/end', { turn: 10, reason: { kind: 'completed' } }),
  );
  const second = await service.suggest({ sessionId: 'session-1', locale: 'zh' });
  assert.equal(second, '补上缺失的断言');
  assert.match(calls[2].messages[0].content[0].text, /滚动摘要/);
});

test('an empty model answer degrades to null instead of an empty placeholder', async () => {
  const { llm } = fakeLlm(['NONE']);
  const ctx = fakeCtx(baseEvents(), llm, { route: { provider: 'p', model: 'm' } });
  const service = createSuggestionService({ ctx, config: normalizeConfig({}), warn: WARN });
  assert.equal(await service.suggest({ sessionId: 'session-1', locale: 'zh' }), null);
});
