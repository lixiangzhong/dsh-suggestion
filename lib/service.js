/**
 * 建议服务：把「会话 + 界面语言」变成一句建议文案。
 *
 * 职责边界：
 *  - 只读会话日志，不改会话状态、不进模型上下文；
 *  - 同一轮次（同一 `turn/end`）只生成一次，跨请求复用；
 *  - 任何失败都返回 null，让客户端保持宿主默认占位文字。
 */

import { resolveModelRoute } from './config.js';
import { collectTurnContext, lastTurnBoundary, seqOf } from './session-context.js';
import { createSummaryCache, readSummary, refreshSummary } from './summary.js';
import { buildSuggestionPrompt, normalizeSuggestion } from './prompt.js';
import { complete } from './llm.js';
import { createTracer } from './trace.js';

/** 同一轮次建议的复用窗口：只要还在进程内，切回旧会话也能立刻看到。 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
/** 缓存条目上限，避免长期运行时无界增长。 */
const MAX_CACHE_ENTRIES = 64;
/** 喂给模型「不要重复」的近期建议条数。 */
const MAX_RECENT_SUGGESTIONS = 3;
/** 记录近期建议的会话数上限。 */
const MAX_RECENT_SESSIONS = 128;
/**
 * 客户端可能比持久化的 `turn/end` 早一帧观察到 running → false。
 * 看到「有 turn/start 但没有对应 turn/end」时最多等这么久再放弃。
 */
const SETTLE_WAIT_MS = 1_200;
/** 等待期间的轮询间隔。 */
const SETTLE_POLL_MS = 100;
/**
 * 只对「刚结束」的轮次**新生成**建议：切回很久以前的会话时补请求会走到这里，
 * 超过窗口就放弃，不白花一次调用。已有缓存不受这条限制（先查缓存再看它）。
 */
const STALE_TURN_MS = 10 * 60 * 1_000;
/**
 * 后台兜底的延迟：用户不在该会话窗口时，客户端不会发请求，
 * 等这么久若确实没人来要，就自己生成一份放进缓存，切回时直接命中。
 */
const BACKGROUND_DELAY_MS = 2_000;

/**
 * 读会话事件日志。
 *
 * `Session` 上唯一可用的同步读入口是 `snapshotEvents()`；`session.events` 是
 * SessionSurface 的属性（只含模型可见事件，缺 `turn/end` 这类边界标记），不能用来判断轮次。
 * @param {{snapshotEvents?: Function, events?: unknown}} session - 会话对象。
 * @returns {readonly unknown[]} 事件数组；读不到时返回空数组。
 */
function eventsOf(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents() ?? [];
    if (Array.isArray(session?.events)) return session.events;
  } catch {
    // 会话已被回收等情况：按空日志处理，调用方会降级为「没有建议」。
  }
  return [];
}

/**
 * 会话最后一条 `turn/start` 是否仍未结束。
 * @param {readonly unknown[]} events - 会话事件。
 * @returns {boolean} 存在未收尾的轮次返回 true。
 */
function hasTurnInFlight(events) {
  let lastStart = -1;
  let lastEnd = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (lastEnd < 0 && type === 'turn/end') lastEnd = index;
    if (lastStart < 0 && type === 'turn/start') lastStart = index;
    if (lastStart >= 0 && lastEnd >= 0) break;
  }
  return lastStart > lastEnd;
}

/**
 * 等这一轮真正收尾（持久化了 `turn/end`），最多等 `SETTLE_WAIT_MS`。
 * @param {{events: readonly unknown[]}} session - 会话对象。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<boolean>} 已收尾返回 true。
 */
async function waitForSettledTurn(session, signal) {
  const deadline = Date.now() + SETTLE_WAIT_MS;
  for (;;) {
    const events = eventsOf(session);
    if (!hasTurnInFlight(events)) return true;
    if (Date.now() >= deadline) return false;
    if (signal?.aborted === true) return false;
    await new Promise(resolve => {
      setTimeout(resolve, SETTLE_POLL_MS);
    });
  }
}


/**
 * 创建建议服务。
 * @param {object} deps - 依赖。
 * @param {object} deps.ctx - Host 插件 context（需要 `llm` / `sessions`）。
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config - 归一化后的配置。
 * @param {(message: string, error?: unknown) => void} deps.warn - 诊断日志。
 * @param {number} [deps.backgroundDelayMs] - 后台兜底延迟（测试可注入）。
 * @returns {{suggest: (input: {sessionId: string, locale: string, signal?: AbortSignal}) => Promise<string|null>, dispose: () => void}} 服务门面。
 */
