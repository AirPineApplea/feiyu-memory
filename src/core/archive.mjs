/**
 * 档案层 —— `.dshpack` 的读写、校验、迁移。
 *
 * 这一层是**纯函数**：只在「文件名 → 文本」的映射上工作，不碰磁盘。
 * 真正的 IO 由 host 层负责（走 DSH 的 fs 服务或 node:fs）。
 * 这样核心逻辑可以完全脱机测试，也保证档案格式与运行环境解耦。
 */

import { zipSync, unzipSync } from './zip.mjs';

/** 当前档案格式版本。改格式必须同时加迁移函数。 */
export const SCHEMA_VERSION = 1;

export const MANIFEST_FILE = 'manifest.json';
export const PERSONA_FILE = 'persona.md';
export const RELATIONSHIP_FILE = 'relationship.json';
export const LEXICON_FILE = 'lexicon.json';
export const DIARY_DIR = 'diary';

/** 人格锚点的分界注释 —— 锚点块永不被自动改写（SPEC §1.2） */
export const ANCHOR_BEGIN = '<!-- feiyu:anchor:begin -->';
export const ANCHOR_END = '<!-- feiyu:anchor:end -->';

/** 自动学到的认知写在这一行之后 */
export const LEARNED_HEADING = '## 我后来想明白的';

/**
 * @typedef {object} DiaryEntry
 * @property {string} id
 * @property {string} date            YYYY-MM-DD
 * @property {string} text            第一人称
 * @property {string[]} tags
 * @property {'failure'|'win'|'chat'|'disclosure'|'grievance'} kind
 * @property {number} salience        0~1
 * @property {boolean} [resolved]     仅 failure 有意义
 * @property {string} [session]
 * @property {number} created_at
 * @property {string[]} [keywords]
 */

/**
 * @typedef {object} Trait
 * @property {string} key
 * @property {string} value
 * @property {number} confidence      被观察到几次
 * @property {number} salience
 * @property {number} last_reinforced
 */

/**
 * @typedef {object} Grievance
 * @property {string} id
 * @property {string} what
 * @property {number} intensity
 * @property {boolean} resolved
 * @property {number} created_at
 */

/**
 * @typedef {object} Archive
 * @property {object} manifest
 * @property {string} persona
 * @property {object} relationship
 * @property {object} lexicon
 * @property {DiaryEntry[]} diary
 */

/* ───────────────────────── 默认值 ───────────────────────── */

/**
 * @param {number} [now]
 * @param {string} [persona] 出厂人格正文
 * @returns {Archive}
 */
export function createEmptyArchive(now = Date.now(), persona = '') {
  return {
    manifest: {
      schema_version: SCHEMA_VERSION,
      created_at: now,
      updated_at: now,
      last_seen_at: 0,
      session_count: 0,
      diary_count: 0,
      generator: 'feiyu-memory',
      /**
       * **墓碑**：被删掉的日记 id，只增不减。
       *
       * 为什么需要它：档案被很多个会话同时打开，落盘时整份重写。
       * 落盘前的三路合并要能区分"别人刚加的"和"我们删掉的"——
       * 光靠"加载时的基线"不够：**本会话自己新增、又自己删掉的条目
       * 不在基线里**，会被当成"别人刚加的"捞回来（`burn()` 就是这么坏的）。
       *
       * 所以删除必须留个记号。老档案没有这个字段 → 当空数组处理。
       */
      deleted_ids: /** @type {string[]} */ ([]),
    },
    persona: ensurePersonaStructure(persona),
    relationship: {
      familiarity: 0,
      nickname: '',
      traits: /** @type {Trait[]} */ ([]),
      grievances: /** @type {Grievance[]} */ ([]),
    },
    lexicon: { items: /** @type {Array<object>} */ ([]) },
    diary: /** @type {DiaryEntry[]} */ ([]),
  };
}

/* ───────────────────────── persona 结构 ───────────────────────── */

