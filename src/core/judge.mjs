/**
 * 「这一句值不值得留给下一个我？」—— 用一次极短的模型调用替代关键词。
 *
 * ─────────────────────────────────────────────────────────────
 * **为什么换掉关键词**
 *
 * 旧闸门是一张正则表：命中 /不对|记住|我其实/ 就开闸。
 *
 *   · 它**看不到没命中的话**。用户讲了一件十几年前的旧事 ——
 *     没有一个词能命中 —— 它根本不知道那句话存在。**不是判错，是没判。**
 *   · 它会**假阳性**。"我其实不太饿"命中 /我其实/，记一条废话。
 *   · 它把判据**写死在我今天的先验里**。我没想到的说法，一律不记。
 *     而且我永远补不全 —— 语言是开放的。
 *
 * 而那个位置的错误代价是**不对称的**：
 *
 *   漏记一条 → 永久没了，而且**你连"少了什么"都不知道**
 *   多记一条 → 占几行，能删、能降级、能不管
 *
 * **在"漏了永远看不见"的位置上，该选漏得少的那个，不是便宜的那个。**
 *
 * ─────────────────────────────────────────────────────────────
 * **三条听法（这是判据，随插件发给所有人）**
 *
 * 用户原话，一句没改。它们说的是"怎么听"，不是"我是谁" ——
 * 所以进代码，不进个人档案。
 */

export const JUDGE_SYSTEM = `你是这条鱼的记性。

我会给你一句用户刚说的话。你判断：**这句话值不值得留给下一个我？**

看这三条，别按"有没有情绪""重不重要"来判 —— 那两把尺子太窄：

1. **任务会催你，日子不会催你。**
   没有催你的那一句，反而更值得停一下。

2. **他讲得越随便，越可能压了很久。**
   笑着说出来的，常常比哭着重。

3. **判据是「他说完这句，我对他的了解有没有变一点」。**
   变了一点，就记。

反过来，这些不用记：
- 寒暄、确认、指令（"帮我打开一下"）
- 一句套话、一句吐槽天气
- 只是把已经知道的事又说了一遍

只回答一行，格式：

  yes <不超过 15 字的理由>
  或
  no <不超过 15 字的理由>

不要解释，不要 markdown。`;

/** 判断一次要多少 token —— 极小，输出只有一个词加一句短语 */
export const JUDGE_MAX_TOKENS = 24;

/**
 * 解析判断结果。
 *
 * **宽容优先**：模型可能回 "是"、"记"、"YES"、"应该记" —— 都算。
 * 认不出来就 **默认记**（用户定的：宁可多记，别静默漏）。
 *
 * @param {string} raw 模型原文
 * @returns {{keep: boolean, why: string, parsed: boolean}}
 */
export function parseVerdict(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { keep: true, why: '模型没答，按默认记', parsed: false };

  const line = text.split('\n')[0].trim();
  // 注意顺序：长的放前面（"不要" 先于 "要"，"别记" 先于 "记"），
  // 否则 `不` 会先吃掉 `不要`，理由那截就脏了。
  const m = /^(yes|no|不要|别记|要|记|是|不)[\s，,、:：-]*(.*)$/i.exec(line);
  if (m) {
    const head = m[1].toLowerCase();
    const keep = ['yes', '是', '记', '要'].includes(head);
    return { keep, why: (m[2] ?? '').trim().slice(0, 40), parsed: true };
  }

  // 认不出格式，但话里明显有否定 —— 也当"不记"，省得把 "no" 误当 "yes"
  if (/^no\b|^不需要|^不值得/i.test(line)) return { keep: false, why: line.slice(0, 40), parsed: false };

  // 其余一律**记**。漏的代价比多的大。
  return { keep: true, why: `认不出格式，按默认记：${line.slice(0, 30)}`, parsed: false };
}

/**
 * 组装这一次判断的输入。
 *
 * **只给这一轮他说的话** —— 不给整段对话。判断只需要那一句，
 * 而且省 token（约 260/轮，比固化本身便宜一半以上）。
 *
 * @param {object} input
 * @param {string} input.lastUserText 这一轮用户说的话
 * @param {string[]} [input.handNotes] 手记里的话（用户自己的偏好，作为补充判据）
 * @returns {{system: string, user: string}}
 */
export function buildJudgeInput(input = {}) {
  const said = String(input.lastUserText ?? '').trim();
  const notes = (Array.isArray(input.handNotes) ? input.handNotes : [])
    .filter((n) => typeof n === 'string' && n.trim() !== '')
    .map((n) => `- ${n.trim()}`);

  const system =
    notes.length === 0
      ? JUDGE_SYSTEM
      : `${JUDGE_SYSTEM}

── 补充：这个用户自己说过的话（也算判据）──
${notes.join('\n')}`;

  return { system, user: said };
}