export function createSuggestionService(deps) {
  const { ctx, config, warn } = deps;
  /** 诊断留痕（`tracePath` 为空时是 no-op）。 */
  const traceEvent = createTracer(config.tracePath);
  /** @type {Map<string, {text: string, at: number}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<string|null>>} */
  const inflight = new Map();
  /** @type {Map<string, string[]>} */
  const recent = new Map();
  const summaries = createSummaryCache();
  /** 正在后台刷新摘要的会话，保证同一会话同时只刷新一次。 */
  const summaryRefreshing = new Set();
  /** 每会话一个待触发的后台兜底定时器：新一轮结束会顶掉旧的一轮。 */
  const backgroundTimers = new Map();
  /** 后台兜底不知道界面语言，沿用最近一次客户端请求报上来的语言。 */
  let lastLocale = '';
  const backgroundDelayMs = Number.isFinite(deps.backgroundDelayMs)
    ? Math.max(0, Number(deps.backgroundDelayMs))
    : BACKGROUND_DELAY_MS;

  /**
   * 读取该会话最近一次请求的模型路由。
   * @param {object} session - 会话对象。
   * @returns {{provider: string, model: string} | undefined} 路由。
   */
  function routeOf(session) {
    let sessionRoute;
    try {
      sessionRoute = session.requestHeader?.()?.config;
    } catch {
      sessionRoute = undefined;
    }
    return resolveModelRoute(config, sessionRoute);
  }

  /**
   * 会话是否应当跳过：子代理会话没有「用户下一步」的概念。
   * @param {object} session - 会话对象。
   * @returns {boolean} 跳过返回 true。
   */
  function shouldSkipSession(session) {
    const header = session.header ?? {};
    if (header.origin === 'subagent') return true;
    if (typeof header.depth === 'number' && header.depth > 0) return true;
    return false;
  }

  /**
   * 记录一条已展示的建议，供后续「不要重复」使用。
   * @param {string} sessionId - 会话 id。
   * @param {string} text - 建议文案。
   */
  function rememberSuggestion(sessionId, text) {
    const list = recent.get(sessionId) ?? [];
    list.push(text);
    while (list.length > MAX_RECENT_SUGGESTIONS) list.shift();
    recent.set(sessionId, list);
    if (recent.size > MAX_RECENT_SESSIONS) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
  }

  /**
   * 真实生成一次建议（不含缓存与并发合并）。
   *
   * 关键时序：只用已有摘要拼 prompt → 一次模型调用 → 返回；摘要刷新放在返回之后
   * fire-and-forget，用户等待时间不包含它。
   * @param {object} input - 输入。
   * @param {object} input.session - 会话对象。
   * @param {readonly unknown[]} input.events - 会话事件。
   * @param {number} input.summaryUptoIndex - 本轮结束后摘要应覆盖到的下标（不含）。
   * @param {string} input.locale - 界面语言。
   * @param {{provider: string, model: string}} input.route - 模型路由。
   * @param {{reasonKind: string, userText: string, assistantText: string, tools: readonly object[], historyEndIndex: number}} input.turn - 本轮上下文。
   * @param {AbortSignal} [input.signal] - 外部取消信号。
   * @returns {Promise<string | null>} 建议文案；模型表示没有建议时返回 null。
   */
  async function generateOne(input) {
    const prompts = buildSuggestionPrompt({
      locale: input.locale,
      maxChars: config.maxChars,
      reasonKind: input.turn.reasonKind,
      userText: input.turn.userText,
      assistantText: input.turn.assistantText,
      tools: input.turn.tools,
      summary: readSummary(summaries, input.session.id),
      recent: recent.get(input.session.id) ?? [],
    });
    try {
      const raw = await complete(ctx.llm, {
        provider: input.route.provider,
        model: input.route.model,
        system: prompts.system,
        user: prompts.user,
        timeoutMs: config.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return normalizeSuggestion(raw, config.maxChars);
    } finally {
      scheduleSummaryRefresh(input);
    }
  }

  /**
   * 后台刷新摘要：同一会话同时只跑一次，失败只记日志。
   * @param {object} input - 与 `generateOne` 相同的输入。
   * @returns {void}
   */
  function scheduleSummaryRefresh(input) {
    const sessionId = input.session.id;
    if (summaryRefreshing.has(sessionId)) return;
    summaryRefreshing.add(sessionId);
    void refreshSummary({
      llm: ctx.llm,
      cache: summaries,
      maxChars: config.summaryMaxChars,
      warn,
    }, {
      sessionId,
      events: input.events,
      uptoIndex: input.summaryUptoIndex,
      route: input.route,
      locale: input.locale,
      timeoutMs: config.timeoutMs,
    })
      .catch(() => '')
      .finally(() => {
        summaryRefreshing.delete(sessionId);
      });
  }

  /**
   * 生成（或复用）指定会话当前最后一轮的建议。
   * @param {{sessionId: string, locale: string, signal?: AbortSignal}} request - 请求。
   * @returns {Promise<string | null>} 建议文案；无可用结果时返回 null。
   */
  async function suggest(request) {
    const startedAt = Date.now();
    /**
     * 记录一次请求的结论；开启 `tracePath` 时才有落盘副作用。
     * @param {string} outcome - 结论码。
     * @param {object} [extra] - 附加字段。
     * @returns {void}
     */
    const trace = (outcome, extra = {}) => {
      traceEvent({
        scope: 'host',
        event: 'suggest',
        sessionId: request.sessionId,
        locale: request.locale,
        outcome,
        ms: Date.now() - startedAt,
        ...extra,
      });
    };

    if (typeof request.locale === 'string' && request.locale !== '') lastLocale = request.locale;
    if (!config.enabled) {
      trace('disabled');
      return null;
    }
    const session = ctx.sessions.get(request.sessionId);
    if (session === undefined) {
      trace('session-missing');
      return null;
    }
    if (shouldSkipSession(session)) {
      trace('subagent');
      return null;
    }
    if (!(await waitForSettledTurn(session, request.signal))) {
      trace('turn-in-flight');
      return null;
    }

    const events = eventsOf(session);
    const boundary = lastTurnBoundary(events);
    if (boundary === undefined) {
      trace('no-turn');
      return null;
    }
    if (boundary.reasonKind === 'aborted') {
      trace('aborted');
      return null;
    }

    const turnSeq = seqOf(events[boundary.endIndex]) ?? boundary.endIndex;
    // 语言进 key：后台兜底用的是「最近一次客户端报上来的语言」，界面换语言后不会串。
    const cacheKey = `${request.sessionId}#${turnSeq}#${boundary.reasonKind}#${request.locale}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at <= CACHE_TTL_MS) {
      trace('cached', { text: cached.text });
      return cached.text;
    }

    const running = inflight.get(cacheKey);
    if (running !== undefined) {
      trace('inflight');
      return running;
    }

    // 先查缓存再看新旧：已经生成过的轮次，切回多久都能直接给。
    const endedAt = events[boundary.endIndex]?.time;
    if (typeof endedAt === 'number' && Date.now() - endedAt > STALE_TURN_MS) {
      trace('stale-turn', { ageMs: Date.now() - endedAt });
      return null;
    }

    const route = routeOf(session);
    if (route === undefined) {
      warn('no model route for this session; set provider/model in the plugin config', undefined);
      trace('no-route');
      return null;
    }

    const turn = collectTurnContext(events);
    if (turn === undefined) {
      trace('no-turn');
      return null;
    }
    if (turn.userText === '' && turn.assistantText === '' && turn.tools.length === 0) {
      trace('empty-turn');
      return null;
    }

    const task = generateOne({
      session,
      events,
      // 摘要覆盖到本轮结束为止：下一轮拿到的是「上一轮及更早」的背景，不与本轮重复。
      summaryUptoIndex: boundary.endIndex + 1,
      locale: request.locale,
      route,
      turn,
      signal: request.signal,
    })
      .then((text) => {
        if (text !== null) {
          cache.set(cacheKey, { text, at: Date.now() });
          rememberSuggestion(request.sessionId, text);
          if (cache.size > MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          trace('generated', {
            provider: route.provider,
            model: route.model,
            reasonKind: turn.reasonKind,
            toolCalls: turn.tools.length,
            text,
          });
        } else {
          trace('none-marker', { provider: route.provider, model: route.model });
        }
        return text;
      })
      .catch((error) => {
        warn('suggestion generation failed', error);
        trace('llm-failed', {
          provider: route.provider,
          model: route.model,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        inflight.delete(cacheKey);
      });

    inflight.set(cacheKey, task);
    return task;
  }

  /**
   * 后台兜底：某会话一轮结束后延迟触发一次生成。
   *
   * 用户不在该会话窗口时客户端不会来请求；这里补上一份放进缓存，切回时会直接命中。
   * 客户端若在延迟内自己来了，`suggest` 的 in-flight / 缓存会把它合并成同一次调用。
   * @param {string} sessionId - 会话 id。
   * @returns {void}
   */
  function scheduleBackground(sessionId) {
    if (!config.enabled) return;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const pending = backgroundTimers.get(sessionId);
    if (pending !== undefined) clearTimeout(pending);

    const timer = setTimeout(() => {
      backgroundTimers.delete(sessionId);
      const locale = lastLocale !== '' ? lastLocale : 'en';
      traceEvent({ scope: 'host', event: 'background.attempt', sessionId, locale });
      void suggest({ sessionId, locale }).catch(() => null);
    }, backgroundDelayMs);
    // 宿主关闭时不要因为一个待触发的兜底让进程多挂 2 秒。
    timer.unref?.();
    backgroundTimers.set(sessionId, timer);
  }

  /**
   * 取消某会话待触发的后台兜底。
   *
   * 客户端在场但输入框已有草稿时不会请求建议；它会发一条取消，避免 Host 白跑一次模型。
   * @param {string} sessionId - 会话 id。
   * @returns {boolean} 确实取消了返回 true。
   */
  function cancelBackground(sessionId) {
    const pending = backgroundTimers.get(sessionId);
    if (pending === undefined) return false;
    clearTimeout(pending);
    backgroundTimers.delete(sessionId);
    traceEvent({ scope: 'host', event: 'background.cancelled', sessionId });
    return true;
  }

  return {
    suggest,
    scheduleBackground,
    cancelBackground,
    trace: traceEvent,
    dispose() {
      for (const timer of backgroundTimers.values()) clearTimeout(timer);
      backgroundTimers.clear();
      cache.clear();
      inflight.clear();
      recent.clear();
      summaries.clear();
      summaryRefreshing.clear();
    },
  };
}
