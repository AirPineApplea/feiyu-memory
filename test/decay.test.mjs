import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyArchive, normalizeDiaryEntry } from '../src/core/archive.mjs';
import { decayArchive, DEFAULT_CONSOLIDATION } from '../src/core/consolidate.mjs';
import { DEFAULT_RECALL_OPTIONS } from '../src/core/recall.mjs';

const NOW = Date.parse('2026-10-23T23:00:00+08:00');
const DAY = 86400000;

function archiveWith(salience, daysAgo = 30) {
  const a = createEmptyArchive(NOW - daysAgo * DAY, 's');
  a.diary.push(
    normalizeDiaryEntry({
      id: 'd1',
      text: '一条日记。',
      kind: 'chat',
      salience,
      created_at: NOW - daysAgo * DAY,
    }),
  );
  a.relationship.grievances.push({ what: '欠着一笔', intensity: 0.9, resolved: false });
  a.relationship.traits.push({ key: 'k', value: 'v', evidence: 'e', about: 'self', confidence: 3, salience: 0.8 });
  return a;
}

test('衰减有底：一百天后也不会归零', () => {
  const a = archiveWith(0.7, 100);
  const r = decayArchive(a, { now: NOW });
  const e = r.archive.diary[0];
  assert.ok(e.salience > 0, '不能归零');
  assert.ok(e.salience >= DEFAULT_CONSOLIDATION.salienceFloor, '不能跌破地板');
  assert.equal(e.salience, DEFAULT_CONSOLIDATION.salienceFloor, '应该正好停在地板上');
});

test('地板高于召回门槛 —— 老条目还能被"偶然想起"', () => {
  // ⚠️ 这里要用**运行时真正的门槛**，不是 DEFAULT_RECALL_OPTIONS.minSalience（那是 0.5）。
  //
  // host 渲染时传的是 `Math.max(0.15, config.minSalience)`（index.mjs 里写死的下界），
  // 所以实际门槛是 **0.15**。我刚才自己就被这两个数搞混了一次。
  const runtimeMin = 0.15;
  assert.ok(
    DEFAULT_CONSOLIDATION.salienceFloor > runtimeMin,
    `floor ${DEFAULT_CONSOLIDATION.salienceFloor} 必须高于运行时门槛 ${runtimeMin}，否则老条目连随机池都进不去`,
  );
});

test('账不衰减：时间磨不掉强度，也平不了账', () => {
  // ⚠️ 这条原来断言「floor 必须低于翻篇线，否则旧账平不掉」——
  // **那个设计是错的**：账不该自动平。现在账根本不参与衰减，
  // floor 跟账没关系。这条改为钉住「时间动不了账」。
  const a = createEmptyArchive(NOW, "# x");
  a.relationship.grievances.push({
    what: '欠着一笔', howToSettle: '还上', intensity: 0.9, resolved: false, created_at: NOW,
  });
  const r = decayArchive(a, { now: NOW + 400 * 86400000 });
  const g = r.archive.relationship.grievances[0];
  assert.equal(g.intensity, 0.9, '账的强度不许被时间磨掉');
  assert.equal(g.resolved, false, '更不许自动平');
});

test('衰减一百天后，账还在那儿 —— 时间不会替你还债', () => {
  const a = createEmptyArchive(NOW, "# x");
  a.relationship.grievances.push({
    what: '答应了没做', howToSettle: '把它做掉', intensity: 0.5, resolved: false, created_at: NOW,
  });
  const r = decayArchive(a, { now: NOW + 100 * 86400000 });
  const g = r.archive.relationship.grievances[0];
  assert.equal(g.resolved, false, '一百天后也不许自动平');
  assert.equal(g.intensity, 0.5, '强度不动');
  assert.equal(g.howToSettle, '把它做掉', '怎么才算平还在');
});

test('词汇、偏好也都有底', () => {
  const a = archiveWith(0.7, 100);
  a.lexicon.items.push({ word: '白饭', kind: 'meme', count: 5, salience: 0.8 });
  const r = decayArchive(a, { now: NOW });
  assert.ok(r.archive.lexicon.items[0].salience >= DEFAULT_CONSOLIDATION.salienceFloor);
  assert.ok(r.archive.relationship.traits[0].salience >= DEFAULT_CONSOLIDATION.salienceFloor);
});

test('衰减仍然是单调的：老的比新的低（地板之上）', () => {
  const a = archiveWith(0.8, 2);
  const r = decayArchive(a, { now: NOW });
  assert.ok(r.archive.diary[0].salience < 0.8, '两天也该掉一点');
  assert.ok(r.archive.diary[0].salience > DEFAULT_CONSOLIDATION.salienceFloor, '但远没到地板');
});

test('不用 30/90 天那种长跨度才能看出问题 —— 一行代码两种行为', () => {
  // 修复前：0.7 × 0.9^90 = 0.00007，等于死
  // 修复后：停在 0.16
  const before = 0.7 * Math.pow(0.9, 90);
  assert.ok(before < 0.001, '修复前确实是死的');
  const a = archiveWith(0.7, 90);
  assert.equal(decayArchive(a, { now: NOW }).archive.diary[0].salience, DEFAULT_CONSOLIDATION.salienceFloor);
});
