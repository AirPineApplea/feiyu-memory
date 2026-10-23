/**
 * 隐私层：落盘前的最后一道闸。
 *
 * 分三类，处理方式完全不同：
 *
 *  1. format —— 强确定性的可识别格式（手机号/证件/卡号/邮箱）
 *     只要开了第三方泛化就一律处理。误伤概率极低。
 *
 *  2. secret —— 密钥。**硬阻断**，永远处理，没有开关。
 *     命中即替换，绝不入档、绝不进日志。
 *
 *  3. name / amount —— 弱信号。**只认高置信标记**。
 *     人名只认称谓（王总/李老师）、小X/老X、"叫X"三种明确写法；
 *     金额只处理超过门槛的数（保住"3 块钱的包子"这种生活细节）。
 *
 * 设计原则：**宁可少泛化，不要过度泛化**。
 * 糊成一团"某人和某人在某地发生了某事"的日记，既没有隐私价值也没有记忆价值，
 * 用户会直接关掉这个功能 —— 那就等于没有隐私保护。
 */

/** 永远处理：密钥。命中的文本块直接丢弃。 */
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '私钥'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'API Key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'GitHub Token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'GitHub Token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS Key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google Key'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, 'Slack Token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer Token'],
  [
    /\b(?:pass(?:wo?r?d)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)\b\s*(?::|=|\bis\b|是|为)\s*["']?[^\s"',;]{6,}["']?/gi,
    '凭据',
  ],
  // ── 中文键名 ──
  //
  // 审计报告（F2，P2）：上面那条只认英文键名，而这是个中文插件 ——
  // README 承诺"密码……被替换成 [已拦截]"，可是这些写法全都放行：
  //
  //   服务器 root 密码是 Zx9!kq2#Lm7$Pw
  //   WiFi 密码：hunter2pass2026
  //   数据库口令 Hunter2pass
  //   阿里云 AccessKey Secret 是 wJalrXUtn...
  //   my password is Hunter2pass
  //
  // 中文没有 \b 词边界，所以单独一条规则，分隔符接受 : ： = 是 为 is。
  [/(?:密码|口令|密钥|秘钥|验证码)\s*(?::|：|=|是|为|\bis\b)?\s*["']?[^\s"',;，。]{6,}["']?/g, '凭据'],
  // 只写冒号、没有连接词的那种（"密码：xxx" 上面已覆盖，这条兜 Union 场景）
  [/(?:密码|口令|密钥|秘钥)\s*[:：]\s*\S{6,}/g, '凭据'],
  // ── URL 里内嵌的凭据 ──
  //
  // postgres://admin:Hunter2pass@db.internal:5432/app
  //
  // 原来这条"碰巧"被邮箱规则吃掉了（Hunter2pass@db.internal 像个邮箱），
  // 换个 scheme 或者密码里没 @ 就漏。单独成规则才稳。
  [/\/\/[^\/\s:@]+:[^@\s/]{4,}@/g, '凭据'],
  // ── 长数字 ──
  //
  // 社区报告（2026-10-24）：一串 13 位数字 `1145141919810` 原样进了
  // relationship.json 的 evidence 字段。手机号规则只认 11 位大陆号，
  // 11 位以上的一律放行。
  //
  // **门槛是 12 位，不是 11** —— 11 位是手机号，那个由上面 `RULES` 里的手机号
  // 而且用户明确表示过"露着吧"。11 位以上基本只有电话号码和身份证号。
  [/\b\d{12,}\b/g, '长数字'],
];

const SECRET_PLACEHOLDER = '[已拦截]';

/**
 * @typedef {'format'|'name'|'amount'} RuleGroup
 * @typedef {object} Rule
 * @property {RegExp} re
 * @property {string | ((...m: string[]) => string)} replace
 * @property {string} label
 * @property {RuleGroup} group
 */

