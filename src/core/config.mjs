/**
 * 配置层 —— 一份规格，两个出口。
 *
 * 为什么不用「静态 import schemastery」：
 * 那会让 `@deepseek-ai/schemastery` 成为运行时硬依赖。一旦它在目标机器上
 * 解析不到，`import` 直接抛错 → **整个插件加载失败**。
 * 对于一个"装上就该忘掉它"的插件，这个失败模式不能接受。
 *
 * 所以：
 *  - `CONFIG_SPEC` 是唯一真相源，纯 JS，零依赖。
 *  - `resolveConfig()` 自己补默认值、做类型转换和范围钳制 —— 保证行为**一定确定**。
 *  - `buildSchema(z)` 在 schemastery 可用时才调用，额外产出给设置表单用的 schema。
 *    拿不到就没有表单，但**所有选项照样能在 `cordis.patch.yml` 的 `config:` 里写**。
 */

/**
 * @typedef {'boolean'|'number'|'string'} ConfigType
 * @typedef {object} ConfigField
 * @property {string} key
 * @property {ConfigType} type
 * @property {*} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} label
 */

/** @type {ConfigField[]} */
export const CONFIG_SPEC = [
  {
    key: 'dataDir',
    type: 'string',
    default: '',
    label: '档案目录（留空 = ~/.dsh/feiyu-diary）',
  },
  {
    key: 'enabled',
    type: 'boolean',
    default: true,
    label: '总开关',
  },
  {
    key: 'includePersona',
    type: 'boolean',
    default: true,
    label: '把人格内核一起注入（装了别的人设插件就关掉）',
  },
  {
    key: 'budgetTokens',
    type: 'number',
    default: 2000,
    min: 200,
    max: 4000,
    step: 1,
    label: '注入预算（token）',
  },
  {
    key: 'model',
    type: 'string',
    default: '',
    label: '固化用模型（留空 = 跟随当前默认模型）',
  },
  {
    key: 'reasoningEffort',
    type: 'string',
    default: 'off',
    label: '固化的思考档位（off/low/high/max；保持 off）',
  },
  {
    key: 'maxTokens',
    type: 'number',
    default: 900,
    min: 200,
    max: 4000,
    step: 1,
    label: '固化最大输出 token',
  },
  {
    key: 'thirdPartyRedaction',
    type: 'boolean',
    default: true,
    label: '第三方隐私泛化',
  },
  {
    key: 'amountThreshold',
    type: 'number',
    default: 100,
    min: 0,
    step: 1,
    label: '金额泛化门槛（低于此值保留）',
  },
  {
    key: 'minSalience',
    type: 'number',
    default: 0.15,
    min: 0,
    max: 1,
    step: 0.05,
    label: '日记重要度门槛',
  },
  {
    key: 'highSim',
    type: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    label: '必触发的相似度阈值',
  },
  {
    key: 'recentEntries',
    type: 'number',
    default: 8,
    min: 0,
    max: 30,
    step: 1,
    label: '「最近的事」最多列几条（不靠相似度，永远在场）',
  },
  {
    key: 'maxShowPerTurn',
    type: 'number',
    default: 4,
    min: 0,
    max: 12,
    step: 1,
    label: '「突然想起来」最多几条（按相似度召回）',
  },
  {
    key: 'wanderChance',
    type: 'number',
    default: 0.08,
    min: 0,
    max: 0.5,
    step: 0.01,
    label: '走神想起旧事的概率',
  },
  {
    key: 'offPeakHours',
    type: 'string',
    default: '00:30-08:30',
    label: '低峰时段（HH:MM-HH:MM）',
  },
  {
    key: 'deferToOffPeak',
    type: 'boolean',
    default: false,
    label: '把固化推迟到低峰时段',
  },
  {
    key: 'debugLog',
    type: 'boolean',
    default: false,
    label: '开发期调试日志',
  },
];

/** 全部默认值（冻结） */
export const CONFIG_DEFAULTS = Object.freeze(
  Object.fromEntries(CONFIG_SPEC.map((f) => [f.key, f.default])),
);

// ★ 解 cosmokit volatile 引用（DSH 0.2.x 会把 config 值包成引用）。
//   ★ 病：coerce 把引用当普通值 → String(ref) 得 "[object Object]"
//     → path.resolve 相对进程 cwd ⇒ 档案落在 cwd 下的 [object Object] 目录。
//   ★ 判定口径同 @deepseek-ai/cosmokit isVolatile：`write in value`，
//     write = Symbol.for('cosmokit.volatile.write')。用 Symbol.for 探测，不引依赖。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 解开 cosmokit 的 volatile 引用；不是引用就原样返回。 */
function unref(value) {
  if (typeof value !== 'object' || value === null) return value;
  if (!(VOLATILE_WRITE in value) || typeof value.get !== 'function') return value;
  try {
    return value.get();
  } catch {
    return undefined;
  }
}

function coerce(field, value) {
  value = unref(value);
  if (value === undefined || value === null) return field.default;

  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return field.default;
  }

  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return field.default;
    let out = n;
    if (Number.isFinite(field.min)) out = Math.max(field.min, out);
    if (Number.isFinite(field.max)) out = Math.min(field.max, out);
    return out;
  }

  return typeof value === 'string' ? value : String(value);
}

/**
 * 把原始配置（来自 `cordis.patch.yml` 的 `config:`）规整成一定合法的配置对象。
 * **永不抛错** —— 坏配置退回默认值。
 *
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
export function resolveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const field of CONFIG_SPEC) out[field.key] = coerce(field, src[field.key]);
  return out;
}

/**
 * 用 schemastery 构造 Config。**只在能 import 到 schemastery 时调用。**
 *
 * 注意 `volatile` 是**链式方法**（`z.string().volatile()`），
 * 而且必须落在固定对象路径上 —— 不能嵌在数组、union、dict 里。
 *
 * @param {any} z schemastery 默认导出
 * @returns {any}
 */
export function buildSchema(z) {
  /** @type {Record<string, any>} */
  const shape = {};
  for (const f of CONFIG_SPEC) {
    let s;
    if (f.type === 'boolean') s = z.boolean();
    else if (f.type === 'number') {
      s = z.number();
      if (Number.isFinite(f.step)) s = s.step(f.step);
      if (Number.isFinite(f.min)) s = s.min(f.min);
      if (Number.isFinite(f.max)) s = s.max(f.max);
    } else s = z.string();
    shape[f.key] = s.default(f.default).volatile();
  }
  return z.object(shape);
}

/**
 * 判断"现在是不是低峰时段"。配置成 `HH:MM-HH:MM`；跨午夜也支持。
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {boolean} 配置不合法时返回 true（即"随时可以跑"，不让坏配置卡死功能）
 */
export function isOffPeak(spec, now = new Date()) {
  if (typeof spec !== 'string') return true;
  const m = spec.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (m === null) return true;

  const [, sh, sm, eh, em] = m;
  const start = Number(sh) * 60 + Number(sm);
  const end = Number(eh) * 60 + Number(em);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;

  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * 距离下一个低峰时段开始还有多少毫秒。已经在低峰里就返回 0。
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {number}
 */
export function msUntilOffPeak(spec, now = new Date()) {
  if (isOffPeak(spec, now)) return 0;
  const m = typeof spec === 'string' ? spec.match(/^\s*(\d{1,2}):(\d{2})/) : null;
  if (m === null) return 0;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const cur = now.getHours() * 60 + now.getMinutes();
  let delta = start - cur;
  if (delta <= 0) delta += 24 * 60;
  return delta * 60000;
}
