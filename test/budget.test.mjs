/**
 * 注入预算的分配规则。
 *
 * 这一组测试来自一次实测：在真实档案上，**权重最低的那一栏永远死**。
 *
 *   预算 2000–3500  词汇 ✗
 *   加保底后       词汇 ✓，突然想起来 ✗  ← 接棒死
 *   再给召加保底   两栏都 ✓，代价是「最近的事」被裁
 *
 * 所以规矩是：**每栏要么有保底，要么接受自己永远死。**
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMemoryBlock } from '../src/core/persona.mjs';
import { estimateTokens } from '../src/core/tokenize.mjs';

/** 造一条长度接近真实日记的文本（约 400 字，真实档案里单条常常两百到三百字） */
function longText(tag) {
  return `${tag}：` + '这是那天他说的一件挺具体的事，我当时的反应是先愣了一下，然后才慢慢想明白他指的是什么。'.repeat(6);
}

function bigArchive(now) {
  const events = [];
  for (let i = 0; i < 8; i++) {
    events.push({
      id: 'd' + i,
      text: longText('最近第' + i + '件'),
      kind: 'chat',
      salience: 0.7,
      created_at: now - (8 - i) * 3600000,
    });
  }
  const recalled = [
    { entry: { id: 'old1', text: longText('很久以前那件事'), kind: 'chat', salience: 0.7, created_at: now - 20 * 86400000 }, sim: 0.9 },
    { entry: { id: 'old2', text: longText('另一件旧事'), kind: 'chat', salience: 0.7, created_at: now - 30 * 86400000 }, sim: 0.8 },
  ];
  const lexicon = { items: [] };
  for (let i = 0; i < 8; i++) {
    lexicon.items.push({ term: '词' + i, kind: 'meme', count: 3, salience: 1 - i * 0.05 });
  }
  return { events, recalled, lexicon };
}

function render(budget) {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  const { events, recalled, lexicon } = bigArchive(now);
  return renderMemoryBlock({
    persona: '# 我是谁\n我是 DeepSeek。'.repeat(20),
    relationship: { familiarity: 0.5, nickname: '肥鱼', traits: [] },
    lexicon,
    notes: [],
    recent: events,
    recalled,
    handNotes: [],
    includePersona: true,
    budget,
    now,
  });
}

/* ═════════ 词汇 ═════════ */

test('预算分配: 词汇栏在 2000–4000 都要出得来', () => {
  for (const b of [2000, 2500, 3000, 4000]) {
    const t = render(b).text ?? '';
    assert.ok(/我最近常说的/.test(t), '预算 ' + b + ' 时词汇不见了');
  }
});

/* ═════════ 召回 ═════════ */

test('预算分配: 「突然想起来」在 2000–4000 都要出得来', () => {
  // 这条是回归：加词汇保底之后，召回接棒成了被饿死的那一栏。
  // 实测：3000 / 3200 / 3500 全是 ✗，只有 4000 才有。
  for (const b of [2000, 2500, 3000, 3500, 4000]) {
    const t = render(b).text ?? '';
    assert.ok(/突然想起来/.test(t), '预算 ' + b + ' 时召回不见了');
  }
});

/* ═════════ 代价说清楚 ═════════ */

test('预算分配: 保底是有代价的 —— 预算越小，「最近的事」越少', () => {
  // 这条不是炫技，是把代价钉住：给两栏保底，就等于从「最近的事」里扣。
  const at2000 = (render(2000).text ?? '').match(/^- (今天|昨天|\d+ 天前)：/gm) ?? [];
  const at4000 = (render(4000).text ?? '').match(/^- (今天|昨天|\d+ 天前)：/gm) ?? [];
  assert.ok(
    at4000.length > at2000.length,
    '预算 4000 的「最近的事」应该比 2000 多，实际 ' + at4000.length + ' vs ' + at2000.length,
  );
});

test('预算分配: 不许超预算', () => {
  for (const b of [2000, 2500, 3000, 4000]) {
    const t = render(b).text ?? '';
    assert.ok(estimateTokens(t) <= b, '预算 ' + b + ' 超了：' + estimateTokens(t));
  }
});

test('预算分配: 只装得下人格时要能降级，不许抛错', () => {
  // 极小预算：保底逻辑不能让它崩，也不能死循环
  assert.doesNotThrow(() => render(200));
  const t = render(200).text ?? '';
  assert.ok(estimateTokens(t) <= 200);
});
