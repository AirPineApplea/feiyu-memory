/**
 * 安全审计（2026-10-23，review.lingshulab.com）四条发现的回归测试。
 *
 * F1 [P1] feiyu_note 不过隐私闸 —— 密钥原样落盘
 * F2 [P2] 密钥规则只认英文键名
 * F4 [P1] 焚毁 / 忘掉删不干净，重启复活
 *
 * F3（面板跨站删除）在 host.test.mjs 里，那两条需要假 ctx。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scrub } from '../src/core/privacy.mjs';
import {
  archiveToFiles,
  archiveFromFiles,
  createEmptyArchive,
  normalizeDiaryEntry,
  DIARY_DIR,
} from '../src/core/archive.mjs';

/* ═════════════════ F2：中文凭据 ═════════════════ */

const SECRET_CASES = [
  ['sk- 前缀', 'key 是 sk-0123456789abcdefABCDEF'],
  ['password=', 'password=Hunter2pass'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'],
  ['中文「密码是」', '服务器 root 密码是 Zx9!kq2#Lm7$Pw'],
  ['中文「密码：」', 'WiFi 密码：hunter2pass2026'],
  ['中文「口令」无标点', '数据库口令 Hunter2pass'],
  ['英文键名 + 中文连接词', '阿里云 AccessKey Secret 是 wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
  ['英文 my password is', 'my password is Hunter2pass'],
  ['URL 内嵌凭据', 'postgres://admin:Hunter2pass@db.internal:5432/app'],
];

for (const [name, text] of SECRET_CASES) {
  test('F2: 拦得住 —— ' + name, () => {
    const r = scrub(text, { thirdParty: false });
    assert.notEqual(r.text, text, '这条必须被改：' + text);
    assert.ok(r.text.includes('[已拦截]'), '应该替换成 [已拦截]');
  });
}

test('F2: 别误伤日常话', () => {
  for (const t of ['我忘了密码', '这个网站要输密码才能进', '密码是一个词语', '我们聊聊 token 计费']) {
    assert.equal(scrub(t, { thirdParty: false }).text, t, '不该动：' + t);
  }
});

/* ═════════════════ F1：note 写入也要洗 ═════════════════ */

test('F1: 审计报告里那段原文，洗完不该剩 key / 手机号 / 人名', () => {
  // 这一段就是报告里 feiyu_note 落盘的那条
  const raw = '他把部署 key sk-0123456789abcdefABCDEF0123 发给我了，让我记着；王总的电话 13800138000 也记一下';
  const r = scrub(raw, { thirdParty: true, amountThreshold: 100 });

  assert.equal(r.blocked, true, '密钥命中必须标记 blocked');
  assert.equal(r.text.includes('sk-0123456789abcdefABCDEF0123'), false, '密钥不能留');
  assert.equal(r.text.includes('13800138000'), false, '手机号不能留');
  assert.equal(r.text.includes('王总'), false, '人名不能留');
  assert.ok(r.text.includes('[已拦截]'));
});

test('F1: 单独跑 scrub 是干净的 —— 问题在调用方漏了它', () => {
  // 这条测试的意义：把"函数没问题、是调用点漏了"这个事实钉住，
  // 免得下次又去翻 privacy.mjs 找 bug。
  const r = scrub('password=Hunter2pass', { thirdParty: false });
  assert.equal(r.blocked, true);
  assert.equal(r.text.includes('Hunter2pass'), false);
});

/* ═════════════════ F4：删除要落盘 ═════════════════ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-f4-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ } });

/** 模拟 host 的 writeArchiveDir：写清单 + 清掉清单外的月份文件 */
function writeDir(dir, files) {
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data, 'utf8');
  }
  const wanted = new Set(
    files.filter((f) => f.name.startsWith(DIARY_DIR + '/')).map((f) => path.basename(f.name)),
  );
  const dd = path.join(dir, DIARY_DIR);
  if (!fs.existsSync(dd)) return;
  for (const name of fs.readdirSync(dd)) {
    if (!name.endsWith('.jsonl') || wanted.has(name)) continue;
    fs.rmSync(path.join(dd, name), { force: true });
  }
}

