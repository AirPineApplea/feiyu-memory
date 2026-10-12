/**
 * 中文分词与关键词提取 —— 零依赖、纯启发式。
 *
 * 中文没有空格，标准做法是分词器（jieba 等）。但引入分词器对插件来说太重，
 * 而且我们**不需要语言学上的正确切分**，只需要"稳定地把文本变成可比较的 token"。
 *
 * 方案：CJK 用 **bigram**（相邻两字一组）。
 *  - 对检索来说 bigram 效果出奇地好（"排序"→ 排序，"代码"→ 代码）
 *  - 不需要词典，不会因为没登录词而漏掉新词
 *  - 缺点是有噪声（"的排"、"序算"），但 IDF 加权会自动把它们压下去
 *
 * 拉丁文按单词切，小写化，长度 ≥2。
 */

/** 高频虚词 bigram —— 直接丢掉，纯噪声 */
const CJK_STOP_BIGRAMS = new Set([
  '的了', '了的', '是的', '这个', '那个', '一个', '什么', '怎么', '可以', '我们',
  '他们', '你们', '就是', '还是', '但是', '因为', '所以', '如果', '而且', '然后',
  '现在', '已经', '自己', '这样', '那样', '不是', '没有', '这些', '那些', '一些',
  '时候', '东西', '事情', '问题', '地方', '的话', '起来', '出来', '过来', '下来',
  '的时', '我的', '你的', '他的', '她的', '它们', '这个', '这些', '有点', '一点',
  '不会', '不能', '可能', '应该', '知道', '觉得', '感觉', '一直', '一下', '一样',
]);

/** 英文停用词 */
const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now',
  'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'use', 'that', 'this', 'with',
  'have', 'from', 'they', 'been', 'were', 'said', 'each', 'which', 'their', 'will',
  'about', 'would', 'there', 'could', 'other', 'than', 'then', 'them', 'these',
  'some', 'what', 'when', 'your', 'into', 'just', 'like', 'only', 'also', 'over',
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[A-Za-z]/;
const DIGIT_RE = /[0-9]/;

/** bigram 是噪声还是信息，取决于它是否含实词 —— 数字/拉丁混在 CJK 里通常有意义，保留 */
function isCjk(ch) {
  return ch !== undefined && CJK_RE.test(ch);
}

/**
 * 把文本切成 token 序列（保留重复，用于计算词频）。
 *
 * @param {string} text
 * @returns {string[]} 归一化后的 token
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = [];
  const chars = [...text.toLowerCase()];

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];

    // CJK 段：连续取，生成 bigram
    if (isCjk(ch)) {
      let j = i;
      while (j < chars.length && (isCjk(chars[j]) || DIGIT_RE.test(chars[j]))) j++;
      const run = chars.slice(i, j);
      if (run.length === 1) {
        tokens.push(run[0]); // 单字也留着（"饭"）
      } else {
        for (let k = 0; k + 1 < run.length; k++) {
          const bg = run[k] + run[k + 1];
          if (!CJK_STOP_BIGRAMS.has(bg)) tokens.push(bg);
        }
      }
      i = j;
      continue;
    }

    // 拉丁词 / 数字
    if (LATIN_RE.test(ch) || DIGIT_RE.test(ch)) {
      let j = i;
      while (j < chars.length && /[a-z0-9_+#.-]/.test(chars[j])) j++;
      const word = chars.slice(i, j).join('').replace(/^[.-]+|[.-]+$/g, '');
      if (word.length >= 2 && !EN_STOPWORDS.has(word)) tokens.push(word);
      i = j;
      continue;
    }

    i++;
  }
  return tokens;
}

/**
 * 提关键词：按词频排序，去重，取前 N 个。用于给日记条目打索引。
 *
 * @param {string} text
 * @param {{max?: number}} [options]
 * @returns {string[]}
 */
export function extractKeywords(text, options = {}) {
  const max = options.max ?? 12;
  const freq = new Map();
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([t]) => t);
}

/**
 * 两段文本的 token 重合度（Jaccard）。用于"同一话题反复出现"这类本地信号。
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1
 */
export function overlap(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
