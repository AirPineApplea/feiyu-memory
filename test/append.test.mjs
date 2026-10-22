import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyArchive, normalizeDiaryEntry } from '../src/core/archive.mjs';
import { applyConsolidation, DEFAULT_CONSOLIDATION, buildConsolidationInput } from '../src/core/consolidate.mjs';

const NOW = Date.parse('2026-10-22T22:00:00+08:00');

/** 造一个已经有一条日记的档案 */
function withOneEntry(over = {}) {
  const a = createEmptyArchive(NOW, 'sess-1');
  a.diary.push(
    normalizeDiaryEntry({
      id: 'd_20261022_01',
      text: '他让我把出厂人格从硬编码里搬出来。改完第一次跑就 ENOENT 炸了，路径写错。',
      tags: ['重构'],
      kind: 'chat',
      salience: 0.6,
      session: 'sess-1',
      turn: 10,
      created_at: NOW - 60_000,
      keywords: ['人格'],
      ...over,
    }),
  );
  return a;
}

/* ───────────────────── 档案字段 ───────────────────── */

test('archive: turn / updated_at 会被保留（老档案没有也不报错）', () => {
  const withTurn = normalizeDiaryEntry({ id: 'x', text: 'a', created_at: 1, turn: 7, updated_at: 9 });
  assert.equal(withTurn.turn, 7);
  assert.equal(withTurn.updated_at, 9);

  const old = normalizeDiaryEntry({ id: 'y', text: 'b', created_at: 1 });
  assert.equal('turn' in old, false, '老条目没有 turn');
  assert.equal('updated_at' in old, false);
});

/* ───────────────────── 续写 ───────────────────── */

test('append: 拼到已有那条后面，不新建条目', () => {
  const a = withOneEntry();
  const before = a.diary.length;

  const r = applyConsolidation(
    a,
    { skip: false, diary: { append: '然后又写了一遍，因为第一次路径写错了。', salience: 0.5 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );

  assert.equal(r.accepted, true);
  assert.equal(r.appended, true, '要标明这是续写，不是新条目');
  assert.equal(r.archive.diary.length, before, '条数不能变');
  assert.ok(r.archive.diary[0].text.includes('然后又写了一遍'), '新内容要拼上去');
  assert.ok(r.archive.diary[0].text.includes('ENOENT'), '旧内容不能丢');
});

test('append: updated_at 会更新，created_at 不动', () => {
  const a = withOneEntry();
  const originalCreated = a.diary[0].created_at;

  const r = applyConsolidation(
    a,
    { skip: false, diary: { append: '补一句。', salience: 0.5 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );

  assert.equal(r.archive.diary[0].created_at, originalCreated, 'created_at 是它出生的时间');
  assert.equal(r.archive.diary[0].updated_at, NOW, 'updated_at 是它最后一次长大的时间');
});

test('append: salience 取高的那个（同一件事越聊越重）', () => {
  const a = withOneEntry({ salience: 0.7 });
  const r = applyConsolidation(
    a,
    { skip: false, diary: { append: '又是这件事。', salience: 0.4 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );
  assert.equal(r.archive.diary[0].salience, 0.7, '不能被后一次的低分拉下来');
});

test('append: 超过 appendMaxChars 就不拼，也不新建', () => {
  const a = withOneEntry();
  const huge = '字'.repeat(DEFAULT_CONSOLIDATION.appendMaxChars);

  const r = applyConsolidation(
    a,
    { skip: false, diary: { append: huge, salience: 0.6 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );

  assert.equal(r.accepted, false, '拼不下就别动');
  assert.equal(r.archive.diary.length, 1);
  assert.equal(r.archive.diary[0].text.length < 200, true, '原来那条不能被撑大');
});

test('append: 要续写的那条找不到（比如被删了）→ 丢弃', () => {
  const a = withOneEntry();
  const r = applyConsolidation(
    a,
    { skip: false, diary: { append: '补一句。', salience: 0.6 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_不存在_99' },
    {},
  );
  assert.equal(r.accepted, false);
  assert.equal(r.archive.diary.length, 1);
});

test('append: 没给 extendId 时，append 不会乱拼（走新建那条路）', () => {
  const a = withOneEntry();
  const r = applyConsolidation(
    a,
    { skip: false, diary: { append: '补一句。', salience: 0.6 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11 },
    {},
  );
  // append 只有在明确知道"续哪条"时才生效；没有 extendId 就当没看见
  assert.equal(r.appended, false);
  assert.equal(r.archive.diary.length, 1, '不能凭空多一条');
});

/* ───────────────────── 输入组装 ───────────────────── */

test('build: 有 extend 时把旧文本和"只写多出来的"一起给模型', () => {
  const b = buildConsolidationInput({
    transcript: '他：又改了一版',
    extend: { id: 'd_1', text: '上一轮写的那条。' },
  });
  assert.ok(b.user.includes('这条已经记过了'), '要告诉模型这是延续');
  assert.ok(b.user.includes('上一轮写的那条。'), '要把旧文本给它看');
  assert.ok(b.user.includes('diary.append'), '要说清写哪里');
  assert.ok(b.user.includes('不要重写全文'));
});

test('build: 没有 extend 时不多这几句（省 token）', () => {
  const b = buildConsolidationInput({ transcript: '他：说了句别的' });
  assert.equal(b.user.includes('这条已经记过了'), false);
});

/* ───────────────────── 链路 ───────────────────── */

test('链路: 新写的条目会带上 turn（下一轮才有得续）', () => {
  const a = createEmptyArchive(NOW, 'sess-2');
  const r = applyConsolidation(
    a,
    {
      skip: false,
      diary: { text: '他讲了一件从没提过的事。我听完没接话。', tags: ['聊'], kind: 'chat', salience: 0.6 },
    },
    { now: NOW, session: 'sess-2', sessionDiaryCount: 0, sessionTurn: 9 },
    {},
  );
  assert.equal(r.accepted, true);
  assert.equal(r.appended, false);
  assert.equal(r.archive.diary[0].turn, 9, '没有 turn 就永远续不上');
});

test('链路: 老条目没有 turn —— 于是不会被当成可续写的目标', () => {
  const old = normalizeDiaryEntry({ id: 'old', text: '很久以前的一条。', created_at: NOW - 86400000 });
  // 这正是"不误伤历史档案"的那道保护：Number.isFinite(undefined) 是 false
  assert.equal(Number.isFinite(old.turn), false);
});
