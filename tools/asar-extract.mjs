#!/usr/bin/env node
/**
 * 无依赖的 Electron asar 解包器。
 *
 * 用法:
 *   node asar-extract.mjs list   <archive> [prefix]
 *   node asar-extract.mjs stat   <archive> [prefix]
 *   node asar-extract.mjs extract <archive> <outDir> [prefix] [excludeRegex]
 *
 * asar 布局 (Electron 实测):
 *   [0..4)   : UInt32LE = 4
 *   [4..8)   : UInt32LE = headerPickleSize (已 4 字节对齐)
 *   [8..12)  : UInt32LE = payloadSize
 *   [12..16) : UInt32LE = jsonLen
 *   [16..)   : UTF-8 JSON 头
 *   文件数据 : 8 + headerPickleSize 起，offset 相对于该基点
 */
import fs from 'node:fs';
import path from 'node:path';

const [mode, archive, a3, a4, a5] = process.argv.slice(2);
if (!mode || !archive) {
  console.error('usage: asar-extract.mjs <list|stat|extract> <archive> [outDir] [prefix]');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const hb = Buffer.alloc(jsonLen);
fs.readSync(fd, hb, 0, jsonLen, 16);
const tree = JSON.parse(hb.toString('utf8'));
const base = 8 + headerSize;

/** 收集条目: {path, size, offset|null(目录)} */
function collect(prefix) {
  const out = [];
  (function walk(node, p) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const cur = p ? `${p}/${name}` : name;
      if (entry.files) {
        if (!prefix || cur.startsWith(prefix) || prefix.startsWith(cur)) walk(entry, cur);
      } else if (!prefix || cur.startsWith(prefix)) {
        out.push({ path: cur, size: Number(entry.size ?? 0), offset: entry.offset ?? null, link: entry.link ?? null });
      }
    }
  })(tree, '');
  return out;
}

const prefixForList = mode === 'extract' ? a4 : a3;
const entries = collect(prefixForList);

if (mode === 'list') {
  for (const e of entries) console.log(`${String(e.size).padStart(10)}  ${e.path}`);
  console.log(`\n${entries.length} files`);
} else if (mode === 'stat') {
  const byPkg = new Map();
  for (const e of entries) {
    // 归并到 @scope/pkg 或首个路径段
    const seg = e.path.split('/');
    const key = seg[0].startsWith('@') ? seg.slice(0, 2).join('/') : seg[0];
    const cur = byPkg.get(key) ?? { files: 0, bytes: 0 };
    cur.files++; cur.bytes += e.size;
    byPkg.set(key, cur);
  }
  const rows = [...byPkg].sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [k, v] of rows) console.log(`${(v.bytes / 1048576).toFixed(1).padStart(9)} MB  ${String(v.files).padStart(6)} files  ${k}`);
  console.log(`\n合计 ${(rows.reduce((s, r) => s + r[1].bytes, 0) / 1048576).toFixed(1)} MB / ${entries.length} files`);
} else if (mode === 'extract') {
  const outDir = a3;
  if (!outDir) { console.error('extract 需要 outDir'); process.exit(2); }
  const exclude = a5 ? new RegExp(a5) : null;
  let n = 0, bytes = 0;
  const buf = Buffer.alloc(1 << 20);
  for (const e of entries) {
    if (exclude && exclude.test(e.path)) continue;
    const dest = path.join(outDir, e.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (e.link) { n++; continue; } // 跳过符号链接条目
    const need = e.size;
    const data = Buffer.allocUnsafe(need);
    let got = 0;
    while (got < need) {
      const want = Math.min(buf.length, need - got);
      const read = fs.readSync(fd, buf, 0, want, base + Number(e.offset) + got);
      if (read <= 0) break;
      buf.copy(data, got, 0, read);
      got += read;
    }
    fs.writeFileSync(dest, data);
    n++; bytes += need;
  }
  console.log(`解出 ${n} 个文件, ${(bytes / 1048576).toFixed(1)} MB -> ${outDir}`);
}
fs.closeSync(fd);
