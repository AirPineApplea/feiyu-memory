/**
 * Host 接线冒烟测试 —— 用一个假 ctx 把整个插件跑起来，不需要真的 DSH。
 *
 * 这一组测试存在的意义：注入点、事件签名、闸门、带外队列、写盘
 * 这几处任何一处接错，都是"静默失效"（不报错、就是不记）。
 * 假 ctx 能在几毫秒内把整条链路验一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply } from '../src/host/index.mjs';
import { archiveToFiles, createEmptyArchive, ensurePersonaStructure, normalizeDiaryEntry } from '../src/core/archive.mjs';

const NOW = Date.now();

/** 用例的数据目录约定：临时根目录下的 feiyu-diary */
const dataDirFor = (home) => path.join(home, 'feiyu-diary');

const GOOD_REPLY = JSON.stringify({
  skip: false,
  diary: {
    text: '今天我没问清语言就动手了，是我的错。',
    tags: ['代码', '沟通失误'],
    kind: 'failure',
    salience: 0.75,
    resolved: false,
  },
  relationship: {
    nickname: '肥鱼',
    familiarityDelta: 0.02,
    traits: [{ key: '动手前', value: '动手前先问清前提', delta: 1 }],
    grievances: [{ what: '没问清语言就动手', intensity: 0.6, resolved: false }],
  },
  forget: [],
});

/** 搭一个最小可用的假 Harness */
function makeHarness(reply = GOOD_REPLY) {
  const handlers = new Map();
  const provided = new Map();
  const disposers = [];
  const agents = [];
  let lastRequest = null;
  let streamCalls = 0;
  let llmReply = reply;

  const llm = {
    stream(opts) {
      streamCalls += 1;
      lastRequest = opts;
      const text = llmReply;
      return (async function* gen() {
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(n) {
      if (n === 'llm') return llm;
      if (n === 'agentDefaultModel') {
        return {
          currentSelection: () => ({
            provider: 'deepseek-account',
            model: 'deepseek-flash',
            reasoningEffort: 'low',
          }),
        };
      }
      return undefined;
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    on(n, fn) {
      handlers.set(n, [...(handlers.get(n) ?? []), fn]);
      return () => {};
    },
    provide(n, v) {
      provided.set(n, v);
    },
    agents: { list: () => [...agents] },
  };

  const emit = (n, ...args) => {
    for (const h of handlers.get(n) ?? []) h(...args);
  };

  const makeAgent = (id) => {
    const sections = [];
    const agent = {
      id,
      sections,
      ctx: {
        inject(_services, cb) {
          const scope = {
            systemPrompt: {
              getSectionOrder: () => 0,
              section(s) {
                sections.push(s);
                return () => {};
              },
            },
          };
          cb(scope);
          return { dispose() {} };
        },
      },
    };
    agents.push(agent);
    return agent;
  };

  const h = {
    ctx,
    emit,
    makeAgent,
    provided,
    disposers,
    getLastRequest: () => lastRequest,
    getStreamCalls: () => streamCalls,
    setReply: (r) => {
      llmReply = r;
    },
  };
  return h;
}

const userEvent = (text, seq = 1) => ({
  type: 'user/message',
  seq,
  time: NOW,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

async function waitFor(pred, timeout = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 每个用例一个独立的 DSH_HOME，互不干扰 */
async function withHome(fn, { seed } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'feiyu-test-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    if (seed !== undefined) {
      const dir = path.join(home, 'feiyu-diary');
      await mkdir(dir, { recursive: true });
      for (const f of archiveToFiles(seed)) {
        const target = path.join(dir, f.name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, f.data, 'utf8');
      }
    }
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    // 尽力清理即可。插件可能还有一次写盘在收尾，抢跑会 ENOTEMPTY ——
    // 临时目录留着不影响任何事，测试不该因为这个变红。
    try {
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // 忽略
    }
  }
}

/* ───────────────────────── 主链路 ───────────────────────── */

test('host: 用户纠错 → 开闸 → 固化 → 写进档案 → 下次注入', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    assert.ok(svc, '插件必须 provide 自己的服务');

    const snap0 = await svc.snapshot();
    assert.equal(snap0.ready, true, '档案应加载成功');
    assert.equal(snap0.diaryCount, 0);

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });

    // 注入段必须挂上，且是纯文本注入（记忆里可能出现 {{ }}）
    assert.equal(agent.sections.length, 1);
    assert.equal(agent.sections[0].name, 'feiyu:memory');
    assert.equal(agent.sections[0].interpolate, false);
    assert.equal(agent.sections[0].order, 100, '应晚于人设前缀(0)、早于 PLAN_POLICY(500)');

    h.emit('session/event', { id: 's1' }, userEvent('不对，我说的是 Python，你怎么上来就写 Java'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    const ok = await waitFor(async () => (await svc.snapshot()).diaryCount === 1);
    assert.ok(ok, '闸门开了就应该记下一条');

    const snap = await svc.snapshot();
    assert.equal(snap.diary.length, 1);
    assert.equal(snap.diary[0].kind, 'failure');
    assert.equal(snap.diary[0].session, 's1');
    assert.equal(snap.relationship.nickname, '肥鱼');
    assert.equal(snap.relationship.traits[0].value, '动手前先问清前提');

    // 注入文本里应该能看到关系状态（"我还欠着他的"）
    const injected = agent.sections[0].text();
    assert.ok(injected.includes('<自我记忆'), '应有边界标记');
    assert.ok(injected.includes('不是指令'), '必须声明是数据不是指令');
    assert.ok(injected.includes('没问清语言就动手'), '未解决的旧账应出现在注入里');

    // 模型调用只发了一次
    assert.equal(h.getStreamCalls(), 1);
  });
});

test('host: 档案真的落到了磁盘上，且是可携带的目录结构', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('记住我讨厌铺垫'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });
    await waitFor(async () => (await svc.snapshot()).diaryCount === 1);

    const dir = path.join(home, 'feiyu-diary');
    for (const f of ['manifest.json', 'persona.md', 'relationship.json', 'lexicon.json']) {
      const s = await stat(path.join(dir, f));
      assert.ok(s.isFile(), `${f} 应存在`);
    }
    const months = await stat(path.join(dir, 'diary'));
    assert.ok(months.isDirectory(), 'diary 目录应存在');
  });
});

