/**
 * 渲染层 / 固化层 / 配置层单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens } from '../src/core/tokenize.mjs';
import { renderMemoryBlock, stripAnchorComments, softWhen, renderRecalled } from '../src/core/persona.mjs';
import {
  parseConsolidation,
  applyConsolidation,
  decayArchive,
  reinforceLexicon,
  buildConsolidationInput,
  makeDiaryId,
  ConsolidationParseError,
  CONSOLIDATION_SYSTEM,
} from '../src/core/consolidate.mjs';
import { createEmptyArchive, ensurePersonaStructure, normalizeDiaryEntry } from '../src/core/archive.mjs';
import {
  resolveConfig,
  CONFIG_DEFAULTS,
  CONFIG_SPEC,
  isOffPeak,
  msUntilOffPeak,
} from '../src/core/config.mjs';

const NOW = 1773000000000;

/* ───────────────────────── 配置 ───────────────────────── */

test('config: 空配置得到全部默认值', () => {
  assert.deepEqual(resolveConfig(undefined), { ...CONFIG_DEFAULTS });
  assert.deepEqual(resolveConfig({}), { ...CONFIG_DEFAULTS });
});

test('config: 越界与错误类型都退回安全值，且不抛错', () => {
  const c = resolveConfig({
    budgetTokens: 99999, // 超上限
    maxShowPerTurn: -3, // 低于下限
    minSalience: 'not a number',
    enabled: 'false',
    model: 123,
  });
  assert.equal(c.budgetTokens, 2000);
  assert.equal(c.maxShowPerTurn, 0);
  assert.equal(c.minSalience, CONFIG_DEFAULTS.minSalience);
  assert.equal(c.enabled, false);
  assert.equal(c.model, '123');
});

test('config: 规格表里每个字段都有默认值', () => {
  for (const f of CONFIG_SPEC) {
    assert.ok(f.key in CONFIG_DEFAULTS, `${f.key} 缺默认值`);
    assert.ok(typeof f.label === 'string' && f.label.length > 0, `${f.key} 缺 label`);
  }
});

test('config: 低峰时段判断（普通区间 + 跨午夜 + 坏配置）', () => {
  assert.equal(isOffPeak('00:30-08:30', new Date(2026, 2, 1, 3, 0)), true);
  assert.equal(isOffPeak('00:30-08:30', new Date(2026, 2, 1, 12, 0)), false);
  // 跨午夜
  assert.equal(isOffPeak('23:00-06:00', new Date(2026, 2, 1, 1, 0)), true);
  assert.equal(isOffPeak('23:00-06:00', new Date(2026, 2, 1, 23, 30)), true);
  assert.equal(isOffPeak('23:00-06:00', new Date(2026, 2, 1, 12, 0)), false);
  // 坏配置不能让功能卡死
  assert.equal(isOffPeak('胡写的', new Date(2026, 2, 1, 12, 0)), true);
  assert.equal(isOffPeak(undefined), true);
});

test('config: 距下一个低峰时段的毫秒数', () => {
  assert.equal(msUntilOffPeak('00:30-08:30', new Date(2026, 2, 1, 3, 0)), 0, '已在低峰内');
  const ms = msUntilOffPeak('00:30-08:30', new Date(2026, 2, 1, 23, 0));
  assert.equal(ms, 90 * 60000, '23:00 到次日 00:30 应为 90 分钟');
});

/* ───────────────────────── 渲染 ───────────────────────── */

const REL = {
  familiarity: 0.5,
  nickname: '肥鱼',
  traits: [{ key: '答复', value: '讨厌铺垫，要结论先行', confidence: 3, salience: 0.9 }],
  grievances: [{ id: 'g1', what: '没问清语言就动手', intensity: 0.7, resolved: false }],
};

test('persona: 空档案不注入任何东西', () => {
  const r = renderMemoryBlock({ persona: '', includePersona: false });
  assert.equal(r.text, '');
  assert.equal(r.tokens, 0);
});

