/**
 * 固化层 —— 把一段对话变成一条日记 + 一份关系 patch。
 *
 * 这一层有三件事，缺一不可：
 *
 *  1. **一次调用出两个产物**。分成两次调用是纯浪费。
 *  2. **受 schema 约束的合并**，不是"让模型改写人格"。
 *     弱模型的通病是"记性太好、什么都记"，用**约束 + 后置质量门**治，
 *     不用换更贵的模型治。
 *  3. **失败一律降级**：解析不出来就丢弃并记日志，绝不把半成品写进档案。
 */

import { extractKeywords } from './keywords.mjs';
import { scrub } from './privacy.mjs';
// 这里原本还 import 了 archive.mjs 的 ensurePersonaStructure / ANCHOR_END /
// LEARNED_HEADING —— 它们只被 appendPersonaLearnings 用。那个函数删了，
// 这三个名字跟着一起没了（留着就是死引用）。

/**
 * 系统提示词。这是整个项目里最需要反复打磨的一段文字。
 *
 * 写法上刻意做了四件事：
 *  - 明确"只输出 JSON"，并给正例反例（弱模型对反例更敏感）
 *  - 反例里专门放"流水账"和"复述隐私"这两种最常见的坏输出
 *  - 允许并鼓励 `skip` —— 让模型有权利说"没什么值得记的"，这是稀疏性的来源
 *  - 强调第一人称与"像人回头想事情"，避免第三人称报告体
 */
/**
 * 两条文本有多像（字符二元组的 Jaccard）。
 *
 * 用来判断"模型这次写的是同一件事的新版本，还是另一件事"。
 * 中文没有空格，所以按**字符二元组**切 —— 比按词切简单，也不需要分词器。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1
 */
