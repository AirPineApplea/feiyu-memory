/**
 * 账（grievance）的规矩。
 *
 * 来源是一封信，判断得很准：
 *
 *   往事 —— 想起来就想起来，忘了没什么。稀疏地冒出来才像活的。
 *   账   —— 答应过谁什么、欠着谁一件事。**不能等"想起来"，它有到期日，
 *           忘了就是赖账。**
 *
 * 原来这个插件在做相反的事：账按 0.97^天 衰减，掉到 0.2 以下就 resolved = true。
 * 0.9 那笔 50 天平、0.6 那笔 37 天平 —— **没人管 = 算平了。**
 *
 * 现在四条规矩：
 *   1. 账不衰减
 *   2. resolved 只认「我做到了」或「他明说算了」
 *   3. 每条账必须能说清「怎么才算平」
 *   4. 渲染全列，最老优先，不静默吞
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyConsolidation,
  decayArchive,
  buildConsolidationInput,
  DEFAULT_CONSOLIDATION,
} from '../src/core/consolidate.mjs';
import { createEmptyArchive, archiveFromFiles, archiveToFiles } from '../src/core/archive.mjs';
import { renderRelationship } from '../src/core/persona.mjs';

const NOW = Date.UTC(2026, 9, 24, 4, 0, 0);

function withDebt(debts) {
  const a = createEmptyArchive(NOW, '# x');
  for (const d of debts) a.relationship.grievances.push(d);
  return a;
}

/* ═════════════ ① 不衰减 ═════════════ */

test('账: 时间磨不掉强度', () => {
  const a = withDebt([
    { id: 'g1', what: '欠着一笔', howToSettle: '还上', intensity: 0.9, resolved: false, created_at: NOW },
  ]);
  for (const days of [10, 60, 400, 3650]) {
    const r = decayArchive(a, { now: NOW + days * 86400000 });
    assert.equal(r.archive.relationship.grievances[0].intensity, 0.9, days + ' 天后强度不该变');
  }
});

test('账: 十年都不许自动平', () => {
  const a = withDebt([
    { id: 'g1', what: '答应了没做', howToSettle: '把它做掉', intensity: 0.3, resolved: false, created_at: NOW },
  ]);
  const r = decayArchive(a, { now: NOW + 3650 * 86400000 });
  assert.equal(r.archive.relationship.grievances[0].resolved, false, '「久了」不算理由');
});

test('账: 衰减还是照常处理日记和印象（别把整个衰减废了）', () => {
  const a = createEmptyArchive(NOW, '# x');
  a.diary.push({ id: 'd1', text: '一件往事', kind: 'chat', salience: 0.9, created_at: NOW });
  a.relationship.traits.push({ key: 'k', value: 'v', evidence: 'e', about: 'user', confidence: 1, salience: 0.9 });
  const r = decayArchive(a, { now: NOW + 30 * 86400000 });
  assert.ok(r.archive.diary[0].salience < 0.9, '往事该淡');
  assert.ok(r.archive.relationship.traits[0].salience < 0.9, '印象也该淡');
});

/* ═════════════ ② resolved 只认明说 ═════════════ */

test('账: 模型给 resolved:true 才平', () => {
  const a = withDebt([
    { id: 'g1', what: '没问清语言就动手', howToSettle: '下次先问', intensity: 0.8, resolved: false, created_at: NOW },
  ]);
  const r = applyConsolidation(
    a,
    {
      skip: false,
      relationship: {
        grievances: [
          { what: '没问清语言就动手', howToSettle: '下次先问', intensity: 0.8, resolved: true },
        ],
      },
    },
    { now: NOW + 86400000 },
    {},
  );
  const g = r.archive.relationship.grievances[0];
  assert.equal(g.resolved, true);
  assert.equal(g.settled_at, NOW + 86400000, '平账要留时间');
});

test('账: 模型没说平就绝不自己平', () => {
  const a = withDebt([
    { id: 'g1', what: '答应了没做', howToSettle: '做掉', intensity: 0.8, resolved: false, created_at: NOW },
  ]);
  const r = applyConsolidation(
    a,
    { skip: false, relationship: { grievances: [{ what: '答应了没做', intensity: 0.1, resolved: false }] } },
    { now: NOW + 86400000 },
    {},
  );
  const g = r.archive.relationship.grievances[0];
  assert.equal(g.resolved, false, '强度低不是平账的理由');
});

/* ═════════════ ③ howToSettle ═════════════ */

test('账: howToSettle 会存下来', () => {
  const a = createEmptyArchive(NOW, '# x');
  const r = applyConsolidation(
    a,
    {
      skip: false,
      relationship: {
        grievances: [
          { what: '读 evidence 时偷懒', howToSettle: '下次念出格子里写了什么', intensity: 0.7, resolved: false },
        ],
      },
    },
    { now: NOW },
    {},
  );
  assert.equal(r.archive.relationship.grievances[0].howToSettle, '下次念出格子里写了什么');
});

test('账: 后来补的 howToSettle 要记上', () => {
  const a = withDebt([
    { id: 'g1', what: '老账', howToSettle: '', intensity: 0.6, resolved: false, created_at: NOW },
  ]);
  const r = applyConsolidation(
    a,
    { skip: false, relationship: { grievances: [{ what: '老账', howToSettle: '补一句具体的话', intensity: 0.6, resolved: false }] } },
    { now: NOW + 1000 },
    {},
  );
  assert.equal(r.archive.relationship.grievances[0].howToSettle, '补一句具体的话');
});

