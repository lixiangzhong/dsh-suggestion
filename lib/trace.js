/**
 * 可选诊断留痕：把每次建议请求的结论追加到一行 JSONL。
 *
 * 默认关闭（`tracePath` 为空）；开启后用于回答「这一轮到底请求了没有、为什么没有建议」，
 * 也方便把问题现场原样交给别人复现。写入失败一律吞掉——诊断能力不能影响主流程。
 */
import { appendFile } from 'node:fs/promises';

/**
 * 创建留痕函数。
 * @param {string} path - JSONL 目标路径；空串表示关闭。
 * @returns {(event: object) => void} 留痕函数（同步调用、异步写盘）。
 */
export function createTracer(path) {
  if (typeof path !== 'string' || path.trim() === '') return () => {};
  const target = path.trim();
  return event => {
    let line;
    try {
      line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    } catch {
      return;
    }
    appendFile(target, line, 'utf8').catch(() => {});
  };
}