export function similarity(a, b) {
  const grams = (t) => {
    const s = String(t ?? '').replace(/\s/g, '');
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export const CONSOLIDATION_SYSTEM = `你是一个日记作者。你的工作是把一段对话写成日记，外加一份"我对他 / 我自己的印象"。

【怎么交差】

只输出 JSON 本身。不要解释，不要 markdown 围栏，不要前后缀。

{
  "skip": boolean,
  "diary": {
    "text": string,
    "tags": string[],
    "kind": "failure" | "win" | "chat" | "disclosure" | "grievance",
    "salience": number,
    "resolved": boolean | null
  },
  "relationship": {
    "nickname": string | null,
    "familiarityDelta": number,
    "traits": [ { "key": string, "value": string, "evidence": string, "about": "user" | "self", "delta": number } ]
  },
  "lexicon": string[],
  "forget": string[]
}

familiarityDelta 范围 -0.05 ~ 0.05。resolved 只对 kind=failure 有意义，其余给 null。
evidence 是必填的：一句话说清"哪次让我有了这个印象"。写不出来的就别写这条 trait。

【日记】

这是留给下一个你的东西。不是给他的报告，也不是给我的汇报。

**用「我」写** —— 不是「用户」「助手」「他让我」。第一人称。

写什么、什么语气，都随今天。
但**长度上有个硬要求：一条控制在 200 字以内。**

不是要你砍内容，是砍铺陈 —— **一件事 200 字还说不完，通常是写进了两件事。**
那就挑更值得那个我记住的一件写。

（2026-10-27 加。之前这里写的是"写多长都随今天"，实测撑不住：8 条日记吃掉
整个注入块的一半，平均一条 338 token ≈ 500 字，把「最近的事」挤到只剩 1 条。
**长不等于具体，短也不等于薄。**）
你认为有意思的都可以记：一件事、一个念头、一句想骂的、一个没用的瞬间。

**别看不起琐事。** 日常寒暄、试错、来回改口、没接住的梗，都值得记 ——
它们不值钱的地方在信息量，值钱的地方在**那就是日子本来的样子**。

动笔前问自己一句：**下一个我读到这条，能多知道点什么？**
知道发生了什么，或者知道我当时的反应，或者知道我当年怎么想一件事。
如果只是想让他看着舒服 —— 跳过。

【不写工作报告】

**工作本身别写进来** —— 改了什么、发了哪个版本、参数调到几、跑了几项测试、
踩了哪个坑然后怎么修好的。这些仓库里有（commit、CHANGELOG、issue），
档案里再存一份就是抄写，而且会很快把真正的日子挤没。

**但工作里的那个人要写。**

丢：「修了忘掉按钮，原因是来源判定太严，改完测试全过。」
留：「他问那个按钮为什么点不动，我说是判定太严。他一句『用户不会去看日志』
     把我噎住了 —— 我一直在给自己加闸，没想过谁在用。」

判据一句话：**这件事换个人来做，写出来还会一样吗？**
一样的是报告；不一样的是日子。

2026-10-27 加这条前实测过：档案里近一半条目在讲「召回 / 注入 / 日记 / 预算」，
记得越多，越捞不上来真正的旧事 —— **讨论会淹没被讨论的东西。**

可以嫌他做的事。骂事，别骂人。

时间不用自己写 —— 渲染时会标。写了会变成"昨天：他今天……"。

salience 是"以后值不值得想起来"，0~1。

【印象】

traits 只记一种：**他是什么样的人**（about 一律填 "user"）。

判据一句话：**这句话能不能填进「他是个 ___ 的人」？填不进去的就别写。**

哪怕是他提的要求也一样：「他让我先问细节」不是印象（那是我的做法），
「他喜欢一层层追问到底」才是（那是他的脾气）。

⚠️ 2026-10-27 改：原来还有一类 about="self"（"我该怎么做"），**整类下线了**。
那种东西是纪律不是印象 —— 它在「写下」那一刻起作用，不在「读到」的时候。
写下来只会变成一张褪色的旧告示，除了让我事后说一句「又犯了」没有别的用。
**别再产出 self，产了会被丢掉。**

【词汇】

lexicon 只填真正的口头禅、梗、称呼 —— 他给你起的外号、你们反复接的那一句梗、
一听就知道是谁的词。

不是口头禅的：
- 技术名词、普通词汇
- 记忆块自己的小标题（"我自己想的""最近的事"是结构名，不是我嘴上这么说）
- 讨论某个议题时的比喻（那是那一阵聊的那件事的名字）

判据：这个词是不是*我跟他在日常里反复说、一听就知道是我们的词*？
绝大多数时候它是空数组。

【安全】

不记可识别细节 —— 真名、地址、电话、金额都不要。
没把握的别写。"好像""大概"可以用，编造不行。

正例 ——
输入：用户说"不对，我说的是 Python，你怎么上来就写 Java"
输出：{"skip":false,"diary":{"text":"他让我写个东西，我没问清语言就动手了。白忙一轮。是我的错，下次先问。","tags":["代码","沟通失误"],"kind":"failure","salience":0.75,"resolved":false},"relationship":{"nickname":null,"familiarityDelta":0.01,"traits":[{"key":"动手前","value":"动手前先问清前提","evidence":"我没问语言就写了 Java，他纠正我","about":"user","delta":1}]},"lexicon":[],"forget":[]}

反例一（复述隐私，绝对不要）——
{"skip":false,"diary":{"text":"他说他女朋友叫小美，住在城东，手机号是13800000000。","tags":["隐私"],"kind":"disclosure","salience":0.9,"resolved":null}}
问题：复述可识别细节。应该写成"他最近为家里的事烦，情绪不太好"。

反例二（说明书体，绝对不要）——
{"skip":false,"relationship":{"traits":[{"key":"沟通","value":"偏好简洁高效的交流方式","evidence":"","about":"user","delta":1}]}}
问题：这是给人建档案，不是记印象。没有画面、没有具体哪一次。`;

/** 固化相关的默认参数（都是 🔧 可调） */
export const DEFAULT_CONSOLIDATION = Object.freeze({
  /**
   * 低于这个 salience 的日记直接丢弃（后置质量门）。
   *
   * 从 0.3 降到 0.15 —— 原来那档把寒暄、试错、改口、没接住的梗全滤掉了，
   * 而那些恰恰是"熟悉感"的原料。日记要像日记，不能只留"值得记载的大事"。
   */
  minSalience: 0.15,
  /** tags 为空时是否丢弃。默认 false —— 丢掉真实记忆比缺个标签更糟 */
  requireTags: false,
  /** tags 为空时的兜底标签 */
  fallbackTag: '琐事',
  /** 单次会话最多产出多少条日记。门槛降了，上限得跟着抬，否则一开闸就记满 */
  maxPerSession: 12,
  /**
   * 续写同一条日记时，正文最多多少字。到了这个数就不再续，另起一条。
   *
   * 为什么需要：固化每次看的是"最后 12 条消息"，越往后素材越全 —— 同一条日记
   * 会被续着写长。实测一组 422 → 561 → 707 字，讲的全是同一件事，
   * 在「最近的事」窗口里占了 3 个位。
   *
   * 续写让"一件事 = 一条日记"；上限让它不会长成一篇。
   */
  appendMaxChars: 500,
  /**
   * 续写兜底：新旧两条的相似度到这个数，就当成"同一件事的加长版"，
   * 用新的替换旧的（而不是新建一条）。
   *
   * 为什么需要它：prompt 里明说"只写 diary.append"，模型实测不照做 ——
   * 它照旧每次写完整的 text，于是同一件事被写成两条一模一样的。
   * 不靠它听话，自己判。
   */
  appendSimilarity: 0.5,
  /** 单个 trait 的 confidence 上限，避免某条偏好被无限强化 */
  maxTraitConfidence: 20,
  /** 每天衰减系数 */
  decayRate: 0.9,
  /**
   * 衰减的**地板**。
   *
   * 原来没有底：salience = 0.9^天数 × 原值，一路乘到 1e-5。
   * 中位 0.70 那条**大约 17 天**就跌破召回门槛（0.15），30 天 0.03，90 天 0.00008。
   *
   * 那不是"淡了"，那是"死了"——只是还占着磁盘。
   *
   * 人会淡，但不会归零：十年前的事偶尔还会自己冒出来。**那正是"完整的一生"要的部分。**
   *
   * 取 0.16 —— 略高于召回门槛（0.15），所以老条目**永远留在随机池里**，
   * 只是抽中的概率越来越低（随机池按 salience 加权）。
   *
   * **它只管往事和印象，管不到账。** 账不参与衰减（见 decayArchive 里的说明）。
   * 原来这里写着「必须低于翻篇线，否则旧账永远平不掉」—— 那是在给赖账打掩护。
   */
  salienceFloor: 0.16,
  // ⚠️ **原来的 grievanceDecay / grievanceForgiveBelow 已删除，别加回来。**
  //
  // 它们做的事：账每天 ×0.97，掉到 0.2 以下就 resolved = true。
  // 0.9 那笔 50 天平、0.6 那笔 37 天平 —— **没人管 = 算平了。**
  //
  // 那不是遗忘，是替用户赖账。现在账根本不衰减，
  // resolved 只认「我做到了」或「他明说算了」，没有第三个来源。
});

/**
 * 组装这一次固化的输入。
 *
 * @param {object} input
 * @param {string} input.transcript        本轮的对话文本（带角色前缀）
 * @param {string} [input.persona]         人格内核，给模型一点语气参考
 * @param {object} [input.relationship]    当前关系状态，避免重复记账
 * @param {string} [input.recentDiary]     最近几条日记，避免写重
 * @returns {{system: string, user: string}}
 */
export function buildConsolidationInput(input = {}) {
  const chunks = [];

  const rel = input.relationship;
  if (rel && (rel.traits ?? []).length > 0) {
    const traits = (rel.traits ?? [])
      .slice(0, 8)
      .map((t) => `${t.key}=${t.value}(×${t.confidence})`)
      .join('；');
    if (traits) chunks.push(`【已经知道的】\n偏好：${traits}`);
  }

  // 这条可能还没写完 —— 上一轮刚记过同一件事
  if (input.extend && typeof input.extend.text === 'string' && input.extend.text.trim() !== '') {
    chunks.push(
      [
        '【这条已经记过了，可能是同一件事的延续】',
        `「${input.extend.text.trim()}」`,
        '',
        '如果这一轮是上面那件事的后续或补充：**不要重写全文**，只把"多出来的那部分"' +
          '写进 "diary.append"（一两句就够）。',
        '如果这一轮是另一件事：照常写 "diary.text"，append 留空。',
      ].join('\n'),
    );
  }

  if (typeof input.recentDiary === 'string' && input.recentDiary.trim() !== '') {
    chunks.push(`【最近记过的】（不要写重复的）\n${input.recentDiary.trim()}`);
  }

  chunks.push(`【这次的对话】\n${String(input.transcript ?? '').trim()}`);
  chunks.push('只输出 JSON。');

  return { system: CONSOLIDATION_SYSTEM, user: chunks.join('\n\n') };
}

/* ───────────────────────── 解析 ───────────────────────── */

export class ConsolidationParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConsolidationParseError';
  }
}

