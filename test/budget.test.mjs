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


/* ═════════ 召回 ═════════ */

test('预算分配: 旧事候选在 2000–4000 都要出得来', () => {
  // 这条是回归：加词汇保底之后，召回接棒成了被饿死的那一栏。
  // 实测：3000 / 3200 / 3500 全是 ✗，只有 4000 才有。
  for (const b of [2000, 2500, 3000, 3500, 4000]) {
    const t = render(b).text ?? '';
    // 2026-10-27：那一栏的标题去掉了，现在只能靠「哪条进去了」判 ——
    // 用召回条目的原话当锚点。
    assert.ok(/很久以前那件事/.test(t), '预算 ' + b + ' 时召回不见了');
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

/* ═════════ 最近的事：平时让预算管，两个时刻整段重灌 ═════════ */

test('pinRecent: 不打标时，「最近的事」照样受预算管（会被裁）', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: 'e' + i,
    kind: 'chat',
    text: ('第' + i + '件事：') + '这是一段挺长的事情描述，用来把预算吃满。'.repeat(6),
    salience: 0.7,
    created_at: Date.now() - i * 3600000,
  }));
  const r = renderMemoryBlock({
    persona: '', relationship: {}, lexicon: { items: [] }, notes: [],
    recent: many, recalled: [], handNotes: [], handNoteHint: '',
    includePersona: true, budget: 400, now: Date.now(),
  });
  const shown = ((r.text ?? '').match(/^- (今天|昨天|\d+ 天前)：/gm) ?? []).length;
  assert.ok(shown < 8, '不打标时不该 8 条全进来，实际 ' + shown);
  assert.ok(r.tokens <= 400, '不该超预算，实际 ' + r.tokens);
});

test('pinRecent: 打标后 8 条全灌，而且**允许超预算** —— 它是补上下文，不是常年陪跑', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: 'e' + i,
    kind: 'chat',
    text: ('第' + i + '件事：') + '这是一段挺长的事情描述，用来把预算吃满。'.repeat(6),
    salience: 0.7,
    created_at: Date.now() - i * 3600000,
  }));
  const r = renderMemoryBlock({
    persona: '', relationship: {}, lexicon: { items: [] }, notes: [],
    recent: many, recalled: [], handNotes: [], handNoteHint: '',
    includePersona: true, budget: 400, now: Date.now(), pinRecent: true,
  });
  const shown = ((r.text ?? '').match(/^- (今天|昨天|\d+ 天前)：/gm) ?? []).length;
  assert.equal(shown, 8, '8 条必须全在，实际 ' + shown);
  assert.ok(r.tokens > 400, '整段重灌本来就该超预算，实际 ' + r.tokens);
});

test('pinRecent: 关掉它，行为跟以前一模一样（不许偷偷常驻）', () => {
  const r1 = renderMemoryBlock({
    persona: '# 我是谁\n我是鱼。', relationship: {}, lexicon: { items: [] }, notes: [],
    recent: [{ id: 'a', kind: 'chat', text: '一件事。', created_at: Date.now() }],
    recalled: [], handNotes: [], handNoteHint: '', includePersona: true, budget: 3000, now: Date.now(),
  });
  assert.match(r1.text, /一件事/);
  const r2 = renderMemoryBlock({
    persona: '# 我是谁\n我是鱼。', relationship: {}, lexicon: { items: [] }, notes: [],
    recent: [{ id: 'a', kind: 'chat', text: '一件事。', created_at: Date.now() }],
    recalled: [], handNotes: [], handNoteHint: '', includePersona: true, budget: 3000, now: Date.now(), pinRecent: false,
  });
  assert.equal(r2.text, r1.text, 'pinRecent:false 必须跟不传一模一样');
});
