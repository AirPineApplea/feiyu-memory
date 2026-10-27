/**
 * 记忆召回 —— 完全本地、零模型 token。
 *
 * 为什么不用 SQLite / 向量库：
 *  - 向量库要下载模型 + 占几百 MB，还得开 GPU 之外的线程池，与"轻到不像插件"背道而驰
 *  - SQLite 要么引原生依赖（插件装不上），要么赌运行时有 `node:sqlite`
 *  - 倒排索引对我们这个量级（十年日记 ≈ 几千条）是**毫秒级**的，
 *    而且索引是纯派生的 —— 每次加载重建，不需要存盘，文件坏了也不影响档案本体
 *
 * 打分 = a·文本相似度 + b·salience + c·新鲜度 − d·最近刚提过的惩罚
 *
 * 分流刻意保留随机性：人本来就是"联想到什么说什么"，
 * 每次都精准翻出最相关的那条，是数据库，不是鱼。
 */

import { tokenize } from './keywords.mjs';

/** IDF 平滑，避免 df=0 时除零 */
const IDF_SMOOTH = 1;

/**
 * 建倒排索引。纯派生数据，随用随建。
 *
 * @param {Array<{id: string, keywords?: string[], text?: string}>} entries
 * @returns {{postings: Map<string, Map<string, number>>, df: Map<string, number>, lengths: Map<string, number>, N: number}}
 */
