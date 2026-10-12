#!/usr/bin/env node
/**
 * 校验 cordis.patch.yml 的结构。
 *
 * 为什么需要它：DSH 对 patch 文件的要求是硬的 ——
 * **顶层必须是 YAML 数组**，行的键只有 8 个
 * （id / name / config / group / disabled / inject / intercept / isolate）
 * 加上 patch 自己的 insert。写错了 loader 会直接抛错、插件根本装不上，
 * 而 YAML 的错误（缩进、`!!js` tag、类型被引号变成字符串）肉眼很难看出来。
 *
 * 用法：
 *   node tools/check-patch-yaml.mjs [patchFile] [jsYamlDir]
 *
 * 默认：
 *   patchFile = ./cordis.patch.yml
 *   jsYamlDir = ./.refs/tools/node_modules/js-yaml
 *
 * js-yaml 从哪来：本仓库不把它列为依赖（它只是开发期工具）。
 * 用 tools/asar-extract.mjs 从本机 DSH 里抽一份：
 *
 *   node tools/asar-extract.mjs extract \
 *     "<DeepSeek Harness>/resources/app.asar" \
 *     ./.refs/tools \
 *     node_modules/js-yaml
 *
 * 或者干脆 `npm i -D js-yaml` 然后传它的目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const patchFile = path.resolve(repoRoot, process.argv[2] ?? 'cordis.patch.yml');
const jsYamlDir = path.resolve(repoRoot, process.argv[3] ?? '.refs/tools/node_modules/js-yaml');

/** DSH 文档里写明的行键 */
const ROW_KEYS = new Set([
  'id',
  'name',
  'config',
  'group',
  'disabled',
  'inject',
  'intercept',
  'isolate',
]);
const PATCH_KEYS = new Set([...ROW_KEYS, 'insert']);

let yaml;
try {
  const require = createRequire(import.meta.url);
  yaml = require(jsYamlDir);
} catch (err) {
  console.error(`找不到 js-yaml：${jsYamlDir}`);
  console.error(`（${err instanceof Error ? err.message : String(err)}）`);
  console.error('\n用 tools/asar-extract.mjs 从 DSH 里抽一份，或 npm i -D js-yaml 后把目录作为第二个参数传进来。');
  process.exit(2);
}

if (!fs.existsSync(patchFile)) {
  console.error(`找不到 patch 文件：${patchFile}`);
  process.exit(2);
}

const problems = [];
const note = (msg) => problems.push(msg);

let doc;
try {
  doc = yaml.load(fs.readFileSync(patchFile, 'utf8'));
} catch (err) {
  console.error(`YAML 解析失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!Array.isArray(doc)) {
  note('顶层必须是 YAML 数组 —— DSH 会直接抛错 "must be a top-level YAML array of loader patch entries"');
}

const rows = [];
function walkRows(list, where) {
  list.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      note(`${where}[${i}] 不是对象`);
      return;
    }
    for (const k of Object.keys(entry)) {
      if (!PATCH_KEYS.has(k)) note(`${where}[${i}] 有未知键 "${k}"`);
    }
    if (entry.id !== undefined && typeof entry.id !== 'string') {
      note(`${where}[${i}].id 必须是字符串（YAML 里没加引号的数字/时间会被解析成别的类型）`);
    }
    if (entry.name !== undefined && typeof entry.name !== 'string') {
      note(`${where}[${i}].name 必须是字符串`);
    }
    if (entry.group === true) {
      if (!Array.isArray(entry.config)) note(`${where}[${i}] group:true 时 config 必须是数组`);
      else walkRows(entry.config, `${where}[${i}].config`);
    }
    if (entry.insert !== undefined) {
      if (!Array.isArray(entry.insert)) note(`${where}[${i}].insert 必须是数组`);
      else {
        entry.insert.forEach((r, j) => {
          if (r === null || typeof r !== 'object') note(`${where}[${i}].insert[${j}] 不是对象`);
          else {
            for (const k of Object.keys(r)) {
              if (!ROW_KEYS.has(k)) note(`${where}[${i}].insert[${j}] 有未知键 "${k}"`);
            }
            if (typeof r.name !== 'string') note(`${where}[${i}].insert[${j}] 缺 name`);
            rows.push(r);
          }
        });
      }
    }
  });
}
if (Array.isArray(doc)) walkRows(doc, '$');

// 插件包自己的 package.json 必须与 patch 里的 name 对得上
const pkgPath = path.join(repoRoot, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const r of rows) {
    if (r.name === pkg.name) continue;
    // 不是错误：patch 里也可能覆写内置行。只提示。
    console.log(`· 提示：patch 里的 name "${r.name}" 与本包名 "${pkg.name}" 不同（覆写内置行时正常）`);
  }
  if (pkg.dsh?.bundle?.patch === undefined) note('package.json 缺 dsh.bundle.patch');
  const scriptNames = Object.keys(pkg.scripts ?? {});
  for (const bad of ['prepare', 'postinstall', 'preinstall', 'install']) {
    if (scriptNames.includes(bad)) {
      note(`package.json 有 "${bad}" 脚本 —— pnpm 11 会拦住 GitHub 安装（需要人工授权 allowBuilds）`);
    }
  }
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
    if (dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-')) {
      note(`peerDependencies 里有 "${dep}" —— 这会被安装期兼容性校验逐条比对运行时版本，写错就装不上`);
    }
  }
}

if (problems.length === 0) {
  const configKeys = rows[0]?.config ? Object.keys(rows[0].config).length : 0;
  console.log(`✅ ${path.relative(repoRoot, patchFile)} 结构正常（${rows.length} 个插件行，首个行有 ${configKeys} 个配置项）`);
  process.exit(0);
}

console.error(`❌ 发现 ${problems.length} 个问题：`);
for (const p of problems) console.error(`   - ${p}`);
process.exit(1);