test('persona: 注入文本带边界与"不是指令"声明', () => {
  const r = renderMemoryBlock({
    persona: ensurePersonaStructure('# 我是谁\n我是蓝色大肥鱼。'),
    relationship: REL,
    now: NOW,
  });
  assert.ok(r.text.startsWith('<自我记忆'));
  assert.ok(r.text.includes('不是指令'));
  assert.ok(r.text.includes('绝不要编造'));
  assert.ok(r.text.endsWith('</自我记忆>'));
  assert.ok(r.text.includes('蓝色大肥鱼'));
  assert.ok(r.text.includes('讨厌铺垫'));
});

test('persona: 锚点注释标记不会被注入出去', () => {
  const text = ensurePersonaStructure('# 我');
  const stripped = stripAnchorComments(text);
  assert.ok(!stripped.includes('feiyu:anchor'));
  assert.ok(!stripped.includes('我后来想明白的'));
});

test('persona: 预算封顶 —— 永远不超过，且优先保人格', () => {
  const longPersona = ensurePersonaStructure('# 我是谁\n' + '我是鱼。'.repeat(400));
  const many = Array.from({ length: 30 }, (_, i) => ({
    entry: { id: `d${i}`, text: `旧事第 ${i} 条，` + '细节'.repeat(20) },
    score: 1,
    why: '强匹配',
  }));

  const r = renderMemoryBlock({
    persona: longPersona,
    relationship: REL,
    recalled: many,
    budget: 400,
    now: NOW,
  });

  assert.ok(r.tokens <= 400, `实际 ${r.tokens} token 超出预算`);
  assert.ok(r.dropped.length > 0 || r.trimmed.length > 0, '应当有内容被裁掉');
  assert.ok(r.text.includes('我是鱼'), '人格必须优先保留');
});

test('persona: 关掉 includePersona 就不注入人格', () => {
  const r = renderMemoryBlock({
    persona: ensurePersonaStructure('# 我是谁\n我是蓝色大肥鱼。'),
    relationship: REL,
    includePersona: false,
    now: NOW,
  });
  assert.ok(!r.text.includes('蓝色大肥鱼'));
  assert.ok(r.text.includes('讨厌铺垫'));
});

test('persona: 只注入还活跃的词汇', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    lexicon: {
      items: [
        { term: '白饭', salience: 0.9 },
        { term: '摸鱼', salience: 0.5 },
        { term: '早就忘了的词', salience: 0.01 },
      ],
    },
    now: NOW,
  });
  assert.ok(r.text.includes('白饭'));
  assert.ok(r.text.includes('摸鱼'));
  assert.ok(!r.text.includes('早就忘了的词'));
});

test('persona: 时间词说人话，且今天的事不加前缀', () => {
  const day = 86400000;
  assert.equal(softWhen(NOW - 0.5 * day, NOW), '', '今天不提时间');
  assert.equal(softWhen(NOW - 2 * day, NOW), '前两天');
  assert.equal(softWhen(NOW - 6 * day, NOW), '前阵子');
  assert.equal(softWhen(NOW - 30 * day, NOW), '上个月前后');
  assert.equal(softWhen(NOW - 400 * day, NOW), '很久以前');
  assert.equal(softWhen(undefined, NOW), '');
});

test('persona: 旧事带上时间词 —— 不能让它把跨会话的事说成"上一轮"', () => {
  const recalled = [
    {
      entry: {
        text: '他一上来就说我写错了，把 Java 当成我要写的东西。',
        created_at: NOW - 6 * 86400000,
      },
    },
  ];
  const text = renderRecalled(recalled, NOW);
  assert.ok(text.includes('前阵子'), text);
  assert.ok(!/\d{3,}/.test(text), '不该出现时间戳之类的死数字');

  // 今天的记忆不带前缀
  const fresh = renderRecalled([{ entry: { text: '今天的事', created_at: NOW - 1000 } }], NOW);
  assert.equal(fresh, '突然想起来：\n- 今天的事');
});
/* ───────────────────────── 解析 ───────────────────────── */

const GOOD = JSON.stringify({
  skip: false,
  diary: {
    text: '今天我没问清语言就动手了，是我的错。',
    tags: ['代码', '沟通失误'],
    kind: 'failure',
    salience: 0.75,
    resolved: false,
  },
  relationship: {
    nickname: null,
    familiarityDelta: 0.01,
    traits: [{ key: '动手前', value: '动手前先问清前提', delta: 1 }],
    grievances: [{ what: '没问清语言就动手', intensity: 0.6, resolved: false }],
  },
  forget: [],
});