function loadDir(dir) {
  const entries = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else entries.push({ name: path.relative(dir, p).split(path.sep).join('/'), text: () => fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return archiveFromFiles(entries, { now: Date.now() }).archive;
}

function seed() {
  const a = createEmptyArchive(Date.now(), '# 我是谁');
  a.diary.push(normalizeDiaryEntry({ id: 'd_20261020_01', date: '2026-10-20', text: '他说他在准备辞职，还没告诉任何人', kind: 'chat', salience: 0.7, created_at: Date.now() - 2000 }));
  a.diary.push(normalizeDiaryEntry({ id: 'd_20261020_02', date: '2026-10-20', text: '他说体检报告有个指标不太好', kind: 'chat', salience: 0.7, created_at: Date.now() - 1000 }));
  return a;
}

test('F4: 焚毁 → 重启，读回 0 条（这是那条 P1 的核心）', () => {
  const dir = path.join(tmpRoot, 'burn');
  const a = seed();
  writeDir(dir, archiveToFiles(a));

  const burned = { ...a, diary: [], manifest: { ...a.manifest, deleted_ids: a.diary.map((e) => e.id) } };
  writeDir(dir, archiveToFiles(burned));

  const left = fs.existsSync(path.join(dir, DIARY_DIR)) ? fs.readdirSync(path.join(dir, DIARY_DIR)) : [];
  assert.deepEqual(left, [], '焚毁后那个月文件必须消失');

  const reloaded = loadDir(dir);
  assert.equal(reloaded.diary.length, 0, '重启不能把删掉的内容读回来');
  assert.equal(reloaded.manifest.diary_count, 0);
});

test('F4: 删掉当月唯一一条 → 重启，那条不在', () => {
  const dir = path.join(tmpRoot, 'one');
  const a = seed();
  writeDir(dir, archiveToFiles(a));

  const kept = {
    ...a,
    diary: a.diary.filter((e) => e.id !== 'd_20261020_01'),
    manifest: { ...a.manifest, deleted_ids: ['d_20261020_01'] },
  };
  writeDir(dir, archiveToFiles(kept));

  const reloaded = loadDir(dir);
  assert.equal(reloaded.diary.length, 1);
  assert.equal(reloaded.diary.some((e) => e.text.includes('辞职')), false, '删掉的那条不能复活');
});

test('F4: 磁盘上有残留、manifest 有墓碑 → 读的时候也要挡住', () => {
  // 双保险：就算写盘那一步没清干净（老档案、别的进程写坏的），
  // 加载时按墓碑过滤也能挡住。
  const dir = path.join(tmpRoot, 'tomb');
  const a = seed();
  writeDir(dir, archiveToFiles(a));

  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  man.deleted_ids = ['d_20261020_01'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 2), 'utf8');

  const reloaded = loadDir(dir);
  assert.equal(reloaded.diary.length, 1);
  assert.equal(reloaded.diary[0].id, 'd_20261020_02');
});

test('F4: 日记.md 本来就不含被删的内容（渲染版是对的，锅在 jsonl）', () => {
  // 报告里那句「日记.md 含"辞职" = false」值得钉住：
  // 它说明问题不在渲染，而在持久化那一步。
  const a = seed();
  const files = archiveToFiles(a);
  const diaryMdLike = files.map((f) => f.data).join('\n');
  assert.ok(diaryMdLike.includes('辞职'), '原档案里应该有');
  // 焚毁之后，落盘清单里一个字都不该有
  const burned = { ...a, diary: [], manifest: { ...a.manifest, deleted_ids: a.diary.map((e) => e.id) } };
  const after = archiveToFiles(burned).map((f) => f.data).join('\n');
  assert.equal(after.includes('辞职'), false, '焚毁后的落盘清单里不能有');
});
