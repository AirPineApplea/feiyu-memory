/**
 * 极简 token 估算 —— 用于注入预算裁剪，不追求精确，只要求"不会严重低估"。
 *
 * 设计取舍：
 * - 中日韩字符按 1 字符 ≈ 1 token 计（DeepSeek 系分词器对 CJK 大致如此，略保守）
 * - 拉丁字母/数字按 4 字符 ≈ 1 token 计
 * - 标点与空白按 3 字符 ≈ 1 token 计
 * - 结果向上取整，宁可多算不可少算 —— 预算超了会挤掉系统提示，代价比浪费几十 token 大得多
 *
 * 为什么不用真分词器：会引入依赖，且插件每次注入都要算，纯启发式足够。
 */

/** 判断是否 CJK / 全角标点（这些字符通常一个字符一个 token） */
function isWide(code) {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
    (code >= 0xff00 && code <= 0xffef) // 全角形式
  );
}

/**
 * 估算一段文本的 token 数。
 * @param {string} text
 * @returns {number} 非负整数
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (isWide(code)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 3.5);
}

/**
 * 按 token 预算截断文本（在字符边界上截，不切断代理对）。
 * 截断处补一个省略号，并保证结果不超过预算。
 *
 * @param {string} text
 * @param {number} budget 最大 token 数
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncateToTokens(text, budget, ellipsis = '……') {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;

  const ellipsisCost = estimateTokens(ellipsis);
  const room = budget - ellipsisCost;
  if (room <= 0) return truncateToTokens(ellipsis, budget, '');

  // 二分找最长前缀
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join('')) <= room) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + ellipsis;
}
