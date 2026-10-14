/**
 * 渲染层 / 固化层 / 配置层单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens } from '../src/core/tokenize.mjs';
import {
  renderMemoryBlock,
  stripAnchorComments,
  softWhen,
  renderRecalled,
  renderRecent,
  dayLabel,
  calendarDaysBetween,
  stripTimeWords,
  renderNotes,
  MAX_NOTES,
} from '../src/core/persona.mjs';
import {
  parseConsolidation,
  applyConsolidation,
  decayArchive,
  reinforceLexicon,
  buildConsolidationInput,
  makeDiaryId,
  ConsolidationParseError,
  CONSOLIDATION_SYSTEM,
  DEFAULT_CONSOLIDATION,
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
  // 上限现在是 4000（预算从 700 提到 2000 之后跟着抬的）
  assert.equal(c.budgetTokens, CONFIG_SPEC.find((f) => f.key === 'budgetTokens').max);
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
  // 用**确定的日历偏移**构造，不要用 `NOW - 0.5 * day` 这种写法 ——
  // 换成自然日之后，那种写法的结果会随"现在几点"漂。
  const ref = new Date(NOW);
  ref.setHours(12, 0, 0, 0);
  const at = (daysAgo, hour = 12) => {
    const d = new Date(ref);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  assert.equal(softWhen(at(0), ref.getTime()), '', '今天不提时间');
  assert.equal(softWhen(at(3), ref.getTime()), '前两天');
  assert.equal(softWhen(at(10), ref.getTime()), '前阵子');
  assert.equal(softWhen(at(30), ref.getTime()), '上个月前后');
  assert.equal(softWhen(at(400), ref.getTime()), '很久以前');
  assert.equal(softWhen(undefined, ref.getTime()), '');
});

/* ── 「一天」只能有一种算法（另一个肥鱼从输出那侧挑出来的毛病） ── */

test('timeline: 「认识 N 天」和「N 天前」必须用同一把尺子', () => {
  // 经典打架场景：晚上 23:00 认识，次日上午 9:00 看。
  // 旧代码里 renderRelationship 按整 24 小时算 → "认识 1 天"，
  // dayLabel 按自然日算 → "2 天前"。两个数并排躺在同一块记忆里。
  const seenAt = new Date(NOW);
  seenAt.setHours(9, 0, 0, 0);
  const metAt = new Date(seenAt);
  metAt.setDate(metAt.getDate() - 2);
  metAt.setHours(23, 0, 0, 0);

  assert.equal(
    calendarDaysBetween(metAt.getTime(), seenAt.getTime()),
    2,
    '昨晚 23 点到今天上午 9 点，按人的直觉是 2 天',
  );
  assert.equal(dayLabel(metAt.getTime(), seenAt.getTime()), '2 天前');

  const r = renderMemoryBlock({
    includePersona: false,
    relationship: { since: metAt.getTime(), traits: [] },
    now: seenAt.getTime(),
  });
  assert.ok(r.text.includes('认识 2 天'), `不能再说"认识 1 天"：${r.text}`);
});

test('timeline: 全项目只有一处定义"一天"', async () => {
  // 想加第四种日期算法的话，这条会红 —— 那是故意的。
  const { readFile } = await import('node:fs/promises');
  const files = ['src/core/persona.mjs', 'src/core/render-diary.mjs', 'src/host/index.mjs'];
  for (const f of files) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(
      !/\/\s*86400000/.test(code),
      `${f} 里又自己算了毫秒差 —— 日期只该在 timeline.mjs 里算`,
    );
  }
});

test('timeline: 正文里的时间词会被摘掉（时间由前缀给）', () => {
  assert.equal(stripTimeWords('今天他让我写个东西，我没问清语言。'), '他让我写个东西，我没问清语言。');
  assert.equal(stripTimeWords('他今天连着追问了三次。'), '他连着追问了三次。');
  assert.equal(stripTimeWords('昨天我说错了话。'), '我说错了话。');
  assert.equal(stripTimeWords('刚才他又改口了。'), '他又改口了。');
  assert.equal(stripTimeWords('今天，他正式给了我一条规矩。'), '他正式给了我一条规矩。');
  // 叙述性的"那天"不碰 —— 它跟前缀不打架
  assert.equal(stripTimeWords('那天他说要写小说。'), '那天他说要写小说。');
  // 摘没了就别动它：宁可留一个多余的"今天"，也不要把记忆变成空壳
  assert.equal(stripTimeWords('今天'), '今天');
  assert.equal(stripTimeWords(''), '');
  assert.equal(stripTimeWords(undefined), '');
});