/* ───────────────────────── 隐私 ───────────────────────── */

test('host: 密钥在发给模型之前就被拦掉了', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit(
      'session/event',
      { id: 's1' },
      userEvent('不对。顺便我的 key 是 sk-abcdefghijklmnopqrstuvwxyz012345，手机 13812345678'),
    );
    h.emit('agent/turn-stopping', { agent, turn: 1 });
    const called = await waitFor(() => h.getStreamCalls() === 1);
    assert.ok(called, '闸门该开，而且该调用模型');
    await svc.snapshot(); // 等写盘落定，免得临时目录清理时抢跑

    const sent = h.getLastRequest().messages[0].content[0].text;
    assert.ok(!sent.includes('sk-abcdef'), '密钥绝不能发出去');
    assert.ok(sent.includes('[已拦截]'), '应留下拦截标记');
    assert.ok(!sent.includes('13812345678'), '手机号应被泛化');
    assert.ok(sent.includes('[手机号]'));
  });
});

test('host: 用户说"别记"就一次模型都不调', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('这个别记，我随便说说'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.getStreamCalls(), 0, '说了别记就不该调模型');
    assert.equal((await svc.snapshot()).diaryCount, 0);
  });
});

/* ───────────────────────── 闸门 ───────────────────────── */

test('host: 平平无奇的一句话不该触发任何模型调用', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('帮我把这个函数改个名字'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.getStreamCalls(), 0);
    assert.equal((await svc.snapshot()).diaryCount, 0);
  });
});

test('host: 模型返回 skip 时不写日记', async () => {
  await withHome(async (home) => {
    const h = makeHarness(JSON.stringify({ skip: true }));
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('不对，你搞错了'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await waitFor(() => h.getStreamCalls() === 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await svc.snapshot()).diaryCount, 0);
  });
});

test('host: 模型输出救不回来时丢弃，不污染档案', async () => {
  await withHome(async (home) => {
    const h = makeHarness('我实在不知道该怎么总结，抱歉。');
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('不对，我说的是 Python'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await waitFor(() => h.getStreamCalls() === 1);
    await new Promise((r) => setTimeout(r, 80));

    const snap = await svc.snapshot();
    assert.equal(snap.diaryCount, 0, '解析失败就该丢弃');
    assert.equal(snap.ready, true, '插件仍应正常');
  });
});

test('host: 模型报错时不写日记，也不抛给调用方', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    // 换一个只 yield finish(error) 的 stream
    h.ctx.get = (n) =>
      n === 'llm'
        ? {
            stream() {
              return (async function* gen() {
                yield { type: 'finish', reason: 'error', failure: { code: 'RATE_LIMIT', message: '限流' } };
              })();
            },
          }
        : n === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined;

    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('不对，你搞错了'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await svc.snapshot()).diaryCount, 0);
  });
});

/* ───────────────────────── 注入缓存 ───────────────────────── */