/**
 * 保证人格文本有锚点分界。已经有就原样返回。
 * 用户的自由文本一律进锚点块（他写的就是"出厂设定"），
 * 自动学到的东西只能写在 `## 我后来想明白的` 之后。
 *
 * @param {string} text
 * @returns {string}
 */
export function ensurePersonaStructure(text) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (body.includes(ANCHOR_BEGIN) && body.includes(ANCHOR_END)) return body;
  // 末尾不留空行 —— 否则这个函数不是幂等的，每次读档案都会多出一个换行
  return [ANCHOR_BEGIN, '', body, '', ANCHOR_END, '', LEARNED_HEADING, ''].join('\n').trimEnd();
}

/**
 * 拆出锚点与已学部分。
 * @param {string} text
 * @returns {{anchor: string, learned: string, structured: boolean}}
 */
export function splitPersona(text) {
  const src = typeof text === 'string' ? text : '';
  const begin = src.indexOf(ANCHOR_BEGIN);
  const end = src.indexOf(ANCHOR_END);
  if (begin < 0 || end < 0 || end < begin) {
    return { anchor: src.trim(), learned: '', structured: false };
  }
  const anchor = src.slice(begin + ANCHOR_BEGIN.length, end).trim();
  const rest = src.slice(end + ANCHOR_END.length);
  const headingAt = rest.indexOf(LEARNED_HEADING);
  const learned = headingAt >= 0 ? rest.slice(headingAt + LEARNED_HEADING.length).trim() : rest.trim();
  return { anchor, learned, structured: true };
}

/* ───────────────────────── 序列化 ───────────────────────── */

/**
 * 把档案拆成 zip 条目。**diary 按月份分文件**，追加安全、坏一行只丢一行。
 *
 * @param {Archive} archive
 * @returns {Array<{name: string, data: string}>}
 */
export function archiveToFiles(archive) {
  const files = [];

  const manifest = { ...archive.manifest };
  manifest.schema_version = SCHEMA_VERSION;
  manifest.diary_count = archive.diary.length;
  files.push({ name: MANIFEST_FILE, data: JSON.stringify(manifest, null, 2) + '\n' });

  files.push({ name: PERSONA_FILE, data: ensurePersonaStructure(archive.persona) + '\n' });
  files.push({ name: RELATIONSHIP_FILE, data: JSON.stringify(archive.relationship, null, 2) + '\n' });
  files.push({ name: LEXICON_FILE, data: JSON.stringify(archive.lexicon, null, 2) + '\n' });

  const byMonth = new Map();
  for (const entry of archive.diary) {
    const month = (entry.date ?? '').slice(0, 7) || 'unknown';
    const list = byMonth.get(month) ?? [];
    list.push(entry);
    byMonth.set(month, list);
  }
  for (const [month, list] of [...byMonth].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const data = list.map((e) => JSON.stringify(e)).join('\n') + '\n';
    files.push({ name: `${DIARY_DIR}/${month}.jsonl`, data });
  }

  return files;
}

/**
 * 从 zip 条目还原档案。**永不抛错** —— 坏数据降级成 warnings，
 * 因为"记忆坏了不能挡住聊天"（SPEC §10）。
 *
 * @param {Array<{name: string, text: () => string}>} entries
 * @param {{now?: number}} [options]
 * @returns {{archive: Archive, warnings: string[]}}
 */