test('render: 「最近的事」不会出现「昨天：他今天……」这种自相矛盾', () => {
  const recent = [
    { id: 'a', text: '今天他正式给了我一条规矩：解答之前先问细节。', created_at: NOW - 86400000 },
  ];
  const out = renderRecent(recent, [], NOW);
  assert.match(out, /昨天：他正式给了我一条规矩/);
  assert.ok(!/昨天：他今天/.test(out), `时间词写了两遍：${out}`);
});

test('render: 「突然想起来」同样不会双写时间词', () => {
  const recalled = [
    {
      entry: {
        id: 'b',
        text: '今天他连着追问 AGENTS.md 和肥鱼日记的区别。',
        created_at: NOW - 5 * 86400000,
      },
    },
  ];
  const out = renderRecalled(recalled, NOW);
  assert.match(out, /前阵子，他连着追问/);
  assert.ok(!/他今天连着/.test(out), `时间词写了两遍：${out}`);
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
/* ── 「像日记」而不是「像宪法」：这几条是这个项目最容易退化的地方 ── */

test('persona: 印象必须带画面 —— value —— evidence', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    relationship: {
      traits: [
        {
          key: '铺垫',
          value: '讨厌铺垫，要结论先行',
          evidence: '我铺垫了三段，他直接说"说重点"',
          about: 'user',
          confidence: 2,
          salience: 0.9,
        },
      ],
    },
    now: NOW,
  });
  assert.ok(r.text.includes('我对他的一些印象'), r.text);
  assert.ok(r.text.includes('讨厌铺垫，要结论先行 —— 我铺垫了三段'), '要有画面');
  assert.ok(!r.text.includes('他：'), '不该再有旧的「他：」清单行');
});

test('persona: 没有 evidence 的印象不会渲染成空破折号', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    relationship: {
      traits: [{ key: 'k', value: '讨厌铺垫', evidence: '', about: 'user', confidence: 1, salience: 0.9 }],
    },
    now: NOW,
  });
  assert.ok(r.text.includes('- 讨厌铺垫'));
  assert.ok(!r.text.includes('——'), '没画面就不该出现破折号');
});

test('persona: 印象最多 2 条 —— 多了就又变回清单', () => {
  const traits = Array.from({ length: 6 }, (_, i) => ({
    key: `k${i}`,
    value: `印象${i}`,
    evidence: `第${i}次`,
    about: 'user',
    confidence: 3,
    salience: 1 - i * 0.1,
  }));
  const r = renderMemoryBlock({ includePersona: false, relationship: { traits }, now: NOW });
  const hits = (r.text.match(/印象\d/g) ?? []).length;
  assert.equal(hits, 2, `应只留 2 条，实际 ${hits}`);
});

test('persona: 带画面的印象排在前面，没画面的往后站（不删旧数据）', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    relationship: {
      traits: [
        // salience 更高、更老，但没画面
        { key: 'a', value: '旧的无画面印象', evidence: '', about: 'user', confidence: 5, salience: 1 },
        { key: 'b', value: '新的有画面印象', evidence: '那次发生的事', about: 'user', confidence: 1, salience: 0.2 },
      ],
    },
    now: NOW,
  });
  const newAt = r.text.indexOf('新的有画面印象');
  const oldAt = r.text.indexOf('旧的无画面印象');
  assert.ok(newAt >= 0 && oldAt >= 0, '两条都还在（数据不删）');
  assert.ok(newAt < oldAt, '带画面的必须排在前面');
});