test('账: 空串不许把已有的 howToSettle 覆盖掉', () => {
  const a = withDebt([
    { id: 'g1', what: '老账', howToSettle: '已经写清楚了', intensity: 0.6, resolved: false, created_at: NOW },
  ]);
  const r = applyConsolidation(
    a,
    { skip: false, relationship: { grievances: [{ what: '老账', howToSettle: '', intensity: 0.7, resolved: false }] } },
    { now: NOW + 1000 },
    {},
  );
  assert.equal(r.archive.relationship.grievances[0].howToSettle, '已经写清楚了');
});

test('账: 落盘读回来还在（老档案没这字段也不炸）', () => {
  const a = createEmptyArchive(NOW, '# x');
  a.relationship.grievances.push(
    { id: 'g1', what: '新账', howToSettle: '做掉', intensity: 0.7, resolved: false, created_at: NOW },
    { id: 'g2', what: '老账', intensity: 0.6, resolved: false, created_at: NOW },
  );
  const files = archiveToFiles(a).map((f) => ({ name: f.name, text: () => f.data }));
  const back = archiveFromFiles(files, { now: NOW }).archive;
  assert.equal(back.relationship.grievances[0].howToSettle, '做掉');
  assert.equal(back.relationship.grievances[1].howToSettle, '', '老档案缺字段 → 空串，不是 undefined');
});

/* ═════════════ ④ 渲染 ═════════════ */

test('渲染: 最老优先，不按强度', () => {
  const rel = {
    familiarity: 0.5,
    traits: [],
    grievances: [
      { what: '最新的但最重', howToSettle: 'x', intensity: 0.99, resolved: false, created_at: 3000 },
      { what: '最老的但最轻', howToSettle: 'y', intensity: 0.1, resolved: false, created_at: 1000 },
    ],
  };
  const out = renderRelationship(rel, NOW);
  const iOld = out.indexOf('最老的但最轻');
  const iNew = out.indexOf('最新的但最重');
  assert.ok(iOld >= 0 && iNew >= 0, '两条都该在');
  assert.ok(iOld < iNew, '拖得越久越该靠前');
});

test('渲染: 带上「怎么才算平」', () => {
  const rel = {
    familiarity: 0.5,
    traits: [],
    grievances: [{ what: '欠一件事', howToSettle: '把它做掉', intensity: 0.6, resolved: false, created_at: 1 }],
  };
  const out = renderRelationship(rel, NOW);
  assert.ok(out.includes('怎么才算平'), '只有欠什么不够');
  assert.ok(out.includes('把它做掉'));
});

test('渲染: 没说怎么还的要显眼，不是藏起来', () => {
  const rel = {
    familiarity: 0.5,
    traits: [],
    grievances: [{ what: '老账', intensity: 0.6, resolved: false, created_at: 1 }],
  };
  assert.ok(renderRelationship(rel, NOW).includes('没说怎么还'));
});

test('渲染: 超过 6 条不静默吞，要写还剩几笔', () => {
  const grievances = [];
  for (let i = 0; i < 9; i++) {
    grievances.push({ what: '第' + i + '笔', howToSettle: 's', intensity: 0.6, resolved: false, created_at: i });
  }
  const out = renderRelationship({ familiarity: 0.5, traits: [], grievances }, NOW);
  assert.ok(out.includes('第0笔'), '最老的要露脸');
  assert.ok(out.includes('第5笔'), '前 6 条都在');
  assert.ok(!out.includes('第8笔'), '第 9 条不展开');
  assert.ok(out.includes('还有 3 笔'), '但要说清楚还剩几笔');
});

test('渲染: 已平的不出现', () => {
  const rel = {
    familiarity: 0.5,
    traits: [],
    grievances: [{ what: '已经还了', howToSettle: 'x', intensity: 0.9, resolved: true, created_at: 1 }],
  };
  assert.ok(!renderRelationship(rel, NOW).includes('已经还了'));
});

/* ═════════════ ⑤ 喂给模型的那一侧 ═════════════ */

test('输入: 未平的账要带 howToSettle 给模型看', () => {
  const rel = {
    familiarity: 0.5,
    nickname: '',
    traits: [],
    grievances: [
      { what: '欠一件事', howToSettle: '把它做掉', intensity: 0.6, resolved: false, created_at: 1 },
      { what: '已还的', howToSettle: 'x', intensity: 0.6, resolved: true, created_at: 2 },
    ],
  };
  const input = buildConsolidationInput({ transcript: '随便聊聊', relationship: rel }, { now: NOW });
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  assert.ok(text.includes('怎么才算平'), '模型得知道怎么判这次还不还');
  assert.ok(text.includes('把它做掉'));
  assert.ok(!text.includes('已还的'), '平了的别再喂回去');
});

/* ═════════════ ⑥ 预算 ═════════════ */

test('预算: 默认 3000（2000 装不下常驻段）', async () => {
  const { CONFIG_SPEC } = await import('../src/core/config.mjs');
  const f = CONFIG_SPEC.find((x) => x.key === 'budgetTokens');
  assert.equal(f.default, 3000);
  assert.ok(f.max >= 3000);
});

/* ═════════════ ⑦ 别再让「自动平」回来 ═════════════ */

test('别再让自动翻篇回来：decay 里不许出现 grievanceForgiveBelow 的用法', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/core/consolidate.mjs', import.meta.url), 'utf8');
  const decayPart = src.slice(src.indexOf('export function decayArchive'), src.indexOf('export function reinforceLexicon'));
  assert.equal(
    /intensity < opts\.grievanceForgiveBelow/.test(decayPart),
    false,
    '账不许再因为强度低而自动平 —— 那是替用户赖账',
  );
});