/** @type {Rule[]} */
const RULES = [
  { group: 'format', label: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replace: '[手机号]' },
  { group: 'format', label: '证件号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g, replace: '[证件号]' },
  { group: 'format', label: '卡号', re: /(?<!\d)\d{16,19}(?!\d)/g, replace: '[卡号]' },
  {
    group: 'format',
    label: '邮箱',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: '[邮箱]',
  },

  // 称谓式人名：姓氏表 + 称谓。高置信，误伤极小。
  {
    group: 'name',
    label: '称谓式人名',
    re: /[\u5f20\u738b\u674e\u8d75\u5218\u9648\u6768\u9ec4\u5468\u5434\u5f90\u5b59\u9a6c\u6731\u80e1\u6797\u90ed\u4f55\u9ad8\u7f57\u90d1\u6881\u8c22\u5b8b\u5510\u8bb8\u97e9\u51af\u9093\u66f9\u5f6d\u66fe\u8096\u7530\u8463\u6f58\u8881\u8521\u848b\u4f59\u4e8e\u675c\u53f6\u7a0b\u82cf\u9b4f\u5415\u4e01\u4efb\u6c88\u59da\u5362\u59dc\u5d14\u949f\u8c2d\u9646\u6c6a\u8303\u91d1\u77f3\u5ed6\u8d3e\u590f\u97e6\u4ed8\u65b9\u767d\u90b9\u5b5f\u718a\u79e6\u90b1\u6c5f\u5c39\u859b\u95eb\u6bb5\u96f7\u4faf\u9f99\u53f2\u9676\u9ece\u8d3a\u987e\u6bdb\u90dd\u9f9a\u90b5\u4e07\u94b1\u4e25\u8983\u6b66\u6234\u83ab\u5b54\u5411\u6c64][\u603b\u8001\u5e08\u533b\u751f\u7ecf\u7406\u4e3b\u4efb\u54e5\u59d0\u53d4\u59e8\u5de5]/g,
    replace: '[某人]',
  },
  // 小X / 老X
  {
    group: 'name',
    label: '小X/老X',
    re: /[\u5c0f\u8001][\u5f20\u738b\u674e\u8d75\u5218\u9648\u6768\u9ec4\u5468\u5434\u5f90\u5b59\u9a6c\u6731\u80e1\u6797\u90ed\u4f55\u9ad8\u7f57\u90d1\u6881\u8c22\u5b8b\u5510\u8bb8\u97e9\u51af\u9093\u66f9]/g,
    replace: '[某人]',
  },
  // 明确引入的名字："叫X" / "名叫X" / "名字是X"
  {
    group: 'name',
    label: '明确指名的名字',
    re: /(叫|名叫|名字是)([\u4e00-\u9fa5]{2,4})(?=[\s\uff0c\u3002\uff01\uff1f,]|$)/g,
    replace: (_m, lead) => `${lead}[某人]`,
  },
];

/** 金额门槛：低于此值的金额不动 */
export const DEFAULT_AMOUNT_THRESHOLD = 100;

/** 带单位的金额（元/块/万/亿…），要读数字，所以单独处理 */
const AMOUNT_UNIT_RE = /(?<![\d.])(\d[\d,]*(?:\.\d+)?)\s*(万元|万块|亿元|万|亿|元|块钱|块)(?![\d])/g;
/** 带币种符号的金额 */
const AMOUNT_SYMBOL_RE = /(?:¥|￥|\$)\s?(\d[\d,]*(?:\.\d+)?)/g;

/**
 * @typedef {object} PrivacyOptions
 * @property {boolean} [thirdParty]      总开关：泛化第三方信息（默认 true）
 * @property {boolean} [redactNames]     处理人名的弱信号规则（默认随 thirdParty）
 * @property {boolean} [amounts]         泛化大额金额（默认随 thirdParty）
 * @property {number}  [amountThreshold] 金额门槛（默认 100）
 */

/**
 * 清洗一段文本。幂等 —— 占位符不会再次命中规则，重复调用结果稳定。
 *
 * @param {string} text
 * @param {PrivacyOptions} [options]
 * @returns {{text: string, hits: Array<{kind: string, label: string, count: number}>, blocked: boolean}}
 */
export function scrub(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', hits: [], blocked: false };
  }

  const thirdParty = options.thirdParty !== false;
  const redactNames = options.redactNames !== false && thirdParty;
  const doAmounts = options.amounts !== false && thirdParty;
  const threshold = Number.isFinite(options.amountThreshold)
    ? options.amountThreshold
    : DEFAULT_AMOUNT_THRESHOLD;

  const tally = new Map();
  const bump = (kind, label, n = 1) => {
    const key = `${kind}\u0000${label}`;
    const cur = tally.get(key) ?? { kind, label, count: 0 };
    cur.count += n;
    tally.set(key, cur);
  };

  let out = text;

  // 1) 密钥先做，且无条件做。后面任何一步出错，密钥都已经没了。
  let blocked = false;
  for (const [re, label] of SECRET_RULES) {
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, () => {
      blocked = true;
      bump('secret', label);
      return SECRET_PLACEHOLDER;
    });
  }

  // 2) 格式类 / 人名类
  if (thirdParty) {
    for (const rule of RULES) {
      if (rule.group === 'name' && !redactNames) continue;
      out = out.replace(rule.re, (...args) => {
        bump('thirdParty', rule.label);
        return typeof rule.replace === 'function' ? rule.replace(...args) : rule.replace;
      });
    }
  }

  // 3) 金额（带门槛）
  if (doAmounts) {
    const overThreshold = (digits) => {
      const v = Number(String(digits).replace(/,/g, ''));
      return Number.isFinite(v) && v >= threshold;
    };
    out = out.replace(AMOUNT_UNIT_RE, (match, digits) => {
      if (!overThreshold(digits)) return match;
      bump('thirdParty', '金额');
      return '一笔钱';
    });
    out = out.replace(AMOUNT_SYMBOL_RE, (match, digits) => {
      if (!overThreshold(digits)) return match;
      bump('thirdParty', '金额');
      return '一笔钱';
    });
  }

  return { text: out, hits: [...tally.values()], blocked };
}

