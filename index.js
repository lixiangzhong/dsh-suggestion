/**
 * Host 半边：@lixiangzhong/dsh-suggestion。
 *
 * 会话每一轮结束后，浏览器半边会带着会话 id 与界面语言请求本插件，
 * 这里读取该会话的最后一轮上下文（必要时补充早期对话摘要），用模型生成
 * 一句「下一步建议」并通过一条只读鉴权路由返回；浏览器半边负责把它写进
 * 输入框的占位文字。
 *
 * 本插件不改会话日志、不进模型上下文、不注册工具，失败一律降级为「没有建议」。
 */
import { normalizeConfig } from './lib/config.js';
import { createSuggestionService } from './lib/service.js';
import { registerSuggestionRoute } from './lib/route.js';

/** Loader 里的 entry 名，同时是插件身份。 */
export const name = 'dsh-suggestion';

/** 本插件只在带浏览器 HTTP 载体的 profile 里有意义；缺任一服务时不激活。 */
export const inject = ['llm', 'sessions', 'webServer', 'connection'];

/**
 * 诊断日志：统一前缀，优先走宿主 logger；logger 不可用时退回 console。
 * @param {object} ctx - Host context。
 * @param {'info' | 'warn'} level - 级别。
 * @param {string} message - 说明。
 * @param {unknown} [error] - 原始错误。
 * @returns {void}
 */
function logThrough(ctx, level, message, error) {
  const line = `[dsh-suggestion] ${message}`;
  try {
    const sink = ctx?.logger?.[level];
    if (typeof sink === 'function') {
      sink.call(ctx.logger, error === undefined
        ? line
        : `${line}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  } catch {
    // 日志后端自身异常不能影响插件。
  }
  if (error === undefined) console.warn(line);
  else console.warn(line, error);
}

/**
 * 挂载插件：校验配置、创建服务、注册路由。
 * @param {object} ctx - Cordis Host context。
 * @param {unknown} rawConfig - patch 里的 config。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const warn = (message, error) => logThrough(ctx, 'warn', message, error);
  const info = message => logThrough(ctx, 'info', message);

  if (typeof ctx.webServer?.register !== 'function') {
    warn('webServer.register is unavailable in this profile; the suggestion endpoint stays off');
    return;
  }
  if (typeof ctx.connection?.requestRejection !== 'function') {
    warn('connection.requestRejection is unavailable; refusing to expose the suggestion endpoint');
    return;
  }

  const service = createSuggestionService({ ctx, config, warn });
  ctx.effect(() => registerSuggestionRoute(ctx, service), 'dsh-suggestion: suggest route');
  ctx.effect(() => () => service.dispose(), 'dsh-suggestion: dispose');
  // 留痕开启时先落一行启动记录：用来区分「配置没生效」和「客户端没触发」。
  service.trace?.({
    scope: 'host',
    event: 'plugin.start',
    tracePath: config.tracePath,
    provider: config.provider,
    model: config.model,
  });
  info('ready: suggestions follow the session model unless provider/model are configured');
}
