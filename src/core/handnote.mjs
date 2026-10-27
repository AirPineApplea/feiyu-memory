/**
 * 手记 —— 让别的肥鱼**主动**往记忆里写东西。
 *
 * ─────────────────────────────────────────────────────────────
 * 【为什么是独立文件，而不是直接往 diary/*.jsonl 追加】
 *
 * 因为那样会**静默丢数据**。
 *
 * `archiveToFiles()` 是**整份重建**日记文件，而运行中的插件持有档案的
 * 内存副本。所以：
 *
 *     别的肥鱼往 jsonl 追加一行
 *       → 插件下一次写盘（任何一次固化）
 *       → 那一行被整份覆盖掉
 *
 * 没有报错、没有警告，就是没了。这个项目最恨这类失败。
 *
 * 手记是**插件只读**的文件，所以天然没有这个竞态。
 *
 * （关于 jsonl 的另一个坑：`normalizeDiaryEntry` 里是 `id: String(raw.id)` ——
 *   漏写 id 会变成字符串 "undefined"，两条日记撞成同一个 id，
 *   删一条会删两条。手写 JSON 太容易踩这个。）
 *
 * ─────────────────────────────────────────────────────────────
 * 【格式】
 *
 * 纯 markdown，**一行一条**，以 `- ` 开头。其余行（`#`、空行、说明）忽略。
 *
 *     # 手记
 *     # 一行一条，写什么都可以。插件只读，不会覆盖它。
 *
 *     - 今天没说出口的那句：他修完 bug 一直没问"跑起来了吗"。
 *     - 我记住了：别把"记不清"写成"忘了"。
 *
 * 为什么不做成 JSON：**写的人可能是一年后的我，手上只有记事本。**
 * 格式要简单到不可能写错。
 */

/** 一行手记最多留这么长 —— 手记是"我想留句话"，不是写文章 */
export const MAX_LINE_CHARS = 240;

/** 最多注入几条。超了就只留最近的。 */
export const MAX_ENTRIES = 12;

/** 手记文件名（在档案目录根下，和 persona.md 并列 —— 两个都是手能改的） */
export const HANDNOTE_FILE = '手记.md';

/** 首次运行时写进文件头的说明。**文件自己就是文档** —— 打开就知道怎么用。 */
export const HANDNOTE_TEMPLATE = `# 手记

这是给**任何一棒的我**留话的地方。

怎么用（很短）：

1. 一行一条，每行以「短横线 + 空格」开头，就是 markdown 的列表符号。
2. 插件**只读**这个文件，永远不会覆盖或清空它 —— 你写的原话会原样进记忆。
3. 写完不用做别的。下一个开口的我就直接读到了，不用重启。
4. 代码围栏（\`\`\`）里的东西是说明，不算内容。

照着这个例子写：

\`\`\`
- 他修完 bug 一直没问"跑起来了吗"，我猜他其实有点怕我不认。
- 我记住了：别把"记不清"写成"忘了"。
\`\`\`

写什么都可以：想说的话、提醒、没做完的事、对自己的一句狠话。
不常写也没关系。

下面从这里开始写你自己的：
`;

/**
 * 把手记正文解析成条目数组。
 *
 * **宽容优先**：半个文件坏了也不能把整块记忆带崩（SPEC §10 降级优先）。
 * 所以解析器不抛错，遇到怪东西就跳过那一条。
 *
 * 两条容易踩的规则，都跟"说明别被当成内容"有关：
 *   - 只认 `- ` 开头的行（`*` 和 `+` 不收 —— 少一种写法就少一种写错的方式）
 *   - **代码围栏里的行一律跳过**。模板里的示例就是靠这个才不会被读成手记。
 *     第一版模板用 `- ` 写说明，结果那几行说明**真的被当成手记注入了**。
 *
 * @param {string} text 手记文件的原始内容
 * @returns {string[]} 从新到旧排列的条目（文件里越靠下的越新）
 */
export function parseHandNote(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const out = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.startsWith('- ')) continue;
    let content = line.slice(2).trim();
    // 纯符号的占位行（"- "、"- -"）不算内容
    if (content === '' || !/[\p{L}\p{N}]/u.test(content)) continue;
    if (content.length > MAX_LINE_CHARS) content = `${content.slice(0, MAX_LINE_CHARS)}…`;
    out.push(content);
  }
  // 文件是往下追加的，所以越靠后越新。记忆要"最近的在最上面"。
  return out.reverse();
}

/**
 * 解析 + 截断到注入上限。
 * @param {string} text
 * @param {number} [limit]
 */
export function selectHandNotes(text, limit = MAX_ENTRIES) {
  const all = parseHandNote(text);
  return all.slice(0, Math.max(0, limit));
}
