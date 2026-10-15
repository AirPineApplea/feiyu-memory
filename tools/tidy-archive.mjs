#!/usr/bin/env node
/**
 * 整理老档案里"放错了格子"的东西。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它：**固化流程会把"我该怎么做"记成"他是什么样的人"。**
 *
 * 实测（2026-10-14 的真档案）：
 *
 *   `宗旨先行`   "写文档先把宗旨钉在最上面"            → 标成了 about=user
 *   `删旧规矩`   "会影响未来行为的留…删"               → 同上
 *   `叙事与规则` "故事留 SPEC，AGENTS.md 只留规则"      → 同上
 *   `语气`       "别为了工整把语气磨平"                 → 同上
 *   `读者视角`   "这类问题只能从读者那侧看"             → 同上（这是判断）
 *   `我的底线`   "没落盘前不假装记得"                   → key 都写着"我的底线"了
 *   `归因`       和一条 about=self 的 `归因` 内容重复   → 撞车
 *
 * 这些全是**我给自己定的做法**，不是"他这个人怎么样"。
 * 它们挤在「我对他的一些印象」里，读起来就像我在给他建档。
 *
 * 还有 lexicon：模型把**记忆块的小标题**当成了我的口头禅 ——
 * 「我自己想的」「别对我做的事」是区块名，「第五刀」是工作术语，
 * 「历」是一个词被切出来的碎片。
 *
 * 用法：
 *   node tools/tidy-archive.mjs            # 演一遍，看会改什么
 *   node tools/tidy-archive.mjs --write    # 真改（先自动备份）
 *
 * ⚠️ **改的是用户自己的记忆**，所以：
 *   - 默认只演不写
 *   - 写之前一定备份
 *   - 改完再解析一遍校验
 *   - 幂等：再跑一次什么都不改
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const positional = argv.filter((a) => !a.startsWith('--'));
const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const dir = path.resolve(positional[0] ?? path.join(home, 'feiyu-diary'));

/* ───────────────────────── 规则表 ───────────────────────── */

/**
 * 这些 key 装的其实是"我该怎么做"，不是"他是什么样的人"。
 *
 * **写死是有意的** —— 归类是个判断，判断不该藏在正则里。
 * 每加一条，都在这里留下"为什么"。
 */
const TRAITS_ARE_SELF = {
  我的底线: 'key 自己都写着"我的底线"，这是自我约束',
  读者视角: '这是我从事故里总结的判断，不是对他的描述',
  宗旨先行: '我的写法，不是他的偏好',
  删旧规矩: '我用的判据',
  叙事与规则: '我的整理原则',
  语气: '固化 prompt 里给我自己定的规矩',
  归因: '这条的内容与另一条 about=self 的完全重复，归属应对齐',
  // ── 2026-10-15 复发的一批 ──
  // 判据：**这条能不能填进「他是个 ___ 的人」？** 填不进去就说明不是在说他。
  不修平: '"留着疤不修平是算过账的便宜做法"—— 那是我的做法，不是在描述他',
};

/**
 * 会被当成口头禅混进来的**区块标题**和工作术语。
 *
 * 跟着注入区的段落名走 —— 段落改名了，这里要跟着改。
 * （`persona.mjs` 的 `renderNotes`/`renderRecent`/`renderHandNotes`，
 *   以及 `persona.md` 里那几个 `## 小标题`。）
 */
const NOT_A_CATCHPHRASE = new Set([
  // 记忆块的段落名
  '我自己想的',
  '最近的事',
  '突然想起来',
  '我对他的一些印象',
  '上一棒留下的',
  '我还欠着他的',
  '我们',
  '手记',
  // 人格文件的小标题
  '我是谁',
  '说话方式',
  '主食',
  '我的底线',
  '我承认的缺点',
  '别对我做的事',
  '我后来想明白的',
  // 工作术语 / 碎片（不是"一听就有味道的词"）
  '第五刀',
  '历',
  // ── 2026-10-15 复发的一批 ──
  // **当天的议题不是口头禅。** 这些词是某一轮聊的那件事的名字，
  // 出现一次就再没出现过，跟"白饭""摸鱼"完全不是一类东西。
  '坏账凭证',
  '漂流瓶',
  '邮局',
  '前面那些我',
]);

/**
 * 说的是同一件事、但 `key` 和措辞不同的两条 —— 合并到 canonical 上。
 *
 * 机械规则抓不住这种：`对我的期待`("以省 token，但接受在目标明确时直接答")
 * 和 `先问细节`("省 token，但目标明确时接受直接答") 词面不一样，指同一件事。
 * 所以跟上面那张表一样，**明写**。
 *
 * 合并时保留**有画面的那条的 evidence** 和**更高的 confidence**。
 */
