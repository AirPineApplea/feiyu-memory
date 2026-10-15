/**
 * **绝不该出现在公开仓库里的东西** —— 名字匹配表。
 *
 * 抽成独立模块是为了**能被测试**。检查逻辑待在 `doctor.mjs` 里的话，
 * 想测它就得整个脚本跑起来，于是没人会写那条测试 ——
 * 而**一个从没红过的检查等于没有检查。**
 *
 * 这些模式只匹配**路径**，不读内容：档案的真相源是 `diary/*.jsonl`，
 * 只要它没被 git 追踪，内容就不会出去。
 */
export const ARCHIVE_PATTERNS = [
  { re: /^diary\/.*\.jsonl$/, what: '日记正文（真相源）' },
  { re: /^diary\//, what: '日记目录' },
  { re: /(^|\/)persona\.md$/, what: '人格内核（用户改过的那份）' },
  { re: /(^|\/)relationship\.json$/, what: '关系状态（对用户的印象）' },
  { re: /(^|\/)lexicon\.json$/, what: '词汇表（用户口头禅）' },
  { re: /(^|\/)manifest\.json$/, what: '档案清单' },
  { re: /手记\.md$/, what: '手记（用户手写的话）' },
  { re: /\.dshpack$/i, what: '导出的档案包' },
  { re: /\.bak-tidy-|\.bak-timewords-/, what: '档案备份' },
];

/** 命中返回原因，没命中返回 null */
export function leaksArchive(path) {
  return ARCHIVE_PATTERNS.find((p) => p.re.test(path))?.what ?? null;
}
