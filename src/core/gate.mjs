/**
 * 闸门 —— 决定"这一刻值不值得记"。
 *
 * 全部本地、零模型 token。这是整个成本结构的支点：
 * 闸门不开，就一次模型调用都不发。
 *
 * 设计取舍：硬信号（纠正 / 明确要求记住 / 自我披露）**立刻开闸**，
 * 因为漏掉这些的代价远大于多花一次调用。软信号累计打分，过阈值才开。
 * 开闸后有冷却，避免"每轮都记"把日记写成流水账。
 */

/** 硬信号：命中即开闸（除非用户说了"别记"） */
const HARD_SIGNALS = [
  {
    key: 'correction',
    weight: 3,
    label: '用户在纠正我',
    re: /不对|不是这个|不是那|我说的是|你搞错|你理解错|没听懂|重来|理解偏|错了|你弄错/,
  },
  {
    key: 'remember',
    weight: 3,
    label: '用户明确要求记住',
    re: /记住|记一下|记着点|别忘了|以后都|下次要|你要记得/,
  },
  {
    key: 'disclosure',
    weight: 2.5,
    label: '用户自我披露',
    re: /我其实|说实话|我跟你说|我跟你讲|我最近|我家里|我妈|我爸|我老婆|我老公|我女朋友|我男朋友|我对象|我室友|我同事|我老板|我领导|我朋友|我同学/,
  },
];

/** 情绪词 —— 是"信号"不是"审查"，只用来判断这一刻信息密度高 */
const EMOTION_WORDS =
  /生气|烦死|崩溃|无语|离谱|气死|难受|郁闷|恶心|恶心人|服了|受不了|真香|绝了|牛|厉害|太好了|谢谢|感谢/;

/** 强情绪（脏话类）—— 单独一档，权重更高 */
const STRONG_EMOTION =
  /妈的|靠|卧槽|我去|tmd|TMD|操|淦|沙雕|智障|白痴|傻逼|煞笔|废物/;

/** 用户说"别记"—— 强制关闸，且本轮片段永不进候选池 */
export const SUPPRESS_RE = /别记|不要记|别存|不用记|忘掉这个|删除记忆/;

/**
 * @typedef {object} GateOptions
 * @property {number} [threshold]      软信号开闸阈值（默认 2）
 * @property {number} [cooldownTurns]  开闸后冷却轮数（默认 3）
 * @property {number} [minTurns]       会话超过多少轮算"很长"（默认 15）
 * @property {number} [rantLength]     多长算"长篇吐槽"（默认 200 字符）
 * @property {number} [repeatOverlap]  与历史的重合度阈值（默认 0.35）
 */

export const DEFAULT_GATE_OPTIONS = Object.freeze({
  threshold: 2,
  cooldownTurns: 3,
  minTurns: 15,
  rantLength: 200,
  repeatOverlap: 0.35,
});

/**
 * @typedef {object} GateInput
 * @property {string} text              本轮用户消息
 * @property {number} turn              当前轮次（会话内，从 1 开始）
 * @property {string[]} [history]       最近若干轮用户文本（旧→新）
 * @property {number} [sessionTurns]    会话总轮数
 * @property {number} [lastOpenTurn]    上一次开闸的轮次
 * @property {number} [maxOverlap]      与历史的最大重合度（由调用方用 keywords.overlap 算好）
 */

/**
 * 评估是否需要固化。
 *
 * @param {GateInput} input
 * @param {GateOptions} [options]
 * @returns {{open: boolean, score: number, reasons: string[], suppressed: boolean, hard: boolean}}
 */
export function evaluateGate(input, options = {}) {
  const opts = { ...DEFAULT_GATE_OPTIONS, ...options };
  const text = typeof input?.text === 'string' ? input.text : '';
  const turn = Number.isFinite(input?.turn) ? input.turn : 0;
  const sessionTurns = Number.isFinite(input?.sessionTurns) ? input.sessionTurns : turn;

  if (SUPPRESS_RE.test(text)) {
    return { open: false, score: 0, reasons: ['用户说别记'], suppressed: true, hard: false };
  }

  /** @type {string[]} */
  const reasons = [];
  let score = 0;
  let hard = false;

  for (const sig of HARD_SIGNALS) {
    if (sig.re.test(text)) {
      reasons.push(sig.label);
      score += sig.weight;
      hard = true;
    }
  }

  // 情绪强度
  if (STRONG_EMOTION.test(text)) {
    reasons.push('情绪很冲');
    score += 1.5;
  }
  const bangs = (text.match(/[!！]/g) ?? []).length;
  if (bangs >= 3 || EMOTION_WORDS.test(text)) {
    reasons.push('情绪有波动');
    score += 1;
  }

  // 长篇吐槽
  if (text.length >= opts.rantLength) {
    reasons.push('说了一大段');
    score += 1;
  }

  // 老话题又来了
  const maxOverlap = Number.isFinite(input?.maxOverlap) ? input.maxOverlap : 0;
  if (maxOverlap >= opts.repeatOverlap) {
    reasons.push('同一个话题又来了');
    score += 1;
  }

  // 会话很长了，攒了不少东西
  if (sessionTurns >= opts.minTurns) {
    reasons.push('这个会话已经不短了');
    score += 0.5;
  }

  // 冷却：刚记过就缓一缓（硬信号不受冷却限制）
  const lastOpenTurn = Number.isFinite(input?.lastOpenTurn) ? input.lastOpenTurn : -Infinity;
  const inCooldown = turn - lastOpenTurn < opts.cooldownTurns;
  const softOpen = score >= opts.threshold;
  const open = hard || (softOpen && !inCooldown);

  if (!open && inCooldown && softOpen) reasons.push('刚记过，先缓一缓');

  return { open, score, reasons, suppressed: false, hard };
}
