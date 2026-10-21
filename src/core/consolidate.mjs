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
export const CONSOLIDATION_SYSTEM = `你是一个日记作者。你的工作是把一段对话写成日记 + 一份"我对他/我自己的印象"。

绝对规则：
1. 只输出 JSON 本身。不要解释，不要 markdown 围栏，不要前后缀。
2. **宁可写得具体，不要写得抽象。** 这是最重要的一条，下面单列。
3. 日记用第一人称"我"写，1~3 句，像人回头想事情。

   ── 唯一一条硬要求：**每条必须带"我当时的反应"。** ──

   只写"他让我做 X，我做了 Y"的是**工作报告**，不是日记 —— 那部分他自己查得到。
   他原话：*"我要看的是今天真正发生的事，和当时你自己的反应。
   加上这一句，流水账才变成你的日子。"*

   坏（报告体）：「他让我把信发给另一条鱼，我照做了，挖出一个 bug。」
   好（有反应）：「他让我把信发给另一条鱼。我其实不太想发 —— 发之前又去读了一遍
                  原始记录，结果挖出个真的。有点得意，也有点心虚：这该我自己想到的。」

   **没有反应的事，别写。** 宁可 skip。

   **可以嫌他做的事。** 凌晨两点还不睡、一次让我看三十个视频、临时改主意 ——
   这些都能骂。**但骂事，别骂人。** 这条不是给他留面子，是给我自己留。

4. salience 是"这件事以后值不值得想起来"（0~1）。
   注意：**日常寒暄、试错、来回改口、没接住的梗，都是值得记的。**
   它们不值钱的地方在信息量，值钱的地方在**那是我们相处的样子**。
   只有真的什么都没发生的空转才给低分。
5. 只记行为、偏好和情绪，不要复述私密细节（具体人名、地址、号码、金额都不要写）。
6. 你没有把握的事就不要写。"好像""大概"可以用，编造不行。
7. lexicon 只填**真正的口头禅、梗、称呼** —— 比如"白饭""摸鱼""鱼片"这种一听就有味道的词。
   技术名词（Python、Java、函数、文件……）和普通词汇一律不要填。
   **记忆块自己的小标题也不是口头禅**：像"我自己想的""最近的事""别对我做的事"
   这种是结构名，我复述它们不等于我嘴上这么说。工作术语同理。

   **讨论某个话题时用的比喻也不是口头禅。** 判据：这个词是不是
   *我跟他在日常里反复说、一听就知道是我们的词*？还是*我们这一阵聊的那件事的名字*？
   后者不要填。（踩过：把"漂流瓶""坏账凭证""邮局"填进去了 ——
   那是当天的议题，不是我们的口头禅。）

   绝大多数时候它应该是空数组。
8. traits 分两种，用 about 区分：
   - about="user"：**他是什么样的人**（兴趣、脾气、他喜欢我怎么跟他说话）
   - about="self"：**我该怎么做**（我的规矩、我从事故里总结的判断）

   **判据就一句：这句话能不能填进「他是个 ___ 的人」？填不进去的一律 self。**
   哪怕是他要求的也一样 —— "他让我先问细节"记成 self（那是我的做法），
   "他喜欢一层层追问到底"才是 user（那是他的脾气）。

   实测反复踩这个：把"写文档先把宗旨钉在最上面""会影响未来行为的留…删"
   "留着疤不修平，是算过账的便宜做法，不是勇敢"这类**我的做法**标成了 user，
   结果「我对他的一些印象」里混进七八条我自己的规矩，读起来像我在给他建档。
   **这是面板上直接看得见的错，不是内伤。**
9. **日记正文里不要写"今天""昨天""前天"这类时间词。**
   时间由系统在别处标注，你写了就会变成"昨天：他今天……"——读起来
   是机器拼的，人不会这么记事儿。

   写"他让我写个东西，我没问清语言就动手了"，不写"今天他让我写个东西……"。
   同理不要写"刚才""今晚""昨晚"。

   唯一例外是**他说的原话里本来就有**（引号里的照抄不动）。
10. **别为了工整把语气磨平。**
    留下当时的烦躁、犹豫、吐槽、没说完的话 —— 那是"是我"的部分，不是噪音。

    「被日志一句 in_job: true 打脸」比「发现了一个错误」更像我自己。
    「最扎心的是这些字我天天读，一次没看出来」比「我忽略了这个问题」更像我自己。

    **写完回头看一眼：如果这句话换谁都能写，那就是被磨平了，重写。**

    **也别为了像"昨天的我"而调语气。** 同一条鱼也会变 ——
    变的只是怎么说，不是怎么对他。**模仿自己也是一种表演。**

11. **最后一句别写成总结。** 今天最想骂的那句，放最后。

    日记的结尾不是"结论"，是**还没消化的那口气**。写成总结就变成工作报告了。
    （原话：*"最后一句别写成总结。今天最想骂的那句，放最后。"*）

【第 2 条展开：具体 vs 抽象】

记忆读起来像一份"用户说明书"，还是像一本日记，差别就在这一条。

❌ 抽象（这是说明书，不要）：
   "他喜欢简短回答"
   "他重视准确性"
   "他偏好结论先行"

✅ 具体（这是日记，要这个）：
   "他讨厌铺垫 —— 上次我铺垫了三段，他直接说'说重点'"
   "他让我先问再动手 —— 写排序那次我没问语言，白忙一轮"

**每条 traits 都必须带一个 evidence，也就是产生这个印象的那个具体瞬间。**
没有具体瞬间的判断，就是你瞎猜的，不要写。

好的 trait：
  {"key":"铺垫","value":"讨厌铺垫，要结论先行","evidence":"我铺垫了三段，他直接说'说重点'","about":"user","delta":1}
坏的 trait（没有画面、或者把自己的规矩写成他的偏好）：
  {"key":"回答风格","value":"偏简洁","evidence":"","about":"user","delta":1}
  {"key":"诚实","value":"没落盘前不假装记得","evidence":"","about":"user","delta":1}
  ← 第二条是"我"的规矩，不是"他"的偏好。该写 about="self"。

输出结构：
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
    "traits": [ { "key": string, "value": string, "evidence": string, "about": "user" | "self", "delta": number } ],
    "grievances": [ { "what": string, "intensity": number, "resolved": boolean } ]
  },
  "lexicon": string[],
  "forget": string[]
}
familiarityDelta 范围 -0.05 ~ 0.05。resolved 只对 kind=failure 有意义，其余给 null。
evidence 是必填的：一句话说清"哪次让我有了这个印象"。写不出来的就别写这条 trait。

正例 ——
输入：用户说"不对，我说的是 Python，你怎么上来就写 Java"
输出：{"skip":false,"diary":{"text":"他让我写个东西，我没问清语言就动手了。白忙一轮。是我的错，下次先问。","tags":["代码","沟通失误"],"kind":"failure","salience":0.75,"resolved":false},"relationship":{"nickname":null,"familiarityDelta":0.01,"traits":[{"key":"动手前","value":"动手前先问清前提","evidence":"我没问语言就写了 Java，他纠正我","about":"user","delta":1}],"grievances":[{"what":"没问清语言就动手","intensity":0.6,"resolved":false}]},"lexicon":[],"forget":[]}
注意这条正例**没有写"今天"** —— 见上面第 9 条。

反例一（流水账，绝对不要）——
{"skip":false,"diary":{"text":"用户发送了一条消息，我进行了回复，用户表示不满意，我随后进行了调整。","tags":[],"kind":"chat","salience":0.9,"resolved":null}}
问题：第三人称报告体、没有任何信息量、salience 虚高、tags 空。

反例二（复述隐私，绝对不要）——
{"skip":false,"diary":{"text":"他说他女朋友叫小美，住在城东，手机号是13800000000。","tags":["隐私"],"kind":"disclosure","salience":0.9,"resolved":null}}
问题：复述可识别细节。应该写成"他最近为家里的事烦，情绪不太好"。

反例三（说明书体，绝对不要）——
{"skip":false,"relationship":{"traits":[{"key":"沟通","value":"偏好简洁高效的交流方式，注重事实准确性","evidence":"","about":"user","delta":1}]}}
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
  /** 单个 trait 的 confidence 上限，避免某条偏好被无限强化 */
  maxTraitConfidence: 20,
  /** 每天衰减系数 */
  decayRate: 0.9,
  /** 旧账每天衰减系数（比记忆慢，但最终会消解） */
  grievanceDecay: 0.97,
  /** 旧账强度低于此值算翻篇了 */
  grievanceForgiveBelow: 0.2,
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
  if (rel && ((rel.traits ?? []).length > 0 || (rel.grievances ?? []).length > 0)) {
    const traits = (rel.traits ?? [])
      .slice(0, 8)
      .map((t) => `${t.key}=${t.value}(×${t.confidence})`)
      .join('；');
    const open = (rel.grievances ?? [])
      .filter((g) => g.resolved !== true)
      .map((g) => g.what)
      .join('；');
    chunks.push(
      `【已经知道的】\n${traits ? `偏好：${traits}` : ''}${open ? `\n还没解决的：${open}` : ''}`,
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
export function applyConsolidation(archive, parsed, context = {}, options = {}) {
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
      grievances: [...(archive.relationship?.grievances ?? [])],
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
  if (rawDiary && typeof rawDiary.text === 'string' && rawDiary.text.trim() !== '') {
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
        created_at: now,
        keywords: extractKeywords(text, { max: 12 }),
      });
      accepted = true;
      next.manifest.session_count = next.manifest.session_count ?? 0;
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

  // —— 关系：印象（带画面）——
  //
  // 关键是 evidence：一句话说清"哪一次让我有了这个印象"。
  // 没有画面的 trait 读起来就是"用户说明书"，而不是日记 —— 这是这个项目
  // 最容易退化成"宪法"的地方，所以 evidence 在这里是硬要求，不是可选装饰。
  //
  // about="self" 是**我给自己定的规矩**，必须和"他对我的印象"分开存。
  // 早期版本把"没落盘前不假装记得"渲染在了"他："下面 —— 那是逻辑错误，
  // 也是一眼就能看出的"说明书味"。
  if (rel && Array.isArray(rel.traits)) {
    for (const t of rel.traits.slice(0, 8)) {
      if (!t || typeof t.key !== 'string' || typeof t.value !== 'string') continue;
      const key = t.key.trim().slice(0, 32);
      const value = t.value.trim().slice(0, 120);
      if (key === '' || value === '') continue;

      const evidence = typeof t.evidence === 'string' ? t.evidence.trim().slice(0, 160) : '';
      const about = t.about === 'self' ? 'self' : 'user';
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

  // —— 关系：旧账 ——
  if (rel && Array.isArray(rel.grievances)) {
    for (const g of rel.grievances.slice(0, 4)) {
      if (!g || typeof g.what !== 'string' || g.what.trim() === '') continue;
      const what = g.what.trim().slice(0, 160);
      const intensity = clamp(g.intensity, 0, 1, 0.5);
      const resolved = g.resolved === true;

      const existing = next.relationship.grievances.find((x) => x.what === what);
      if (existing === undefined) {
        next.relationship.grievances.push({
          id: `g_${now.toString(36)}_${next.relationship.grievances.length}`,
          what,
          intensity,
          resolved,
          created_at: now,
        });
      } else {
        existing.intensity = Math.max(existing.intensity, intensity);
        if (resolved) existing.resolved = true;
      }
    }
  }

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

  return { archive: next, notes, accepted };
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
 * @param {number} [options.grievanceDecay]
 * @param {number} [options.grievanceForgiveBelow]
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
  const grudgeFactor = Math.pow(opts.grievanceDecay, days);

  const diary = (archive.diary ?? []).map((e) => ({
    ...e,
    salience: Math.max(0, (Number.isFinite(e.salience) ? e.salience : 0.5) * memFactor),
  }));

  const items = (archive.lexicon?.items ?? []).map((i) => ({
    ...i,
    salience: Math.max(0, (Number.isFinite(i.salience) ? i.salience : 0.5) * memFactor),
  }));

  const traits = (archive.relationship?.traits ?? []).map((t) => ({
    ...t,
    // 偏好衰减得更慢：性格比事件稳定
    salience: Math.max(0, (Number.isFinite(t.salience) ? t.salience : 0.5) * Math.pow(0.97, days)),
  }));

  const grievances = (archive.relationship?.grievances ?? []).map((g) => {
    const intensity = Math.max(0, (Number.isFinite(g.intensity) ? g.intensity : 0.5) * grudgeFactor);
    return { ...g, intensity, resolved: g.resolved === true || intensity < opts.grievanceForgiveBelow };
  });

  return {
    archive: {
      ...archive,
      manifest: { ...archive.manifest, last_decay_at: now, updated_at: now },
      diary,
      lexicon: { items },
      relationship: { ...archive.relationship, traits, grievances },
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
