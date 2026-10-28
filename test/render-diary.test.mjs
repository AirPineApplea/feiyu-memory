/**
 * 人读版日记的渲染测试。
 *
 * 这一层的价值全在"能不能看懂"上，所以测试也围绕这个：
 * 头部要说清它是自动生成的、删掉的条目不能还在、倒序要是真的倒序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderDiaryMarkdown, renderDiaryFile } from '../src/core/render-diary.mjs';
import { createEmptyArchive, normalizeDiaryEntry, ensurePersonaStructure } from '../src/core/archive.mjs';

const NOW = new Date(2026, 9, 12, 22, 31).getTime(); // 本地 2026-10-12 22:31
const DAY = 86400000;

function archiveWith(entries, tweak = () => {}) {
  const a = createEmptyArchive(NOW - 5 * DAY, ensurePersonaStructure('# 我是谁\n蓝色大肥鱼。'));
  a.diary.push(...entries);
  tweak(a);
  return a;
}

const entry = (over = {}) =>
  normalizeDiaryEntry({
    id: 'd1',
    text: '今天他让我写排序，我没问清语言就动手了。',
    tags: ['代码'],
    kind: 'failure',
    salience: 0.7,
    resolved: false,
    created_at: NOW,
    ...over,
  });

test('render: 头部必须声明"自动生成、改它没用"', () => {
  const md = renderDiaryMarkdown(archiveWith([entry()]), { now: NOW });
  assert.ok(md.startsWith('# 肥鱼日记'));
  assert.ok(md.includes('自动生成'));
  assert.ok(md.includes('改它没用'));
  assert.ok(md.includes('persona.md'), '要告诉用户改人格去哪');
  assert.ok(md.includes('.jsonl'), '要告诉用户真数据在哪');
});

test('render: 统计与相识时长说人话', () => {
  const md = renderDiaryMarkdown(archiveWith([entry(), entry({ id: 'd2' })]), { now: NOW });
  assert.ok(md.includes('记了 **2** 条'), md.slice(0, 400));
  assert.ok(md.includes('认识 5 天'));
});

test('render: 刚建档案时说"今天刚认识"', () => {
  const a = createEmptyArchive(NOW, 'x');
  const md = renderDiaryMarkdown(a, { now: NOW });
  assert.ok(md.includes('今天刚认识'));
  assert.ok(md.includes('## 还没有日记'));
});

test('render: 关系摘要包含昵称、偏好（账那一栏已删）', () => {
  const a = archiveWith([entry()], (x) => {
    x.relationship.nickname = '蓝色大肥鱼';
    x.relationship.traits.push({ key: 'k1', value: '讨厌铺垫', confidence: 3, salience: 0.9, last_reinforced: NOW });
  });
  const md = renderDiaryMarkdown(a, { now: NOW });
  assert.ok(md.includes('他管我叫「蓝色大肥鱼」'));
  assert.ok(md.includes('讨厌铺垫'));
  // 「我还欠着他的」/「已经翻篇的」两行随功能删除（2026-10-24）。
  assert.ok(!md.includes('我还欠着他的'), '这一栏已经删了，不该再出现');
});

test('render: 低活跃的词不进人读版', () => {
  const a = archiveWith([entry()], (x) => {
    x.lexicon.items.push(
      { term: '白饭', salience: 0.9 },
      { term: '早就忘了的', salience: 0.01 },
    );
  });
  const md = renderDiaryMarkdown(a, { now: NOW });
  assert.ok(md.includes('白饭'));
  assert.ok(!md.includes('早就忘了的'));
});

test('render: 日记按时间倒序 —— 打开就想看最近的', () => {
  const a = archiveWith([
    entry({ id: 'old', text: '较早的一条', created_at: NOW - 2 * 3600000 }),
    entry({ id: 'new', text: '较新的一条', created_at: NOW }),
  ]);
  const md = renderDiaryMarkdown(a, { now: NOW });
  assert.ok(md.indexOf('较新的一条') < md.indexOf('较早的一条'), '新的要排在前面');
});

test('render: 跨月会分组，月份也倒序', () => {
  const sept = new Date(2026, 8, 20, 10, 0).getTime();
  const a = archiveWith([
    entry({ id: 's', text: '九月的事', date: '2026-09-20', created_at: sept }),
    entry({ id: 'o', text: '十月的事', date: '2026-10-12', created_at: NOW }),
  ]);
  const md = renderDiaryMarkdown(a, { now: NOW });
  assert.ok(md.includes('## 2026 年 10 月'));
  assert.ok(md.includes('## 2026 年 9 月'));
  assert.ok(md.indexOf('## 2026 年 10 月') < md.indexOf('## 2026 年 9 月'));
});

test('render: 条目带上人类可读的分类与状态，而不是枚举值', () => {
  const md = renderDiaryMarkdown(archiveWith([entry()]), { now: NOW });
  assert.ok(md.includes('搞砸了'), 'failure 要说人话');
  assert.ok(!md.includes('failure'), '不该把枚举值直接漏给用户');
  assert.ok(md.includes('还欠着'), '未解决的失败要标出来');
  assert.ok(md.includes('重要度 0.70'));
  // tags 2026-10-27 停止产出，人读版不再写它
  assert.ok(!md.includes('代码'), '标签不再往人读版里写');
  assert.ok(md.includes('d1'), '带上 id，方便用户去 jsonl 里删');
});

test('render: 已解决的失败标"已解决"', () => {
  const md = renderDiaryMarkdown(archiveWith([entry({ resolved: true })]), { now: NOW });
  assert.ok(md.includes('已解决'));
  assert.ok(!md.includes('还欠着'));
});

test('render: 未知 kind 不会渲染出 undefined', () => {
  // 第一层：档案层已经把未知 kind 规整成 chat 了
  const sanitized = renderDiaryMarkdown(archiveWith([entry({ kind: 'weird' })]), { now: NOW });
  assert.ok(!sanitized.includes('undefined'));
  assert.ok(sanitized.includes('闲聊'));

  // 第二层：渲染器自己的兜底 —— 针对被手改坏的 jsonl（绕过档案层）
  const raw = createEmptyArchive(NOW, 'x');
  raw.diary.push({ id: 'raw', text: '一条手改坏了 kind 的记录', kind: '乱写的', created_at: NOW });
  const md = renderDiaryMarkdown(raw, { now: NOW });
  assert.ok(!md.includes('undefined'));
  assert.ok(md.includes('记一笔'));
});

test('render: 坏数据不炸', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.diary.push({ id: 'x', text: '' }); // 缺一堆字段
  assert.doesNotThrow(() => renderDiaryMarkdown(a, { now: NOW }));
  assert.doesNotThrow(() => renderDiaryMarkdown({}, { now: NOW }));
  assert.doesNotThrow(() => renderDiaryMarkdown(null, { now: NOW }));
});

test('render: 文件版末尾只有一个换行', () => {
  const s = renderDiaryFile(archiveWith([entry()]), { now: NOW });
  assert.ok(s.endsWith('\n'));
  assert.ok(!s.endsWith('\n\n'));
});