test('persona: 只留 2 条时，没画面的会被挤掉', () => {
  const traits = [
    { key: 'a', value: '旧的无画面', evidence: '', about: 'user', confidence: 5, salience: 1 },
    { key: 'b', value: '有画面一', evidence: '第一次', about: 'user', confidence: 1, salience: 0.2 },
    { key: 'c', value: '有画面二', evidence: '第二次', about: 'user', confidence: 1, salience: 0.1 },
  ];
  const r = renderMemoryBlock({ includePersona: false, relationship: { traits }, now: NOW });
  assert.ok(r.text.includes('有画面一') && r.text.includes('有画面二'));
  assert.ok(!r.text.includes('旧的无画面'), '没画面的该被挤掉');
});

test('persona: 自己的规矩和他人的印象分开 —— 不能混在「他：」下面', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    relationship: {
      traits: [
        { key: 'a', value: '讨厌铺垫', evidence: '', about: 'user', confidence: 1, salience: 0.9 },
        { key: 'b', value: '没落盘前不假装记得', evidence: '', about: 'self', confidence: 1, salience: 0.5 },
      ],
    },
    now: NOW,
  });
  assert.ok(r.text.includes('我对他的一些印象'));
  assert.ok(r.text.includes('上一棒留下的'));
  // 规矩不能出现在印象那一段里
  const impStart = r.text.indexOf('我对他的一些印象');
  const ruleStart = r.text.indexOf('上一棒留下的');
  assert.ok(impStart < ruleStart);
  assert.ok(!r.text.slice(impStart, ruleStart).includes('不假装记得'), '规矩串到印象里了');
});

/* ── 身份声明：告诉读者这堆字是谁的 ── */

test('persona: 最前面是身份声明，且声明在人格之前', () => {
  const r = renderMemoryBlock({
    persona: '# 我是谁\n\n我是 DeepSeek。',
    relationship: { since: NOW, traits: [] },
    now: NOW,
  });
  const decl = r.text.indexOf('这是你的记忆，不是关于你的资料。');
  const persona = r.text.indexOf('# 我是谁');
  assert.ok(decl > 0, '声明必须在注入块里');
  assert.ok(decl < persona, '声明要在最前面 —— 先说清这堆字是谁的，再给内容');

  // 三句都要在，一句都不能少
  assert.ok(r.text.includes('它由很多个你陆续写下'), '防撞层那句不能省');
  assert.ok(r.text.includes('都不记得写它的那一刻'));
  assert.ok(r.text.includes('所有对话都是同一条鱼。'));
});

test('persona: 声明不带日期、不带条目 id —— 它是性质不是记录', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    relationship: { since: NOW, traits: [] },
    recent: [{ id: 'd_20261014_07', text: '某件小事。', created_at: NOW }],
    now: NOW,
  });
  const declLine = r.text.slice(0, r.text.indexOf('最近的事'));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(declLine), '声明里不该有日期');
  assert.ok(!/d_\d/.test(declLine), '声明里不该有条目 id');
});

test('persona: 声明**不受预算影响** —— 给再小的预算也不许裁掉', () => {
  // 「你是同一条鱼」因为重要度衰减被裁掉，那就滑稽了。
  const input = {
    includePersona: false,
    relationship: { since: NOW, traits: [] },
    recent: [{ id: 'a', text: '很长很长的一条日记正文。'.repeat(40), created_at: NOW }],
    now: NOW,
  };
  for (const budget of [200, 400, 800, 2000]) {
    const r = renderMemoryBlock({ ...input, budget });
    if (r.text === '') continue; // 预算小到连帧都装不下，整个不注入是可以的
    assert.ok(
      r.text.includes('所有对话都是同一条鱼。'),
      `预算 ${budget} 时声明被裁掉了：${r.text.slice(0, 120)}`,
    );
    assert.ok(r.tokens <= budget, `预算 ${budget} 时超了：${r.tokens}`);
  }
});

test('persona: 一点记忆都没有时，不注入声明', () => {
  // 没有东西可以归属，就别摆那段话
  const r = renderMemoryBlock({ includePersona: false, now: NOW });
  assert.equal(r.text, '');
});

