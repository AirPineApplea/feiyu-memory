#!/usr/bin/env node
/**
 * 预览「此刻注入给模型的是什么」。
 *
 * 这是开发这个插件时最该有的工具 —— 因为你平时**看不到**注入内容，
 * 只能从模型的反应去猜。而"读起来像日记还是像用户说明书"这件事，
 * 光看代码是判断不了的，必须把渲染结果打出来看。
 *
 * 用法：
 *   node tools/preview-memory.mjs [档案目录] [--query "模拟这一轮用户说了什么"]
 *
 * 默认档案目录 = %USERPROFILE%\.dsh\feiyu-diary
 *
 * ⚠️ 它会把你的记忆内容打到终端上。这是本地工具，只在你主动跑的时候发生。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { archiveFromFiles, DIARY_DIR } from '../src/core/archive.mjs';
import { buildIndex, selectMemories } from '../src/core/recall.mjs';
import { renderMemoryBlock } from '../src/core/persona.mjs';
import { resolveConfig } from '../src/core/config.mjs';
import { selectHandNotes, HANDNOTE_FILE } from '../src/core/handnote.mjs';

const argv = process.argv.slice(2);
const queryIdx = argv.indexOf('--query');
const query = queryIdx >= 0 ? (argv[queryIdx + 1] ?? '') : '';
// 只剔除 --query 和它的值。
// 注意 queryIdx 为 -1 时不能按 -1/0 去过滤 —— 那会把第一个位置参数（档案目录）也吃掉。
const positional = argv.filter(
  (_, i) => !(queryIdx >= 0 && (i === queryIdx || i === queryIdx + 1)),
);

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const dir = path.resolve(positional[0] ?? path.join(home, 'feiyu-diary'));

if (!fs.existsSync(dir)) {
  console.error(`找不到档案目录：${dir}`);
  process.exit(1);
}

const READ_ORDER = ['manifest.json', 'persona.md', 'relationship.json', 'lexicon.json'];
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

// 用插件的默认配置，和线上跑的是同一套
const config = resolveConfig({});

const index = buildIndex(archive.diary);
const { chosen } = selectMemories(archive.diary, index, query, { lastShownTurn: new Map() }, 1, {
  highSim: config.highSim,
  maxShow: config.maxShowPerTurn,
  wanderChance: config.wanderChance,
  minSalience: Math.max(0.15, config.minSalience),
  now: Date.now(),
});

const recentCount = config.recentEntries;
const recent = recentCount > 0 ? archive.diary.slice(-recentCount) : [];

// 手记 —— 也读进来，否则预览出来的东西跟线上注入不是一回事
// （预览的全部价值就在于"跟真的一样"）
const notePath = path.join(dir, HANDNOTE_FILE);
const handNotes = fs.existsSync(notePath) ? selectHandNotes(fs.readFileSync(notePath, 'utf8')) : [];

const rendered = renderMemoryBlock({
  persona: archive.persona,
  relationship: { ...archive.relationship, since: archive.manifest.created_at },
  lexicon: archive.lexicon,
  recent,
  recalled: chosen,
  handNotes,
  handNoteHint: '想给后面的我留话，用 feiyu_note 工具说一声就行 —— 不用管格式，也别为了记事去动文件。',
  includePersona: config.includePersona,
  budget: config.budgetTokens,
  now: Date.now(),
});

const line = (s) => console.log(s);
line('');
line(`档案：${dir}`);
line(`日记 ${archive.diary.length} 条 · 印象 ${archive.relationship.traits.length} 条 · 词汇 ${archive.lexicon.items.length} 个`);
line(`模拟查询：${query === '' ? '（空 —— 等于"没有相关旧事"）' : query}`);
line(`召回命中：${chosen.length} 条${chosen.length > 0 ? `（${chosen.map((c) => c.why).join('、')}）` : ''}`);
line(`预算：${config.budgetTokens} token · 实际：${rendered.tokens} token`);
if (rendered.dropped.length > 0) line(`因预算裁掉：${rendered.dropped.join('、')}`);
if (rendered.trimmed.length > 0) line(`被截断：${rendered.trimmed.join('、')}`);
line('');
line('─'.repeat(64));
line(rendered.text === '' ? '（什么都没注入）' : rendered.text);
line('─'.repeat(64));
line('');

// 顺手报一下比例 —— "像日记还是像说明书"这个问题的主要指标
const seg = (label, text) =>
  text === '' ? 0 : Math.round((text.length / Math.max(1, rendered.text.length)) * 100);
const rel = archive.relationship;
const impText = (rel.traits ?? []).filter((t) => t.about !== 'self').map((t) => t.value + t.evidence).join('');
const diaryText = rendered.text.includes('最近的事：')
  ? rendered.text.slice(rendered.text.indexOf('最近的事：'), rendered.text.indexOf('突然想起来：') > 0 ? rendered.text.indexOf('突然想起来：') : undefined)
  : '';
line(`比例参考：印象 ${seg('imp', impText)}% · 日记段 ${seg('diary', diaryText)}%`);
line('（日记段占比越高，读起来越像日记；印象占比高就偏"用户说明书"）');
line('');
