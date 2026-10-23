import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../src/core/config.mjs';

/**
 * cosmokit 的 createVolatile —— **逐字照抄**（社区报告里贴的那段）。
 *
 * DSH 0.2.0-rc.2 起，loader 为了 `patchReload: live` 把 `config:` 里每个值包成这个。
 * 它是 Object.freeze 过的普通对象：get 是函数值，write 是 symbol 键。
 * 于是 String(ref) === "[object Object]"、JSON.stringify(ref) === "{}"。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
function createVolatile(value) {
  let current = value;
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (v) => { current = v; },
  });
}

/* ───────────────── 核心：volatile 引用必须被解开 ───────────────── */

test('volatile: 这个包装确实会变成 "[object Object]"（先确认前提）', () => {
  const ref = createVolatile('C:\\x');
  assert.equal(String(ref), '[object Object]');
  assert.deepEqual(Object.keys(ref), ['get']);
  assert.equal(JSON.stringify(ref), '{}');
});

test('volatile: string 字段全部解开', () => {
  const c = resolveConfig({
    dataDir: createVolatile('C:\\sync\\feiyu'),
    model: createVolatile('deepseek-flash'),
    reasoningEffort: createVolatile('off'),
    offPeakHours: createVolatile('00:30-08:30'),
  });
  assert.equal(c.dataDir, 'C:\\sync\\feiyu', 'dataDir 不能变成 [object Object]');
  assert.equal(c.model, 'deepseek-flash', 'model 错了，固化那次调用就发不出去');
  assert.equal(c.reasoningEffort, 'off');
  assert.equal(c.offPeakHours, '00:30-08:30');
});

test('volatile: number / boolean 也要解开（否则静默回落）', () => {
  const c = resolveConfig({
    budgetTokens: createVolatile(3000),
    enabled: createVolatile(false),
    recentEntries: createVolatile(5),
    maxShowPerTurn: createVolatile(2),
  });
  assert.equal(c.budgetTokens, 3000, '不能静默回落 2000');
  assert.equal(c.enabled, false, '不能静默回落 true');
  assert.equal(c.recentEntries, 5);
  assert.equal(c.maxShowPerTurn, 2);
});

test('volatile: get() 抛错时安全降级，不能把插件带崩', () => {
  const broken = Object.freeze({
    get: () => { throw new Error('boom'); },
    [VOLATILE_WRITE]: () => {},
  });
  const c = resolveConfig({ dataDir: broken, budgetTokens: broken });
  assert.equal(c.dataDir, '');
  assert.equal(c.budgetTokens, 2000);
});

/* ───────────────── 回归：纯值配置照旧 ───────────────── */

test('回归: 老宿主给的是纯值，行为一点不能变', () => {
  const c = resolveConfig({ dataDir: 'C:\\plain', model: '', budgetTokens: 1500, enabled: false });
  assert.equal(c.dataDir, 'C:\\plain');
  assert.equal(c.model, '');
  assert.equal(c.budgetTokens, 1500);
  assert.equal(c.enabled, false);
});

test('回归: 什么都没配 → 全走默认', () => {
  const c = resolveConfig(undefined);
  assert.equal(c.dataDir, '');
  assert.equal(c.budgetTokens, 2000);
  assert.equal(c.enabled, true);
});

/* ───────────────── 硬化：非字符串不再变成垃圾 ───────────────── */

test('硬化: string 字段拿到非字符串 → 回默认，而不是 String(x)', () => {
  // 这一步正是把对象变成 "[object Object]" 的地方。
  // 回默认比"变成一串垃圾"好排查 —— 而且不会再拿着垃圾去 path.resolve。
  assert.equal(resolveConfig({ dataDir: {} }).dataDir, '');
  assert.equal(resolveConfig({ dataDir: 42 }).dataDir, '');
  assert.equal(resolveConfig({ dataDir: [] }).dataDir, '');
  assert.equal(resolveConfig({ model: {} }).model, '');
});

test('硬化: 坏值本来就是安全降级，这条别破', () => {
  const c = resolveConfig({ enabled: 'nope', budgetTokens: 'x', minSalience: 'oops' });
  assert.equal(c.enabled, true);
  assert.equal(c.budgetTokens, 2000);
  assert.equal(c.minSalience, 0.15);
});

/* ───────────────── 组合：volatile + resolveArchiveDir 那条线 ───────────────── */

test('组合: volatile 包着绝对路径 → 档案目录不会被当成相对路径', async () => {
  const { resolveArchiveDir } = await import('../src/host/index.mjs');
  const path = await import('node:path');
  const target = path.resolve('C:/sync/feiyu');
  const c = resolveConfig({ dataDir: createVolatile(target) });
  assert.equal(resolveArchiveDir(c, path.join('C:', 'fake-home')), target);
});

test('组合: volatile 包着空串 → 回默认目录（不是 [object Object] 目录）', async () => {
  const { resolveArchiveDir } = await import('../src/host/index.mjs');
  const path = await import('node:path');
  const home = path.join('C:', 'fake-home');
  const c = resolveConfig({ dataDir: createVolatile('') });
  const got = resolveArchiveDir(c, home);
  assert.equal(got, path.join(home, 'feiyu-diary'));
  assert.equal(got.includes('[object Object]'), false);
});
