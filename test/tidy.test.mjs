/**
 * `tools/tidy-archive.mjs` 的测试。
 *
 * 它直接改用户的记忆文件，所以护栏跟 `fix-time-words` 一样：
 * 演的时候不写盘、改之前备份、改完能解析回来、再跑一次什么都不动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const NODE = process.execPath;
const TOOL = fileURLToPath(new URL('../tools/tidy-archive.mjs', import.meta.url));

async function makeArchive({ traits = [], lexicon = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'feiyu-tidy-'));
  await writeFile(
    path.join(dir, 'relationship.json'),
    `${JSON.stringify({ familiarity: 0.2, nickname: '', traits, grievances: [] }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(dir, 'lexicon.json'),
    `${JSON.stringify({ items: lexicon }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

const invoke = (dir, ...extra) =>
  run(NODE, [TOOL, dir, ...extra], { env: { ...process.env, DSH_HOME: dir } });

const trait = (key, value, about = 'user', extra = {}) => ({
  key,
  value,
  evidence: '',
  about,
  confidence: 1,
  salience: 0.5,
  last_reinforced: 1,
  ...extra,
});

test('tidy: 默认只演不写', async () => {
  const dir = await makeArchive({ traits: [trait('我的底线', '没落盘前不假装记得')] });
  try {
    const before = await readFile(path.join(dir, 'relationship.json'), 'utf8');
    const { stdout } = await invoke(dir);
    assert.match(stdout, /user → self/, '要把改动打出来');
    assert.equal(await readFile(path.join(dir, 'relationship.json'), 'utf8'), before, '演的时候不能写');
    assert.equal((await readdir(dir)).filter((f) => f.includes('bak')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tidy: 把"我的做法"从 user 挪到 self，并且留备份', async () => {
  const dir = await makeArchive({
    traits: [
      trait('我的底线', '没落盘前不假装记得'),
      trait('兴趣', '写小说，愿意拿旧稿给人看'), // 这条是真·对他的印象，不该动
    ],
  });
  try {
    await invoke(dir, '--write');
    const rel = JSON.parse(await readFile(path.join(dir, 'relationship.json'), 'utf8'));
    assert.equal(rel.traits.find((t) => t.key === '我的底线').about, 'self');
    assert.equal(rel.traits.find((t) => t.key === '兴趣').about, 'user', '不该误伤真的印象');
    assert.equal((await readdir(dir)).filter((f) => f.includes('bak-tidy')).length, 1, '要留备份');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tidy: 同一件事两种说法会合并，且保留有画面的那条', async () => {
  const dir = await makeArchive({
    traits: [
      trait('对我的期待', '解答前先问细节'),
      trait('先问细节', '解答前先问细节', 'user', {
        evidence: '他给我定了这条规矩',
        confidence: 2,
      }),
    ],
  });
  try {
    await invoke(dir, '--write');
    const rel = JSON.parse(await readFile(path.join(dir, 'relationship.json'), 'utf8'));
    assert.equal(rel.traits.length, 1, '两条该并成一条');
    assert.equal(rel.traits[0].key, '对我的期待');
    assert.equal(rel.traits[0].evidence, '他给我定了这条规矩', '要留下有画面的那条的证据');
    assert.equal(rel.traits[0].confidence, 2, 'confidence 取高的');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tidy: 完全重复的两条会去掉一条', async () => {
  const dir = await makeArchive({
    traits: [
      trait('归因', '观察对不等于归因对', 'self'),
      trait('归因', '观察对不等于归因对', 'user'),
    ],
  });
  try {
    await invoke(dir, '--write');
    const rel = JSON.parse(await readFile(path.join(dir, 'relationship.json'), 'utf8'));
    assert.equal(rel.traits.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tidy: 段落标题和工作术语会被挑出词汇表，真口头禅留着', async () => {
  const dir = await makeArchive({
    lexicon: ['肥鱼', '摸鱼', '我自己想的', '别对我做的事', '第五刀', '历'].map((term) => ({
      term,
      kind: 'meme',
      count: 1,
      salience: 0.35,
      last_seen: 1,
    })),
  });
  try {
    await invoke(dir, '--write');
    const lex = JSON.parse(await readFile(path.join(dir, 'lexicon.json'), 'utf8'));
    assert.deepEqual(
      lex.items.map((i) => i.term),
      ['肥鱼', '摸鱼'],
      '段落标题和工作术语该走，真口头禅该留',
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tidy: 再跑一次什么都不改（幂等）', async () => {
  const dir = await makeArchive({
    traits: [trait('我的底线', '没落笔前不假装记得'), trait('先问细节', 'x'), trait('对我的期待', 'y')],
    lexicon: [{ term: '我自己想的', kind: 'meme', count: 1, salience: 0.35, last_seen: 1 }],
  });
  try {
    await invoke(dir, '--write');
    const after1 = await readFile(path.join(dir, 'relationship.json'), 'utf8');
    const lex1 = await readFile(path.join(dir, 'lexicon.json'), 'utf8');
    const { stdout } = await invoke(dir, '--write');
    assert.equal(await readFile(path.join(dir, 'relationship.json'), 'utf8'), after1);
    assert.equal(await readFile(path.join(dir, 'lexicon.json'), 'utf8'), lex1);
    assert.match(stdout, /共 0 处要改/);
    assert.equal(
      (await readdir(dir)).filter((f) => f.includes('bak-tidy')).length,
      2,
      '没改动就不该再留备份',
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('tidy: 档案目录不存在时报错退出，不静默', async () => {
  await assert.rejects(() => invoke(path.join(tmpdir(), 'feiyu-does-not-exist-xyz')), /找不到档案文件/);
});
