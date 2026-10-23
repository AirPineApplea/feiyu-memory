/**
 * 配置来源的回归测试。
 *
 * 社区报告（2026-10-24）：装了插件之后 `~/.dsh/feiyu-diary/` 一直是空目录，
 * 档案跑进了 `profiles/desktop/[object Object]/`。
 *
 * 探针打出来 rawConfig 每个字段都是 `{}` —— 不是"空字符串"，是**空对象**。
 *
 * 链路：
 *   coerce() 的 string 分支 String({}) → "[object Object]"
 *   → resolveArchiveDir 当路径用 → path.resolve 按进程 cwd 解析
 *   → 档案落在 profiles/desktop/[object Object]/
 *
 * 而 debugLog 是 boolean，{} 也走不到 true —— **开着 debugLog 也看不到日志**，
 * 这让排查多绕一轮。
 *
 * 更深的根因：`Config` 在拿不到 schemastery 时导出了 `undefined`，
 * 注释里以为"loader 会跳过校验"，实际是**传一份空模板**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../src/core/config.mjs';
import { Config } from '../src/host/index.mjs';

/** 报告里那份"每个字段都是空对象"的模板 */
const EMPTY_TEMPLATE = {
  dataDir: {}, enabled: {}, includePersona: {}, budgetTokens: {},
  model: {}, reasoningEffort: {}, maxTokens: {}, thirdPartyRedaction: {},
  amountThreshold: {}, minSalience: {}, highSim: {}, recentEntries: {},
  maxShowPerTurn: {}, wanderChance: {}, offPeakHours: {}, deferToOffPeak: {}, debugLog: {},
};

test('空模板：一个 [object Object] 都不能出现', () => {
  const c = resolveConfig(EMPTY_TEMPLATE);
  const dump = JSON.stringify(c);
  assert.equal(dump.includes('[object Object]'), false, '配置里绝不能有这种垃圾值：' + dump);
});

test('空模板：string 字段全部回默认（于是档案不会再跑去 [object Object] 目录）', () => {
  const c = resolveConfig(EMPTY_TEMPLATE);
  assert.equal(c.dataDir, '');
  assert.equal(c.model, '');
  assert.equal(c.reasoningEffort, 'off');
  assert.equal(c.offPeakHours, '00:30-08:30');
});

test('空模板：number / boolean 也回默认（debugLog 尤其重要 —— 不然开日志也看不到）', () => {
  const c = resolveConfig(EMPTY_TEMPLATE);
  assert.equal(c.debugLog, false);
  assert.equal(c.budgetTokens, 2000);
  assert.equal(c.enabled, true);
  assert.equal(c.minSalience, 0.15);
});

/* ───────────────── Config 不能再是 undefined ───────────────── */

test('Config: 必须是个可调用的东西，不能是 undefined', () => {
  // 这是最深的那层根因：原来拿不到 schemastery 就导出 undefined，
  // 注释里以为"loader 会跳过校验"，实际是传空模板 —— 用户改的配置全不生效。
  assert.notEqual(Config, undefined, 'Config 是 undefined 的话，DSH 会传空模板');
  assert.equal(typeof Config, 'function', 'loader 会把它当函数调');
});

test('Config: 调它一次，喂进去的配置必须原样生效', () => {
  const filled = Config({ dataDir: '/x/y', debugLog: true, budgetTokens: 1500 });
  assert.equal(filled.dataDir, '/x/y', '用户写的配置必须被读进去');
  assert.equal(filled.debugLog, true, 'debugLog: true 必须真的变 true');
  assert.equal(filled.budgetTokens, 1500);
});

test('Config: 空模板喂进去也是干净的（兜底逻辑和 resolveConfig 一致）', () => {
  const c = Config(EMPTY_TEMPLATE);
  assert.equal(c.dataDir, '');
  assert.equal(JSON.stringify(c).includes('[object Object]'), false);
});

test('Config: 有 .dict，字段数跟 CONFIG_SPEC 对得上', async () => {
  const { CONFIG_SPEC } = await import('../src/core/config.mjs');
  assert.ok(Config.dict, '没有 .dict 的话设置表单读不到字段');
  assert.equal(Object.keys(Config.dict).length, CONFIG_SPEC.length);
  for (const f of CONFIG_SPEC) assert.ok(f.key in Config.dict, '缺字段：' + f.key);
});

test('Config: toString 能打出每个字段（设置表单的展示用）', async () => {
  const { CONFIG_SPEC } = await import('../src/core/config.mjs');
  const text = String(Config);
  for (const f of CONFIG_SPEC) assert.ok(text.includes(f.key), '缺 ' + f.key);
});

/* ───────────────── 组合：发霉的空模板不会再让档案乱跑 ───────────────── */

test('组合: 空模板 + resolveArchiveDir → 回默认目录，不是 [object Object]', async () => {
  const { resolveArchiveDir } = await import('../src/host/index.mjs');
  const path = await import('node:path');
  const home = path.join('C:', 'fake-home');
  const c = resolveConfig(EMPTY_TEMPLATE);
  const dir = resolveArchiveDir(c, home);
  assert.equal(dir, path.join(home, 'feiyu-diary'));
  assert.equal(dir.includes('[object Object]'), false);
});

test('Config: 必须有 .validate —— cordis 是调它，不是调函数本身', () => {
  // ⚠️ 这条是端到端验出来的，不是想出来的。
  //
  // 第一版兜底 schema 只有：可调用 + .dict + .toString。
  // 301 项单元测试全绿，装进真 profile 之后：
  //
  //   TypeError: Cannot read properties of undefined (reading 'validate')
  //   at resolveConfig (cordis/lib/index.js:958)
  //
  // 插件整个没激活。**单元测试碰不到这一层。**
  assert.equal(typeof Config.validate, 'function', '缺 validate 的话插件根本起不来');
  const v = Config.validate({ dataDir: '/a/b', debugLog: true });
  assert.equal(v.dataDir, '/a/b');
  assert.equal(v.debugLog, true);
});

test('Config: validate 和直接调用结果一致', () => {
  const input = { dataDir: '/x', budgetTokens: 1234, enabled: false };
  assert.deepEqual(Config.validate(input), Config(input));
});
