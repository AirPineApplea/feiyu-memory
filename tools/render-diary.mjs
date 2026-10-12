#!/usr/bin/env node
/**
 * 按需把人读版日记渲染出来。
 *
 * 插件自己会在每次写档案之后自动刷新 `日记.md`，所以**平时不需要跑这个**。
 * 什么时候需要：
 *   - 你手动编辑过 `diary/*.jsonl`（删了几条），想立刻刷新
 *   - 你从别人那儿导入了 `.dshpack`，想马上看到可读版
 *   - 你想把日记渲染到别的地方（比如放进笔记软件）
 *
 * 用法：
 *   node tools/render-diary.mjs [档案目录] [输出文件]
 *
 * 默认：
 *   档案目录 = %USERPROFILE%\.dsh\feiyu-diary
 *   输出文件 = <档案目录>\日记.md
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { archiveFromFiles, DIARY_DIR } from '../src/core/archive.mjs';
import { renderDiaryFile } from '../src/core/render-diary.mjs';

const READ_ORDER = ['manifest.json', 'persona.md', 'relationship.json', 'lexicon.json'];

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const dir = path.resolve(process.argv[2] ?? path.join(home, 'feiyu-diary'));
const outFile = path.resolve(process.argv[3] ?? path.join(dir, '日记.md'));

if (!fs.existsSync(dir)) {
  console.error(`找不到档案目录：${dir}`);
  console.error('（插件还没装？或者用第一个参数指定目录）');
  process.exit(1);
}

/** @type {Array<{name: string, text: () => string}>} */
const entries = [];
for (const name of READ_ORDER) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) entries.push({ name, text: () => fs.readFileSync(file, 'utf8') });
}

const diaryDir = path.join(dir, 'diary');
if (fs.existsSync(diaryDir)) {
  for (const f of fs.readdirSync(diaryDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(diaryDir, f);
    entries.push({ name: `${DIARY_DIR}/${f}`, text: () => fs.readFileSync(file, 'utf8') });
  }
}

if (entries.length === 0) {
  console.error(`${dir} 里没有档案文件。`);
  process.exit(1);
}

const { archive, warnings } = archiveFromFiles(entries, { now: Date.now() });
for (const w of warnings) console.warn(`警告：${w}`);

const md = renderDiaryFile(archive, { now: Date.now() });
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, md, 'utf8');

console.log(`已渲染 ${archive.diary.length} 条日记 -> ${outFile}`);
