// ★ 复现 issue #1：config 值被 cosmokit 包成 volatile 引用时，coerce 得到 "[object Object]"
//
// 这个用例直接对着 DSH 真正用的包装形状造引用（@deepseek-ai/cosmokit isVolatile 的判定口径），
// 不 import cosmokit —— 保住"零运行时依赖"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/core/config.mjs'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 与 @deepseek-ai/cosmokit lib/index.js:102-110 createVolatile() 逐字同形 */
function createVolatile(value) {
  return Object.freeze({
    get: () => value,
    [VOLATILE_WRITE]: () => {},
  })
}

test('config: volatile 引用要被解开（DSH 0.2.x 的 config 形状）', () => {
  const cfg = resolveConfig({
    dataDir: createVolatile('C:\\Users\\me\\.dsh\\feiyu-diary'),
    model: createVolatile('deepseek-chat'),
    offPeakHours: createVolatile('00:30-08:30'),
    reasoningEffort: createVolatile('low'),
  })

  assert.equal(cfg.dataDir, 'C:\\Users\\me\\.dsh\\feiyu-diary')
  assert.equal(cfg.model, 'deepseek-chat')
  assert.equal(cfg.offPeakHours, '00:30-08:30')
  assert.equal(cfg.reasoningEffort, 'low')
})

test('config: number / boolean 字段的 volatile 也要解开', () => {
  const cfg = resolveConfig({
    budgetTokens: createVolatile(2500),
    enabled: createVolatile(false),
    minSalience: createVolatile(0.3),
  })

  assert.equal(cfg.budgetTokens, 2500)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.minSalience, 0.3)
})

test('config: 纯值配置不走解引用那条路（老宿主回归）', () => {
  const cfg = resolveConfig({
    dataDir: 'C:\\plain\\dir',
    model: 'm1',
    budgetTokens: 999,
    enabled: false,
  })

  assert.equal(cfg.dataDir, 'C:\\plain\\dir')
  assert.equal(cfg.model, 'm1')
  assert.equal(cfg.budgetTokens, 999)
  assert.equal(cfg.enabled, false)
})

test('config: 任何情况下都不许把字符串字段变成 "[object Object]"', () => {
  const cfg = resolveConfig({
    dataDir: createVolatile('x'),
    model: createVolatile('y'),
  })

  assert.ok(!cfg.dataDir.includes('[object Object]'))
  assert.ok(!cfg.model.includes('[object Object]'))
})

test('config: get() 抛错的引用要安全降级，不许抛出', () => {
  const 炸 = Object.freeze({
    get: () => {
      throw new Error('boom')
    },
    [VOLATILE_WRITE]: () => {},
  })

  assert.doesNotThrow(() => resolveConfig({ dataDir: 炸 }))
})