export function buildIndex(entries) {
  const postings = new Map();
  const df = new Map();
  const lengths = new Map();
  const list = Array.isArray(entries) ? entries : [];

  for (const entry of list) {
    // 以正文为主索引；已存的关键词额外加权（重复计入），因为它们是刻意提炼过的
    const tokens = tokenize(entry.text ?? '');
    if (Array.isArray(entry.keywords)) {
      for (const k of entry.keywords) {
        const kt = tokenize(k);
        tokens.push(...kt, ...kt);
      }
    }
    if (tokens.length === 0) continue;

    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    for (const [t, n] of tf) {
      let bucket = postings.get(t);
      if (bucket === undefined) {
        bucket = new Map();
        postings.set(t, bucket);
      }
      bucket.set(entry.id, n);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    lengths.set(entry.id, tokens.length);
  }

  return { postings, df, lengths, N: lengths.size };
}

/**
 * BM25-lite 检索，分数映射到 0~1（便于设阈值）。
 *
 * 归一化方式经过一次返工：最初用"命中证据 / 查询全部 token 的 idf 之和"，
 * 结果**永远匹配不上** —— 中文 bigram 会产生大量噪声 token（"序算""法还"），
 * 它们把分母顶得很大，一条明显相关的日记只能拿到 0.10 分。
 *
 * 现在改用**饱和函数**：只看命中了多少有区分度的证据，与查询长度解耦。
 *
 *     sim = 1 − exp(−Σgain / saturation)
 *
 * 好处：分数含义稳定 —— 命中 1 个实词约 0.4，命中 2 个约 0.67，完全无关是 0。
 * 阈值因此可以说人话，也不会因为用户多打几个字就掉到阈值以下。
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{limit?: number, saturation?: number}} [options]
 * @returns {Map<string, number>} id → 相似度 0~1（未命中的条目不会出现在 map 里）
 */

/**
 * 虚词 / 语气词 / 高频代词的单字表。
 *
 * **只用来判断"这句话是不是压根没内容"，不用来做分词。**
 * 一个字都不在这张表里，这句话就算有实词。
 *
 * 「好」「哈」也在里面 —— 它们单看是实词，但夹在「你好」「哈哈」这种两字里
 * 就是纯寒暄。宁可漏判（多翻一次记忆），也别把「你上次说的那个公园」挡掉：
 * **这张表只影响"整句全是这些字"的情况**。
 */
const FILLER_CHARS = new Set(
  '的了吗呢啊吧呀哦嗯么嘛唉诶哟哇啦咯喽呗呐嗨好哈呵嘿嘻是了在有我你他她它您这那哪个就都也还又很太不要能会可说对于把被给让跟和与或但而所以如果因然后先再才刚正啥什怎样多少点些一儿'.split(
    '',
  ),
);

/**
 * 这句话有没有内容？没内容就别去翻记忆。
 *
 * ── 为什么要有这道门 ──
 *
 * 「嗯」「好」「在吗」「然后呢」这种话，字面上什么实词都没有 ——
 * 拿它去检索，最好的情况是**空手而归白跑一趟**，最坏的情况是
 * 命中一堆"他今天说了嗯"之类的噪声，然后被当成"突然想起来"塞进注入。
 *
 * 所以：**没内容的话，这一轮不翻记忆。**
 *
 * 注意这道门**只管自动召回**（`renderFor` 里那一栏）——
 * 不管 `feiyu_recall` 工具。工具是它自己发起去查的，那是它要的，不该拦。
 *
 * 判据很土但够用：去掉标点空白后，**至少有一个字不在这张虚词表里**。
 * 不做模型判断 —— 这一层要是花一次模型调用，就为了判断"嗯"要不要查，
 * 那比它省下来的还贵。
 *
 * @param {unknown} query 用户这一轮说的话
 * @returns {boolean} true = 有内容，可以翻记忆
 */
export function queryHasSubstance(query) {
  // 只认字符串。`String({})` 会变成 "[object Object]"，那里面当然"有实词"——
  // 这种输入本来就该当成没内容，不是当成有话要说。
  if (typeof query !== 'string') return false;
  const s = query.replace(/[\s\p{P}\p{S}]/gu, '');
  if (s.length < 2) return false;
  for (const ch of s) if (!FILLER_CHARS.has(ch)) return true;
  return false;
}

/**
 * BM25-lite 检索，分数映射到 0~1（便于设阈值）。
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{limit?: number, saturation?: number}} [options]
 * @returns {Map<string, number>} id → 相似度 0~1（未命中的条目不会出现在 map 里）
 */
export function searchScores(index, query, options = {}) {
  const limit = options.limit ?? 50;
  const saturation = Number.isFinite(options.saturation) && options.saturation > 0
    ? options.saturation
    : 2;
  const scores = new Map();
  if (index.N === 0) return scores;

  // 查询侧去重：bigram 噪声里重复 token 不该重复计分
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return scores;

  const idf = (t) => Math.log(1 + (index.N + IDF_SMOOTH) / ((index.df.get(t) ?? 0) + IDF_SMOOTH));

  const k1 = 1.2;
  const b = 0.75;
  const avgLen =
    [...index.lengths.values()].reduce((s, n) => s + n, 0) / Math.max(1, index.lengths.size);

  const raw = new Map();
  for (const t of qTokens) {
    const bucket = index.postings.get(t);
    if (bucket === undefined) continue;
    const w = idf(t);
    for (const [id, tf] of bucket) {
      const len = index.lengths.get(id) ?? avgLen;
      const norm = 1 - b + (b * len) / Math.max(1, avgLen);
      const gain = (w * (tf * (k1 + 1))) / (tf + k1 * norm);
      raw.set(id, (raw.get(id) ?? 0) + gain);
    }
  }

  for (const [id, r] of raw) scores.set(id, Math.min(1, 1 - Math.exp(-r / saturation)));

  if (scores.size > limit) {
    const kept = [...scores.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, limit);
    return new Map(kept);
  }
  return scores;
}

/** 新鲜度：指数衰减 */
function recencyFactor(createdAt, now, halfLifeDays) {
  if (!Number.isFinite(createdAt)) return 0.5;
  const ageDays = Math.max(0, (now - createdAt) / 86400000);
  return Math.pow(0.5, ageDays / Math.max(0.5, halfLifeDays));
}

/**
 * @typedef {object} RecallOptions
 * @property {number} [highSim]        高相似必触发（默认 0.5 ≈ 共享 2 个以上实词）
 * @property {number} [midSim]         中相似进随机池（默认 0.25 ≈ 共享 1 个实词）
 * @property {number} [minSalience]    进入随机池的最低 salience（默认 0.5）
 * @property {number} [saturation]     相似度饱和尺度（默认 2）
 * @property {number} [a]              相似度权重（默认 1）
 * @property {number} [b]              salience 权重（默认 0.45）
 * @property {number} [c]              新鲜度权重（默认 0.2）
 * @property {number} [d]              最近刚提过的惩罚（默认 0.8）
 * @property {number} [temperature]    softmax 温度（默认 0.15）
 * @property {number} [cooldownTurns]  同一条的冷却轮数（默认 20）
 * @property {number} [maxShow]        每轮最多露几条（默认 1）
 * @property {number} [wanderChance]   没有强匹配时"走神"随机想起一条的概率（默认 0.08）
 * @property {number} [halfLifeDays]   新鲜度半衰期（默认 45）
 * @property {number} [now]            当前时间戳
 * @property {() => number} [rng]      注入随机源（测试用）
 */

export const DEFAULT_RECALL_OPTIONS = Object.freeze({
  highSim: 0.5,
  midSim: 0.25,
  minSalience: 0.5,
  saturation: 2,
  a: 1,
  b: 0.45,
  c: 0.2,
  d: 0.8,
  temperature: 0.15,
  cooldownTurns: 20,
  maxShow: 1,
  wanderChance: 0.08,
  halfLifeDays: 45,
});

/**
 * @typedef {object} RecallState
 * @property {Map<string, number>} [lastShownTurn]  条目 → 上次露出的轮次
 */

/**
 * 挑出这一轮要提起的记忆。
 *
 * @param {Array<object>} entries 全部日记条目
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query 本轮用户消息
 * @param {RecallState} state
 * @param {number} turn 当前轮次
 * @param {RecallOptions} [options]
 * @returns {{chosen: Array<{entry: object, score: number, sim: number, why: string}>, considered: number}}
 */
export function selectMemories(entries, index, query, state, turn, options = {}) {
  const opts = { ...DEFAULT_RECALL_OPTIONS, ...options };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const lastShownTurn = state?.lastShownTurn ?? new Map();

  const sims = searchScores(index, query, { saturation: opts.saturation });
  /** @type {Array<{entry: object, score: number, sim: number, why: string}>} */
  const scored = [];

  for (const entry of entries) {
    const sim = sims.get(entry.id) ?? 0;
    const salience = Number.isFinite(entry.salience) ? entry.salience : 0.5;

    // 冷却：刚提过就别再提
    const last = lastShownTurn.get(entry.id);
    if (Number.isFinite(last) && turn - last < opts.cooldownTurns) continue;

    const fresh = recencyFactor(entry.created_at, now, opts.halfLifeDays);
    const score =
      opts.a * sim + opts.b * salience + opts.c * fresh - (Number.isFinite(last) ? opts.d : 0);

    if (sim < opts.midSim && salience < opts.minSalience) continue;
    scored.push({ entry, score, sim, why: '' });
  }

  // 未解决的失败记忆：稍微加权，因为它们最该被主动提起
  const addWhy = (c, reason) => {
    c.why = c.why ? `${c.why} + ${reason}` : reason;
  };
  for (const c of scored) {
    if (c.entry.kind === 'failure' && c.entry.resolved !== true) {
      c.score += 0.15;
      addWhy(c, '未解决');
    }
  }

  scored.sort((x, y) => y.score - x.score);

  const strong = scored.filter((c) => c.sim >= opts.highSim);
  const chosen = [];

  // 1) 强匹配：必触发
  for (const c of strong.slice(0, opts.maxShow)) {
    addWhy(c, '强匹配');
    chosen.push(c);
  }

  // 2) 还不够，且允许走神：从中等候选里按 softmax 随机抽
  if (chosen.length < opts.maxShow) {
    const pool = scored.filter(
      (c) => !chosen.includes(c) && c.sim >= opts.midSim && (c.entry.salience ?? 0) >= opts.minSalience,
    );
    if (pool.length > 0) {
      const picked = softmaxPick(pool, opts.temperature, rng);
      if (picked !== undefined) {
        addWhy(picked, '想起来一点');
        chosen.push(picked);
      }
    }
  }

  // 3) 走神：完全没匹配上时，小概率随机想起一条旧事。这条纯粹为了像人。
  if (chosen.length === 0 && rng() < opts.wanderChance) {
    const pool = scored.filter((c) => (c.entry.salience ?? 0) >= opts.minSalience);
    if (pool.length > 0) {
      const picked = pool[Math.floor(rng() * pool.length)];
      addWhy(picked, '走神想起来的');
      chosen.push(picked);
    }
  }

  // 记下露出时间，供冷却使用
  for (const c of chosen) lastShownTurn.set(c.entry.id, turn);

  return { chosen, considered: scored.length };
}

/**
 * 按 softmax 概率抽一个。温度越低越接近"取最高分"。
 * @template T
 * @param {T[]} items 必须已按 score 降序，且每项有 .score
 * @param {number} temperature
 * @param {() => number} rng
 * @returns {T | undefined}
 */
export function softmaxPick(items, temperature, rng) {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  const t = Math.max(1e-6, temperature);
  const max = items[0].score;
  const exps = items.map((it) => Math.exp((it.score - max) / t));
  const sum = exps.reduce((s, e) => s + e, 0);
  if (!(sum > 0)) return items[0];
  let r = rng() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= exps[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
