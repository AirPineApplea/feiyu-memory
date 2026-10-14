#!/usr/bin/env node
/**
 * 把老档案里烤进去的时间词摘掉。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要这个工具，而不是只改渲染：
 *
 * 渲染层已经会摘了（`timeline.mjs` 的 `stripTimeWords`），所以**注入给模型
 * 的那段本来就干净了**。但另外两处显示的是**原始正文**：
 *
 *   - 侧栏面板里的日记卡片
 *   - `日记.md`（人读版）
 *
 * 那两处没东西可摘，只能读原始正文。所以老档案里那些"今天他让我……"
 * 会一直杵在那儿，越攒越多。
 *
 * 这个工具就是一次性把它们清掉。**默认只演不写**，看清了再加 --write。
 *
 * 用法：
 *   node tools/fix-time-words.mjs                       # 演一遍，看会改什么
 *   node tools/fix-time-words.mjs --write               # 真改（先自动备份）
 *   node tools/fix-time-words.mjs <档案目录> --write
 *
 * ⚠️ 它只动日记正文里的时间词，**其他字段一个字节都不碰**。
 *    做法是在原始 JSON 行里做定点字符串替换，而不是重新序列化整行 ——
 *    这样哪怕以后加了新字段，这个工具也不会把它们吃掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { stripTimeWords } from '../src/core/timeline.mjs';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const positional = argv.filter((a) => !a.startsWith('--'));

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const dir = path.resolve(positional[0] ?? path.join(home, 'feiyu-diary'));
const diaryDir = path.join(dir, 'diary');

if (!fs.existsSync(diaryDir)) {
  console.error(`找不到日记目录：${diaryDir}`);
  process.exit(1);
}

const files = fs.readdirSync(diaryDir).filter((f) => f.endsWith('.jsonl'));
if (files.length === 0) {
  console.log(`${diaryDir} 里没有 .jsonl，什么都不用做。`);
  process.exit(0);
}

let scanned = 0;
let changed = 0;
let skipped = 0;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

for (const name of files) {
  const file = path.join(diaryDir, name);
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const out = [];

  for (const line of lines) {
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    scanned += 1;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // 坏行原样留着 —— 这个工具不负责修档案，只负责摘时间词
      out.push(line);
      skipped += 1;
      continue;
    }

    const before = typeof entry.text === 'string' ? entry.text : '';
    const after = stripTimeWords(before);
    if (after === before) {
      out.push(line);
      continue;
    }

    // 定点替换：只换那个字符串字面量，其余字节不动
    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    if (!line.includes(beforeJson)) {
      // 理论到不了这儿；真到了说明这行不是我们以为的形状，别硬改
      out.push(line);
      skipped += 1;
      console.warn(`  ⚠️  ${name}: ${entry.id ?? '?'} 找不到可替换的字符串，跳过`);
      continue;
    }
    const next = line.replace(beforeJson, afterJson);
    // 改完再解析一次，确认没有改坏
    const check = JSON.parse(next);
    if (check.text !== after || check.id !== entry.id) {
      out.push(line);
      skipped += 1;
      console.warn(`  ⚠️  ${name}: ${entry.id ?? '?'} 改写后校验不过，跳过`);
      continue;
    }

    changed += 1;
    console.log(`  ${name}  ${entry.id ?? '?'}`);
    console.log(`    − ${before}`);
    console.log(`    + ${after}`);
    out.push(next);
  }

  if (write && out.join('\n') !== raw) {
    const backup = `${file}.bak-timewords-${stamp}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, out.join('\n'), 'utf8');
    console.log(`  ↳ 已写入，备份在 ${path.basename(backup)}`);
  }
}

console.log('');
console.log(`扫了 ${scanned} 条，会改 ${changed} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ''}。`);
if (!write && changed > 0) {
  console.log('');
  console.log('这是**演一遍**，什么都没写。看清了再加 --write：');
  console.log(`  node tools/fix-time-words.mjs "${dir}" --write`);
}
if (write && changed > 0) {
  console.log('改完了。面板和 日记.md 下次加载时会重新生成，直接刷新就能看到。');
}
