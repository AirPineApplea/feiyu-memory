import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveArchiveDir } from '../src/host/index.mjs';

const HOME = path.join('C:', 'fake-home');
const DEFAULT = path.join(HOME, 'feiyu-diary');

test('dataDir: 没配 → 用默认目录', () => {
  assert.equal(resolveArchiveDir({}, HOME), DEFAULT);
  assert.equal(resolveArchiveDir(undefined, HOME), DEFAULT);
});

test('dataDir: 空串 → 用默认目录', () => {
  assert.equal(resolveArchiveDir({ dataDir: '' }, HOME), DEFAULT);
  assert.equal(resolveArchiveDir({ dataDir: '   ' }, HOME), DEFAULT);
});

test('dataDir: 绝对路径 → 就用它', () => {
  const p = path.resolve('C:/sync/feiyu');
  assert.equal(resolveArchiveDir({ dataDir: p }, HOME), p);
  assert.equal(resolveArchiveDir({ dataDir: '  ' + p + '  ' }, HOME), p, '前后空格要吃掉');
});

/* ── 这几条是社区那个 bug 的尸检 ── */

test('dataDir: 字符串化的对象 "[object Object]" → 回落默认，绝不能当路径', () => {
  // DSH Desktop 0.2.1-rc.2 实测会把空配置字符串化成这个字面量。
  //
  // 旧代码用 typeof 放它过去，path.resolve 以进程 CWD 为基准 ——
  // 桌面端的 CWD 是 profiles\desktop，于是档案静悄悄落进
  // profiles\desktop\[object Object]\，插件一切正常，全程无报错。
  const got = resolveArchiveDir({ dataDir: '[object Object]' }, HOME);
  assert.equal(got, DEFAULT, '这是那条 bug 的防线');
  assert.equal(got.includes('[object Object]'), false, '绝不能出现这个目录名');
});

test('dataDir: 相对路径 → 回落默认（基准是进程 CWD，用户猜不到）', () => {
  assert.equal(resolveArchiveDir({ dataDir: 'user/foo' }, HOME), DEFAULT);
  assert.equal(resolveArchiveDir({ dataDir: './feiyu' }, HOME), DEFAULT);
});

test('dataDir: 不是字符串的东西一律回落', () => {
  for (const bad of [null, 42, {}, [], true, NaN]) {
    assert.equal(resolveArchiveDir({ dataDir: bad }, HOME), DEFAULT, String(bad));
  }
});

test('dataDir: 默认目录永远在 home 下面', () => {
  // 不管前面的判断怎么走，兜底那一条不能被绕过
  assert.equal(resolveArchiveDir({ dataDir: '' }, HOME).startsWith(HOME), true);
});