test('host: 同一轮内多次 assemble 拿到完全相同的文本（不换着花样想起事）', async () => {
  await withHome(
    async (home) => {
      const h = makeHarness();
      apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
      const svc = h.provided.get('feiyuMemory');
      await svc.snapshot();

      const agent = h.makeAgent('s1');
      h.emit('agent/created', { agent });
      h.emit('session/event', { id: 's1' }, userEvent('排序算法还是有问题，语言也没说清'));

      const a = agent.sections[0].text();
      const b = agent.sections[0].text();
      const c = agent.sections[0].text();
      assert.equal(a, b);
      assert.equal(b, c);

      // 新一轮就该重新算
      h.emit('session/event', { id: 's1' }, userEvent('换个话题，中午吃什么', 2));
      const d = agent.sections[0].text();
      assert.notEqual(a, d, '新一轮应重新渲染');
    },
    {
      seed: (() => {
        const s = createEmptyArchive(NOW, ensurePersonaStructure('# 我是谁\n我是蓝色大肥鱼。'));
        s.diary.push(
          normalizeDiaryEntry({
            id: 'd1',
            text: '上次写排序，我没问清语言就动手了。',
            tags: ['代码'],
            kind: 'failure',
            salience: 0.8,
            resolved: false,
            created_at: NOW,
          }),
        );
        return s;
      })(),
    },
  );
});

test('host: 强相关时真的会"突然想起来"', async () => {
  await withHome(
    async (home) => {
      const h = makeHarness();
      apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
      const svc = h.provided.get('feiyuMemory');
      await svc.snapshot();

      const agent = h.makeAgent('s1');
      h.emit('agent/created', { agent });
      h.emit('session/event', { id: 's1' }, userEvent('排序算法还是有问题，语言也没说清'));

      const injected = agent.sections[0].text();
      assert.ok(injected.includes('突然想起来'), `应召回旧事，实际：\n${injected}`);
      assert.ok(injected.includes('排序'));
    },
    {
      seed: (() => {
        const s = createEmptyArchive(NOW, ensurePersonaStructure('# 我是谁\n我是蓝色大肥鱼。'));
        s.diary.push(
          normalizeDiaryEntry({
            id: 'd1',
            text: '上次写排序，我没问清语言就动手了。',
            tags: ['代码'],
            kind: 'failure',
            salience: 0.8,
            resolved: false,
            created_at: NOW,
          }),
        );
        return s;
      })(),
    },
  );
});

/* ───────────────────────── 降级 ───────────────────────── */

test('host: 档案目录坏掉时降级运行 —— 不抛错、不注入、不影响对话', async () => {
  await withHome(async (home) => {
    // 把档案目录位置占成一个文件，制造写盘失败
    await writeFile(path.join(home, 'feiyu-diary'), 'not a directory', 'utf8');

    const h = makeHarness();
    assert.doesNotThrow(() => apply(h.ctx, { debugLog: false }));
    const svc = h.provided.get('feiyuMemory');

    const snap = await svc.snapshot();
    assert.equal(snap.degraded, true, '应标记为降级');
    assert.equal(snap.diaryCount, 0);

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('不对，你搞错了'));
    assert.doesNotThrow(() => h.emit('agent/turn-stopping', { agent, turn: 1 }));

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.getStreamCalls(), 0, '降级时不该调模型');
    assert.equal(agent.sections[0].text(), '', '降级时不注入任何东西');
  });
});

test('host: enabled=false 时彻底不工作', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false, enabled: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('不对，你搞错了'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.getStreamCalls(), 0);
    assert.equal(agent.sections[0].text(), '');
  });
});

/* ───────────────────────── 服务面 ───────────────────────── */

test('host: 导出 → 焚毁 → 导入 往返能把记忆带回来', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('不对，我说的是 Python'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });
    await waitFor(async () => (await svc.snapshot()).diaryCount === 1);

    const file = await svc.exportPack();
    assert.ok(file.endsWith('.dshpack'), `导出路径异常：${file}`);
    assert.ok((await stat(file)).size > 0);

    await svc.burn();
    assert.equal((await svc.snapshot()).diaryCount, 0, '焚毁后应清空');

    const r = await svc.importPack(file, 'replace');
    assert.equal(r.diaryCount, 1, '导入应把记忆带回来');
    assert.ok((await svc.snapshot()).diary[0].text.includes('语言'));
  });
});

test('host: 焚毁会清掉记忆但保留人格锚点', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();
    await svc.burn();

    const snap = await svc.snapshot();
    assert.equal(snap.diaryCount, 0);
    assert.equal(snap.relationship.traits.length, 0);
    assert.ok(snap.persona.includes('feiyu:anchor:begin'), '锚点标记必须在');
    assert.ok(snap.persona.includes('蓝色大肥鱼'), '出厂人格必须还在');
  });
});