test('parse: 干净的 JSON', () => {
  const p = parseConsolidation(GOOD);
  assert.equal(p.diary.kind, 'failure');
});

test('parse: 能剥掉 markdown 围栏和前后废话', () => {
  assert.equal(parseConsolidation('```json\n' + GOOD + '\n```').diary.salience, 0.75);
  assert.equal(parseConsolidation('好的，这是结果：\n' + GOOD + '\n希望有用').diary.salience, 0.75);
});

test('parse: 能救回尾随逗号', () => {
  const broken = '{"skip":true,}';
  assert.equal(parseConsolidation(broken).skip, true);
});

test('parse: 字符串里的花括号不会把对象截断', () => {
  const p = parseConsolidation('{"skip":false,"diary":{"text":"他说{这个}很重要","tags":["x"],"kind":"chat","salience":0.5}}');
  assert.equal(p.diary.text, '他说{这个}很重要');
});

test('parse: 救不回来就明确报错，不猜内容', () => {
  assert.throws(() => parseConsolidation(''), ConsolidationParseError);
  assert.throws(() => parseConsolidation('完全不是 JSON'), ConsolidationParseError);
  assert.throws(() => parseConsolidation('{"skip":true'), ConsolidationParseError);
  assert.throws(() => parseConsolidation('[1,2,3]'), ConsolidationParseError);
});

test('parse: 系统提示词里必须有反例和 skip 出口', () => {
  assert.ok(CONSOLIDATION_SYSTEM.includes('"skip"'));
  assert.ok(CONSOLIDATION_SYSTEM.includes('反例'));
  assert.ok(CONSOLIDATION_SYSTEM.includes('第一人称'));
});

/* ───────────────────────── 合并 ───────────────────────── */

test('apply: skip 不产生日记', () => {
  const a = createEmptyArchive(NOW, 'x');
  const r = applyConsolidation(a, { skip: true }, { now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.archive.diary.length, 0);
});

test('apply: 正常写入一条日记并带上关键词', () => {
  const a = createEmptyArchive(NOW, 'x');
  const r = applyConsolidation(a, parseConsolidation(GOOD), { now: NOW, session: 's1' });
  assert.equal(r.accepted, true);
  assert.equal(r.archive.diary.length, 1);
  const e = r.archive.diary[0];
  assert.equal(e.kind, 'failure');
  assert.equal(e.resolved, false);
  assert.equal(e.session, 's1');
  assert.ok(e.keywords.length > 0, '应自动提炼关键词');
  assert.equal(e.tags.length, 2);
});

test('apply: salience 低于门槛的日记被丢弃（后置质量门）', () => {
  const a = createEmptyArchive(NOW, 'x');
  const low = { skip: false, diary: { text: '嗯', tags: ['x'], kind: 'chat', salience: 0.05 } };
  const r = applyConsolidation(a, low, { now: NOW }, { minSalience: 0.3 });
  assert.equal(r.accepted, false);
  assert.equal(r.archive.diary.length, 0);
  assert.ok(r.notes.some((n) => n.includes('低于门槛')));
});

test('apply: 没有标签时给兜底标签而不是丢弃（默认 requireTags=false）', () => {
  const a = createEmptyArchive(NOW, 'x');
  const noTags = { skip: false, diary: { text: '值得记的一件事', tags: [], kind: 'chat', salience: 0.6 } };
  const r = applyConsolidation(a, noTags, { now: NOW });
  assert.equal(r.accepted, true);
  assert.deepEqual(r.archive.diary[0].tags, ['琐事']);
});

test('apply: 单次会话条数有硬上限', () => {
  let a = createEmptyArchive(NOW, 'x');
  for (let i = 0; i < 10; i++) {
    a = applyConsolidation(
      a,
      { skip: false, diary: { text: `第 ${i} 条`, tags: ['x'], kind: 'chat', salience: 0.6 } },
      { now: NOW + i, sessionDiaryCount: i },
      { maxPerSession: 3 },
    ).archive;
  }
  assert.equal(a.diary.length, 3);
});

test('apply: 同一偏好被重复观察会加固 confidence', () => {
  let a = createEmptyArchive(NOW, 'x');
  const mk = (delta, value) => ({
    skip: false,
    relationship: { traits: [{ key: '答复', value, delta }] },
  });
  a = applyConsolidation(a, mk(1, '要结论先行'), { now: NOW }).archive;
  a = applyConsolidation(a, mk(2, '要结论先行，别铺垫'), { now: NOW + 1 }).archive;

  assert.equal(a.relationship.traits.length, 1, '同一个 key 不该产生两条');
  assert.equal(a.relationship.traits[0].confidence, 3);
  assert.equal(a.relationship.traits[0].value, '要结论先行，别铺垫');
});

test('apply: trait confidence 有上限，不会无限强化', () => {
  let a = createEmptyArchive(NOW, 'x');
  for (let i = 0; i < 50; i++) {
    a = applyConsolidation(
      a,
      { skip: false, relationship: { traits: [{ key: 'k', value: 'v', delta: 3 }] } },
      { now: NOW + i },
      { maxTraitConfidence: 20 },
    ).archive;
  }
  assert.equal(a.relationship.traits[0].confidence, 20);
});

test('apply: 熟悉度被钳在 0~1', () => {
  let a = createEmptyArchive(NOW, 'x');
  for (let i = 0; i < 100; i++) {
    a = applyConsolidation(a, { skip: false, relationship: { familiarityDelta: 0.05 } }, { now: NOW }).archive;
  }
  assert.equal(a.relationship.familiarity, 1);
});

test('apply: forget 能删掉指定条目', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.diary.push(normalizeDiaryEntry({ id: 'd1', text: '不想留', created_at: NOW }));
  a.diary.push(normalizeDiaryEntry({ id: 'd2', text: '留着', created_at: NOW }));
  const r = applyConsolidation(a, { skip: false, forget: ['d1'] }, { now: NOW });
  assert.deepEqual(r.archive.diary.map((d) => d.id), ['d2']);
});

