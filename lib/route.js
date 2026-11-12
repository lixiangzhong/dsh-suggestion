/**
 * 建议接口的 HTTP 适配层。
 *
 * 契约（冻结，客户端按它调用）：
 *   GET /dsh-suggestion/suggest?session=<id>&locale=<tag>
 *     → 200 { "text": "…" | null }
 *   - 未通过 `connection.requestRejection` 栅栏 → 403 { error: 'forbidden' }
 *   - 非 GET → 405 + allow: GET；未知子路径 → 404
 *   - 任何内部异常 → 500 { error: 'internal' }，绝不把异常抛回宿主
 *
 * 刻意不做：认证、限速、缓存。认证交给 DSH 自己的浏览器栅栏（与 /api 同一套），
 * 缓存与去重在 service 层；这里只做「不添乱」的 HTTP 外壳。
 */

/** 路由前缀；所有子路径都必须落在它下面。 */
export const ROUTE_PREFIX = '/dsh-suggestion';
/** 建议接口的完整路径，客户端用同名常量。 */
export const SUGGEST_PATH = '/dsh-suggestion/suggest';
/** 前端留痕接口；同样走浏览器信任栅栏。 */
export const TRACE_PATH = '/dsh-suggestion/trace';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const CACHE_CONTROL_NO_STORE = 'no-store';
const ALLOW_GET = 'GET';
const ALLOW_POST = 'POST';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL = 500;
const ERROR_FORBIDDEN = Object.freeze({ error: 'forbidden' });
const ERROR_NOT_FOUND = Object.freeze({ error: 'not-found' });
const ERROR_METHOD = Object.freeze({ error: 'method-not-allowed' });
const ERROR_INTERNAL = Object.freeze({ error: 'internal' });
const ERROR_BAD_BODY = Object.freeze({ error: 'bad-body' });
/** 留痕请求体上限：只接受一小段 JSON。 */
const MAX_TRACE_BODY_BYTES = 8 * 1024;

/** 会话 id 的宽松校验：只挡控制字符与超长输入，不假设 id 的具体编码。 */
const SESSION_ID_PATTERN = /^[\w.:-]{1,200}$/;
/** 语言标签校验：2~3 位主语言，可选 1~2 段子标签（zh、zh-CN、pt-BR）。 */
const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/;
/** locale 缺失或非法时使用的兜底语言。 */
const FALLBACK_LOCALE = 'en';

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} response - 响应对象。
 * @param {number} status - 状态码。
 * @param {object} payload - JSON 负载。
 * @param {Record<string, string>} [headers] - 额外响应头。
 * @returns {void}
 */
function sendJson(response, status, payload, headers = {}) {
  if (!response || typeof response.writeHead !== 'function') return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(body),
    'cache-control': CACHE_CONTROL_NO_STORE,
    ...headers,
  });
  response.end(body);
}

/**
 * 浏览器信任栅栏：与 /api 同一套判定，未通过一律拒绝。
 * @param {object} ctx - Host context。
 * @param {unknown} request - Node 请求对象。
 * @returns {boolean} 允许访问返回 true。
 */
function connectionAllowed(ctx, request) {
  const reject = ctx?.connection?.requestRejection;
  if (typeof reject !== 'function') return false;
  try {
    return reject.call(ctx.connection, request) === undefined;
  } catch {
    return false;
  }
}

/**
 * 从请求目标里取 pathname；非法 URL 返回 null。
 * @param {unknown} request - Node 请求对象。
 * @returns {string | null} pathname。
 */
function requestPathname(request) {
  try {
    return new URL(String(request?.url ?? '/'), 'http://dsh.invalid').pathname;
  } catch {
    return null;
  }
}

/**
 * 读取并校验查询参数。
 * @param {unknown} request - Node 请求对象。
 * @returns {{sessionId: string, locale: string} | undefined} 合法入参。
 */
function parseQuery(request) {
  let url;
  try {
    url = new URL(String(request?.url ?? '/'), 'http://dsh.invalid');
  } catch {
    return undefined;
  }
  const sessionId = url.searchParams.get('session') ?? '';
  if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
  const rawLocale = url.searchParams.get('locale') ?? '';
  const locale = LOCALE_PATTERN.test(rawLocale) ? rawLocale : FALLBACK_LOCALE;
  return { sessionId, locale };
}

/**
 * 处理一条建议请求：栅栏 → 方法 → 路径 → 参数 → 生成 → 响应。
 * @param {object} ctx - Host context。
 * @param {{suggest: Function}} service - 建议服务。
 * @param {unknown} request - Node 请求对象。
 * @param {unknown} response - Node 响应对象。
 * @returns {Promise<void>}
 */