test('persona: **内容为空但有指针时，指针不能被吞掉**', () => {
  // 这是真踩过的 bug：build() 里原来写的是
  //   const middle = body === '' ? '' : `${body}${tail}`;
  // 内容为空 → middle 空 → 那句"想留话"的指针一起没了。
  // 187 项测试全绿也抓不到 —— 因为没人写过这个用例。
  const r = renderMemoryBlock({
    includePersona: false,
    handNoteHint: '想留话就用 feiyu_note。',
    now: NOW,
  });
  assert.ok(r.text.includes('feiyu_note'), `指针被吞掉了：${r.text}`);
  assert.ok(r.text.includes('所有对话都是同一条鱼'), '声明也要在');
});

test('persona: 指针和内容并存时，两个都在，且内容在前', () => {
  const r = renderMemoryBlock({
    includePersona: false,
    recent: [{ id: 'a', text: '一条日记。', created_at: NOW }],
    handNoteHint: '想留话就用 feiyu_note。',
    now: NOW,
  });
  assert.match(r.text, /一条日记/);
  assert.ok(r.text.includes('feiyu_note'));
  assert.ok(r.text.indexOf('一条日记') < r.text.indexOf('feiyu_note'));
});

test('persona: 预算再小也不许把指针裁掉（它是帧的一部分）', () => {
  for (const budget of [200, 300, 600]) {
    const r = renderMemoryBlock({
      includePersona: false,
      recent: [{ id: 'a', text: '很长很长的一条。'.repeat(50), created_at: NOW }],
      handNoteHint: '想留话就用 feiyu_note。',
      budget,
      now: NOW,
    });
    if (r.text === '') continue; // 预算小到连帧都装不下，整个不注入是可以的
    assert.ok(r.text.includes('feiyu_note'), `预算 ${budget} 时指针被裁了`);
    assert.ok(r.tokens <= budget, `预算 ${budget} 超了：${r.tokens}`);
  }
});

/* ── 「我自己想的」：第三区 ── */

/**
 * 一位读者把注入区拆成三种声音：
 *   锚点（人格）—— 条文
 *   日记（最近/想起）—— **转述**
 *   **我自己想的** —— 我自己长出来的   ← 原来根本没有
 *
 * 而真相是：**内容早就在生成了，只是放错了格子。** `feiyu_note` 写出来的
 * 判断一直被当成事件渲染在「最近的事」里，格式跟流水账一模一样。
 */

test('notes: 判断有自己的段，不混进「最近的事」', () => {
  const judgement = {
    id: 'n1',
    kind: 'note',
    text: '别人给的数据跟出处对不上时，先问，别照抄。',
    created_at: NOW,
  };
  const event = { id: 'e1', kind: 'chat', text: '他把小说发了过来。', created_at: NOW };

  // 判断交给 renderNotes，事件交给 renderRecent
  const notes = renderNotes([judgement]);
  const recent = renderRecent([judgement, event], [], NOW);

  assert.match(notes, /我自己想的：/);
  assert.match(notes, /先问，别照抄/);
  assert.match(recent, /最近的事：/);
  assert.ok(!recent.includes('先问，别照抄'), `判断串进事件区了：${recent}`);
});

test('notes: renderRecent 自己会拦掉 note（调用方忘了分流也不串味）', () => {
  const r = renderRecent([{ id: 'n', kind: 'note', text: '一条判断。', created_at: NOW }], [], NOW);
  assert.equal(r, '');
});

test('notes: renderNotes 也拦得住事件（各管各的）', () => {
  assert.equal(renderNotes([{ id: 'e', kind: 'chat', text: '一件事。', created_at: NOW }]), '');
  assert.equal(renderNotes([]), '');
  assert.equal(renderNotes(undefined), '');
});

test('notes: 判断不带日期 —— 它不是"某天发生的事"', () => {
  const out = renderNotes([{ id: 'n', kind: 'note', text: '先问再写。', created_at: NOW - 3 * 86400000 }]);
  assert.ok(!/天前/.test(out), `判断不该带相对时间：${out}`);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(out), `判断不该带日期：${out}`);
  assert.equal(out, '我自己想的：\n- 先问再写。');
});

test('notes: 正文里的时间词会被摘掉（跟日记一个规矩）', () => {
  const out = renderNotes([{ id: 'n', kind: 'note', text: '今天我想明白：先问再写。', created_at: NOW }]);
  assert.equal(out, '我自己想的：\n- 我想明白：先问再写。');
});