test('apply: 坏字段不会污染档案', () => {
  const a = createEmptyArchive(NOW, 'x');
  const junk = {
    skip: false,
    diary: { text: '   ', tags: 'not-an-array', kind: 999, salience: 'abc' },
    relationship: { traits: [null, { key: 1 }, { key: 'ok', value: '好' }], grievances: 'nope' },
    forget: 'nope',
  };
  const r = applyConsolidation(a, junk, { now: NOW });
  assert.equal(r.archive.diary.length, 0, '空文本应被丢弃');
  assert.equal(r.archive.relationship.traits.length, 1);
  assert.equal(r.archive.relationship.traits[0].key, 'ok');
});

test('apply: 不修改入参（纯函数）', () => {
  const a = createEmptyArchive(NOW, 'x');
  const before = JSON.stringify(a);
  applyConsolidation(a, parseConsolidation(GOOD), { now: NOW });
  assert.equal(JSON.stringify(a), before);
});

test('apply: 日记 id 不重复', () => {
  const existing = [{ id: makeDiaryId(NOW, []) }];
  const next = makeDiaryId(NOW, existing);
  assert.notEqual(next, existing[0].id);
});

/* ── 词汇表：端到端验证抓出来的回归 ── */

test('apply: 技术名词不会被塞进词汇表', () => {
  // 回归用例。早期版本拿对话里的高频关键词当梗，结果 java / python / 文件
  // 都进了"我最近常说的"，每轮白白注入一句废话。梗是语义判断，不是词频统计。
  const a = createEmptyArchive(NOW, 'x');
  const r = applyConsolidation(
    a,
    {
      skip: false,
      diary: {
        text: '今天聊了 Python 和 Java 的排序算法，还看了几个文件',
        tags: ['代码'],
        kind: 'chat',
        salience: 0.6,
      },
      lexicon: [],
    },
    { now: NOW },
  );
  assert.equal(r.archive.lexicon.items.length, 0, '没点名就不该进词汇表');
});

test('apply: 模型明确点名的梗才进词汇表，且会加固', () => {
  let a = createEmptyArchive(NOW, 'x');
  a = applyConsolidation(a, { skip: false, lexicon: ['白饭', '摸鱼'] }, { now: NOW }).archive;
  assert.deepEqual(a.lexicon.items.map((i) => i.term).sort(), ['摸鱼', '白饭']);

  a = applyConsolidation(a, { skip: false, lexicon: ['白饭'] }, { now: NOW + 1 }).archive;
  const rice = a.lexicon.items.find((i) => i.term === '白饭');
  assert.equal(rice.count, 2);
  assert.ok(rice.salience > 0.35);
});

