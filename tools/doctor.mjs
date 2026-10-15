#!/usr/bin/env node
/**
 * `fc doctor` —— 发版前的体检。
 *
 * ─────────────────────────────────────────────────────────────
 * **它跟 `selfcheck.cmd` 的区别：**
 *
 * `selfcheck` 只回答"测试过没过"（测试 + yaml 两样）。
 * 这个回答的是"**现在这个状态能不能发出去**" —— 多查五类：
 *
 *   版本与发布就绪   package.json / exports / files / LICENSE
 *   文档一致性       **文档里写的数字跟实际对不对得上**
 *   档案健康         jsonl 能不能解析、manifest 计数骗不骗人
 *   仓库卫生         有没有误提交的垃圾、工作区干不干净
 *   隐私             **有没有档案文件被 git 追踪、提交身份是不是真邮箱**
 *
 * ── 为什么"文档一致性"要单独列一类 ──
 *
 * 踩过：改了默认预算却只 grep 了 README，漏了 AGENTS.md 和 SPEC.md 里
 * 那几处 700，SPEC 里那块 ❄️ 还指着过期的数 ——
 * **冻结标记指错方向比没标记更糟。**
 *
 * 所以这一项不是"检查文档写得好不好"，是**把文档里的数字当断言去验证**。
 *
 * 用法：
 *   node tools/doctor.mjs            # 完整体检
 *   node tools/doctor.mjs --quick    # 跳过跑测试（快）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { leaksArchive } from './privacy-patterns.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');

/** @type {Array<{level: 'ok'|'warn'|'fail', area: string, msg: string}>} */
const results = [];
const ok = (area, msg) => results.push({ level: 'ok', area, msg });
const warn = (area, msg) => results.push({ level: 'warn', area, msg });
const fail = (area, msg) => results.push({ level: 'fail', area, msg });

const read = (p) => {
  try {
    return fs.readFileSync(path.join(ROOT, p), 'utf8');
  } catch {
    return null;
  }
};
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ═══════════════ 1. 版本与发布就绪 ═══════════════ */

let pkg = null;
try {
  pkg = JSON.parse(read('package.json') ?? '{}');
  ok('发布', `package.json 读到了：${pkg.name}@${pkg.version}`);
} catch (err) {
  fail('发布', `package.json 读不了：${err.message}`);
}

if (pkg) {
  if (typeof pkg.name !== 'string' || pkg.name === '') fail('发布', 'name 缺了');
  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version))) fail('发布', `version 不是 semver：${pkg.version}`);

  // 零运行时依赖是本项目的硬约束（SPEC §1）——依赖一加，装机面就变大了
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length > 0) fail('发布', `出现了运行时依赖：${deps.join(', ')}（本项目承诺零依赖）`);
  else ok('发布', '零运行时依赖 ✓');

  if (pkg.scripts?.prepare || pkg.scripts?.postinstall) {
    fail('发布', '有 prepare/postinstall —— 安装时会执行脚本，市场审核会挡');
  } else ok('发布', '没有安装期脚本 ✓');

  // 客户端半边靠 exports["./client"] + dsh.client 两条都得在
  const ex = pkg.exports ?? {};
  if (!ex['./client']) fail('发布', 'package.json 缺 exports["./client"] —— 侧栏面板装不上');
  else ok('发布', 'exports["./client"] 在 ✓');

  if (!pkg.dsh) fail('发布', 'package.json 缺 dsh 字段（清单信息）');
  else {
    if (!pkg.dsh.client) warn('发布', 'dsh.client 缺了 —— 客户端半边不会被加载');
    else if (!pkg.dsh.client.platform) fail('发布', 'dsh.client.platform 是必填的');
    else ok('发布', `dsh.client.platform = ${pkg.dsh.client.platform} ✓`);
    if (!Array.isArray(pkg.dsh.bundle?.plugins) && !pkg.dsh.bundle) {
      warn('发布', 'dsh.bundle 没写 —— 市场那边可能认不出这是个 bundle');
    }
  }
}

for (const f of ['LICENSE', 'README.md', 'SPEC.md', 'AGENTS.md', 'cordis.patch.yml', 'src/host/index.mjs', 'src/client/index.js']) {
  if (!exists(f)) fail('发布', `缺文件：${f}`);
}
if (!exists('LICENSE')) fail('发布', '没有 LICENSE —— 别人不敢用');
else ok('发布', 'LICENSE 在 ✓');

/* ═══════════════ 2. 代码 ═══════════════ */

// 全部 .mjs / .js 过一遍语法
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.refs') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
};

const srcFiles = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tools'))];
let syntaxBad = 0;
for (const f of srcFiles) {
  try {
    await run(process.execPath, ['--check', f]);
  } catch {
    syntaxBad += 1;
    fail('代码', `语法错误：${path.relative(ROOT, f)}`);
  }
}
if (syntaxBad === 0) ok('代码', `${srcFiles.length} 个源文件语法全过 ✓`);

