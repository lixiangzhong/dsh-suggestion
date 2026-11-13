/**
 * 辅助模型调用的容错测试：失败重试、错误细节、取消不重试。
 * 这一层是「模型抖一下就整轮没建议」的唯一防线，值得单独覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { complete } from '../lib/llm.js';

/**
 * 造一个按脚本依次返回结果的假 LLM。
 * @param {Array<{text?: string, finish?: object} | Error>} script - 每次调用的结果。
 * @returns {{llm: object, calls: number[]}} 假 llm 与调用次数记录。
 */
function scriptedLlm(script) {
  const calls = [];
  return {
    calls,
    llm: {
      stream() {
        const step = script[Math.min(calls.length, script.length - 1)];
        calls.push(calls.length);
        return {
          async *[Symbol.asyncIterator]() {
            if (step instanceof Error) throw step;
            if (step.text !== undefined) yield { type: 'text-delta', index: 0, text: step.text };
            yield { type: 'finish', reason: step.finish ?? { kind: 'stop' } };
          },
        };
      },
    },
  };
}

/** 常规请求参数。 */
const REQUEST = {
  provider: 'p',
  model: 'm',
  system: 'sys',
  user: 'hi',
  timeoutMs: 5_000,
};

test('retries once after an upstream error finish and returns the second answer', async () => {
  const { llm, calls } = scriptedLlm([
    { finish: { kind: 'error', failure: { code: 'UPSTREAM_5XX', message: 'bad gateway' } } },
    { text: '重试成功' },
  ]);
  const text = await complete(llm, REQUEST);
  assert.equal(text, '重试成功');
  assert.equal(calls.length, 2);
});

test('gives up after two failed attempts and keeps the upstream detail', async () => {
  const { llm, calls } = scriptedLlm([
    { finish: { kind: 'error', failure: { code: 'UPSTREAM_5XX', message: 'bad gateway' } } },
  ]);
  await assert.rejects(
    () => complete(llm, REQUEST),
    /finished with "error" \(UPSTREAM_5XX: bad gateway\)/,
  );
  assert.equal(calls.length, 2, 'only one retry is allowed');
});

test('a cancellation is not retried', async () => {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  const { llm, calls } = scriptedLlm([abortError, { text: '不该出现' }]);
  await assert.rejects(() => complete(llm, REQUEST), /aborted/);
  assert.equal(calls.length, 1);
});

test('a thrown transport error is retried', async () => {
  const { llm, calls } = scriptedLlm([new Error('socket hang up'), { text: '第二次成功' }]);
  const text = await complete(llm, REQUEST);
  assert.equal(text, '第二次成功');
  assert.equal(calls.length, 2);
});
