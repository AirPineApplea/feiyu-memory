/**
 * 三路合并 + 墓碑的测试。
 *
 * 这套东西存在的理由只有一个：**同一份档案被很多个会话同时打开**
 * （实测 10 个），每个会话启动时读进内存、落盘时整份重写。
 * 不合并 → 谁后落盘谁赢，另一个刚写的条目被静默抹掉。
 *
 * 而只做并集 → **删除坏掉**（落盘前读一次磁盘，刚删的又回来了）。
 * 这两条都是真踩出来的，不是假想。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyArchive, mergeArchives, archiveToFiles, archiveFromFiles } from '../src/core/archive.mjs';

const NOW = 1773000000000;

/** 造一条日记 */
const entry = (id, text = `内容 ${id}`) => ({
  id,
  date: '2026-03-01',
  text,
  tags: [],
  kind: 'chat',
  salience: 0.5,
  session: 'session-x',
  created_at: NOW,
  keywords: [],
});

/** 造一份档案，diary 里放指定的 id */
function arch(ids, deletedIds = []) {
  const a = createEmptyArchive(NOW);
  a.diary = ids.map((id) => entry(id));
  a.manifest.deleted_ids = [...deletedIds];
  return a;
}

const idsOf = (a) => a.diary.map((e) => e.id);

test('三路: 两边都有 → 留内存那份（它对已知条目最新）', () => {
  const memory = arch(['a']);
  memory.diary[0].salience = 0.9; // 本会话改过
  const disk = arch(['a']);
  disk.diary[0].salience = 0.1;
  const out = mergeArchives(memory, disk, { baselineIds: ['a'] });
  assert.deepEqual(idsOf(out), ['a']);
  assert.equal(out.diary[0].salience, 0.9, '内存的参数更新');
});

test('三路: 磁盘有、内存没有、基线没有 → **别人刚加的，并进来**', () => {
  // 这就是要防的那件事：别的会话刚写的东西不能被整份重写抹掉
  const memory = arch(['a']);
  const disk = arch(['a', 'b']);
  const out = mergeArchives(memory, disk, { baselineIds: ['a'] });
  assert.deepEqual(idsOf(out), ['a', 'b']);
});

test('三路: 磁盘有、内存没有、基线有 → **我们自己删的，别加回来**', () => {
  const memory = arch([]); // 本会话删了 a
  const disk = arch(['a']); // 磁盘上还没落盘
  const out = mergeArchives(memory, disk, { baselineIds: ['a'] });
  assert.deepEqual(idsOf(out), [], '删掉的东西不能复活');
});

test('三路: 内存有、磁盘没有、基线有 → **别人删了，丢掉**', () => {
  const memory = arch(['a']); // 本会话没删
  const disk = arch([]); // 但别的会话已经删了
  const out = mergeArchives(memory, disk, { baselineIds: ['a'] });
  assert.deepEqual(idsOf(out), [], '别人的删除要认');
});

test('三路: 内存有、磁盘没有、基线没有 → 我们自己刚加的，留着', () => {
  const memory = arch(['new']); // 本会话新写的，还没落盘
  const disk = arch([]);
  const out = mergeArchives(memory, disk, { baselineIds: [] });
  assert.deepEqual(idsOf(out), ['new']);
});

test('墓碑: **本会话自己加的又自己删的，也不能复活**', () => {
  // 这是 burn() 那条测试抓出来的洞：新加的条目不在基线里，
  // 只有基线的话会被判成"别人刚加的" → 捞回来。
  const memory = arch([], ['x']); // 本会话写了 x 又删了它
  const disk = arch(['x']); // 磁盘上还留着（还没落盘）
  const out = mergeArchives(memory, disk, { baselineIds: [] });
  assert.deepEqual(idsOf(out), [], '有墓碑就不能复活');
});

test('墓碑: 两边的墓碑取并集，谁也别想复活', () => {
  const memory = arch([], ['a']);
  const disk = arch(['a', 'b'], ['b']);
  const out = mergeArchives(memory, disk, { baselineIds: ['a', 'b'] });
  assert.deepEqual(idsOf(out), []);
  assert.deepEqual([...out.manifest.deleted_ids].sort(), ['a', 'b']);
});

test('墓碑: 墓碑会落盘、也会读回来', () => {
  const a = arch([], ['gone']);
  // archiveToFiles 返回的是 [{name, data}, ...]（不是元组，也不是 {files}）
  const files = archiveToFiles(a);
  const entries = files.map((f) => ({ name: f.name, text: () => f.data }));
  const { archive: back } = archiveFromFiles(entries, { now: NOW });
  assert.deepEqual(back.manifest.deleted_ids, ['gone'], '墓碑必须活过一轮读写');
});

test('三路: 不传基线时退回简单并集（老行为）', () => {
  const memory = arch(['a']);
  const disk = arch(['a', 'b']);
  const out = mergeArchives(memory, disk);
  assert.deepEqual(idsOf(out), ['a', 'b']);
});

test('三路: 合并结果按时间排好序', () => {
  const memory = arch(['a']);
  const disk = arch(['a', 'b']);
  disk.diary[1].created_at = NOW - 1000; // b 更早
  const out = mergeArchives(memory, disk, { baselineIds: ['a'] });
  assert.deepEqual(idsOf(out), ['b', 'a']);
});

test('三路: 印象/词汇/旧账也照并（它们是并集语义，没有删除界面）', () => {
  const memory = arch(['a']);
  memory.relationship.traits = [
    { key: 'k1', value: 'v1', evidence: '', about: 'user', confidence: 1, salience: 0.5, last_reinforced: NOW },
  ];
  memory.lexicon.items = [{ term: '白饭', kind: 'meme', count: 1, salience: 0.5, last_seen: NOW }];
  const disk = arch(['a']);
  disk.relationship.traits = [
    { key: 'k2', value: 'v2', evidence: '', about: 'self', confidence: 1, salience: 0.5, last_reinforced: NOW },
  ];
  disk.lexicon.items = [{ term: '摸鱼', kind: 'meme', count: 1, salience: 0.5, last_seen: NOW }];
  const out = mergeArchives(memory, disk, { baselineIds: ['a'] });
  assert.deepEqual(out.relationship.traits.map((t) => t.key).sort(), ['k1', 'k2']);
  assert.deepEqual(out.lexicon.items.map((i) => i.term).sort(), ['摸鱼', '白饭']);
});

test('三路: manifest 的 diary_count 跟着实际条数走，不许骗人', () => {
  const out = mergeArchives(arch(['a']), arch(['a', 'b']), { baselineIds: ['a'] });
  assert.equal(out.manifest.diary_count, 2);
});
