/**
 * 隐私检查表的测试。
 *
 * **一个从没红过的检查等于没有检查。**
 *
 * `tools/doctor.mjs` 里有一类"隐私"检查：绝不该被 git 追踪的档案文件。
 * 那条检查要是正则写松了，它会一路绿灯放行，而没人会发现 ——
 * 直到某个人的日记被推到公开仓库里。
 *
 * 所以这里对**两头**都下断言：
 *   该抓的一个都不能漏（漏 = 泄密）
 *   不该抓的一个都不能误伤（误伤 = 天天狼来了，最后没人看它）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { leaksArchive, ARCHIVE_PATTERNS } from '../tools/privacy-patterns.mjs';

test('隐私: 档案的每一部分都认得出来', () => {
  const mustCatch = [
    ['diary/2026-10.jsonl', '日记正文'],
    ['diary/2026-03.jsonl', '日记正文'],
    ['diary/unknown.jsonl', '日记正文'],
    ['persona.md', '人格内核'],
    ['src/persona.md', '人格内核'],
    ['relationship.json', '关系状态'],
    ['data/lexicon.json', '词汇表'],
    ['manifest.json', '档案清单'],
    ['手记.md', '手记'],
    ['肥鱼日记-2026-10-15.dshpack', '导出的档案包'],
    ['backup.DSHPACK', '大小写也要认'],
    ['relationship.json.bak-tidy-2026-10-15T02-51-50-538Z', '档案备份'],
    ['persona.md.bak-timewords-2026-10-14T07-40-28-274Z', '档案备份'],
  ];
  for (const [path, why] of mustCatch) {
    assert.ok(leaksArchive(path) !== null, `**漏了**：${path}（${why}）—— 这等于泄密`);
  }
});

test('隐私: 正常的项目文件一个都不误伤', () => {
  const mustPass = [
    'src/core/persona.mjs',
    'src/core/archive.mjs',
    'src/client/index.js',
    'test/merge.test.mjs',
    'tools/doctor.mjs',
    'cordis.patch.yml',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'SPEC.md',
    'AGENTS.md',
    'LICENSE',
    '/locale/zh.json',
    'docs/本地开发与验证.md',
    // 出厂模板**是**该进仓库的 —— 那是默认人格，不是谁的数据
    'persona.default.md',
  ];
  for (const path of mustPass) {
    assert.equal(leaksArchive(path), null, `**误伤**：${path} 被当成档案挡了`);
  }
});

test('隐私: 中文文件名要处理对（手记.md 不是 ASCII）', () => {
  assert.ok(leaksArchive('手记.md') !== null);
  assert.ok(leaksArchive('data/手记.md') !== null);
  assert.equal(leaksArchive('docs/handnote.md'), null, '英文名的文档不该被当成手记');
});

test('隐私: 检查表本身不是空的（防手滑清空）', () => {
  assert.ok(ARCHIVE_PATTERNS.length >= 8, '模式表被清空了，检查会一路绿灯');
  for (const p of ARCHIVE_PATTERNS) {
    assert.ok(p.re instanceof RegExp, 're 必须是正则');
    assert.ok(typeof p.what === 'string' && p.what !== '', '每条都要说清挡的是什么');
  }
});
