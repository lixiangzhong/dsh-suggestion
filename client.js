/**
 * 浏览器半边：@lixiangzhong/dsh-suggestion。
 *
 * 做三件事：
 *  1. 在 `conversation.composer.dock` 挂一个不可见条目，用标准 Session props 观察
 *     「一轮结束（running → false）+ 草稿为空」，向 Host 的 `/dsh-suggestion/suggest`
 *     拉取一句建议；
 *  2. 把这句话写进宿主自己的 placeholder 节点（`[data-composer-placeholder]`），
 *     只在宿主显示默认占位文案时才接管，其它状态（未选工作区 / 被 block / 计划模式 /
 *     插话队列 / hero）一律让位；
 *  3. 草稿为空且建议在显示时，Tab 一键把建议填进草稿（只填入，不发送）。
 *
 * 降级：宿主若不再提供 placeholder 节点（版本变化），同一 dock 条目改为渲染一行
 * 可点击的建议条，功能不中断、也不会因为选择器失配而报错。
 */
window.__ModuleLoader__.load({
  id: '@lixiangzhong/dsh-suggestion',
  factory(require) {
    'use strict';

    const React = require('react');
    const { useEffect, useRef, useState, useSyncExternalStore } = React;

    /** 建议接口路径，与 Host 侧 `lib/route.js` 的 SUGGEST_PATH 对齐。 */
    const SUGGEST_PATH = '/dsh-suggestion/suggest';
    /** 前端留痕接口；Host 只在配置了 tracePath 时才真正落盘。 */
    const TRACE_PATH = '/dsh-suggestion/trace';
    /** 诊断前缀；插件不向宿主抛异常，只打日志。 */
    const LOG_PREFIX = '[dsh-suggestion]';
    /** 客户端构建标记，写进留痕便于确认某个窗口跑的是哪一版。 */
    const CLIENT_BUILD = '2026-11-12T14:40Z';
    /** 单次请求超时：超过就当作没有建议，保持宿主默认占位。 */
    const REQUEST_TIMEOUT_MS = 20_000;
    /** 同一会话两次请求的最小间隔，挡掉重复挂载带来的抖动。 */
    const REQUEST_COOLDOWN_MS = 800;
    /** 探测宿主 placeholder 节点的等待时间，超时进入降级形态。 */
    const PLACEHOLDER_PROBE_MS = 600;
    /** 宿主 placeholder 节点的稳定 data 钩子。 */
    const PLACEHOLDER_SELECTOR = '[data-composer-placeholder]';
    /** 输入卡片容器的 data 钩子：Tab 与鼠标都靠它判断「在输入框里」。 */
    const CARD_ATTR = 'data-composer-card';
    /** 会话根节点的 data 钩子：把 DOM 映射回 sessionId。 */
    const SESSION_ATTR = 'data-conversation-session';
    /** 本插件自己的语言命名空间。 */
    const LOCALE_NS = 'dshSuggestion';
    /** 宿主「默认占位文案」所在的命名空间与键。 */
    const HOST_LOCALE_NS = 'conversation';
    const HOST_DEFAULT_KEYS = ['placeholder.default', 'placeholder.hero'];

    /** 本插件字典：只放降级建议条需要的界面文案。 */
    const DICTS = {
      zh: {
        'dock.accept': '采纳',
        'dock.hint': 'Tab 填入',
      },
      en: {
        'dock.accept': 'Use',
        'dock.hint': 'Tab to fill',
      },
    };

    // ---- 模块级状态：跨 slot 重挂载保留，按会话 id 分桶 ----

    /** sessionId → { text, at }：当前可展示的建议。 */
    const suggestions = new Map();
    /** sessionId → boolean：输入框此刻是否适合显示建议（草稿为空、处于普通输入态）。 */
    const visible = new Map();
    /** sessionId → (text) => boolean：把建议填进草稿的接受器。 */
    const acceptors = new Map();
    /** sessionId → number：上次请求时间，用于冷却。 */
    const lastRequestAt = new Map();
    /** 建议变更的订阅者。 */
    const listeners = new Set();
    /** 宿主是否提供了 placeholder 节点；undefined 表示还在探测。 */
    let hostHook = undefined;
    /** 当前 Client context；apply 时写入，桥接组件与控制器共用。 */
    const ctxRef = { current: undefined };
    /** placeholder 接管器的重绘入口；状态变化后主动刷一次，不等 DOM 变更。 */
    const repaintRef = { current: () => {} };

    /**
     * 上报一条前端留痕。诊断能力不能影响主流程：任何失败都静默丢弃。
     * @param {string} event - 事件名。
     * @param {object} [extra] - 附加字段。
     * @returns {void}
     */
    function reportTrace(event, extra = {}) {
      if (typeof fetch !== 'function') return;
      try {
        void fetch(TRACE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, ...extra }),
          cache: 'no-store',
          keepalive: true,
        }).catch(() => {});
      } catch {
        // 留痕失败不影响功能。
      }
    }

    /**
     * 通知所有订阅者重新读取建议。
     * @returns {void}
     */
    function notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.warn(LOG_PREFIX, 'listener failed', error);
        }
      }
    }

    /**
     * 订阅建议变更（useSyncExternalStore 合同）。
     * @param {() => void} listener - 订阅者。
     * @returns {() => void} 退订函数。
     */
    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    /**
     * 读取某个会话当前的建文本文。
     * @param {string} sessionId - 会话 id。
     * @returns {string | null} 建议文案。
     */
    function suggestionOf(sessionId) {
      return suggestions.get(sessionId)?.text ?? null;
    }

    /**
     * 写入/清空某个会话的建议。
     * @param {string} sessionId - 会话 id。
     * @param {string | null} text - 建议文案；null 表示清空。
     * @returns {void}
     */
    function setSuggestion(sessionId, text) {
      if (typeof text === 'string' && text !== '') suggestions.set(sessionId, { text, at: Date.now() });
      else suggestions.delete(sessionId);
      notify();
      // 建议本身变化不会引起宿主重渲染，主动刷一次占位文字。
      repaintRef.current();
    }

    /**
     * 当前界面语言标签。
     * @param {object} ctx - Client context。
     * @returns {string} 如 zh / en。
     */
    function activeLocale(ctx) {
      try {
        const snapshot = ctx.locale.getSnapshot();
        if (typeof snapshot?.active === 'string' && snapshot.active !== '') return snapshot.active;
      } catch {
        // 语言服务不可用时按英文处理。
      }
      return 'en';
    }

    /**
     * 翻译本插件自己的界面文案。
     * @param {object} ctx - Client context。
     * @param {string} key - 字典键。
     * @returns {string} 文案；字典缺失时回落英文键值。
     */
    function translate(ctx, key) {
      try {
        const bound = ctx.locale.bind(LOCALE_NS);
        const text = bound(key);
        if (typeof text === 'string' && text !== '' && text !== key) return text;
      } catch {
        // 字典尚未注册时走下面的英语兜底。
      }
      return DICTS.en[key] ?? key;
    }

    /**
     * 向 Host 拉一次建议。
     * @param {string} sessionId - 会话 id。
     * @param {object} ctx - Client context。
     * @returns {Promise<void>}
     */
    async function requestSuggestion(sessionId, ctx) {
      const now = Date.now();
      if (now - (lastRequestAt.get(sessionId) ?? 0) < REQUEST_COOLDOWN_MS) return;
      lastRequestAt.set(sessionId, now);
      reportTrace('request.start', { sessionId });

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error('suggestion request timed out'));
      }, REQUEST_TIMEOUT_MS);
      try {
        const query = `session=${encodeURIComponent(sessionId)}&locale=${encodeURIComponent(activeLocale(ctx))}`;
        const response = await fetch(`${SUGGEST_PATH}?${query}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          reportTrace('request.rejected', { sessionId, status: response.status });
          setSuggestion(sessionId, null);
          return;
        }
        const payload = await response.json().catch(() => undefined);
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        reportTrace('request.done', { sessionId, status: response.status, text });
        setSuggestion(sessionId, text === '' ? null : text);
      } catch (error) {
        // 超时、断连、页面切走都只是「这次没有建议」，不清空已有文案以外的东西。
        reportTrace('request.failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error?.name !== 'AbortError') console.warn(LOG_PREFIX, 'suggestion request failed', error);
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 从任意节点向上解析会话 id。
     * @param {Element | null} node - 起点节点。
     * @returns {string | undefined} 会话 id。
     */
    function sessionOf(node) {
      const host = node?.closest?.(`[${SESSION_ATTR}]`);
      const value = host?.getAttribute?.(SESSION_ATTR);
      return typeof value === 'string' && value !== '' && value !== 'undefined' ? value : undefined;
    }

    /**
     * 创建 placeholder 接管器：观察宿主重渲染并重写占位文本。
     * @param {object} ctx - Client context。
     * @returns {{start: () => () => void}} 启动/停止门面。
     */
    function createPlaceholderController(ctx) {
      /** node → 我们写进去的文本。 */
      const applied = new WeakMap();
      /** node → 已上报过的结论签名，避免同一结论刷屏。 */
      const reported = new WeakMap();
      /** 当前语言的宿主默认占位文案集合；null 表示词典不可用。 */
      let defaults = null;
      /** 缓存 defaults 时使用的语言，切换语言后重算。 */
      let defaultsLocale = undefined;
      let observer = undefined;
      let scheduled = false;

      /**
       * 同一个节点同一结论只上报一次。
       * @param {Element} node - placeholder 节点。
       * @param {string} signature - 结论签名。
       * @param {string} event - 事件名。
       * @param {object} [extra] - 附加字段。
       * @returns {void}
       */
      function note(node, signature, event, extra = {}) {
        if (reported.get(node) === signature) return;
        reported.set(node, signature);
        reportTrace(event, extra);
      }

      /**
       * 读取宿主的「默认占位文案」集合。
       * @returns {Set<string> | null} 文案集合；语言命名空间不可用时返回 null。
       */
      function hostDefaults() {
        const locale = activeLocale(ctx);
        if (defaults !== null && defaultsLocale === locale) return defaults;
        try {
          const translate = ctx.locale.bind(HOST_LOCALE_NS);
          const values = HOST_DEFAULT_KEYS.map(key => translate(key));
          const usable = values.filter(value => typeof value === 'string' && value !== '' && !HOST_DEFAULT_KEYS.includes(value));
          defaults = usable.length > 0 ? new Set(usable) : null;
        } catch {
          defaults = null;
        }
        defaultsLocale = locale;
        return defaults;
      }

      /**
       * 判断一段文本是否宿主的默认占位文案。
       * @param {string} text - 节点当前文本。
       * @returns {boolean} 是默认文案返回 true。
       */
      function isHostDefault(text) {
        const known = hostDefaults();
        if (known === null) return true;
        return known.has(text);
      }

      /**
       * 恢复某个节点：只在我们仍持有该文本时动手，避免覆盖宿主的其它状态。
       * @param {Element} node - placeholder 节点。
       * @returns {void}
       */
      function restore(node) {
        const ours = applied.get(node);
        if (ours === undefined) return;
        applied.delete(node);
        const known = hostDefaults();
        if (known !== null && node.textContent === ours) {
          const [fallback] = known;
          if (typeof fallback === 'string') node.textContent = fallback;
        }
      }

      /**
       * 按当前状态重绘一个节点。
       * @param {Element} node - placeholder 节点。
       * @returns {void}
       */
      function paint(node) {
        const sessionId = sessionOf(node);
        const text = sessionId === undefined ? null : suggestionOf(sessionId);
        // 刚按下发送的这一帧：草稿已清空、占位节点刚重建，但上一轮的建议还没来得及
        // 被清掉（React 的清理 effect 在绘制之后）。看宿主的 data-phase 直接让位，
        // 避免旧建议闪一下。
        const phase = node.closest?.(`[${CARD_ATTR}]`)?.querySelector?.('[data-phase]')?.getAttribute('data-phase');
        const shouldShow = sessionId !== undefined
          && visible.get(sessionId) === true
          && (phase === null || phase === undefined || phase === 'plain');
        if (text === null || !shouldShow) {
          const held = applied.get(node) !== undefined;
          restore(node);
          if (held) note(node, 'restored', 'paint.restore', { sessionId, hasText: text !== null, shouldShow });
          return;
        }
        const ours = applied.get(node);
        const host = node.textContent ?? '';
        if (host === text) {
          applied.set(node, text);
          note(node, `applied:${text}`, 'paint.applied', { sessionId, text });
          return;
        }
        if (ours !== undefined && host === ours) {
          // 宿主没动过，只是建议换了一句。
          node.textContent = text;
          applied.set(node, text);
          note(node, `applied:${text}`, 'paint.applied', { sessionId, text });
          return;
        }
        if (!isHostDefault(host)) {
          // 宿主在显示自己的状态文案（计划模式、插话提示、不可用…）：立即让位。
          applied.delete(node);
          note(node, `skip:${host}`, 'paint.skipped', {
            sessionId,
            reason: defaults === null ? 'no-dictionary' : 'host-state',
            hostText: host.slice(0, 80),
          });
          return;
        }
        node.textContent = text;
        applied.set(node, text);
      }

      /**
       * 全量扫描一次文档里的 placeholder 节点。
       * @returns {void}
       */
      function scan() {
        scheduled = false;
        const nodes = document.querySelectorAll(PLACEHOLDER_SELECTOR);
        const available = nodes.length > 0;
        if (hostHook !== available) {
          hostHook = available;
          notify();
          reportTrace('hook.changed', {
            available,
            nodes: nodes.length,
            defaultsKnown: hostDefaults() !== null,
          });
        }
        for (const node of nodes) paint(node);
      }

      /**
       * 合并一帧内的多次 DOM 变更。
       * @returns {void}
       */
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        if (typeof queueMicrotask === 'function') queueMicrotask(scan);
        else setTimeout(scan, 0);
      }

      return {
        start() {
          scan();
          observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          repaintRef.current = schedule;
          return () => {
            observer?.disconnect();
            observer = undefined;
            repaintRef.current = () => {};
          };
        },
      };
    }

    /**
     * Tab 接受器：只在「输入框聚焦 + 草稿为空 + 建议在显示」时接管 Tab。
     * @param {object} ctx - Client context。
     * @returns {() => void} 卸载函数。
     */
    function installTabAccept(ctx) {
      /**
       * 捕获阶段的 Tab 处理：宿主命令菜单自己处理 Tab，因此这里只在菜单不可能
       * 展开时（草稿为空）接管，其余情况原样放行。
       * @param {KeyboardEvent} event - 键盘事件。
       * @returns {void}
       */
      function onKeyDown(event) {
        if (event.key !== 'Tab') return;
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.defaultPrevented) return;
        const target = event.target;
        const card = target?.closest?.(`[${CARD_ATTR}]`);
        if (card === null || card === undefined) return;
        const sessionId = sessionOf(card);
        if (sessionId === undefined) return;
        if (visible.get(sessionId) !== true) return;
        const text = suggestionOf(sessionId);
        if (text === null) return;
        const accept = acceptors.get(sessionId);
        if (accept === undefined) return;
        if (!accept(text)) return;
        event.preventDefault();
        event.stopPropagation();
      }

      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    }

    /**
     * 降级建议条：宿主没有 placeholder 钩子时，把建议显示成一行可点击文本。
     * @param {{text: string, label: string, hint: string, onAccept: () => void}} props - 渲染输入。
     * @returns {object | null} React 元素。
     */
    function SuggestionDock(props) {
      const style = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        margin: '2px auto 0',
        maxWidth: '100%',
        padding: '0 6px',
        color: 'var(--dsw-alias-label-caption)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        background: 'none',
        border: '0',
        textAlign: 'left',
        pointerEvents: 'auto',
      };
      const hintStyle = {
        flex: '0 0 auto',
        padding: '0 4px',
        border: '1px solid var(--dsw-alias-border-secondary, currentColor)',
        borderRadius: '4px',
        fontFamily: 'inherit',
        fontSize: '11px',
        opacity: '0.8',
      };
      return React.createElement(
        'button',
        {
          type: 'button',
          style,
          title: `${props.label} · ${props.hint}`,
          onClick: props.onAccept,
        },
        React.createElement('span', {
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, props.text),
        React.createElement('span', { style: hintStyle }, props.hint),
      );
    }

    /**
     * 看不见的桥接组件：观察会话状态、注册接受器、必要时渲染降级建议条。
     * @param {object} props - slot props（session 作用域标准 props）。
     * @returns {object | null} React 元素或 null。
     */
    function SuggestionBridge(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const useInput = props.useInput;
      const useSession = props.useSession;
      const input = typeof useInput === 'function' ? useInput(state => state) : undefined;
      const session = typeof useSession === 'function' ? useSession(state => state) : undefined;
      const text = useSyncExternalStore(
        subscribe,
        () => suggestionOf(sessionId),
        () => null,
      );
      const [fallbackMode, setFallbackMode] = useState(hostHook === false);

      const draftEmpty = (input?.draft ?? '') === '';
      const phasePlain = (input?.phase ?? 'plain') === 'plain';
      const queueEmpty = (input?.queue?.length ?? 0) === 0;
      const canShow = draftEmpty && phasePlain && queueEmpty;

      // 可显示状态与接受器：每次渲染刷新，保证 Tab 用到的是最新草稿状态。
      const canShowRef = useRef(canShow);
      canShowRef.current = canShow;
      useEffect(() => {
        visible.set(sessionId, canShow);
        acceptors.set(sessionId, (value) => {
          if (!canShowRef.current) return false;
          try {
            inputActions?.setDraft?.(value);
            inputActions?.focus?.();
            reportTrace('accept.done', { sessionId, text: value });
            return true;
          } catch (error) {
            console.warn(LOG_PREFIX, 'failed to fill the draft', error);
            reportTrace('accept.failed', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        });
        repaintRef.current();
        return () => {
          visible.delete(sessionId);
          acceptors.delete(sessionId);
        };
      }, [sessionId, canShow, inputActions]);

      // running: true → false 就是「一轮结束」，此时且仅此时请求一次建议；
      // 新一轮开始时先撤掉上一轮的建议，避免占位文字过时。
      const running = session?.running === true;
      const runningRef = useRef({ sessionId, running });      useEffect(() => {
        const previous = runningRef.current;
        runningRef.current = { sessionId, running };
        // 切换会话时不把上一个会话的运行状态当作本会话的轮次结束。
        if (previous.sessionId !== sessionId) {
          reportTrace('bridge.session', { sessionId, from: previous.sessionId });
          return;
        }
        if (running) {
          setSuggestion(sessionId, null);
          return;
        }
        if (!previous.running) return;
        reportTrace('turn.ended', {
          sessionId,
          canShow: canShowRef.current,
          draftEmpty,
          phase: input?.phase ?? 'plain',
          queued: input?.queue?.length ?? 0,
        });
        if (!canShowRef.current) return;
        void requestSuggestion(sessionId, ctxRef.current);
      }, [running, sessionId]);

      // 探测宿主 placeholder 钩子：缺失时切到降级建议条。
      useEffect(() => {
        reportTrace('bridge.mount', {
          sessionId,
          hasInputHook: typeof useInput === 'function',
          hasSessionHook: typeof useSession === 'function',
          hasActions: typeof inputActions?.setDraft === 'function',
          draftEmpty,
          running,
          updatedAt: typeof session?.updatedAt === 'number' ? session.updatedAt : null,
        });
        return undefined;
      }, [sessionId]);

      // 重挂载（刷新窗口、切换回来）时补一次请求：Host 按轮次缓存，所以来回切换
      // 不会重复花钱，而且会自己拒绝「已经过了很久」的旧轮次。
      const mountHandledRef = useRef(new Set());
      useEffect(() => {
        if (running) return;
        if (!canShowRef.current) return;
        if (mountHandledRef.current.has(sessionId)) return;
        mountHandledRef.current.add(sessionId);
        reportTrace('mount.request', { sessionId });
        void requestSuggestion(sessionId, ctxRef.current);
      }, [sessionId, running]);

      useEffect(() => {
        if (hostHook !== undefined) {
          setFallbackMode(hostHook === false);
          return undefined;
        }
        const timer = setTimeout(() => {
          setFallbackMode(document.querySelector(PLACEHOLDER_SELECTOR) === null);
        }, PLACEHOLDER_PROBE_MS);
        return () => clearTimeout(timer);
      }, [text]);

      if (!fallbackMode || text === null || !canShow) return null;
      return React.createElement(SuggestionDock, {
        text,
        label: translate(ctxRef.current, 'dock.accept'),
        hint: translate(ctxRef.current, 'dock.hint'),
        onAccept: () => {
          const accept = acceptors.get(sessionId);
          if (accept !== undefined) accept(text);
        },
      });
    }

    return {
      name: 'dsh-suggestion',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctxRef.current = ctx;
        reportTrace('client.start', { locale: activeLocale(ctx), build: CLIENT_BUILD });
        try {
          ctx.effect(() => {
            const disposers = [
              ctx.locale.register(LOCALE_NS, 'zh', DICTS.zh),
              ctx.locale.register(LOCALE_NS, 'en', DICTS.en),
            ];
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose?.();
                } catch {
                  // 字典已被宿主回收时忽略。
                }
              }
            };
          }, 'dsh-suggestion: locales');

          const controller = createPlaceholderController(ctx);
          ctx.effect(() => controller.start(), 'dsh-suggestion: placeholder');
          ctx.effect(() => installTabAccept(ctx), 'dsh-suggestion: tab accept');

          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-suggestion', order: 90 },
            SuggestionBridge,
          ));

          // 诊断入口：只在插件自己的状态上读写，方便在浏览器控制台核对「请求 → 占位 →
          // Tab 接受」这条链路，不碰宿主内部对象。
          globalThis.__DSH_SUGGESTION__ = {
            get: sessionId => suggestionOf(sessionId),
            set: (sessionId, text) => setSuggestion(sessionId, text),
            request: sessionId => requestSuggestion(sessionId, ctx),
            repaint: () => repaintRef.current(),
          };
        } catch (error) {
          console.warn(LOG_PREFIX, 'failed to start', error);
        }
      },
    };
  },
});