/**
 * 批量清洗，合并命中统计。
 * @param {string[]} texts
 * @param {PrivacyOptions} [options]
 */
export function scrubAll(texts, options = {}) {
  const merged = new Map();
  let blocked = false;
  const out = texts.map((t) => {
    const r = scrub(t, options);
    blocked ||= r.blocked;
    for (const h of r.hits) {
      const key = `${h.kind}\u0000${h.label}`;
      const cur = merged.get(key) ?? { kind: h.kind, label: h.label, count: 0 };
      cur.count += h.count;
      merged.set(key, cur);
    }
    return r.text;
  });
  return { texts: out, hits: [...merged.values()], blocked };
}

/**
 * 给用户看的一句提示。刻意短，不弹窗、不说教 —— 像鱼，不像系统。
 * @param {Array<{kind: string, label: string, count: number}>} hits
 * @returns {string} 无命中时返回空串
 */
export function noticeFor(hits) {
  if (!hits || hits.length === 0) return '';
  const sum = (kind) =>
    hits.filter((h) => (kind === 'secret' ? h.kind === 'secret' : h.kind !== 'secret'))
      .reduce((s, h) => s + h.count, 0);
  const parts = [];
  const secrets = sum('secret');
  const others = sum('other');
  if (secrets > 0) parts.push(`拦下 ${secrets} 处密钥`);
  if (others > 0) parts.push(`模糊了 ${others} 处别人家的信息`);
  return parts.length > 0 ? parts.join('，') + '。' : '';
}

/**
 * 预设：给"我就想让它记住我女朋友名字"的用户。
 * 注意密钥与格式类仍然生效 —— 那两类没有关闭的理由。
 */
export const PRESET_REMEMBER_NAMES = Object.freeze({
  thirdParty: true,
  redactNames: false,
  amounts: false,
});
