/**
 * 档案层单测：.dshpack 往返、坏数据降级、迁移、合并、人格锚点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  createEmptyArchive,
  archiveToFiles,
  archiveFromFiles,
  packArchive,
  unpackArchive,
  migrateArchive,
  mergeArchives,
  ensurePersonaStructure,
  splitPersona,
  normalizeDiaryEntry,
  ANCHOR_BEGIN,
  ANCHOR_END,
  LEARNED_HEADING,
} from '../src/core/archive.mjs';
// 原本还 import 了 consolidate.mjs 的 appendPersonaLearnings —— 那个函数删了。

const NOW = 1773000000000;

function sampleArchive() {
  const a = createEmptyArchive(NOW, '# 我是谁\n我是蓝色大肥鱼。');
  a.diary.push(
    normalizeDiaryEntry({
      id: 'd1',
      text: '我没问清语言就动手了。',
      tags: ['代码'],
      kind: 'failure',
      salience: 0.8,
      resolved: false,
      created_at: NOW,
    }),
    normalizeDiaryEntry({
      id: 'd2',
      text: '他说他讨厌铺垫。',
      tags: ['偏好'],
      kind: 'chat',
      salience: 0.6,
      created_at: NOW + 1000,
    }),
  );
  a.relationship.traits.push({
    key: '答复',
    value: '要结论先行',
    confidence: 3,
    salience: 0.8,
    last_reinforced: NOW,
  });
  a.manifest.diary_count = 2;
  return a;
}

test('archive: .dshpack 往返一致', () => {
  const a = sampleArchive();
  const bytes = packArchive(a);
  const { archive: b, ok, warnings } = unpackArchive(bytes, { now: NOW });

  assert.equal(ok, true);
  assert.deepEqual(warnings, []);
  assert.equal(b.manifest.schema_version, SCHEMA_VERSION);
  assert.equal(b.diary.length, 2);
  assert.equal(b.diary[0].id, 'd1');
  assert.equal(b.diary[0].kind, 'failure');
  assert.equal(b.diary[0].resolved, false);
  assert.equal(b.diary[1].text, '他说他讨厌铺垫。');
  assert.equal(b.relationship.traits[0].value, '要结论先行');
  assert.ok(b.persona.includes('蓝色大肥鱼'));
});

test('archive: 日期跨月会拆成多个 jsonl 文件', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.diary.push(
    normalizeDiaryEntry({ id: 'a', text: '三月', created_at: Date.UTC(2026, 2, 5) }),
    normalizeDiaryEntry({ id: 'b', text: '四月', created_at: Date.UTC(2026, 3, 5) }),
  );
  const files = archiveToFiles(a);
  const months = files.map((f) => f.name).filter((n) => n.startsWith('diary/'));
  assert.deepEqual(months.sort(), ['diary/2026-03.jsonl', 'diary/2026-04.jsonl']);
});

test('archive: 日记坏行只丢一行，其余照读', () => {
  const files = [
    { name: 'manifest.json', data: JSON.stringify({ schema_version: 1, created_at: NOW }) },
    { name: 'persona.md', data: ensurePersonaStructure('# 我') },
    { name: 'relationship.json', data: '{}' },
    { name: 'lexicon.json', data: '{"items":[]}' },
    {
      name: 'diary/2026-03.jsonl',
      data: [
        JSON.stringify({ id: 'ok1', text: '好的第一条', created_at: NOW }),
        '{ 这不是 JSON',
        JSON.stringify({ id: 'ok2', text: '好的第二条', created_at: NOW + 1 }),
        '{"id":123}', // id 不是字符串 → 丢
      ].join('\n'),
    },
  ];
  const entries = files.map((f) => ({ name: f.name, text: () => f.data }));
  const { archive, warnings } = archiveFromFiles(entries, { now: NOW });

  assert.equal(archive.diary.length, 2);
  assert.deepEqual(archive.diary.map((d) => d.id), ['ok1', 'ok2']);
  assert.ok(warnings.some((w) => w.includes('2 行读不出来')), warnings.join(' | '));
});

test('archive: manifest 坏掉时按空档案处理而不是抛错', () => {
  const entries = [
    { name: 'manifest.json', text: () => '{ 坏掉的 manifest' },
    { name: 'persona.md', text: () => ensurePersonaStructure('# 我') },
  ];
  const { archive, warnings } = archiveFromFiles(entries, { now: NOW });
  assert.equal(archive.diary.length, 0);
  assert.ok(warnings.some((w) => w.includes('manifest')));
});

test('archive: 解不开的字节返回空档案 + ok=false，不抛', () => {
  const r = unpackArchive(new Uint8Array([1, 2, 3, 4]), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.archive.diary.length, 0);
  assert.ok(r.warnings[0].includes('解不开'));
});

test('archive: 缺少迁移函数时保留原档案并报警', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.manifest.schema_version = -5; // 逼出一条不存在的迁移链
  const { archive, warnings } = migrateArchive(a);
  assert.equal(archive.manifest.schema_version, -5);
  assert.ok(warnings.length > 0);
});

test('archive: 合并按 id 去重，base 优先', () => {
  const base = sampleArchive();
  const incoming = createEmptyArchive(NOW, 'x');
  incoming.diary.push(
    normalizeDiaryEntry({ id: 'd1', text: '重复的，应被忽略', created_at: NOW }),
    normalizeDiaryEntry({ id: 'd3', text: '新的', created_at: NOW + 2 }),
  );
  incoming.relationship.traits.push({
    key: '新偏好',
    value: '喜欢短句',
    confidence: 1,
    salience: 0.5,
    last_reinforced: NOW,
  });

  const merged = mergeArchives(base, incoming);
  assert.deepEqual(
    merged.diary.map((d) => d.id).slice().sort(),
    ['d1', 'd2', 'd3'],
    '三条都该在，且不重复',
  );
  // 合并后按时间排序；d1 的正文必须来自 base（base 优先）
  assert.equal(merged.diary.find((d) => d.id === 'd1').text, '我没问清语言就动手了。');
  assert.equal(merged.relationship.traits.length, 2);
});

test('persona: 结构保证锚点存在且幂等', () => {
  const once = ensurePersonaStructure('# 我是谁\n我是鱼。');
  const twice = ensurePersonaStructure(once);
  assert.equal(once, twice, 'ensurePersonaStructure 必须幂等');
  assert.ok(once.includes(ANCHOR_BEGIN));
  assert.ok(once.includes(ANCHOR_END));
  assert.ok(once.includes(LEARNED_HEADING));
});

test('persona: 锚点与已学部分能拆开', () => {
  const text = ensurePersonaStructure('# 我是谁\n我是鱼。');
  const { anchor, learned, structured } = splitPersona(text);
  assert.equal(structured, true);
  assert.ok(anchor.includes('我是鱼。'));
  assert.equal(learned, '');
});

/*
 * 这里原本有 3 项测试，覆盖 `appendPersonaLearnings`（把"学到的认知"追加到
 * persona.md 的 `## 我后来想明白的` 后面，带每日限流）。
 *
 * 那个函数**从来没有被任何地方调用过**。删它是有意的决定：
 * 接上它就等于同一类东西存两处（persona.md 一份、kind:"note" 一份）=
 * 双真相源 —— 这项目已经因为双写栽过两次。
 *
 * 现在判断只有一个家：`kind: "note"` 的日记条目 → 渲染成「我自己想的」。
 * 那部分的测试在 `test/host.test.mjs` 里（搜 「note:」）。
 *
 * 别把 `appendPersonaLearnings` 加回来 —— `consolidate.mjs` 里留了墓碑说明。
 */

test('persona: 结构化的 persona 永远带一个空的「我后来想明白的」区', () => {
  // 这一区**保留**，但它现在是人手写的地方（跟 手记.md 一个性质），
  // 插件永不自动写它。这个测试盯的是"结构还在"。
  const text = ensurePersonaStructure('# 我是谁\n我是鱼。');
  assert.ok(text.includes(LEARNED_HEADING), '标题必须保留');
  const { learned } = splitPersona(text);
  assert.equal(learned, '', '插件不该往里写任何东西');
});
