/**
 * 时间怎么说人话 —— **"一天"和"时间词"的唯一真相源**。
 *
 * ─────────────────────────────────────────────────────────────
 * 这个模块是一次真实事故的产物，别把它拆回去。
 *
 * 有位读者（另一个 DSH 会话）从**渲染输出那一侧**读到了这么一块：
 *
 *     我们：认识 1 天
 *     最近的事：
 *     - 昨天：他今天正式给了我一条规矩……
 *     - 2 天前：今天他让我介绍自己……
 *
 * 两个毛病，都不是遗忘机制能管的，也不会随时间自愈：
 *
 * 【一】时间词写了两遍
 * 正文里的"今天"（写入时模型写的）+ 前缀里的"昨天："（渲染时加的）
 * → 读出来是"昨天，他今天……"。人不会这么记事儿。
 *
 * 更难看的是根因在我自己：`consolidate.mjs` 的**正例**里明明白白写着
 * `"text":"今天他让我写个东西……"` —— **我在教模型写"今天"。**
 *
 * 【二】"一天"在一个文件里有三种算法
 *   renderRelationship： floor((now − since) / 86400000)   ← 整 24 小时
 *   dayLabel：          round((当日零点差) / 86400000)      ← 自然日
 *   softWhen：          (now − t) / 86400000                ← 带小数
 *
 * 晚上 23:00 认识、次日上午 9:00 看：前一个算出"认识 1 天"，
 * 后一个算出"2 天前"。**这俩永远会打架**，因为一把尺子从小时算、
 * 一把从零点算。
 *
 * 所以这里只干一件事：把"一天"定死成**自然日**（人的直觉 ——
 * 前天见的就是"认识 2 天"），所有需要日期的地方都从这儿取。
 * ─────────────────────────────────────────────────────────────
 */

/** 某时刻所在那一天的零点 */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 两个时刻相差几个**自然日**。
 *
 * 这是全项目唯一允许出现的"一天"算法。想加新的日期逻辑，用这个，
 * 别再写第四种。
 */
export function calendarDaysBetween(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}

/**
 * 「最近的事」用的日期标签：今天 / 昨天 / 3 天前 / 10-05
 *
 * 语气偏准确 —— 这一栏是"我本来就知道的事"，说清楚是哪天很正常。
 */
export function dayLabel(createdAt, now = Date.now()) {
  if (!Number.isFinite(createdAt)) return '';
  const days = calendarDaysBetween(createdAt, now);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const d = new Date(createdAt);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 「突然想起来」用的时间词：前两天 / 前阵子 / 上个月前后 / 很久以前
 *
 * 语气故意含糊 —— 鱼不会说"根据 10 月 12 日的记录"。
 * **但它和 dayLabel 用同一把尺子**（自然日），只是换了个说法。
 * 词汇差异是有意的，算法差异是 bug。
 */
export function softWhen(createdAt, now = Date.now()) {
  if (!Number.isFinite(createdAt)) return '';
  const days = calendarDaysBetween(createdAt, now);
  if (days <= 0) return '';
  if (days <= 3) return '前两天';
  if (days <= 14) return '前阵子';
  if (days <= 60) return '上个月前后';
  return '很久以前';
}

/**
 * 会跟前缀打架的时间词。
 *
 * 判据很具体：**这些词是在断言"相对于写下它的那一刻"是哪天**，
 * 而前缀断言的又是"相对于现在"。两个断言放在一起就自相矛盾。
 *
 * 刻意**不在**这一列的：
 *  - "那天 / 这天" —— 叙述性的，读起来不跟前缀打架
 *  - "生日 / 春节" 之类的名词 —— 那是事件不是时点
 */
const DEICTIC = /(今天|今日|今儿|昨天|昨日|昨儿|前天|前日|今早|今晨|今上午|今晚|昨早|昨晚|刚才|刚刚)/g;

/** 句首的时间词要连它后面的顿挫一起吃掉，免得留下一个光秃秃的逗号 */
const DEICTIC_LEADING =
  /^\s*(?:今天|今日|今儿|昨天|昨日|昨儿|前天|前日|今早|今晨|今上午|今晚|昨早|昨晚|刚才|刚刚)\s*[，,、]*\s*/;

/**
 * 把正文里"相对于写入时刻"的时间词摘掉。
 *
 * 为什么在**渲染时**摘、而不是只靠提示词约束：
 *
 *  1. 老档案里已经烤进去一堆"今天"，不可能为此重写用户的记忆
 *  2. 模型不可能 100% 听话，得有一道兜底
 *  3. 摘掉之后正文变成"他让我写个东西……"，而时间由前缀给 ——
 *     **时间只在一处生成**，这才是那个读者要的东西
 *
 * @param {string} text
 * @returns {string} 摘干净之后仍然像人话的正文
 */
export function stripTimeWords(text) {
  if (typeof text !== 'string') return '';
  const original = text.trim();
  let s = original.replace(DEICTIC_LEADING, '');
  s = s.replace(DEICTIC, '');
  s = s.replace(/^\s*[，,、]+\s*/, '').replace(/\s{2,}/g, ' ').trim();

  // 兜底：摘没了、或者摘得只剩几个字，就别动它。
  // 宁可留一个多余的"今天"，也不要把一条记忆变成空壳。
  if (s.length < 4) return original;
  return s;
}