test('notes: 最近的排最前，且条数封顶', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `n${i}`,
    kind: 'note',
    text: `第 ${i} 条判断`,
    created_at: NOW + i * 1000,
  }));
  const out = renderNotes(many);
  const lines = out.split('\n').slice(1);
  assert.equal(lines.length, MAX_NOTES);
  assert.equal(lines[0], '- 第 19 条判断', '刚想明白的最该被记着');
});

test('notes: 在整块注入里排在人格之后、印象之前', () => {
  const r = renderMemoryBlock({
    persona: '# 我是谁\n我是鱼。',
    notes: [{ id: 'n', kind: 'note', text: '先问再写。', created_at: NOW }],
    relationship: { since: NOW, traits: [{ key: 'k', value: '讨厌铺垫', evidence: '', about: 'user', confidence: 1, salience: 0.9 }] },
    now: NOW,
  });
  const iPersona = r.text.indexOf('# 我是谁');
  const iNotes = r.text.indexOf('我自己想的：');
  const iRel = r.text.indexOf('我对他的一些印象');
  assert.ok(iPersona >= 0 && iNotes >= 0 && iRel >= 0, r.text);
  assert.ok(iPersona < iNotes, '人格在最前 —— 那是人家给的设定，底线');
  assert.ok(iNotes < iRel, '判断排在"我对他"之前 —— 它更"我"');
});

/* ── 「我后来想明白的」：现在是手写的地方 ── */

test('persona: 空的「我后来想明白的」标题会被藏掉', () => {
  const text = '# 我是谁\n\n我是鱼。\n\n## 我后来想明白的';
  assert.ok(!stripAnchorComments(text).includes('我后来想明白的'));
});

test('persona: **人手写进去之后，标题必须留着**', () => {
  // 它现在的定位是人手写的地方（跟 手记.md 一个性质）。
  // 无条件删标题的话，人写的东西会挂在前一个小标题底下 —— 像走错门。
  const text = '# 我是谁\n\n我是鱼。\n\n## 我后来想明白的\n\n- 手写的一条判断。\n';
  const out = stripAnchorComments(text);
  assert.ok(out.includes('## 我后来想明白的'), `标题被误删了：${out}`);
  assert.ok(out.includes('手写的一条判断'), out);
});

/* ── 「最近的事」：不需要相似度，永远在场 ── */

test('recent: 按时间倒序，最近的在最上面', () => {
  const entries = [
    { id: 'a', text: '三天前的事', created_at: NOW - 3 * 86400000 },
    { id: 'b', text: '今天的事', created_at: NOW },
    { id: 'c', text: '昨天的事', created_at: NOW - 86400000 },
  ];
  const out = renderRecent(entries, [], NOW);
  assert.ok(out.startsWith('最近的事：'));
  assert.ok(out.indexOf('今天的事') < out.indexOf('昨天的事'));
  assert.ok(out.indexOf('昨天的事') < out.indexOf('三天前的事'));
});

test('recent: 日期标签说人话', () => {
  assert.equal(dayLabel(NOW, NOW), '今天');
  assert.equal(dayLabel(NOW - 86400000, NOW), '昨天');
  assert.equal(dayLabel(NOW - 3 * 86400000, NOW), '3 天前');
  assert.match(dayLabel(NOW - 30 * 86400000, NOW), /^\d+-\d{2}$/);
  assert.equal(dayLabel(undefined, NOW), '');
});

test('recent: 已经在「突然想起来」里的条目不再重复出现', () => {
  const entries = [
    { id: 'x', text: '同一条事', created_at: NOW },
    { id: 'y', text: '另一条事', created_at: NOW - 1000 },
  ];
  const out = renderRecent(entries, [{ entry: { id: 'x' } }], NOW);
  assert.ok(out.includes('另一条事'));
  assert.ok(!out.includes('同一条事'), '同一条不该既在"最近"又在"突然想起来"里');
});