export function archiveFromFiles(entries, options = {}) {
  const now = options.now ?? Date.now();
  /** @type {string[]} */
  const warnings = [];
  const byName = new Map();
  for (const e of entries) {
    try {
      byName.set(e.name, e.text());
    } catch (err) {
      warnings.push(`读不出 ${e.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(byName.get(MANIFEST_FILE) ?? '{}');
  } catch {
    manifest = {};
    warnings.push('manifest.json 解析失败，按空档案处理');
  }

  const version = Number(manifest.schema_version);
  if (!Number.isFinite(version)) {
    warnings.push('manifest 缺少 schema_version，按当前版本处理');
  } else if (version > SCHEMA_VERSION) {
    warnings.push(
      `档案版本 ${version} 比本插件（${SCHEMA_VERSION}）新，可能读不全新字段；只读不写更安全`,
    );
  } else if (version < SCHEMA_VERSION) {
    warnings.push(`档案版本 ${version} 需要迁移到 ${SCHEMA_VERSION}`);
  }

  const persona = readText(byName, PERSONA_FILE, '');
  const relationship = readJson(byName, RELATIONSHIP_FILE, warnings, {
    familiarity: 0,
    nickname: '',
    traits: [],
    grievances: [],
  });
  const lexicon = readJson(byName, LEXICON_FILE, warnings, { items: [] });

  /** @type {DiaryEntry[]} */
  const diary = [];
  let dropped = 0;
  for (const [name, text] of byName) {
    if (!name.startsWith(`${DIARY_DIR}/`) || !name.endsWith('.jsonl')) continue;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.id === 'string' && typeof parsed.text === 'string') {
          diary.push(normalizeDiaryEntry(parsed));
        } else {
          dropped++;
        }
      } catch {
        dropped++;
      }
    }
  }
  if (dropped > 0) warnings.push(`日记里有 ${dropped} 行读不出来，已跳过`);

  diary.sort((a, b) => a.created_at - b.created_at);

  // ── 墓碑在这里也必须生效 ──
  //
  // 社区报的（这次比前两个严重）：焚毁 / 忘掉一条之后，内存里没了，
  // **磁盘上那份 jsonl 没被重写** —— 于是重启一读，删掉的内容全回来了。
  //
  // 为什么之前只在 mergeArchives 里过滤：那个函数是"磁盘 + 内存"的三路合并，
  // 它需要墓碑来判断"这条是我删的还是别人加的"。但**加载这一步不经过它** ——
  // 启动时直接 archiveFromFiles(entries)，磁盘上有什么就读什么。
  //
  // 所以过滤要做两处：合并时一次，**读盘时也要一次**。
  // （导入包依然是"先撤碑、再读"，见 importPack —— 那是用户明确要把东西拿回来。）
  const tombstones = new Set(
    Array.isArray(manifest.deleted_ids) ? manifest.deleted_ids.filter((x) => typeof x === 'string') : [],
  );
  const visible = tombstones.size > 0 ? diary.filter((e) => !tombstones.has(e.id)) : diary;
  const resurrected = diary.length - visible.length;
  if (resurrected > 0) {
    warnings.push(`按墓碑跳过 ${resurrected} 条已删除的日记（它们还躺在磁盘上）`);
  }

  return {
    archive: {
      manifest: {
        schema_version: SCHEMA_VERSION,
        created_at: Number(manifest.created_at) || now,
        updated_at: Number(manifest.updated_at) || now,
        last_seen_at: Number(manifest.last_seen_at) || 0,
        session_count: Number(manifest.session_count) || 0,
        diary_count: visible.length,
        generator: typeof manifest.generator === 'string' ? manifest.generator : 'feiyu-memory',
        // 墓碑必须活过一轮读写 —— 它靠的就是"删过的永不再来"。
        // 这里漏了它，落盘一次墓碑就没了，删除立刻开始复活。
        deleted_ids: Array.isArray(manifest.deleted_ids)
          ? manifest.deleted_ids.filter((x) => typeof x === 'string')
          : [],
      },
      persona: ensurePersonaStructure(persona),
      relationship: sanitizeRelationship(relationship),
      lexicon: { items: Array.isArray(lexicon.items) ? lexicon.items : [] },
      diary: visible,
    },
    warnings,
  };
}

/** 把一条日记规整成合法形状，缺字段补默认值 */
export function normalizeDiaryEntry(raw) {
  // 'note' = **哪个肥鱼自己主动留下的**，不是固化模型生成的那种。
  // 未知 kind 会退化成 'chat'，所以加一个新值不会让老档案读不了 ——
  // 不需要 schema 版本迁移。
  const KINDS = new Set(['failure', 'win', 'chat', 'disclosure', 'grievance', 'note']);
  return {
    id: String(raw.id),
    date: typeof raw.date === 'string' ? raw.date : new Date(Number(raw.created_at) || Date.now()).toISOString().slice(0, 10),
    text: String(raw.text),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
    kind: KINDS.has(raw.kind) ? raw.kind : 'chat',
    salience: clamp01(raw.salience, 0.5),
    ...(raw.kind === 'failure' ? { resolved: raw.resolved === true } : {}),
    ...(typeof raw.session === 'string' ? { session: raw.session } : {}),
    // 轮次 —— "续写同一条日记"靠它算窗口。
    // 老条目没有这个字段，Number.isFinite(undefined) 是 false，所以它们永远不续写。
    ...(Number.isFinite(raw.turn) ? { turn: Number(raw.turn) } : {}),
    // 最后一次被追加的时间。created_at 不动，但排序看它 ——
    // 否则刚续写的那条会按原始时间沉到下面去。
    ...(Number.isFinite(raw.updated_at) ? { updated_at: Number(raw.updated_at) } : {}),
    created_at: Number(raw.created_at) || Date.now(),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k) => typeof k === 'string').slice(0, 16) : [],
  };
}

function sanitizeRelationship(raw) {
  const traits = Array.isArray(raw?.traits)
    ? raw.traits
        .filter((t) => t && typeof t.key === 'string' && typeof t.value === 'string')
        .map((t) => ({
          key: t.key,
          value: t.value,
          // 产生这个印象的那个具体瞬间。没有它，注入区就读起来像"用户说明书"。
          evidence: typeof t.evidence === 'string' ? t.evidence : '',
          // 'user' = 我对他的印象；'self' = 我给自己定的规矩。两者不能混。
          about: t.about === 'self' ? 'self' : 'user',
          confidence: Number(t.confidence) || 1,
          salience: clamp01(t.salience, 0.5),
          last_reinforced: Number(t.last_reinforced) || Date.now(),
        }))
    : [];
  const grievances = Array.isArray(raw?.grievances)
    ? raw.grievances
        .filter((g) => g && typeof g.what === 'string')
        .map((g, i) => ({
          id: typeof g.id === 'string' ? g.id : `g${i}`,
          what: g.what,
          intensity: clamp01(g.intensity, 0.5),
          resolved: g.resolved === true,
          created_at: Number(g.created_at) || Date.now(),
        }))
    : [];
  return {
    familiarity: clamp01(raw?.familiarity, 0),
    nickname: typeof raw?.nickname === 'string' ? raw.nickname : '',
    traits,
    grievances,
  };
}

function readText(map, name, fallback) {
  const v = map.get(name);
  return typeof v === 'string' ? v : fallback;
}

function readJson(map, name, warnings, fallback) {
  const text = map.get(name);
  if (typeof text !== 'string') return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    warnings.push(`${name} 解析失败，用默认值顶上：${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

function clamp01(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/* ───────────────────────── 打包 / 解包 ───────────────────────── */

/**
 * 打包成 `.dshpack` 字节。默认压缩（日记是文本，压缩收益明显）。
 * @param {Archive} archive
 * @param {{compress?: boolean, date?: Date}} [options]
 * @returns {Uint8Array}
 */
export function packArchive(archive, options = {}) {
  return zipSync(archiveToFiles(archive), { compress: options.compress !== false, date: options.date });
}

/**
 * 解包 `.dshpack`。任何失败都变成 warning + 尽可能还原，不抛给调用方。
 *
 * @param {Uint8Array} bytes
 * @param {{now?: number}} [options]
 * @returns {{archive: Archive, warnings: string[], ok: boolean}}
 */
export function unpackArchive(bytes, options = {}) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    return {
      archive: createEmptyArchive(options.now),
      warnings: [`档案解不开，已按空档案处理：${err instanceof Error ? err.message : String(err)}`],
      ok: false,
    };
  }
  const { archive, warnings } = archiveFromFiles(entries, options);
  return { archive, warnings, ok: true };
}

/* ───────────────────────── 迁移 ───────────────────────── */

/**
 * 迁移表：键是**目标版本**，值是把上一版升到该版的函数。
 *
 * 目前只有 v1，所以是空的。以后加 v2 就在这里写 `2: (archive) => {...}`，
 * 并**同时**补一个测试。迁移必须是纯函数、幂等。
 *
 * @type {Record<number, (archive: any) => any>}
 */
export const MIGRATIONS = {
  // 2: (archive) => ({ ...archive, manifest: { ...archive.manifest, schema_version: 2 } }),
};

/**
 * 把档案从它自己的版本升到 SCHEMA_VERSION。迁移函数缺失时**保留原档案并报警**，
 * 绝不半途改坏用户的记忆。
 *
 * @param {Archive} archive
 * @returns {{archive: Archive, warnings: string[]}}
 */
export function migrateArchive(archive) {
  const warnings = [];
  let current = archive;
  let version = Number(current.manifest?.schema_version) || 1;

  if (version > SCHEMA_VERSION) {
    warnings.push(`档案版本 ${version} 高于本插件支持的 ${SCHEMA_VERSION}，不做迁移`);
    return { archive: current, warnings };
  }

  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    const step = MIGRATIONS[next];
    if (typeof step !== 'function') {
      warnings.push(`缺少从 v${version} 到 v${next} 的迁移，保留原档案`);
      break;
    }
    try {
      current = step(current);
      current.manifest = { ...current.manifest, schema_version: next };
      version = next;
    } catch (err) {
      warnings.push(`从 v${version} 迁移到 v${next} 失败：${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return { archive: current, warnings };
}

/**
 * 两个档案的合并策略：把 incoming 的条目并进 base，按 id 去重，base 优先。
 *
 * ── 传了 `baselineIds` 就是**三路合并**，这是并发写入的正解 ──
 *
 * 场景：同一份档案被很多个会话同时打开（实测 10 个），每个会话启动时读进内存、
 * 落盘时**整份重写**。不合并的话，谁后落盘谁赢，另一个刚写的条目被静默抹掉。
 *
 * 但只做并集（`base ∪ incoming`）会**把删除弄坏** —— 落盘前读一次磁盘，
 * 刚删掉的条目又回来了。三条测试当场抓到。
 *
 * 所以需要第三个信息：**这个会话加载时磁盘上有什么**（`baselineIds`）。
 * 有了它，"谁删了什么"就能推出来：
 *
 *   | 内存 | 磁盘 | 基线 | 含义 | 处置 |
 *   |---|---|---|---|---|
 *   | 有 | 有 | — | 两边都有 | 留内存的（它对已知条目最新） |
 *   | 有 | 无 | 有 | **别人删了它** | 丢掉，别复活 |
 *   | 有 | 无 | 无 | 我们自己刚加的 | 留着 |
 *   | 无 | 有 | 有 | **我们自己删了它** | 不加回来 |
 *   | 无 | 有 | 无 | **别人刚加的** | 并进来 |
 *   | 无 | 无 | — | 都删了 | 没有 |
 *
 * ⚠️ 光有基线**不够**：本会话自己新增、又自己删掉的条目不在基线里，
 * 按上表会被当成"别人刚加的"捞回来 —— 面板上那个「忘掉」和「焚毁」
 * 就是这样坏掉的，三条测试当场抓到。
 *
 * 所以还要一张**墓碑**（`manifest.deleted_ids`）：删过的 id 只增不减，
 * **夹在两边的墓碑并集里就永远不加回来**。它同时管住了跨会话的删除。
 *
 * 不传 `baselineIds` 时退回简单并集（老行为），给不关心删除的调用方用。
 *
 * ⚠️ **调用方有责任保证磁盘真的读到了**：磁盘读失败时如果还传一个空基线，
 * 上表第一行会全部退化成"别人删了它"，**整个档案会被清空**。
 * 读不到就别调这个函数。
 *
 * @param {object} base 内存里的档案（优先）
 * @param {object} incoming 磁盘上的档案
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.baselineIds] 加载时磁盘上的 id 集合
 */
export function mergeArchives(base, incoming, options = {}) {
  const baseline =
    options.baselineIds instanceof Set
      ? options.baselineIds
      : Array.isArray(options.baselineIds)
        ? new Set(options.baselineIds)
        : null;

  // 墓碑取并集：两边删过的都算删过，谁也别复活
  const tombstones = new Set([
    ...(base.manifest?.deleted_ids ?? []),
    ...(incoming.manifest?.deleted_ids ?? []),
  ]);

  const memoryIds = new Set(base.diary.map((e) => e.id));
  const diskIds = new Set(incoming.diary.map((e) => e.id));

  let merged;
  if (baseline === null) {
    merged = [...base.diary];
    for (const e of incoming.diary) if (!memoryIds.has(e.id)) merged.push(e);
  } else {
    merged = [];
    // 1) 内存里的：磁盘没有它，而基线有 → 别人删了，丢掉
    for (const e of base.diary) {
      if (diskIds.has(e.id)) { merged.push(e); continue; }
      if (baseline.has(e.id)) continue; // 别人删的
      merged.push(e); // 我们自己刚加的
    }
    // 2) 磁盘上的：内存没有它 → 先问墓碑，再问基线
    for (const e of incoming.diary) {
      if (memoryIds.has(e.id)) continue;
      if (tombstones.has(e.id)) continue; // 删过，永不复活
      if (baseline.has(e.id)) continue; // 我们自己删的
      merged.push(e); // 别人刚加的
    }
  }
  // ⚠️ **这里不要再兜底过滤一遍。**
  //
  // 写过一版 `merged = merged.filter(e => !tombstones.has(e.id))`，看着更保险，
  // 实际把**导入**弄坏了：焚毁立碑 → 导入同一个包 → 磁盘上的墓碑还在
  // （墓碑取并集）→ 刚导入的条目被滤掉 → **导入等于没导**。端到端测试当场抓到。
  //
  // 正解是各管各的：
  //   · 内存里活着的条目**以内存为准** —— 它要么是我们刚加的，要么已经
  //     在循环 1 里按基线判过了
  //   · 墓碑只管"**从磁盘新加进来的**"那一路（循环 2），也就是基线
  //     帮不上忙的那一种
  merged.sort((a, b) => a.created_at - b.created_at);

  const traitByKey = new Map(base.relationship.traits.map((t) => [t.key, t]));
  for (const t of incoming.relationship.traits) {
    const existing = traitByKey.get(t.key);
    if (existing === undefined) traitByKey.set(t.key, t);
    else existing.confidence = Math.max(existing.confidence, t.confidence);
  }

  const grievanceIds = new Set(base.relationship.grievances.map((g) => g.id));
  const grievances = [...base.relationship.grievances];
  for (const g of incoming.relationship.grievances) {
    if (grievanceIds.has(g.id)) continue;
    grievanceIds.add(g.id);
    grievances.push(g);
  }

  const termSet = new Set((base.lexicon.items ?? []).map((i) => i.term));
  const items = [...(base.lexicon.items ?? [])];
  for (const item of incoming.lexicon.items ?? []) {
    if (termSet.has(item.term)) continue;
    termSet.add(item.term);
    items.push(item);
  }

  return {
    manifest: {
      ...base.manifest,
      created_at: Math.min(base.manifest.created_at, incoming.manifest.created_at),
      updated_at: Date.now(),
      diary_count: merged.length,
      deleted_ids: [...tombstones],
    },
    persona: base.persona,
    relationship: {
      familiarity: Math.max(base.relationship.familiarity, incoming.relationship.familiarity),
      nickname: base.relationship.nickname || incoming.relationship.nickname,
      traits: [...traitByKey.values()],
      grievances,
    },
    lexicon: { items },
    diary: merged,
  };
}
