/**
 * `tools/fix-time-words.mjs` 的测试。
 *
 * 这个工具**直接改用户的记忆文件**，所以它自己也得有护栏：
 * 演的时候绝不能写盘、改之前必须备份、改完必须还能解析回来、
 * 其他字段一个字节都不能动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const NODE = process.execPath;
// 用 fileURLToPath，别用 URL.pathname —— 后者是百分号编码的，
// 中文路径会变成 %E8%82%A5... 然后找不到文件
const TOOL = fileURLToPath(new URL('../tools/fix-time-words.mjs', import.meta.url));

/** 造一个只有日记的临时档案 */
async function makeArchive(entries) {
  const home = await mkdtemp(path.join(tmpdir(), 'feiyu-timeline-'));
  const diaryDir = path.join(home, 'diary');
  await mkdir(diaryDir, { recursive: true });
  const lines = entries.map((e) =>
    JSON.stringify({
      id: e.id,
      date: '2026-10-13',
      text: e.text,
      tags: ['测试'],
      kind: 'chat',
      salience: 0.5,
      created_at: 1791900000000,
      keywords: ['测试'],
    }),
  );
  await writeFile(path.join(diaryDir, '2026-10.jsonl'), lines.join('\n') + '\n', 'utf8');
  return home;
}

const invoke = (home, ...extra) =>
  run(NODE, [TOOL, home, ...extra], { env: { ...process.env, DSH_HOME: home } });

test('fix-time-words: 默认只演不写', async () => {
  const home = await makeArchive([{ id: 'a', text: '今天他让我写个东西。' }]);
  try {
    const file = path.join(home, 'diary', '2026-10.jsonl');
    const before = await readFile(file, 'utf8');

    const { stdout } = await invoke(home);
    assert.match(stdout, /他让我写个东西/, '演的时候要把改动打出来');
    assert.equal(await readFile(file, 'utf8'), before, '演的时候绝不能动文件');
    assert.equal((await readdir(path.join(home, 'diary'))).filter((f) => f.includes('bak')).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('fix-time-words: --write 摘掉时间词、留备份、其余字段不动', async () => {
  const home = await makeArchive([
    { id: 'a', text: '今天他让我写个东西。' },
    { id: 'b', text: '那天他说要写小说。' }, // 叙述性的，不该动
  ]);
  try {
    const dir = path.join(home, 'diary');
    const file = path.join(dir, '2026-10.jsonl');
    await invoke(home, '--write');

    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 2);

    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.text, '他让我写个东西。', '时间词要摘掉');
    assert.equal(b.text, '那天他说要写小说。', '"那天"是叙述性的，不该动');

    // 其他字段一字不动
    assert.equal(a.id, 'a');
    assert.deepEqual(a.tags, ['测试']);
    assert.equal(a.salience, 0.5);
    assert.equal(a.created_at, 1791900000000);
    assert.deepEqual(a.keywords, ['测试']);

    const backups = (await readdir(dir)).filter((f) => f.includes('bak-timewords'));
    assert.equal(backups.length, 1, '改之前必须留一份备份');
    const backup = await readFile(path.join(dir, backups[0]), 'utf8');
    assert.ok(backup.includes('今天他让我写个东西。'), '备份要是改动前的内容');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('fix-time-words: 坏行原样留着，不抛错', async () => {
  const home = await makeArchive([{ id: 'a', text: '今天他来了。' }]);
  try {
    const file = path.join(home, 'diary', '2026-10.jsonl');
    const raw = await readFile(file, 'utf8');
    await writeFile(file, raw + '{这行是坏的\n', 'utf8');

    const { stdout } = await invoke(home, '--write');
    assert.match(stdout, /扫了 2 条/);
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines[1], '{这行是坏的', '坏行原样保留 —— 这个工具不负责修档案');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('fix-time-words: 再跑一次是幂等的（没得改就不写）', async () => {
  const home = await makeArchive([{ id: 'a', text: '今天他让我写个东西。' }]);
  try {
    const dir = path.join(home, 'diary');
    await invoke(home, '--write');
    const after1 = await readFile(path.join(dir, '2026-10.jsonl'), 'utf8');
    const { stdout } = await invoke(home, '--write');
    const after2 = await readFile(path.join(dir, '2026-10.jsonl'), 'utf8');

    assert.equal(after1, after2, '第二次不该有任何改动');
    assert.match(stdout, /会改 0 条/);
    assert.equal(
      (await readdir(dir)).filter((f) => f.includes('bak-timewords')).length,
      1,
      '没改动就不该再留一份备份',
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