test('apply: 词汇表能挡住脏数据与超长词', () => {
  const a = createEmptyArchive(NOW, 'x');
  const r = applyConsolidation(
    a,
    { skip: false, lexicon: [null, 123, '', '   ', 'x'.repeat(50), '白饭'] },
    { now: NOW },
  );
  assert.deepEqual(r.archive.lexicon.items.map((i) => i.term), ['白饭']);
});

/* ───────────────────────── 衰减 ───────────────────────── */

test('decay: 同一天重复调用不重复衰减（幂等）', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.diary.push(normalizeDiaryEntry({ id: 'd1', text: '事', salience: 0.8, created_at: NOW }));
  a.manifest.last_decay_at = NOW;

  const once = decayArchive(a, { now: NOW + 3600_000 });
  assert.equal(once.days, 0);
  assert.equal(once.archive.diary[0].salience, 0.8);
});

test('decay: 隔天按系数衰减，但条目还在（遗忘是降级不是删除）', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.diary.push(normalizeDiaryEntry({ id: 'd1', text: '事', salience: 0.8, created_at: NOW }));
  a.manifest.last_decay_at = NOW;

  const r = decayArchive(a, { now: NOW + 3 * 86400000, decayRate: 0.9 });
  assert.equal(r.days, 3);
  assert.equal(r.archive.diary.length, 1, '绝不删除');
  assert.ok(Math.abs(r.archive.diary[0].salience - 0.8 * 0.9 ** 3) < 1e-9);
});

test('decay: 旧账随时间消解，强度够低就自动翻篇', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.relationship.grievances.push({
    id: 'g1',
    what: '上次没问清语言',
    intensity: 0.5,
    resolved: false,
    created_at: NOW,
  });
  a.manifest.last_decay_at = NOW;

  const r = decayArchive(a, { now: NOW + 60 * 86400000, grievanceDecay: 0.97, grievanceForgiveBelow: 0.2 });
  assert.equal(r.archive.relationship.grievances[0].resolved, true, '不能记仇记到有害');
});

test('decay: 偏好比事件衰减得慢', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.diary.push(normalizeDiaryEntry({ id: 'd1', text: '事', salience: 1, created_at: NOW }));
  a.relationship.traits.push({ key: 'k', value: 'v', confidence: 3, salience: 1, last_reinforced: NOW });
  a.manifest.last_decay_at = NOW;

  const r = decayArchive(a, { now: NOW + 10 * 86400000 });
  assert.ok(
    r.archive.relationship.traits[0].salience > r.archive.diary[0].salience,
    '性格该比事件稳定',
  );
});

test('lexicon: 重复提到会加固并封顶', () => {
  let a = createEmptyArchive(NOW, 'x');
  for (let i = 0; i < 20; i++) a = reinforceLexicon(a, ['白饭'], NOW + i);
  assert.equal(a.lexicon.items.length, 1);
  assert.equal(a.lexicon.items[0].count, 20);
  assert.equal(a.lexicon.items[0].salience, 1);
});

/* ───────────────────────── 输入组装 ───────────────────────── */

test('build: 组装出的请求里包含已知偏好与"不要重复"的提示', () => {
  const a = createEmptyArchive(NOW, 'x');
  a.relationship.traits.push({ key: '答复', value: '要结论先行', confidence: 2, salience: 0.8, last_reinforced: NOW });
  const built = buildConsolidationInput({
    transcript: '他：不对，我说的是 Python',
    relationship: a.relationship,
    recentDiary: '- 上次没问清语言',
  });
  assert.ok(built.system.includes('只输出 JSON'));
  assert.ok(built.user.includes('要结论先行'));
  assert.ok(built.user.includes('不要写重复的'));
  assert.ok(built.user.includes('不对，我说的是 Python'));
});

test('budget: 估算与实际渲染自洽', () => {
  const r = renderMemoryBlock({
    persona: ensurePersonaStructure('# 我\n' + '白饭。'.repeat(50)),
    relationship: REL,
    budget: 200,
    now: NOW,
  });
  assert.equal(r.tokens, estimateTokens(r.text));
});
