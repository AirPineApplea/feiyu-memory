/**
 * `手记.md` 的解析测试。
 *
 * 这个模块的失效方式特别阴：**说明文字被当成内容读进注入**。
 * 第一版的模板就是用 `- ` 写说明的，结果那几行说明真的出现在记忆里
 * （`preview-memory` 抓到的 —— 又是"从读者那一侧看"才发现的）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHandNote,
  selectHandNotes,
  HANDNOTE_TEMPLATE,
  MAX_ENTRIES,
  MAX_LINE_CHARS,
} from '../src/core/handnote.mjs';

test('手记: 只认 "- " 开头的行', () => {
  const notes = parseHandNote(
    ['# 标题', '', '- 第一条', '普通段落，不算', '* 星号不算', '+ 加号不算', '- 第二条'].join('\n'),
  );
  // 越靠后越新 → 反转后"第二条"在前
  assert.deepEqual(notes, ['第二条', '第一条']);
});

test('手记: **模板本身不能产出任何条目**（这是上一版真踩的坑）', () => {
  const notes = parseHandNote(HANDNOTE_TEMPLATE);
  assert.deepEqual(notes, [], `模板被当成内容读进去了：${JSON.stringify(notes)}`);
});

test('手记: 代码围栏里的示例不算内容', () => {
  const notes = parseHandNote(
    ['说明：', '```', '- 这是示例，别读', '```', '', '- 这才是真的'].join('\n'),
  );
  assert.deepEqual(notes, ['这才是真的']);
});

test('手记: 纯符号 / 空白行不算条目', () => {
  assert.deepEqual(parseHandNote('- \n- - \n-   \n- 真内容'), ['真内容']);
});

test('手记: 超长的一行会被截断，不会撑爆注入', () => {
  const notes = parseHandNote(`- ${'长'.repeat(500)}`);
  assert.equal(notes[0].length, MAX_LINE_CHARS + 1, '截断后加一个省略号');
  assert.ok(notes[0].endsWith('…'));
});

test('手记: 条数封顶，只留最近的', () => {
  const text = Array.from({ length: 30 }, (_, i) => `- 第 ${i} 条`).join('\n');
  const notes = selectHandNotes(text);
  assert.equal(notes.length, MAX_ENTRIES);
  assert.equal(notes[0], '第 29 条', '最近的在最前面');
});

test('手记: 坏输入不抛错（记忆坏了不能挡住聊天）', () => {
  assert.deepEqual(parseHandNote(undefined), []);
  assert.deepEqual(parseHandNote(null), []);
  assert.deepEqual(parseHandNote(''), []);
  assert.deepEqual(parseHandNote('   \n  '), []);
  assert.deepEqual(parseHandNote(42), []);
  assert.deepEqual(selectHandNotes(undefined, 5), []);
});