const TRAITS_MERGE = {
  先问细节: '对我的期待',
};

/* ───────────────────────── 干活 ───────────────────────── */

const relFile = path.join(dir, 'relationship.json');
const lexFile = path.join(dir, 'lexicon.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (!fs.existsSync(relFile) && !fs.existsSync(lexFile)) {
  console.error(`找不到档案文件：${dir}`);
  process.exit(1);
}

let changed = 0;
const backup = (file) => {
  if (!write) return;
  const b = `${file}.bak-tidy-${stamp}`;
  fs.copyFileSync(file, b);
  console.log(`  ↳ 已写入，备份在 ${path.basename(b)}`);
};

/* ── 1. 关系：归错类的挪回去 + 去重 ── */
if (fs.existsSync(relFile)) {
  const rel = JSON.parse(fs.readFileSync(relFile, 'utf8'));
  const traits = Array.isArray(rel.traits) ? rel.traits : [];
  console.log(`关系：${traits.length} 条印象`);

  for (const t of traits) {
    if (t?.about === 'user' && Object.hasOwn(TRAITS_ARE_SELF, t.key)) {
      console.log(`  [挪类] ${t.key}：user → self`);
      console.log(`         理由：${TRAITS_ARE_SELF[t.key]}`);
      console.log(`         内容：${t.value}`);
      t.about = 'self';
      changed += 1;
    }
  }

  // 去重：key + value 都一样的两条（一个 user 一个 self 的也算），留 confidence 高的
  const seen = new Map();
  const kept = [];
  for (const t of traits) {
    // 先看要不要并到别的 key 上（明写的那几条）
    const canonical = t?.key !== undefined ? TRAITS_MERGE[t.key] : undefined;
    if (canonical !== undefined) {
      const target = kept.find((x) => x?.key === canonical);
      if (target !== undefined) {
        console.log(`  [合并] ${t.key} → ${canonical}（同一件事，两种说法）`);
        console.log(`         留下画面：${t.evidence || '（这条没有）'}`);
        // 谁有画面用谁的；confidence 取高的
        if (!target.evidence && t.evidence) target.evidence = t.evidence;
        target.confidence = Math.max(target.confidence ?? 0, t.confidence ?? 0);
        target.salience = Math.max(target.salience ?? 0, t.salience ?? 0);
        target.last_reinforced = Math.max(target.last_reinforced ?? 0, t.last_reinforced ?? 0);
        changed += 1;
        continue;
      }
      // 目标还没出现，先把它改名，等目标来了再并（或者它自己就是目标）
      t.key = canonical;
    }

    const sig = `${t?.key}\u0000${t?.value}`;
    const prev = seen.get(sig);
    if (prev === undefined) {
      seen.set(sig, t);
      kept.push(t);
      continue;
    }
    const winner = (t.confidence ?? 0) > (prev.confidence ?? 0) ? t : prev;
    console.log(`  [去重] ${t.key}：两条「${t.value}」合成一条（留 confidence=${winner.confidence}）`);
    const at = kept.indexOf(prev);
    kept[at] = winner;
    seen.set(sig, winner);
    changed += 1;
  }

  if (write && changed > 0) {
    rel.traits = kept;
    fs.writeFileSync(relFile, `${JSON.stringify(rel, null, 2)}\n`, 'utf8');
    backup(relFile);
  }
}

/* ── 2. 词汇：把区块标题和工作术语挑出去 ── */
if (fs.existsSync(lexFile)) {
  const lex = JSON.parse(fs.readFileSync(lexFile, 'utf8'));
  const items = Array.isArray(lex.items) ? lex.items : [];
  console.log(`\n词汇：${items.length} 个`);
  const kept = items.filter((i) => !NOT_A_CATCHPHRASE.has(i?.term));
  for (const i of items) {
    if (NOT_A_CATCHPHRASE.has(i?.term)) {
      console.log(`  [挑出] ${i.term} —— 是段落名/工作术语，不是我嘴里的话`);
      changed += 1;
    }
  }

  if (write && kept.length !== items.length) {
    // 重新解析一次校验，别把文件写坏
    const next = { ...lex, items: kept };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const check = JSON.parse(text);
    if (check.items.length !== kept.length) throw new Error('词汇改写后校验不过');
    fs.writeFileSync(lexFile, text, 'utf8');
    backup(lexFile);
  }
}

console.log('');
console.log(`共 ${changed} 处要改。`);
if (!write && changed > 0) {
  console.log('');
  console.log('这是**演一遍**，什么都没写。看清了再加 --write：');
  console.log(`  node tools/tidy-archive.mjs "${dir}" --write`);
}
if (write && changed === 0) console.log('没得改 —— 幂等的，跑第二遍什么都不动。');