// 测试
let testCount = null;
if (quick) {
  warn('代码', '--quick：跳过跑测试');
} else {
  try {
    // node --test 把汇总写到 stderr
    const { stdout, stderr } = await run(process.execPath, ['--test'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    const text = `${stdout}\n${stderr}`;
    const m = /^ℹ tests (\d+)$/m.exec(text);
    const mp = /^ℹ pass (\d+)$/m.exec(text);
    const mf = /^ℹ fail (\d+)$/m.exec(text);
    testCount = m ? Number(m[1]) : null;
    if (mf && Number(mf[1]) > 0) fail('代码', `测试有 ${mf[1]} 项失败`);
    else if (mp && testCount !== null && Number(mp[1]) === testCount) ok('代码', `${testCount} 项测试全过 ✓`);
    else warn('代码', `测试跑完了但读数对不上：${m?.[1]} 项 / ${mp?.[1]} 通过`);
  } catch (err) {
    fail('代码', `测试挂了：${(err.stdout ?? '') + (err.stderr ?? '')}`.slice(0, 400));
  }
}

// cordis.patch.yml
try {
  await run(process.execPath, ['tools/check-patch-yaml.mjs'], { cwd: ROOT });
  ok('代码', 'cordis.patch.yml 结构正常 ✓');
} catch (err) {
  const msg = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  if (msg.includes('js-yaml')) warn('代码', 'cordis.patch.yml 跳过（没装 js-yaml，只影响这一项）');
  else fail('代码', `cordis.patch.yml 有问题：${msg}`.slice(0, 300));
}

/* ═══════════════ 3. 文档一致性（把文档当断言验） ═══════════════ */

const docs = ['README.md', 'SPEC.md', 'AGENTS.md', 'docs/本地开发与验证.md']
  .map((n) => ({ name: n, text: read(n) ?? '' }))
  .filter((d) => d.text !== '');

/**
 * 讲历史的数字不算"过期"。
 *
 * 文档里有一类句子是**故意**留着旧数的：*"当时 105 项测试全绿，然后在真实
 * DSH 里一跑还是抓出 5 个致命问题"* —— 那个 105 是事实，改了就是篡改历史。
 *
 * 但读者（和这个检查器）分不出"当前值"和"当年值"，所以规矩是：
 * **讲历史的那一行必须带一个时间词**（当时/曾经/那时/当年），
 * 否则一律当成当前值来验。
 */
const isHistorical = (line) => /当时|曾经|那时|当年/.test(line);

// 测试数
if (testCount !== null) {
  const claims = [];
  const historical = [];
  for (const d of docs) {
    for (const line of d.text.split('\n')) {
      for (const m of line.matchAll(/(\d{2,5})\s*(?:项|个)\s*测试/g)) {
        (isHistorical(line) ? historical : claims).push({ doc: d.name, n: Number(m[1]), line: line.trim() });
      }
    }
  }
  const wrong = claims.filter((c) => c.n !== testCount);
  if (claims.length === 0) warn('文档', `文档里没写测试数（实际 ${testCount}）—— 建议写明，读者会拿它当可信度信号`);
  else if (wrong.length > 0) {
    fail(
      '文档',
      `测试数对不上：实际 ${testCount}，但文档里写着 ${[...new Set(wrong.map((c) => c.n))].join('/')}\n      ` +
        wrong.map((c) => `${c.doc}：${c.line}`).join('\n      '),
    );
  } else ok('文档', `文档里的测试数跟实际一致（${testCount}）✓`);
  if (historical.length > 0) {
    ok('文档', `${historical.length} 处讲历史的旧数（带时间词，不算过期）✓`);
  }
}

// 预算 token 数：读配置默认值，再对文档
//
// ⚠️ 这里**不能**用"约 N token"这种宽泛模式 —— `SPEC.md` 里
// "判断每条约 180 token" 是一句真实的度量，不是预算声明。
// 只认明确在说预算/自我记忆大小 的写法。
let budget = null;
try {
  const cfg = read('src/core/config.mjs') ?? '';
  const m = /budgetTokens[^\n]*?default:\s*(\d+)/.exec(cfg) ?? /budgetTokens[\s\S]{0,200}?default:\s*(\d+)/.exec(cfg);
  if (m) budget = Number(m[1]);
} catch { /* 读不到就算了 */ }

if (budget !== null) {
  const claims = [];
  for (const d of docs) {
    for (const line of d.text.split('\n')) {
      if (isHistorical(line)) continue;
      // 只认这几种明确在说"这块记忆有多大"的写法
      for (const m of line.matchAll(/(?:约|默认)\s*(\d{3,5})\s*token\s*的?(?:自我记忆|记忆|预算)|默认预算\s*[（(]?\s*(\d{3,5})/g)) {
        const n = Number(m[1] ?? m[2]);
        if (Number.isFinite(n)) claims.push({ doc: d.name, n, line: line.trim() });
      }
    }
  }
  const stale = claims.filter((c) => c.n !== budget);
  if (stale.length > 0) {
    fail(
      '文档',
      `预算对不上：默认 ${budget}，但文档里写着\n      ${stale.map((c) => `${c.doc}：${c.line}`).join('\n      ')}`,
    );
  } else if (claims.length > 0) {
    ok('文档', `文档里的预算数跟实际一致（${budget}）✓`);
  }
}

// 提交给市场的 yml：描述里有没有漏掉当前的功能区块
const marketYml = read('上架投稿.yml');
if (marketYml === null) warn('发布', '没找到 上架投稿.yml（市场投稿文件）');
else {
  // 第三区是 v0.2 的主角，市场描述里必须提到它
  if (!/我自己想的|我自己|x我自己/.test(marketYml) && !/on-my-mind|judgement|judgment/i.test(marketYml)) {
    fail('发布', '市场投稿的描述里**没提「我自己想的」第三区** —— 那是这一版的主角，描述过期了');
  } else ok('发布', '市场描述里提到第三区 ✓');
  if (budget !== null && !marketYml.includes(String(budget))) {
    warn('发布', `市场描述里没出现默认预算 ${budget} —— 确认一下是不是漏了`);
  }
  // name 跟 package.json 必须一致，否则市场那边对不上
  if (pkg?.name && !marketYml.includes(pkg.name)) fail('发布', `市场 yml 里的 name 跟 package.json（${pkg.name}）对不上`);
}

/* ═══════════════ 4. 档案健康 ═══════════════ */

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const archiveDir = path.join(home, 'feiyu-diary');
if (!fs.existsSync(archiveDir)) {
  warn('档案', `本机没有档案目录（${archiveDir}）—— 没装过就正常`);
} else {
  const diaryDir = path.join(archiveDir, 'diary');
  let total = 0;
  let bad = 0;
  const ids = new Set();
  const dup = [];
  if (fs.existsSync(diaryDir)) {
    for (const f of fs.readdirSync(diaryDir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(diaryDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        total += 1;
        try {
          const e = JSON.parse(line);
          if (typeof e.id !== 'string' || e.id === '') bad += 1;
          else if (ids.has(e.id)) dup.push(e.id);
          else ids.add(e.id);
        } catch {
          bad += 1;
        }
      }
    }
  }
  if (total === 0) warn('档案', '档案是空的（首次运行就是这样）');
  else if (bad > 0) fail('档案', `${total} 行里有 ${bad} 行解析不了或没有 id`);
  else ok('档案', `${total} 条日记全部可解析 ✓`);

  if (dup.length > 0) fail('档案', `有重复 id：${dup.slice(0, 5).join(', ')}（两条日记撞车，删一条会删两条）`);
  else if (total > 0) ok('档案', 'id 没有重复 ✓');

  try {
    const m = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
    if (m.diary_count !== total) {
      fail('档案', `manifest 说 ${m.diary_count} 条、实际 ${total} 条 —— **计数对不上是丢过写入的信号**`);
    } else ok('档案', `manifest 计数对得上（${total}）✓`);
    if (!Array.isArray(m.deleted_ids)) warn('档案', 'manifest 里没有 deleted_ids（老档案），删除保护会弱一档');
    else ok('档案', `墓碑机制在（${m.deleted_ids.length} 条）✓`);
  } catch {
    fail('档案', 'manifest.json 读不了');
  }

  for (const f of ['persona.md', 'relationship.json', 'lexicon.json']) {
    try {
      JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
      ok('档案', `${f} 能解析 ✓`);
    } catch {
      if (f.endsWith('.json')) fail('档案', `${f} 解析不了`);
    }
  }
}

/* ═══════════════ 5. 仓库卫生 ═══════════════ */

const git = async (args) => {
  try {
    const { stdout } = await run('git', args, { cwd: ROOT });
    return stdout.trim();
  } catch {
    return null;
  }
};

const status = await git(['status', '--porcelain']);
if (status === null) warn('仓库', '不在 git 仓库里，或者没装 git');
else if (status === '') ok('仓库', '工作区干净 ✓');
else {
  const lines = status.split('\n');
  // 版本号之类的联动改动本来就会在发版时出现，别误报
  warn('仓库', `有 ${lines.length} 处未提交改动 —— 发版前应该清掉或单独提交：\n      ${lines.slice(0, 6).join('\n      ')}`);
}

// 误提交的垃圾
const junk = [];
const tracked = (await git(['ls-files']))?.split('\n') ?? [];
for (const f of tracked) {
  if (/^\.refs\//.test(f)) junk.push(`${f}（.refs 是侦察产物，37MB，绝不该进仓库）`);
  if (/\.bak-/.test(f)) junk.push(`${f}（用户档案的备份，不该进代码仓库）`);
  if (/^\.verify/.test(f)) junk.push(`${f}（验证残留）`);
  if (/^\.(pack|compare|prune|dbg|measure|final|check|risk)/.test(f)) junk.push(`${f}（临时脚本）`);
}
if (junk.length > 0) fail('仓库', `误提交的垃圾：\n      ${junk.slice(0, 8).join('\n      ')}`);
else ok('仓库', '没有误提交的垃圾 ✓');

if (!exists('.gitignore')) warn('仓库', '没有 .gitignore');
else {
  const gi = read('.gitignore') ?? '';
  for (const pat of ['.refs', 'node_modules']) {
    if (!gi.includes(pat)) warn('仓库', `.gitignore 里没有 ${pat}`);
  }
}

const log = await git(['log', '--oneline', '-1']);
if (log) ok('仓库', `HEAD: ${log}`);

/* ═══════════════ 6. 隐私（这一推就收不回来了） ═══════════════ */

/**
 * 为什么这一类要单独列：
 *
 * 代码错了能改，**推出去的隐私收不回来。** 而且"顺手发上去"这个动作
 * 恰恰发生在发版、改描述、建 Release 的时候 —— 就是 doctor 会跑的时候。
 *
 * 所以这里把"不该出现在公开仓库里的东西"变成断言。
 * 模式表在 `./privacy-patterns.mjs`，那样才**测得了**它。
 */
const trackedFiles = (await git(['ls-files']))?.split('\n').filter(Boolean) ?? [];
const leaked = [];
for (const f of trackedFiles) {
  const why = leaksArchive(f);
  if (why !== null) leaked.push(`${f}  ← ${why}`);
}
if (leaked.length > 0) {
  fail('隐私', `**仓库里有用户档案！**\n      ${leaked.join('\n      ')}`);
} else ok('隐私', `没有任何档案文件被追踪（${trackedFiles.length} 个文件扫过）✓`);

// 提交身份：真邮箱会被 GitHub 永久挂在每个提交上
const authors = (await git(['log', '--format=%ae']))?.split('\n').filter(Boolean) ?? [];
const uniqAuthors = [...new Set(authors)];
const realMail = uniqAuthors.filter(
  (e) => !/@users\.noreply\.github\.com$/.test(e) && !/@example\.(com|org)$/.test(e),
);
if (realMail.length > 0) {
  warn(
    '隐私',
    `提交里带着非 noreply 邮箱：${realMail.join(', ')}\n` +
      `      它会被永久写进每个提交。想换：git filter-repo，或者只改之后的提交`,
  );
} else if (uniqAuthors.length > 0) {
  ok('隐私', `提交身份是 noreply 邮箱 ✓（${uniqAuthors.join(', ')}）`);
}

// 被追踪的文件里不该出现本机路径 / 用户名
const localPaths = [];
for (const f of trackedFiles) {
  if (!/\.(mjs|js|json|md|yml|yaml|txt)$/.test(f)) continue;
  const text = read(f);
  if (text === null) continue;
  for (const line of text.split('\n')) {
    const m = /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"']+)/.exec(line);
    if (m) localPaths.push(`${f}：${m[0]}`);
  }
}
if (localPaths.length > 0) {
  warn('隐私', `被追踪的文件里有本机绝对路径（会露出你的用户名）：\n      ${[...new Set(localPaths)].slice(0, 6).join('\n      ')}`);
} else ok('隐私', '被追踪的文件里没有本机路径 ✓');

/* ═══════════════ 汇总 ═══════════════ */

const width = 46;
let current = '';
for (const r of results.sort((a, b) => (a.area < b.area ? -1 : 1))) {
  if (r.area !== current) {
    current = r.area;
    console.log('');
    console.log(`── ${current} ${'─'.repeat(Math.max(0, width - current.length - 4))}`);
  }
  const mark = r.level === 'ok' ? '  ✓' : r.level === 'warn' ? '  !' : '  ✖';
  console.log(`${mark} ${r.msg}`);
}

const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
console.log('');
console.log('='.repeat(width + 6));
if (fails.length === 0) {
  console.log(`  ✅ 可以发。${results.filter((r) => r.level === 'ok').length} 项通过${warns.length > 0 ? `，${warns.length} 项提醒` : ''}`);
} else {
  console.log(`  ✖ **先别发。** ${fails.length} 项红的：`);
  for (const f of fails) console.log(`      · [${f.area}] ${f.msg.split('\n')[0]}`);
}
console.log('='.repeat(width + 6));
process.exit(fails.length > 0 ? 1 : 0);
