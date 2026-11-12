/**
 * 插件配置归一化。
 *
 * cordis patch 里的 `config` 是不可信外部输入（YAML 字符串、设置表单写回、环境变量），
 * 这里一律容错解析：非法值静默回落默认值，绝不把配置问题抛成插件加载失败。
 */

/** 全部配置项的默认值。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关：关掉后路由直接返回空建议，客户端保持宿主默认占位。 */
  enabled: true,
  /** 辅助调用的 provider；空串表示跟随该会话最近一次请求的路由。 */
  provider: '',
  /** 辅助调用的 model；与 provider 必须同时给出才生效。 */
  model: '',
  /** 单次生成（含摘要调用）的超时时间。 */
  timeoutMs: 8000,
  /** 建议文案的字符上限（按码点计）。 */
  maxChars: 100,
  /** 是否为早期对话额外做一次摘要（关掉可省一次调用，但长会话后建议质量下降）。 */
  summaryEnabled: true,
  /** 摘要自身的字符上限。 */
  summaryMaxChars: 800,
  /** 诊断留痕的 JSONL 路径；空串表示关闭。 */
  tracePath: '',
});

/** 超时的合法区间：低于 1 秒基本必然失败，高于 60 秒会卡住输入框体验。 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
/** 建议长度的合法区间：太短没有信息量，太长在单行占位里一定被省略号截断。 */
const MIN_CHARS = 12;
const MAX_CHARS = 200;
/** 摘要长度的合法区间。 */
const MIN_SUMMARY_CHARS = 200;
const MAX_SUMMARY_CHARS = 4_000;

/**
 * 取布尔配置。
 * @param {unknown} value - 原始值。
 * @param {boolean} fallback - 无法解析时的默认值。
 * @returns {boolean} 解析结果。
 */
function pickBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * 取数字配置并夹到合法区间；非有限数字回落默认值。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 无法解析时的默认值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @returns {number} 解析结果。
 */
function pickNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * 取字符串配置；空白串按缺省处理。
 * @param {unknown} value - 原始值。
 * @param {string} fallback - 无法解析时的默认值。
 * @returns {string} 去首尾空白后的结果。
 */
function pickString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * 归一化一行 patch config。
 * @param {unknown} raw - Loader 传入的原始配置。
 * @returns {typeof DEFAULT_CONFIG} 完整可用的配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  return Object.freeze({
    enabled: pickBoolean(source.enabled, DEFAULT_CONFIG.enabled),
    provider: pickString(source.provider, DEFAULT_CONFIG.provider),
    model: pickString(source.model, DEFAULT_CONFIG.model),
    timeoutMs: pickNumber(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxChars: pickNumber(source.maxChars, DEFAULT_CONFIG.maxChars, MIN_CHARS, MAX_CHARS),
    summaryEnabled: pickBoolean(source.summaryEnabled, DEFAULT_CONFIG.summaryEnabled),
    summaryMaxChars: pickNumber(
      source.summaryMaxChars,
      DEFAULT_CONFIG.summaryMaxChars,
      MIN_SUMMARY_CHARS,
      MAX_SUMMARY_CHARS,
    ),
    tracePath: typeof source.tracePath === 'string' ? source.tracePath.trim() : DEFAULT_CONFIG.tracePath,
  });
}

/**
 * 解析本次生成要用的模型路由：显式配置优先，其次跟随会话最近一次请求。
 * provider 与 model 必须同时给出，只配一半视为未配置。
 * @param {typeof DEFAULT_CONFIG} config - 归一化后的配置。
 * @param {unknown} sessionRoute - 会话日志里的 `request/header` 路由（`{provider, model}`）。
 * @returns {{provider: string, model: string} | undefined} 可用路由。
 */
export function resolveModelRoute(config, sessionRoute) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model };
  }
  const provider = sessionRoute === null || typeof sessionRoute !== 'object' ? undefined : sessionRoute.provider;
  const model = sessionRoute === null || typeof sessionRoute !== 'object' ? undefined : sessionRoute.model;
  if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
    return { provider, model };
  }
  return undefined;
}