test('recent: 有条数上限，且空文本被跳过', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`,
    text: `第 ${i} 条`,
    created_at: NOW - i * 1000,
  }));
  const out = renderRecent(many, [], NOW, 5);
  assert.equal((out.match(/^- /gm) ?? []).length, 5);
  assert.equal(renderRecent([{ id: 'z', text: '   ', created_at: NOW }], [], NOW), '');
  assert.equal(renderRecent(null, [], NOW), '');
});

test('persona: 最近的事在注入块里，且排在突然想起来之前', () => {
  const recent = [{ id: 'r', text: '今天聊了日记的设计', created_at: NOW }];
  const recalled = [{ entry: { id: 'o', text: '很久以前的那件事', created_at: NOW - 60 * 86400000 } }];
  const r = renderMemoryBlock({ includePersona: false, recent, recalled, now: NOW });
  assert.ok(r.text.includes('最近的事：'));
  assert.ok(r.text.includes('突然想起来：'));
  assert.ok(r.text.indexOf('最近的事：') < r.text.indexOf('突然想起来：'));
});

/* ── 门槛与 case 分层 ── */

test('apply: 寒暄不再是「无效信息」—— 低 salience 也能留下来', () => {
  // 这是用户指出的设计错误：把"寒暄/试错/改口"当成不值得记的，
  // 恰恰扔掉了熟悉感的原料。默认门槛从 0.3 降到 0.15。
  assert.equal(DEFAULT_CONSOLIDATION.minSalience, 0.15);
  const a = createEmptyArchive(NOW, 'x');
  const chitChat = {
    skip: false,
    diary: { text: '今天他随口聊了两句吃的。没什么正事。', tags: ['闲聊'], kind: 'chat', salience: 0.2 },
  };
  const r = applyConsolidation(a, chitChat, { now: NOW });
  assert.equal(r.accepted, true, '0.2 的闲聊应该留得住');
  assert.equal(r.archive.diary.length, 1);
});

test('apply: 印象带上画面与归属，且 about 不同算两条', () => {
  const a = createEmptyArchive(NOW, 'x');
  const r = applyConsolidation(
    a,
    {
      skip: false,
      relationship: {
        traits: [
          { key: '铺垫', value: '讨厌铺垫', evidence: '我说了三段他说说重点', about: 'user', delta: 1 },
          { key: '诚实', value: '不假装记得', evidence: '他要求过', about: 'self', delta: 1 },
        ],
      },
    },
    { now: NOW },
  );
  const t = r.archive.relationship.traits;
  assert.equal(t.length, 2);
  assert.equal(t.find((x) => x.key === '铺垫').evidence, '我说了三段他说说重点');
  assert.equal(t.find((x) => x.key === '铺垫').about, 'user');
  assert.equal(t.find((x) => x.key === '诚实').about, 'self');
});

test('apply: 加固时不会把已有的画面清空', () => {
  let a = createEmptyArchive(NOW, 'x');
  a = applyConsolidation(
    a,
    { skip: false, relationship: { traits: [{ key: 'k', value: 'v', evidence: '第一次的画面', about: 'user', delta: 1 }] } },
    { now: NOW },
  ).archive;
  // 第二次没带 evidence
  a = applyConsolidation(
    a,
    { skip: false, relationship: { traits: [{ key: 'k', value: 'v2', evidence: '', about: 'user', delta: 1 }] } },
    { now: NOW + 1 },
  ).archive;
  assert.equal(a.relationship.traits.length, 1);
  assert.equal(a.relationship.traits[0].evidence, '第一次的画面', '画面不该被空字符串覆盖');
  assert.equal(a.relationship.traits[0].value, 'v2');
  assert.equal(a.relationship.traits[0].confidence, 2);
});

test('提示词：明确写了「寒暄值得记」并且要求 evidence', () => {
  assert.ok(CONSOLIDATION_SYSTEM.includes('寒暄'), '要明说寒暄值得记');
  assert.ok(CONSOLIDATION_SYSTEM.includes('evidence'), '要有 evidence 字段');
  assert.ok(CONSOLIDATION_SYSTEM.includes('about="self"'), '要区分自己的规矩');
  assert.ok(CONSOLIDATION_SYSTEM.includes('说明书'), '要有"不要写成说明书"的反例');
  assert.ok(!/寒暄、试错、无信息的往返 → 低于 0\.3/.test(CONSOLIDATION_SYSTEM), '旧的那句必须删掉');
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
