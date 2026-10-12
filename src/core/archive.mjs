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

  return {
    archive: {
      manifest: {
        schema_version: SCHEMA_VERSION,
        created_at: Number(manifest.created_at) || now,
        updated_at: Number(manifest.updated_at) || now,
        last_seen_at: Number(manifest.last_seen_at) || 0,
        session_count: Number(manifest.session_count) || 0,
        diary_count: diary.length,
        generator: typeof manifest.generator === 'string' ? manifest.generator : 'feiyu-memory',
      },
      persona: ensurePersonaStructure(persona),
      relationship: sanitizeRelationship(relationship),
      lexicon: { items: Array.isArray(lexicon.items) ? lexicon.items : [] },
      diary,
    },
    warnings,
  };
}

/** 把一条日记规整成合法形状，缺字段补默认值 */
export function normalizeDiaryEntry(raw) {
  const KINDS = new Set(['failure', 'win', 'chat', 'disclosure', 'grievance']);
  return {
    id: String(raw.id),
    date: typeof raw.date === 'string' ? raw.date : new Date(Number(raw.created_at) || Date.now()).toISOString().slice(0, 10),
    text: String(raw.text),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
    kind: KINDS.has(raw.kind) ? raw.kind : 'chat',
    salience: clamp01(raw.salience, 0.5),
    ...(raw.kind === 'failure' ? { resolved: raw.resolved === true } : {}),
    ...(typeof raw.session === 'string' ? { session: raw.session } : {}),
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

/** 两个档案的合并策略：把 incoming 的条目并进 base，按 id 去重，base 优先 */
export function mergeArchives(base, incoming) {
  const seen = new Set(base.diary.map((e) => e.id));
  const merged = [...base.diary];
  for (const e of incoming.diary) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
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
