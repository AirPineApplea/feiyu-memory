/**
 * 核心逻辑单测 —— 用 Node 内置 node:test，零依赖。
 * 跑法：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32, zipSync, unzipSync } from '../src/core/zip.mjs';
import { scrub, scrubAll, noticeFor, PRESET_REMEMBER_NAMES } from '../src/core/privacy.mjs';
import { tokenize, extractKeywords, overlap } from '../src/core/keywords.mjs';
import { estimateTokens, truncateToTokens } from '../src/core/tokenize.mjs';
import { SUPPRESS_RE } from '../src/core/gate.mjs';
import { buildIndex, searchScores, selectMemories, parseTimeHint } from '../src/core/recall.mjs';

/* ───────────────────────── zip ───────────────────────── */

test('zip: 中文文件名与内容往返一致', () => {
  const files = [
    { name: 'manifest.json', data: JSON.stringify({ schema_version: 1 }) },
    { name: 'persona.md', data: '# 我是谁\n我是蓝色大肥鱼。' },
    { name: 'diary/2026-03.jsonl', data: '{"id":"d1"}\n{"id":"d2"}\n' },
  ];
  const buf = zipSync(files);
  const read = unzipSync(buf);
  assert.equal(read.length, 3);
  const byName = new Map(read.map((e) => [e.name, e]));
  assert.equal(byName.get('persona.md').text(), '# 我是谁\n我是蓝色大肥鱼。');
  assert.equal(byName.get('diary/2026-03.jsonl').text(), '{"id":"d1"}\n{"id":"d2"}\n');
});

test('zip: compress 选项仍能正确读回', () => {
  const long = '白饭'.repeat(2000);
  const buf = zipSync([{ name: 'a.txt', data: long }], { compress: true });
  const [entry] = unzipSync(buf);
  assert.equal(entry.text(), long);
  assert.ok(buf.length < long.length, '压缩后应更小');
});

test('zip: CRC 能发现损坏', () => {
  const buf = zipSync([{ name: 'a.txt', data: 'hello world hello world' }]);
  // 破坏数据区（本地头 30 + 文件名 5 = 35 起）
  const broken = Uint8Array.from(buf);
  broken[40] = broken[40] ^ 0xff;
  const [entry] = unzipSync(broken);
  assert.throws(() => entry.bytes(), /CRC|长度/);
});

test('zip: 非法输入明确报错而非静默返回', () => {
  assert.throws(() => unzipSync(new Uint8Array([1, 2, 3, 4])), /EOCD/);
});