async function handleSuggest(ctx, service, request, response) {
  try {
    if (!connectionAllowed(ctx, request)) {
      sendJson(response, HTTP_FORBIDDEN, ERROR_FORBIDDEN);
      return;
    }
    if (request?.method !== ALLOW_GET) {
      sendJson(response, HTTP_METHOD_NOT_ALLOWED, ERROR_METHOD, { allow: ALLOW_GET });
      return;
    }
    if (requestPathname(request) !== SUGGEST_PATH) {
      sendJson(response, HTTP_NOT_FOUND, ERROR_NOT_FOUND);
      return;
    }
    const query = parseQuery(request);
    if (query === undefined) {
      sendJson(response, HTTP_NOT_FOUND, ERROR_NOT_FOUND);
      return;
    }

    // 客户端关页/切走时取消模型调用，别让一次没人要的生成继续烧 token。
    // 监听 response 而不是 request：Node 的 IncomingMessage 在请求读完后就会 close，
    // 拿它当「客户端断开」会误杀正在进行的生成。
    const controller = new AbortController();
    response.on?.('close', () => {
      if (response.writableEnded !== true) controller.abort(new Error('client closed the suggestion request'));
    });

    const text = await service.suggest({ ...query, signal: controller.signal });
    if (response?.writableEnded === true) return;
    sendJson(response, HTTP_OK, { text: typeof text === 'string' ? text : null });
  } catch {
    // 关键边界：handler 异常若冒泡，webServer 会回 400 并打 warn，把插件接口弄坏。
    if (response?.writableEnded !== true) sendJson(response, HTTP_INTERNAL, ERROR_INTERNAL);
  }
}

/**
 * 处理一条前端留痕：POST 一段小 JSON，开启 `tracePath` 时追加到同一个 JSONL。
 * 只用于诊断「客户端到底有没有触发、占位有没有接管」，与建议生成无关。
 * @param {object} ctx - Host context。
 * @param {{trace?: Function}} service - 建议服务（暴露留痕函数）。
 * @param {unknown} request - Node 请求对象。
 * @param {unknown} response - Node 响应对象。
 * @returns {Promise<void>}
 */
async function handleTrace(ctx, service, request, response) {
  if (!connectionAllowed(ctx, request)) {
    sendJson(response, HTTP_FORBIDDEN, ERROR_FORBIDDEN);
    return;
  }
  if (request?.method !== ALLOW_POST) {
    sendJson(response, HTTP_METHOD_NOT_ALLOWED, ERROR_METHOD, { allow: ALLOW_POST });
    return;
  }
  const body = await readBody(request);
  if (body === undefined) {
    sendJson(response, HTTP_BAD_REQUEST, ERROR_BAD_BODY);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(response, HTTP_BAD_REQUEST, ERROR_BAD_BODY);
    return;
  }
  if (payload === null || typeof payload !== 'object' || typeof payload.event !== 'string') {
    sendJson(response, HTTP_BAD_REQUEST, ERROR_BAD_BODY);
    return;
  }
  service.trace?.({ scope: 'client', ...payload });
  sendJson(response, HTTP_NO_CONTENT, {});
}

/**
 * 读取请求体并限制大小，超限或读取失败返回 undefined。
 * @param {unknown} request - Node 请求对象。
 * @returns {Promise<string | undefined>} 请求体文本。
 */
async function readBody(request) {
  if (typeof request?.on !== 'function') return undefined;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_TRACE_BODY_BYTES) return undefined;
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 注册建议路由。
 * @param {object} ctx - Host context（需要 `webServer` 与可选的 `connection`）。
 * @param {{suggest: Function, trace?: Function}} service - 建议服务。
 * @returns {() => void} 卸载函数。
 */
export function registerSuggestionRoute(ctx, service) {
  const webServer = ctx?.webServer;
  if (typeof webServer?.register !== 'function') return () => {};
  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => {
      const pathname = requestPathname(request);
      const run = pathname === TRACE_PATH
        ? handleTrace(ctx, service, request, response)
        : handleSuggest(ctx, service, request, response);
      Promise.resolve(run).catch(() => {
        if (response?.writableEnded !== true) sendJson(response, HTTP_INTERNAL, ERROR_INTERNAL);
      });
    },
  };
  const dispose = webServer.register(route);
  return typeof dispose === 'function' ? dispose : () => {};
}
