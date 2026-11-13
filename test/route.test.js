/**
 * 路由层集成测试：模拟一次真实的 `GET /dsh-suggestion/suggest`，
 * 断言浏览器实际收到的 JSON 里就是完整建议（超过 100 字也不追加省略号）。
 *
 * 这一层是「Host 返回什么」的唯一出口：客户端按 Tab 填入的就是这里 `text` 字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { createSuggestionService } from '../lib/service.js';
import { registerSuggestionRoute, SUGGEST_PATH } from '../lib/route.js';

/**
 * 造一条会话事件。
 * @param {number} seq - 序号。
 * @param {string} type - 类型。
 * @param {object} data - 数据。
 * @returns {object} 事件。
 */
function event(seq, type, data) {
  return { seq, type, data, time: Date.now() };
}

/**
 * 造一段「已结束一轮」的事件流。
 * @param {number} answerLength - 无关，占位保持签名一致。
 * @returns {object[]} 事件。
 */
function turnEvents() {
  return [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { content: [{ type: 'text', text: '按 Tab 验证一条长建议' }] }),
    event(3, 'assistant/message', { message: { content: [{ type: 'text', text: '建议已生成' }] } }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

/**
 * 假 LLM：总是输出同一段文本。
 * @param {string} text - 输出文本。
 * @returns {{stream: Function}} 假 llm。
 */
function fakeLlm(text) {
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
}

/**
 * 最小可用的 fake response：把 writeHead/end 记录下来。
 * @returns {{response: object, done: Promise<object>}} 响应对象与完成信号。
 */
function fakeResponse() {
  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });
  const response = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
      return response;
    },
    end(body) {
      response.body = body;
      response.writableEnded = true;
      resolveDone(response);
    },
  };
  return { response, done };
}

/**
 * 挂载路由并返回可调用的 handler。
 * @param {object} ctx - 假 Host context。
 * @param {object} service - 建议服务。
 * @returns {(request: object, response: object) => void} 路由 handler。
 */
function mountRoute(ctx, service) {
  let captured;
  const webServer = {
    register(route) {
      captured = route;
      return () => {};
    },
  };
  registerSuggestionRoute({ ...ctx, webServer }, service);
  assert.ok(captured, 'the route must be registered');
  return captured.handler;
}

test('a suggestion longer than 100 characters reaches the client intact', async () => {
  // 130 个字符，模拟模型写出的一句较长建议。
  const longText = `先跑一遍全量回归，再按失败用例的堆栈逐个修：${'检查登录与鉴权分支'.repeat(12)}`;
  assert.ok(Array.from(longText).length > 100, 'fixture must exceed the old 100-char cap');

  const session = {
    id: 'session-1',
    header: {},
    snapshotEvents: () => turnEvents(),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };
  const ctx = {
    sessions: { get: id => (id === session.id ? session : undefined) },
    llm: fakeLlm(longText),
    connection: { requestRejection: () => undefined },
  };
  const service = createSuggestionService({ ctx, config: normalizeConfig({}), warn: () => {} });
  const handler = mountRoute(ctx, service);

  const request = {
    method: 'GET',
    url: `${SUGGEST_PATH}?session=session-1&locale=zh`,
    headers: { host: '127.0.0.1:1' },
  };
  const { response, done } = fakeResponse();
  handler(request, response);

  const finished = await done;
  assert.equal(finished.status, 200);
  const payload = JSON.parse(finished.body);
  assert.equal(typeof payload.text, 'string');
  assert.equal(payload.text, longText, 'the JSON body must carry the whole suggestion');
  assert.ok(!payload.text.endsWith('…'), 'no ellipsis is appended below the cap');
  assert.ok(Array.from(payload.text).length > 100);
});