test('crc32: 已知向量', () => {
  // "123456789" 的 CRC-32 是 0xCBF43926
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

/* ───────────────────────── privacy ───────────────────────── */

test('privacy: 密钥硬阻断，且明确标记 blocked', () => {
  const r = scrub('这是我的 key: sk-abcdefghijklmnopqrstuvwxyz012345');
  assert.equal(r.blocked, true);
  assert.ok(!r.text.includes('sk-abc'), '密钥不应出现在结果里');
  assert.ok(r.text.includes('[已拦截]'));
  assert.ok(r.hits.some((h) => h.kind === 'secret'));
});

test('privacy: 密码赋值形式被拦', () => {
  const r = scrub('数据库 password=Hunter2Secret 记一下');
  assert.equal(r.blocked, true);
  assert.ok(!r.text.includes('Hunter2Secret'));
});

test('privacy: 手机号与邮箱泛化', () => {
  const r = scrub('我朋友手机 13812345678，邮箱 laowang@example.com');
  assert.ok(r.text.includes('[手机号]'));
  assert.ok(r.text.includes('[邮箱]'));
  assert.ok(!r.text.includes('13812345678'));
});

test('privacy: 称谓式人名泛化，但不误伤普通句子', () => {
  const r = scrub('今天王总又改需求了，李老师也被拉进来');
  assert.ok(r.text.includes('[某人]'));
  assert.ok(!r.text.includes('王总'));

  // 关键反例：不能把"我朋友在北京"吃掉
  const r2 = scrub('我朋友在北京工作，最近很累');
  assert.equal(r2.text, '我朋友在北京工作，最近很累');
});

test('privacy: 金额门槛 —— 小额保留，大额泛化', () => {
  const small = scrub('中午吃了 3 块钱的包子');
  assert.ok(small.text.includes('3 块钱'), '小额要留着，这是生活细节');

  const big = scrub('他欠我 5000 块一直没还');
  assert.ok(big.text.includes('一笔钱'));
  assert.ok(!big.text.includes('5000'));
});

test('privacy: 幂等 —— 重复清洗结果稳定', () => {
  const once = scrub('我朋友手机 13812345678，欠我 8000 块').text;
  const twice = scrub(once).text;
  assert.equal(twice, once);
});

test('privacy: 预设"记住名字"仍保留密钥与格式拦截', () => {
  const r = scrub('王总说 password=abc123def', PRESET_REMEMBER_NAMES);
  assert.ok(r.text.includes('王总'), '该预设下人名保留');
  assert.equal(r.blocked, true, '密钥永远拦');
  assert.ok(!r.text.includes('abc123def'));
});

test('privacy: 空输入与坏输入不抛错', () => {
  assert.deepEqual(scrub('').text, '');
  assert.deepEqual(scrub(null).text, '');
  assert.equal(scrub(undefined).hits.length, 0);
});

test('privacy: noticeFor 生成人话且无命中时为空', () => {
  assert.equal(noticeFor([]), '');
  const r = scrub('sk-abcdefghijklmnopqrstuvwx 和 13812345678');
  const n = noticeFor(r.hits);
  assert.ok(n.includes('密钥'));
  assert.ok(n.endsWith('。'));
});

/* ───────────────────────── keywords ───────────────────────── */

test('keywords: 中文 bigram 切分', () => {
  const t = tokenize('排序算法');
  assert.deepEqual(t, ['排序', '序算', '算法']);
});

test('keywords: 丢掉高频虚词 bigram', () => {
  assert.ok(!tokenize('的时候').includes('的时'));
});

test('keywords: 拉丁词归一化且过滤停用词', () => {
  const t = tokenize('Please Use Python3 for the Task');
  assert.ok(t.includes('python3'));
  assert.ok(t.includes('task'));
  assert.ok(!t.includes('the'), 'the 应被停用词过滤');
});

test('keywords: overlap 能识别同一话题', () => {
  const a = '帮我看看这个排序算法的问题';
  const b = '排序算法还是有问题，帮我看看';
  assert.ok(overlap(a, b) > 0.3);
  assert.ok(overlap(a, '今天天气不错适合睡觉') < 0.1);
});

test('keywords: extractKeywords 按词频取前 N', () => {
  const k = extractKeywords('白饭白饭白饭吃白饭', { max: 2 });
  assert.equal(k[0], '白饭');
});

/* ───────────────────────── tokenize(预算) ───────────────────────── */

test('tokenize: CJK 按 1 字符 1 token 估', () => {
  assert.equal(estimateTokens('白饭'), 2);
});

test('tokenize: truncateToTokens 不超过预算且保留省略号', () => {
  const text = '白饭'.repeat(100);
  const out = truncateToTokens(text, 20);
  assert.ok(estimateTokens(out) <= 20, `实际 ${estimateTokens(out)}`);
  assert.ok(out.endsWith('……'));
});

test('tokenize: 预算足够时原样返回', () => {
  assert.equal(truncateToTokens('白饭', 10), '白饭');
});

/* ───────────────────────── judge ───────────────────────── */

// 旧的关键词闸门拆了（三个结构性洞：看不到没命中的话、假阳性、判据写死），
// 换成 judge.mjs 的模型判断。它的测试在 judge.test.mjs。
//
// SUPPRESS_RE 留着 —— 那不是启发式，是用户的控制。
test('gate: SUPPRESS_RE 覆盖常见说法', () => {
  for (const t of ['别记这个', '不要记', '这个不用记', '忘掉这个']) {
    assert.ok(SUPPRESS_RE.test(t), t);
  }
});

/* ───────────────────────── recall ───────────────────────── */

const ENTRIES = [
  {
    id: 'd1',
    text: '今天他让我写个排序，我上来就动手，结果他连语言都没说清。',
    keywords: ['排序', '语言'],
    kind: 'failure',
    salience: 0.8,
    resolved: false,
    created_at: Date.now() - 3 * 86400000,
  },
  {
    id: 'd2',
    text: '他说他讨厌铺垫，要结论先行。',
    keywords: ['铺垫', '结论'],
    kind: 'chat',
    salience: 0.7,
    created_at: Date.now() - 10 * 86400000,
  },
  {
    id: 'd3',
    text: '中午一起纠结了半天吃什么，最后吃了白饭。',
    keywords: ['白饭', '中午'],
    kind: 'chat',
    salience: 0.4,
    created_at: Date.now() - 100 * 86400000,
  },
];

test('recall: 倒排索引能命中相关条目', () => {
  const idx = buildIndex(ENTRIES);
  const s = searchScores(idx, '排序算法写得怎么样了');
  assert.ok((s.get('d1') ?? 0) > 0, '应命中 d1');
  assert.ok((s.get('d1') ?? 0) > (s.get('d3') ?? 0), 'd1 应比 d3 相关');
});

test('recall: 相似度归一化在 0~1', () => {
  const idx = buildIndex(ENTRIES);
  for (const [, v] of searchScores(idx, '排序算法')) {
    assert.ok(v >= 0 && v <= 1, `越界: ${v}`);
  }
});

test('recall: 强匹配必触发', () => {
  const idx = buildIndex(ENTRIES);
  const state = { lastShownTurn: new Map() };
  const { chosen } = selectMemories(
    ENTRIES,
    idx,
    '排序算法还是有问题，语言也没说清',
    state,
    1,
    { rng: () => 0.99 },
  );
  assert.ok(chosen.length >= 1);
  assert.equal(chosen[0].entry.id, 'd1');
  assert.ok(chosen[0].why.includes('强匹配'), `why 应包含强匹配，实际 ${chosen[0].why}`);
});

test('recall: 阈值校准 —— 分数含义稳定，与查询长度解耦', () => {
  const idx = buildIndex(ENTRIES);
  const strong = searchScores(idx, '排序算法还是有问题，语言也没说清').get('d1') ?? 0;
  const lone = searchScores(idx, '结果').get('d1') ?? 0; // 只共享一个非关键词 token
  const none = searchScores(idx, '准备睡觉了明天再说').get('d1') ?? 0;

  assert.ok(strong > 0.5, `共享多个实词应过 highSim，实际 ${strong.toFixed(3)}`);
  assert.ok(lone > 0 && lone < strong, `单个实词证据应弱于多个，实际 ${lone.toFixed(3)}`);
  assert.equal(none, 0, '无关查询必须为 0');

  // 关键回归：用户多打几个字，不能让相关条目掉到阈值以下
  const longQuery = searchScores(
    idx,
    '排序算法还是有问题，语言也没说清，你帮我看看这段代码到底哪里写错了',
  );
  assert.ok((longQuery.get('d1') ?? 0) > 0.5, '加长查询不应让相关性崩掉');
});

test('recall: 冷却期内同一条不再露出', () => {
  const idx = buildIndex(ENTRIES);
  const state = { lastShownTurn: new Map([['d1', 10]]) };
  const { chosen } = selectMemories(ENTRIES, idx, '排序算法还是有问题', state, 12, {
    rng: () => 0.99,
    cooldownTurns: 20,
  });
  assert.ok(!chosen.some((c) => c.entry.id === 'd1'), '冷却中的条目不该再出现');
});

test('recall: 冷却过后可以再次露出', () => {
  const idx = buildIndex(ENTRIES);
  const state = { lastShownTurn: new Map([['d1', 10]]) };
  const { chosen } = selectMemories(ENTRIES, idx, '排序算法还是有问题', state, 40, {
    rng: () => 0.99,
    cooldownTurns: 20,
  });
  assert.ok(chosen.some((c) => c.entry.id === 'd1'));
});

test('recall: 每轮最多露 maxShow 条', () => {
  const idx = buildIndex(ENTRIES);
  const state = { lastShownTurn: new Map() };
  const { chosen } = selectMemories(ENTRIES, idx, '排序 铺垫 白饭 语言 结论', state, 1, {
    maxShow: 1,
    rng: () => 0.5,
  });
  assert.equal(chosen.length, 1);
});

test('recall: 完全无关时绝大多数情况不触发（走神概率很低）', () => {
  const idx = buildIndex(ENTRIES);
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const state = { lastShownTurn: new Map() };
    const { chosen } = selectMemories(ENTRIES, idx, 'zzz qqq 完全无关的内容', state, 1, {
      wanderChance: 0.08,
    });
    if (chosen.length > 0) hits++;
  }
  assert.ok(hits < 60, `走神命中过多: ${hits}/200`);
});

test('recall: 未解决的失败记忆获得加权', () => {
  const idx = buildIndex(ENTRIES);
  const state = { lastShownTurn: new Map() };
  const { chosen } = selectMemories(ENTRIES, idx, '排序', state, 1, { rng: () => 0.99 });
  assert.equal(chosen[0].entry.kind, 'failure');
  assert.ok(chosen[0].why.includes('未解决'), `why 应说明未解决，实际 ${chosen[0].why}`);
});

test('recall: 空索引不抛错', () => {
  const idx = buildIndex([]);
  const { chosen } = selectMemories([], idx, '随便', { lastShownTurn: new Map() }, 1);
  assert.deepEqual(chosen, []);
});


/* ───────────── 索引的数据源：summary 而不是 keywords ───────────── */

test('索引吃 summary —— 正文里没有的词，靠 summary 也能命中', () => {
  // 2026-10-28：一条日记只有一个检索表示（summary）。
  // 这是它跟老版本的分界：老版本拿正文 + keywords 建索引，
  // 正文里没写别名就搜不到；summary 是专为"找"写的，别名都在。
  const idx = buildIndex([
    { id: 'd1', text: '他说这部不好看，我说是编剧的问题。', summary: '边缘行者2·赛博朋克续集·五十岚海·他嫌洗白' },
    { id: 'd2', text: '他熬到半夜剪视频。', summary: '剪视频·半夜·两个视频·最耗时的活' },
  ]);
  const hits = searchScores(idx, '赛博朋克', { limit: 10 });
  assert.ok(hits.has('d1'), 'summary 里的别名应该命中');
  assert.ok(!hits.has('d2'), '无关的条目不该被命中');
});

test('索引吃 summary —— 没有 summary 的条目用正文兜底', () => {
  const idx = buildIndex([{ id: 'd1', text: '他熬到半夜剪视频。' }]);
  const hits = searchScores(idx, '剪视频', { limit: 10 });
  assert.ok(hits.has('d1'), '还没补 summary 的老条目不能搜不到');
});

test('索引不再吃 keywords —— 只有 keywords 的条目检索不到', () => {
  // 字段还在档案里（老数据没删），但它已经不是检索的数据源了。
  const idx = buildIndex([{ id: 'd1', keywords: ['赛博朋克', '边缘行者'], text: '' }]);
  const hits = searchScores(idx, '赛博朋克', { limit: 10 });
  assert.equal(hits.has('d1'), false, 'keywords 不再参与建索引');
});


/* ───────────── 时间提示：让「上个月那个」找得到 ───────────── */

const NOW_T = new Date(2026, 9, 28, 22, 0, 0).getTime(); // 2026-10-28 周三

test('time: 单个自然日', () => {
  const y = parseTimeHint('昨天说的那事', NOW_T);
  assert.equal(y.label, '昨天');
  const d = new Date(y.from);
  assert.equal(d.getDate(), 27);
  assert.equal(d.getHours(), 0);
  assert.equal(new Date(y.to).getHours(), 23);
});

test('time: 上个月是完整的上一个自然月', () => {
  const h = parseTimeHint('上个月那个', NOW_T);
  assert.equal(h.label, '上个月');
  const from = new Date(h.from);
  const to = new Date(h.to);
  assert.equal(from.getMonth(), 8, '九月');
  assert.equal(from.getDate(), 1);
  assert.equal(to.getMonth(), 8);
  assert.equal(to.getDate(), 30);
});

test('time: 前几天 / 最近', () => {
  assert.equal(parseTimeHint('前两天我说过', NOW_T).label, '最近三天');
  assert.equal(parseTimeHint('最近有没有提过', NOW_T).label, '最近一周');
});

test('time: 认不出就说认不出 —— 绝不猜', () => {
  assert.equal(parseTimeHint('赛博朋克那部', NOW_T), null);
  assert.equal(parseTimeHint('', NOW_T), null);
  assert.equal(parseTimeHint(null, NOW_T), null);
  assert.equal(parseTimeHint({}, NOW_T), null);
});

test('time: 还没到的月份算去年', () => {
  // 现在是十月，问「12 月」应该指去年十二月
  const h = parseTimeHint('12 月那事', NOW_T);
  assert.equal(new Date(h.from).getFullYear(), 2025);
  assert.equal(new Date(h.from).getMonth(), 11);
});

test('time: 窗口是闭区间 —— 边界那天要包住', () => {
  const h = parseTimeHint('昨天', NOW_T);
  assert.ok(h.from <= h.to);
  assert.equal(h.to - h.from, 86399999, '一整天少一毫秒');
});