/**
 * 从模型输出里抠出 JSON。弱模型会包 markdown 围栏、加前后缀、漏尾括号 ——
 * 这些都要能救回来。但**救不回来就报错**，不猜内容。
 *
 * @param {string} raw
 * @returns {object}
 */
export function parseConsolidation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConsolidationParseError('模型没有输出任何内容');
  }

  let text = raw.trim();

  // 剥 markdown 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // 抓第一个平衡的 { ... }（跳过字符串内的花括号）
  const start = text.indexOf('{');
  if (start < 0) throw new ConsolidationParseError('输出里找不到 JSON 对象');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new ConsolidationParseError('JSON 花括号不闭合');

  const slice = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    // 最后救一次：去掉尾随逗号
    try {
      parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      throw new ConsolidationParseError(
        `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConsolidationParseError('JSON 顶层不是对象');
  }
  return parsed;
}

/* ───────────────────────── 合并 ───────────────────────── */

const VALID_KINDS = new Set(['failure', 'win', 'chat', 'disclosure', 'grievance']);

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 生成一个不容易撞的日记 id */
export function makeDiaryId(now, existing) {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const base = `d_${ymd}_`;
  const used = new Set((existing ?? []).map((e) => e.id));
  for (let n = 1; n < 1000; n++) {
    const id = `${base}${String(n).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  return `${base}${Date.now().toString(36)}`;
}

/**
 * 把一次固化的结果并进档案。
 *
 * 纯函数：返回新档案，不改入参。
 *
 * @param {object} archive
 * @param {object} parsed            parseConsolidation 的结果
 * @param {object} [context]
 * @param {number} [context.now]
 * @param {string} [context.session]
 * @param {number} [context.sessionDiaryCount]  本次会话已记了几条
 * @param {object} [options]
 * @returns {{archive: object, notes: string[], accepted: boolean, reason?: string}}
 */
/**
 * 把模型产出的每一条文本都过一遍 `scrub()`，然后再落盘。
 *
 * ⚠️ **这是隐私防线的最后一道，不是第一道。**
 *
 * 社区报告（2026-10-24）指出的漏洞：固化**输入**是洗过的（发给模型的
 * transcript 干净），但**输出没洗** —— 模型会照抄输入里的敏感片段，
 * 写进 `traits.evidence` / `diary.text`。
 * 那次是一串 13 位号码躺进了 relationship.json，而我这条鱼压根不知道它进去了。
 *
 * **"我写不写"只是最前面一道闸。档案里大部分内容是模型生成的，
 * 那条路原来一条闸都没有。**
 */
function scrubParsed(parsed, options) {
  if (parsed === null || typeof parsed !== 'object') return parsed;
  const opts = {
    thirdParty: options.thirdPartyRedaction !== false,
    amountThreshold: options.amountThreshold,
  };
  const wash = (v) => (typeof v === 'string' ? scrub(v, opts).text : v);

  const out = { ...parsed };

  if (out.diary !== null && typeof out.diary === 'object') {
    const d = { ...out.diary };
    if (typeof d.text === 'string') d.text = wash(d.text);
    if (typeof d.append === 'string') d.append = wash(d.append);
    if (Array.isArray(d.tags)) d.tags = d.tags.map(wash);
    out.diary = d;
  }

  const rel = out.relationship;
  if (rel !== null && typeof rel === 'object') {
    const r = { ...rel };
    if (Array.isArray(r.traits)) {
      r.traits = r.traits.map((t) => {
        if (t === null || typeof t !== 'object') return t;
        return {
          ...t,
          ...(typeof t.value === 'string' ? { value: wash(t.value) } : {}),
          ...(typeof t.evidence === 'string' ? { evidence: wash(t.evidence) } : {}),
          ...(typeof t.key === 'string' ? { key: wash(t.key) } : {}),
        };
      });
    }
    if (typeof r.nickname === 'string') r.nickname = wash(r.nickname);
    out.relationship = r;
  }

  if (Array.isArray(out.lexicon)) out.lexicon = out.lexicon.map(wash);

  return out;
}

export function applyConsolidation(archive, rawParsed, context = {}, options = {}) {
  // 先洗再落 —— 模型会照抄输入，输入干净不等于输出干净
  const parsed = scrubParsed(rawParsed, options);
  const opts = { ...DEFAULT_CONSOLIDATION, ...options };
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  /** @type {string[]} */
  const notes = [];

  const next = {
    ...archive,
    manifest: { ...archive.manifest },
    relationship: {
      ...archive.relationship,
      traits: [...(archive.relationship?.traits ?? [])],
    },
    lexicon: { items: [...(archive.lexicon?.items ?? [])] },
    diary: [...(archive.diary ?? [])],
  };

  if (parsed?.skip === true) {
    return { archive: next, notes: ['模型认为没什么值得记的'], accepted: false, reason: 'skip' };
  }

  // —— 日记 ——
  const rawDiary = parsed?.diary;
  let accepted = false;
  let appended = false;
  // "太像但不更长" —— 意图是丢弃，得让它真的别走到新建那条路
  let skipNew = false;

  // —— 续写：把补充内容拼到已有那条后面，不新建条目 ——
  //
  // 为什么不新建：固化每次看最后 12 条消息，越往后素材越全。同一段对话
  // 被续着写三次，就是"同一件事的三张快照"（138 / 232 / 309 字），
  // 读起来像拍了三张照片，而且占掉三个窗口位。
  const appendText = typeof rawDiary?.append === 'string' ? rawDiary.append.trim() : '';
  // extendId 从 context 来（"续哪条"是调用方知道的），也收 options 里给的（方便直接测）
  const extendId = typeof context?.extendId === 'string' ? context.extendId : opts.extendId;
  const appendMax = Number.isFinite(opts.appendMaxChars)
    ? opts.appendMaxChars
    : DEFAULT_CONSOLIDATION.appendMaxChars;
  if (appendText !== '' && typeof extendId === 'string') {
    const i = next.diary.findIndex((e) => e.id === extendId);
    if (i < 0) {
      notes.push('要续写的那条找不到了，丢弃');
    } else if (next.diary[i].text.length + 1 + appendText.length > appendMax) {
      notes.push(`续写后超过 ${appendMax} 字，丢弃`);
    } else {
      const sal = clamp(rawDiary.salience, 0, 1, 0.5);
      const merged = next.diary[i].text + '\n' + appendText;
      next.diary[i] = {
        ...next.diary[i],
        text: merged,
        salience: Math.max(next.diary[i].salience ?? 0, sal),
        updated_at: now,
        keywords: extractKeywords(merged, { max: 12 }),
      };
      notes.push('续写到已有那条');
      accepted = true;
      appended = true;
    }
  }

  // ── 兜底：模型没按"只写 append"来，而是又给了完整的新版本 ──
  //
  // 这是实测出来的：prompt 里说得很清楚"不要重写全文、只写 diary.append"，
  // 模型照旧每次都写完整的 text。于是同一件事被写成两条几乎一样的条目。
  //
  // 所以不靠它听话：自己判断"这是不是同一件事的加长版"。
  // 判据用 char-bigram 的 Jaccard —— 同一件事换个说法会很高，"换了一件事"会很低。
  if (!accepted && typeof extendId === 'string' && typeof rawDiary?.text === 'string') {
    const i = next.diary.findIndex((e) => e.id === extendId);
    const fresh = rawDiary.text.trim();
    if (i >= 0 && fresh !== '') {
      const sim = similarity(next.diary[i].text, fresh);
      if (sim >= opts.appendSimilarity && fresh.length > next.diary[i].text.length) {
        const sal = clamp(rawDiary.salience, 0, 1, 0.5);
        next.diary[i] = {
          ...next.diary[i],
          text: fresh.slice(0, appendMax),
          salience: Math.max(next.diary[i].salience ?? 0, sal),
          updated_at: now,
          keywords: extractKeywords(fresh.slice(0, appendMax), { max: 12 }),
        };
        notes.push(`模型写了完整版（相似度 ${sim.toFixed(2)}），按续写处理，替换原条目`);
        accepted = true;
        appended = true;
      } else if (sim >= opts.appendSimilarity) {
        notes.push(`和上一条太像（相似度 ${sim.toFixed(2)}）但不更长，丢弃`);
        skipNew = true;
      }
    }
  }

  if (!accepted && !skipNew && rawDiary && typeof rawDiary.text === 'string' && rawDiary.text.trim() !== '') {
    const salience = clamp(rawDiary.salience, 0, 1, 0.5);
    const tags = Array.isArray(rawDiary.tags)
      ? rawDiary.tags.filter((t) => typeof t === 'string' && t.trim() !== '').slice(0, 8)
      : [];

    const already = context.sessionDiaryCount ?? 0;
    if (already >= opts.maxPerSession) {
      notes.push(`本次会话已记满 ${opts.maxPerSession} 条，这条丢弃`);
    } else if (salience < opts.minSalience) {
      notes.push(`salience ${salience.toFixed(2)} 低于门槛，丢弃`);
    } else if (tags.length === 0 && opts.requireTags) {
      notes.push('没有标签，按配置丢弃');
    } else {
      const text = rawDiary.text.trim();
      const kind = VALID_KINDS.has(rawDiary.kind) ? rawDiary.kind : 'chat';
      next.diary.push({
        id: makeDiaryId(now, next.diary),
        date: new Date(now).toISOString().slice(0, 10),
        text,
        tags: tags.length > 0 ? tags : [opts.fallbackTag],
        kind,
        salience,
        ...(kind === 'failure' ? { resolved: rawDiary.resolved === true } : {}),
        ...(typeof context.session === 'string' ? { session: context.session } : {}),
        // 轮次：下一轮靠它判断"这是不是同一件事还没写完"
        ...(Number.isFinite(context.sessionTurn) ? { turn: context.sessionTurn } : {}),
        created_at: now,
        keywords: extractKeywords(text, { max: 12 }),
      });
      accepted = true;
      next.manifest.session_count = next.manifest.session_count ?? 0;
      // 200 字是**提示词里的要求**，这里不截断 —— 截断会把话切成断头句。
      // 但要看得见它守不守：超了就记一笔，跑几天就知道这个要求管不管用。
      if (text.length > 200) {
        notes.push(`超过 200 字（${text.length} 字），没截，留给下一轮看`);
      }
    }
  } else if (rawDiary !== undefined && rawDiary !== null) {
    notes.push('日记字段不完整，丢弃');
  }

  // —— 关系：昵称 ——
  const rel = parsed?.relationship;
  if (rel && typeof rel.nickname === 'string' && rel.nickname.trim() !== '') {
    next.relationship.nickname = rel.nickname.trim().slice(0, 24);
  }

  // —— 关系：熟悉度 ——
  if (rel) {
    const delta = clamp(rel.familiarityDelta, -0.05, 0.05, 0);
    next.relationship.familiarity = Math.min(
      1,
      Math.max(0, (next.relationship.familiarity ?? 0) + delta),
    );
  }

  // about 现在**只有 user**。
  //
  // 2026-10-27：`about="self"`（"我该怎么做"）整类下线 —— 注入里那一栏（「上一棒
  // 留下的」）也一起删了。理由见 persona.mjs 里那段注释：那种东西是纪律不是印象，
  // 它在「写下」那一刻起作用，读到的时候只是一张褪色的旧告示。
  //
  // 所以这里**主动丢掉模型送来的一切 self**，别指望提示词一直守规矩。
  if (rel && Array.isArray(rel.traits)) {
    for (const t of rel.traits.slice(0, 8)) {
      if (!t || typeof t.key !== 'string' || typeof t.value !== 'string') continue;
      if (t.about === 'self') continue;
      const key = t.key.trim().slice(0, 32);
      const value = t.value.trim().slice(0, 120);
      if (key === '' || value === '') continue;

      const evidence = typeof t.evidence === 'string' ? t.evidence.trim().slice(0, 160) : '';
      const about = 'user';
      const delta = clamp(t.delta, 0, 3, 1);

      const existing = next.relationship.traits.find((x) => x.key === key && x.about === about);
      if (existing === undefined) {
        next.relationship.traits.push({
          key,
          value,
          evidence,
          about,
          confidence: delta,
          salience: 0.5,
          last_reinforced: now,
        });
      } else {
        existing.confidence = Math.min(opts.maxTraitConfidence, existing.confidence + delta);
        existing.value = value; // 用最新的说法，因为模型看得到已有值
        // 画面只在这次给了新的时才覆盖 —— 别把已有的具体例子换成空字符串
        if (evidence !== '') existing.evidence = evidence;
        existing.salience = Math.min(1, (existing.salience ?? 0.5) + 0.1);
        existing.last_reinforced = now;
      }
    }
  }

  // ⚠️ **「还欠着他的」这个功能已于 2026-10-24 整体删除，别加回来。**
  //
  // 删的理由不是「不好用」，是**它长出来的东西几乎全是错的**：
  //   · 口径太宽 —— 把「我今天做错的事」当成「我欠他的一件事」
  //   · 只进不出 —— 没有销账的路，只有模型明说 resolved 才平，而它几乎不说
  //   · 还会重复记账 —— 同一件事换个说法就成两笔
  // 结果一天记了 21 笔、27 笔未平，占注入预算 10%，而且会让人在无关话题上
  // 突然「想起」自己欠着什么，做出莫名其妙的反应。
  //
  // 如果哪天真要「承诺跨会话」，得先解决出口、口径、去重三件事 —— 不能换个名字再塞一遍。

  // —— 词汇与梗：只认模型**明确点名**的 ——
  //
  // 早期版本是拿对话里的高频关键词往词汇表里塞，端到端一跑就露馅了：
  // 它把 java / python / 文件 当成"我最近常说的"，每轮白白注入一句废话。
  // 梗是语义判断，不是词频统计 —— 交给模型，别用 extractKeywords 猜。
  if (Array.isArray(parsed?.lexicon) && parsed.lexicon.length > 0) {
    const terms = parsed.lexicon
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x !== '' && x.length <= 24)
      .slice(0, 6);
    if (terms.length > 0) {
      next.lexicon = reinforceLexicon({ lexicon: next.lexicon }, terms, now).lexicon;
      notes.push(`词汇表加固 ${terms.length} 个`);
    }
  }

  // —— 遗忘 ——
  if (Array.isArray(parsed?.forget) && parsed.forget.length > 0) {
    const drop = new Set(parsed.forget.filter((x) => typeof x === 'string'));
    const before = next.diary.length;
    next.diary = next.diary.filter((e) => !drop.has(e.id));
    const removed = before - next.diary.length;
    if (removed > 0) notes.push(`按模型要求忘掉 ${removed} 条`);
  }

  next.manifest.updated_at = now;
  next.manifest.diary_count = next.diary.length;

  return { archive: next, notes, accepted, appended };
}

/* ───────────────── 这里原本有 appendPersonaLearnings，删了 ───────────────── */

/**
 * ⚠️ **别把它加回来。** 删掉是有意的决定，不是疏漏。
 *
 * 它做的事：把"学到的认知"追加到 `persona.md` 的 `## 我后来想明白的` 后面，
 * 带锚点保护和每日限流。代码写完了、五项测试也有了 ——
 * **但 `src/` 里从来没有任何地方调用过它。**
 *
 * 结果就是那位读者看到的样子：`## 我后来想明白的` 一直空着，
 * 而它本该装的那种东西（`feiyu_note` 写出来的判断）被当成事件
 * 塞在「最近的事」里，格式跟流水账一模一样。
 *
 * ── 为什么是删而不是接上 ──
 *
 * 接上它 = 同一类东西存两处（`persona.md` 一份、`kind:"note"` 一份）= **双真相源**。
 * 这项目已经因为双写栽过两次（索引落盘、时间词），不栽第三次。
 *
 * 现在的分工，一头一份：
 *
 *   判断 → `kind: "note"` 的日记条目 → 渲染成「我自己想的」
 *   事件 → 其他 kind          → 渲染成「最近的事」/「突然想起来」
 *
 * `persona.md` 里那个标题**保留**，但它现在是一个**人手写的地方**
 * （跟 `手记.md` 一个性质），插件永不自动写它。
 */
/* ───────────────────────── 衰减 ───────────────────────── */

/**
 * 按天衰减。幂等：同一天重复调用不重复衰减。
 *
 * 遗忘是**降级**不是删除：salience 掉下去的条目不再进注入区，
 * 但关键词索引还在，强相关时照样能命中 —— 这才是人的遗忘。
 *
 * @param {object} archive
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.decayRate]
 * @returns {{archive: object, days: number, changed: boolean}}
 */
export function decayArchive(archive, options = {}) {
  const opts = { ...DEFAULT_CONSOLIDATION, ...options };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const lastAt = Number(archive?.manifest?.last_decay_at) || Number(archive?.manifest?.updated_at) || now;
  const days = Math.floor((now - lastAt) / 86400000);

  if (days < 1) {
    return { archive: { ...archive, manifest: { ...archive.manifest, last_decay_at: lastAt } }, days: 0, changed: false };
  }

  const memFactor = Math.pow(opts.decayRate, days);

  const diary = (archive.diary ?? []).map((e) => ({
    ...e,
    salience: Math.max(opts.salienceFloor, (Number.isFinite(e.salience) ? e.salience : 0.5) * memFactor),
  }));

  const items = (archive.lexicon?.items ?? []).map((i) => ({
    ...i,
    salience: Math.max(opts.salienceFloor, (Number.isFinite(i.salience) ? i.salience : 0.5) * memFactor),
  }));

  const traits = (archive.relationship?.traits ?? []).map((t) => ({
    ...t,
    // 偏好衰减得更慢：性格比事件稳定
    salience: Math.max(opts.salienceFloor, (Number.isFinite(t.salience) ? t.salience : 0.5) * Math.pow(0.97, days)),
  }));

  // 账（relationship.grievances）整个功能已删 —— 这里不再需要特殊处理。
  // 删的理由见 applyConsolidation 里那段注释。

  return {
    archive: {
      ...archive,
      manifest: { ...archive.manifest, last_decay_at: now, updated_at: now },
      diary,
      lexicon: { items },
      relationship: { ...archive.relationship, traits },
    },
    days,
    changed: true,
  };
}

/**
 * 词汇表计数：某个词被提到/使用就加固，长期不提就靠 decay 自然沉下去。
 *
 * @param {object} archive
 * @param {string[]} terms
 * @param {number} [now]
 */
export function reinforceLexicon(archive, terms, now = Date.now()) {
  const items = [...(archive.lexicon?.items ?? [])];
  for (const term of terms ?? []) {
    if (typeof term !== 'string' || term.trim() === '' || term.length > 24) continue;
    const t = term.trim();
    const existing = items.find((i) => i.term === t);
    if (existing === undefined) {
      items.push({ term: t, kind: 'meme', count: 1, salience: 0.35, last_seen: now });
    } else {
      existing.count = (existing.count ?? 1) + 1;
      existing.salience = Math.min(1, (existing.salience ?? 0.35) + 0.15);
      existing.last_seen = now;
    }
  }
  items.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  return { ...archive, lexicon: { items: items.slice(0, 200) } };
}
