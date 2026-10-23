import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyArchive, normalizeDiaryEntry } from '../src/core/archive.mjs';
import { applyConsolidation, DEFAULT_CONSOLIDATION, buildConsolidationInput, similarity } from '../src/core/consolidate.mjs';

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

/* ───────────────────── 兜底：模型不听话的时候 ───────────────────── */

// 这两条是**编的**，不是从真档案里抄的。
//
// 之前我拿过一对真日记当 fixture —— 里面带着他生活里的细节（哪座城市、
// 哪天做什么实验）。测试通过，隐私漏了。doctor 扫出来才发现。
// 现在换成一个完全虚构、但结构一样的例子：SHORT 是 LONG 的前半段。
const SHORT =
  '他今天翻出来一个旧盒子，里面是几年前的票据。翻到某一张的时候「哦」了一声就合上了，' +
  '没多说。我也没问。我把手头的事做完，他过了一会儿才把话聊回正题上。';

const LONG =
  '他今天翻出来一个旧盒子，里面是几年前的票据。翻到某一张的时候「哦」了一声就合上了，' +
  '没多说。我也没问。我把手头的事做完，他过了一会儿才把话聊回正题上。' +
  '后来他自己提了一句，说那些票一直没扔，也不知道留着干嘛。' +
  '我说留着就留着，哪天想扔了再说。他说行，然后就去忙别的了。';
const OTHER = '他今天问我怎么备份档案，我说把整个文件夹拷走就行，别只拷渲染版。';

test('similarity: 同一件事的加长版很高，另一件事很低', () => {
  const s1 = similarity(SHORT, LONG);
  const s2 = similarity(SHORT, OTHER);
  console.log('  加长版 ' + s1.toFixed(2) + ' / 另一件事 ' + s2.toFixed(2));
  assert.ok(s1 >= 0.5, '加长版应该过阈值，实际 ' + s1.toFixed(2));
  assert.ok(s2 < 0.5, '另一件事应该低于阈值，实际 ' + s2.toFixed(2));
});

test('兜底: 模型给了完整的新版本（更长）→ 替换原来那条，不新建', () => {
  const a = withOneEntry({ text: SHORT });
  const before = a.diary.length;

  const r = applyConsolidation(
    a,
    { skip: false, diary: { text: LONG, salience: 0.6 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );

  assert.equal(r.accepted, true);
  assert.equal(r.appended, true, '要算续写');
  assert.equal(r.archive.diary.length, before, '不能新建');
  assert.equal(r.archive.diary[0].text, LONG, '应该换成新的那版');
  assert.equal(r.archive.diary[0].updated_at, NOW);
});

test('兜底: 一字不差（不更长）→ 丢弃，不重复写一条', () => {
  const a = withOneEntry({ text: SHORT });
  const r = applyConsolidation(
    a,
    { skip: false, diary: { text: SHORT, salience: 0.6 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );
  assert.equal(r.accepted, false, '一模一样的东西不该再写一遍');
  assert.equal(r.archive.diary.length, 1);
});

test('兜底: 换了一件事 → 照常新建（不能因为"有 extendId"就乱合并）', () => {
  const a = withOneEntry({ text: SHORT });
  const r = applyConsolidation(
    a,
    { skip: false, diary: { text: OTHER, tags: ['备份'], kind: 'chat', salience: 0.6 } },
    { now: NOW, session: 'sess-1', sessionDiaryCount: 1, sessionTurn: 11, extendId: 'd_20261022_01' },
    {},
  );
  assert.equal(r.accepted, true);
  assert.equal(r.appended, false, '这是另一件事');
  assert.equal(r.archive.diary.length, 2, '该新建');
});
