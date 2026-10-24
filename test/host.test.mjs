/**
 * Host 接线冒烟测试 —— 用一个假 ctx 把整个插件跑起来，不需要真的 DSH。
 *
 * 这一组测试存在的意义：注入点、事件签名、闸门、带外队列、写盘
 * 这几处任何一处接错，都是"静默失效"（不报错、就是不记）。
 * 假 ctx 能在几毫秒内把整条链路验一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply } from '../src/host/index.mjs';
import { archiveToFiles, createEmptyArchive, ensurePersonaStructure, normalizeDiaryEntry } from '../src/core/archive.mjs';

const NOW = Date.now();

/** 用例的数据目录约定：临时根目录下的 feiyu-diary */
const dataDirFor = (home) => path.join(home, 'feiyu-diary');

/** 当月日记文件名（写盘按本地月份分片） */
const monthFile = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`;
};

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
  // 「记不记」那一次极短判断 —— 跟固化分开数
  let judgeCalls = 0;
  let lastJudgeRequest = null;
  // 判断默认回"记"，这样老用例（不关心判断）不用改
  let judgeReply = 'yes 测试环境默认记';

  /**
   * 假的 webServer —— 记录面板注册的路由，测试可以直接驱动它们。
   *
   * 有它之后，**每个** host 测试都会真的跑一遍面板接口注册，
   * 所以"注册路由把插件搞挂了"这种错会被所有用例一起抓到。
   */
  const routes = new Map();
  const webServer = {
    register(route) {
      const key = `${route.kind}:${route.path}`;
      if (routes.has(key)) throw new Error(`route 重复注册：${key}`);
      routes.set(key, route);
      return () => routes.delete(key);
    },
  };

  /**
   * 假的 tools 服务 —— 记录注册的工具，测试可以直接调 `execute`。
   * 同样让每个 host 测试都跑一遍工具注册。
   */
  const tools = new Map();
  const toolsService = {
    register(def) {
      if (tools.has(def.name)) throw new Error(`tool 重复注册：${def.name}`);
      tools.set(def.name, def);
      return () => tools.delete(def.name);
    },
  };

  const llm = {
    stream(opts) {
      // ⚠️ 现在一次"记不记"要走**两次**模型调用：
      //   1. 判断（judge.mjs）—— 极短，只问 yes/no
      //   2. 固化（consolidate.mjs）—— 产出日记
      //
      // 所以这个假 llm 得把两者分开数。**streamCalls 只数固化** ——
      // 原来那批断言（"该调用模型" / "不该调用模型"）说的都是固化。
      const isJudge = typeof opts?.system === 'string' && opts.system.includes('你是这条鱼的记性');
      if (isJudge) {
        judgeCalls += 1;
        lastJudgeRequest = opts;
        const verdict = judgeReply;
        return (async function* gen() {
          yield { type: 'text-delta', index: 0, text: verdict };
          yield { type: 'finish', reason: 'stop' };
        })();
      }

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
      if (n === 'webServer') return webServer;
      if (n === 'tools') return toolsService;
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
    /**
     * 简化版 Cordis inject：依赖都在就立刻回调，缺一个就永远不回调。
     * 真实 Cordis 会在服务就绪时异步回调；测试只关心"在/不在"两种情形。
     */
    inject(deps, cb) {
      const scope = {};
      for (const d of deps) {
        const v = ctx.get(d);
        if (v === undefined) return { dispose() {} };
        scope[d] = v;
      }
      scope.effect = ctx.effect;
      const d = cb(scope);
      if (typeof d === 'function') disposers.push(d);
      return { dispose() {} };
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
    routes,
    tools,
    /** 驱动一条已注册的面板路由，模拟一次 HTTP 请求 */
    async callRoute(routePath, { method = 'GET', body, headers } = {}) {
      const route = [...routes.values()].find((r) => r.path === routePath);
      if (route === undefined) throw new Error(`没有注册路由 ${routePath}（现有：${[...routes.keys()].join(', ')}）`);
      const req = (async function* gen() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      })();
      req.method = method;
      // 默认模拟**同源 + application/json** 的面板请求 ——
      // 写接口现在要校验这两样（审计报告 F3：跨站 text/plain POST 能删光记忆）。
      req.headers = {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:1234',
        host: '127.0.0.1:1234',
        'sec-fetch-site': 'same-origin',
        ...(headers ?? {}),
      };
      const res = {
        statusCode: 0,
        headers: {},
        body: undefined,
        setHeader(k, v) {
          this.headers[String(k).toLowerCase()] = v;
        },
        end(data) {
          this.body = data;
        },
      };
      await route.handler(req, res);
      return res;
    },
    getLastRequest: () => lastRequest,
    getStreamCalls: () => streamCalls,
    // 「记不记」那次判断的计数和请求 —— 跟固化分开
    getJudgeCalls: () => judgeCalls,
    getLastJudgeRequest: () => lastJudgeRequest,
    setJudgeReply: (r) => {
      judgeReply = r;
    },
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

test('host: 平平无奇的一句话 —— 判断还是会被叫一次，但固化不该跑', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    // 这就是换掉关键词闸门**想要**的行为：每一轮都让模型看一眼，
    // 而不是拿一张正则表去猜"这句话里有没有值得记的信号"。
    // 所以这句平平无奇的话**必须**触发一次判断，但模型说不记 → 固化不跑。
    h.setJudgeReply('no 只是让我改个名字');

    const agent = h.makeAgent('s1');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's1' }, userEvent('帮我把这个函数改个名字'));
    h.emit('agent/turn-stopping', { agent, turn: 1 });

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.getJudgeCalls(), 1, '每一轮都该问模型一句');
    assert.equal(h.getStreamCalls(), 0, '模型说不记，就不该去固化');
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
        // d1 是最旧的那条 —— 该被"想起来"的就是它。
        // 为什么后面还要塞 9 条：`recentEntries` 默认 8，而召回池现在
        // **排除了「最近的事」那几条**（它们已经常驻，不该再被想起来一遍）。
        // 只塞一两条的话，它们全落在最近窗口里，召回池是空的。
        s.diary.push(
          normalizeDiaryEntry({
            id: 'd1',
            text: '上次写排序，我没问清语言就动手了。',
            tags: ['代码'],
            kind: 'failure',
            salience: 0.8,
            resolved: false,
            created_at: NOW - 30 * 86400000,
          }),
        );
        for (let k = 2; k <= 10; k++) {
          s.diary.push(
            normalizeDiaryEntry({
              id: 'd' + k,
              text: '第 ' + k + ' 条闲聊，没什么值得记的。',
              tags: ['闲聊'],
              kind: 'chat',
              salience: 0.6,
              created_at: NOW - (11 - k) * 86400000,
            }),
          );
        }
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
        // d1 是最旧的那条 —— 该被"想起来"的就是它。
        // 为什么后面还要塞 9 条：`recentEntries` 默认 8，而召回池现在
        // **排除了「最近的事」那几条**（它们已经常驻，不该再被想起来一遍）。
        // 只塞一两条的话，它们全落在最近窗口里，召回池是空的。
        s.diary.push(
          normalizeDiaryEntry({
            id: 'd1',
            text: '上次写排序，我没问清语言就动手了。',
            tags: ['代码'],
            kind: 'failure',
            salience: 0.8,
            resolved: false,
            created_at: NOW - 30 * 86400000,
          }),
        );
        for (let k = 2; k <= 10; k++) {
          s.diary.push(
            normalizeDiaryEntry({
              id: 'd' + k,
              text: '第 ' + k + ' 条闲聊，没什么值得记的。',
              tags: ['闲聊'],
              kind: 'chat',
              salience: 0.6,
              created_at: NOW - (11 - k) * 86400000,
            }),
          );
        }
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

/* ─────────────────── 客户端面板的数据接口 ─────────────────── */

/**
 * 面板读日记走的是 HTTP，不是 Cordis RPC —— 理由见 src/host/index.mjs
 * 里 `PANEL_BASE` 那段注释（已安装的客户端插件拿不到自己的 host RPC）。
 *
 * 这一组测试盯三件事：**能看、能删、能带走**，外加一条安全回归。
 */

const SAMPLE = createEmptyArchive(NOW, ensurePersonaStructure('# 测试人格'));

/** 面板测试的种子档案。**必须在 apply 之前落盘** —— 插件是在 apply 时读档案的。 */
function makeSeed() {
  return {
    ...SAMPLE,
    diary: [
      // 注意 normalizeDiaryEntry 只收一个参数，id/created_at/session 都得写全。
      // 少了 id 就会变成字符串 "undefined"，两条日记撞成同一个 id。
      normalizeDiaryEntry({
        id: 'd_test_01',
        text: '他让我写排序，我没问清语言就动手了。',
        tags: ['代码'],
        kind: 'failure',
        salience: 0.7,
        created_at: NOW - 86400000,
        session: 's1',
      }),
      normalizeDiaryEntry({
        id: 'd_test_02',
        text: '他翻出一篇很久以前写的小说发给我看。',
        tags: ['小说'],
        kind: 'chat',
        salience: 0.5,
        created_at: NOW,
        session: 's1',
      }),
    ],
    relationship: {
      ...SAMPLE.relationship,
      nickname: '肥鱼',
      traits: [
        {
          key: '铺垫',
          value: '讨厌铺垫',
          evidence: '我说了三段他说说重点',
          about: 'user',
          confidence: 2,
          salience: 0.8,
        },
        { key: '诚实', value: '不假装记得', evidence: '', about: 'self', confidence: 1, salience: 0.5 },
      ],
    },
  };
}

/** 起一个已经读到种子档案的插件 */
async function seededHarness(home) {
  const h = makeHarness();
  apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
  await h.provided.get('feiyuMemory').snapshot();
  return h;
}

test('panel: 三个接口都注册上了', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    assert.deepEqual(
      [...h.routes.keys()].sort(),
      ['exact:/feiyu-diary/export', 'exact:/feiyu-diary/forget', 'exact:/feiyu-diary/state'],
    );
  }, { seed: makeSeed() });
});

test('panel: GET /state 给出界面要的字段，且按时间倒序', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const res = await h.callRoute('/feiyu-diary/state');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.body);

    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.equal(body.diary.length, 2);
    assert.ok(body.diary[0].text.includes('小说'), '最近的排最前');
    assert.ok(body.diary[1].text.includes('排序'));

    const mine = body.traits.filter((t) => t.about === 'user');
    const self = body.traits.filter((t) => t.about === 'self');
    assert.equal(mine.length, 1);
    assert.equal(self.length, 1);
    assert.equal(mine[0].evidence, '我说了三段他说说重点');
    assert.equal(body.facts.nickname, '肥鱼');
  }, { seed: makeSeed() });
});

test('panel: POST /forget 真的删掉，界面上就没有了', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const before = await h.callRoute('/feiyu-diary/state');
    const target = JSON.parse(before.body).diary[0];
    assert.ok(target.id);

    const res = await h.callRoute('/feiyu-diary/forget', { method: 'POST', body: { id: target.id } });
    assert.equal(res.statusCode, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.removed, true);
    assert.equal(out.count, 1);

    const after = await h.callRoute('/feiyu-diary/state');
    const body = JSON.parse(after.body);
    assert.equal(body.count, 1);
    assert.ok(!body.diary.some((e) => e.id === target.id));
  }, { seed: makeSeed() });
});

test('panel: 跨站 POST /forget 会被挡（Content-Type 不是 json）', async () => {
  // 审计报告 F3：跨站的 text/plain POST 属于「简单请求」，浏览器不做预检就发，
  // 服务端照常执行 —— 而日记 id 是 d_YYYYMMDD_NN，枚举一遍就能删光。
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const before = JSON.parse((await h.callRoute('/feiyu-diary/state')).body);
    const target = before.diary[0];

    const res = await h.callRoute('/feiyu-diary/forget', {
      method: 'POST',
      body: { id: target.id },
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        origin: 'https://attacker.invalid',
        host: '127.0.0.1:1234',
        'sec-fetch-site': 'cross-site',
      },
    });

    assert.notEqual(res.statusCode, 200, '跨站请求不能被当成正常请求');
    const after = JSON.parse((await h.callRoute('/feiyu-diary/state')).body);
    assert.equal(after.count, before.count, '一条都不能少');
  }, { seed: makeSeed() });
});

test('panel: 同源但 Origin 不对 → 也挡（双保险）', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const before = JSON.parse((await h.callRoute('/feiyu-diary/state')).body);
    const target = before.diary[0];

    const res = await h.callRoute('/feiyu-diary/forget', {
      method: 'POST',
      body: { id: target.id },
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.invalid',
        host: '127.0.0.1:1234',
        'sec-fetch-site': 'cross-site',
      },
    });

    assert.notEqual(res.statusCode, 200);
    const after = JSON.parse((await h.callRoute('/feiyu-diary/state')).body);
    assert.equal(after.count, before.count);
  }, { seed: makeSeed() });
});

test('panel: 删掉的那条会从磁盘上一起消失（不是只从界面消失）', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const svc = h.provided.get('feiyuMemory');
    const snap = await svc.snapshot();
    const target = snap.diary.find((e) => e.text.includes('排序'));
    assert.ok(target, '种子里应该有那条');

    assert.equal(await svc.forget(target.id), true);

    // 关键：不只是内存里少了，**磁盘上也得少了** —— 否则重启又回来了。
    const raw = await readFile(
      path.join(dataDirFor(home), 'diary', new Date(target.created_at).toISOString().slice(0, 7) + '.jsonl'),
      'utf8',
    );
    assert.ok(!raw.includes(target.id), '磁盘上不该还有这条');
    assert.equal((await svc.snapshot()).diaryCount, 1);
  }, { seed: makeSeed() });
});

test('panel: forget 一个不存在的 id 会老实说没删掉', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const res = await h.callRoute('/feiyu-diary/forget', { method: 'POST', body: { id: 'd_nope' } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).removed, false);
  }, { seed: makeSeed() });
});

test('panel: GET /export 返回可下载的字节', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const res = await h.callRoute('/feiyu-diary/export');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-disposition'], /attachment/);
    assert.ok(res.body.length > 100, '应该是一个真的 zip');
    assert.equal(res.body[0], 0x50);
    assert.equal(res.body[1], 0x4b, 'ZIP 魔数 PK');
  }, { seed: makeSeed() });
});

test('panel: 方法不对返回 405，不会误伤数据', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    assert.equal((await h.callRoute('/feiyu-diary/state', { method: 'POST' })).statusCode, 405);
    assert.equal((await h.callRoute('/feiyu-diary/forget', { method: 'GET' })).statusCode, 405);
  }, { seed: makeSeed() });
});

test('panel: 响应不带 CORS 头 —— 这是真正有意义的防护', async () => {
  await withHome(async (home) => {
    const h = await seededHarness(home);
    const res = await h.callRoute('/feiyu-diary/state');
    const keys = Object.keys(res.headers).join(' ');
    assert.ok(
      !/access-control-allow-origin/i.test(keys),
      '加了 CORS 就等于把私人日记开放给浏览器里任何网站',
    );
  }, { seed: makeSeed() });
});

test('panel: 没有 webServer 服务时安静跳过，不影响插件其余部分', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    const origGet = h.ctx.get;
    h.ctx.get = (n) => (n === 'webServer' ? undefined : origGet(n));
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    assert.equal(h.routes.size, 0, '没有 webServer 就不该注册任何路由');
    const svc = h.provided.get('feiyuMemory');
    assert.ok(svc, 'feiyuMemory 服务必须还在');
    assert.equal((await svc.snapshot()).ready, true);
  });
});

/* ─────────────── 主动记一条：给鱼用的工具 ─────────────── */

/**
 * 这里测的是"**哪一棒想到了什么，自己说一声就记下**"这条路。
 *
 * 它跟固化那条路的区别：固化是插件判断 + 模型生成；这个是**鱼主动发起**。
 * 用户的原话是"不是自己切后台搞" —— 所以必须**当场落盘**，
 * 工具返回之前条目就该在档案里。
 */

const callNote = (h, args, agentId = 's_test') =>
  h.tools.get('feiyu_note').execute(args, {
    agent: agentId === null ? undefined : { id: agentId },
    signal: new AbortController().signal,
  });

test('note: 工具注册上了，且描述里说清了"不要动文件"', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const tool = h.tools.get('feiyu_note');
    assert.ok(tool, 'feiyu_note 必须注册');
    assert.match(tool.description, /不要为了记事去动任何文件/);
    // 参数 schema 要是**标准 JSON Schema** —— 我们不能 import defineTool，
    // 得自己产出它转出来的那个形状
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['text']);
    assert.equal(tool.parameters.properties.text.type, 'string');
    // output.render 返回 ContentBlock[]
    const blocks = tool.output.render({}, { ok: true, count: 3 });
    assert.deepEqual(blocks, [{ type: 'text', text: '记住了。（档案里现在 3 条）' }]);
  });
});

test('note: 说一声就当场落盘 —— 不进后台队列', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const r = await callNote(h, { text: '我决定不再把"记不清"说成"忘了"。' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);

    // 关键：**工具返回的时候，磁盘上就得已经有了**
    const raw = await readFile(path.join(dataDirFor(home), 'diary', monthFile()), 'utf8');
    assert.match(raw, /记不清/);
    assert.match(raw, /"kind":"note"/);
  });
});

test('note: 正文里的时间词会被摘掉（跟日记一个规矩）', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await callNote(h, { text: '今天我想明白一件事：他其实不在乎我记不记得。' });
    const svc = h.provided.get('feiyuMemory');
    const snap = await svc.snapshot();
    assert.ok(!snap.diary[0].text.startsWith('今天'), snap.diary[0].text);
    assert.match(snap.diary[0].text, /^我想明白一件事/);
  });
});

test('note: 空正文会被拒，不会记进一条空壳', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await assert.rejects(() => callNote(h, { text: '   ' }), /不能是空的/);
    await assert.rejects(() => callNote(h, {}), /不能是空的/);
    assert.equal((await h.provided.get('feiyuMemory').snapshot()).diaryCount, 0);
  });
});

test('note: 记下的东西当场就在注入里，而且进了「我自己想的」', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await callNote(h, { text: '别人给的数据跟出处对不上时，先问，别照抄。' });

    const agent = h.makeAgent('s_later');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's_later' }, userEvent('随便聊点什么', 1));
    const injected = agent.sections[0].text();

    assert.match(injected, /我自己想的：/, `判断该有自己的格子：${injected}`);
    assert.match(injected, /先问，别照抄/);
    // **不能**混进「最近的事」—— 这是这次改动的全部意义
    assert.ok(
      !/最近的事：[\s\S]*先问，别照抄/.test(injected),
      `判断串进事件区了：${injected}`,
    );
  });
});

test('note: 判断不进召回池 —— 它本来就每轮都在，再被"想起来"是重复', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    // 一条判断，用词故意跟下面那句话高度重合
    await callNote(h, { text: '先问再写，别照抄。' });

    const agent = h.makeAgent('s_r');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's_r' }, userEvent('我是不是说过先问再写？', 1));
    const injected = agent.sections[0].text();

    assert.ok(!injected.includes('突然想起来：'), `判断不该被召回：${injected}`);
  });
});

test('note: 没给 tags 时兜底成"手记"，给了就用给的', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await callNote(h, { text: '第一条。' });
    await callNote(h, { text: '第二条。', tags: ['自言自语', '约定'] });
    const snap = await h.provided.get('feiyuMemory').snapshot();
    assert.deepEqual(snap.diary[0].tags, ['手记']);
    assert.deepEqual(snap.diary[1].tags, ['自言自语', '约定']);
  });
});

test('note: 每条 id 都不一样（漏 id 会撞车，那是 jsonl 手写的老坑）', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await callNote(h, { text: '第一条。' });
    await callNote(h, { text: '第二条。' });
    await callNote(h, { text: '第三条。' });
    const snap = await h.provided.get('feiyuMemory').snapshot();
    const ids = snap.diary.map((e) => e.id);
    assert.equal(new Set(ids).size, 3, `id 撞车了：${ids.join(', ')}`);
    assert.ok(ids.every((id) => id.startsWith('d_')), ids.join(', '));
  });
});

test('note: 没有 tools 服务时安静跳过，记忆本身照常可用', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    const orig = h.ctx.get;
    h.ctx.get = (n) => (n === 'tools' ? undefined : orig(n));
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    assert.equal(h.tools.size, 0, '没有 tools 服务就不该注册工具');
    const svc = h.provided.get('feiyuMemory');
    assert.ok(svc, '但记忆服务必须照常可用');
    assert.equal((await svc.snapshot()).ready, true);
  });
});

/* ─────────────── 手记（手写的那个文件） ─────────────── */

test('handnote: 首次运行会建一份带说明的手记文件', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await h.provided.get('feiyuMemory').snapshot();

    const notePath = path.join(dataDirFor(home), '手记.md');
    assert.ok(existsSync(notePath), '手记文件该被建出来');
    const text = await readFile(notePath, 'utf8');
    assert.match(text, /一行一条/, '**文件自己就是文档** —— 打开就知道怎么写');
    assert.match(text, /永远不会覆盖或清空它/, '要讲清它是只读的，别人才敢写');
  });
});

test('handnote: 用户写进去的原话，下一轮就出现在注入里', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await h.provided.get('feiyuMemory').snapshot();

    const notePath = path.join(dataDirFor(home), '手记.md');
    await writeFile(
      notePath,
      '# 手记\n\n- 别把"记不清"说成"忘了"。\n- 他讨厌我上来就动手。\n',
      'utf8',
    );

    const agent = h.makeAgent('s_note');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's_note' }, userEvent('随便说点什么', 1));
    const injected = agent.sections[0].text();
    assert.match(injected, /手记：/, injected);
    assert.match(injected, /别把"记不清"说成"忘了"/);
    assert.match(injected, /他讨厌我上来就动手/);
  });
});

test('handnote: 注入里带着"可以主动记"的指针 —— 这是唯一的发现渠道', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await h.provided.get('feiyuMemory').snapshot();

    const agent = h.makeAgent('s_hint');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's_hint' }, userEvent('你好', 1));
    const injected = agent.sections[0].text();
    assert.match(injected, /feiyu_note/, '不写这句，别的肥鱼根本不知道这条路存在');
    assert.match(injected, /别为了记事去动文件/);
  });
});

/* ─────────────── persona.md 真的能改吗 ─────────────── */

/**
 * `persona.default.md` 里明写着：
 *   *"用户可以直接改这个文件（改的是自己的档案，不是仓库里的这份默认值）"*
 *
 * **而这句话在这之前是假的。** 插件启动后再也不读 `persona.md`，
 * 落盘时拿内存里那份整份写回，`mergeArchives` 里还写死 `persona: base.persona` ——
 * 人改完，插件下一次写日记就把它悄悄覆盖回去。
 *
 * 一个承诺了可编辑、实际改不了的文件。
 */
const MARKER = '- 该皮的时候皮，他先开玩笑我接得住。';

test('persona: 手动改 persona.md，**下一轮就生效**（不用重启）', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await h.provided.get('feiyuMemory').snapshot();

    const file = path.join(dataDirFor(home), 'persona.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('## 说话方式', `## 说话方式\n\n${MARKER}`), 'utf8');

    const agent = h.makeAgent('s_edit');
    h.emit('agent/created', { agent });
    h.emit('session/event', { id: 's_edit' }, userEvent('你好', 1));
    const injected = agent.sections[0].text();
    assert.match(injected, /该皮的时候皮/, `改动没生效：${injected.slice(0, 200)}`);
  });
});

test('persona: 手动改完之后**落盘不会把它覆盖掉**', async () => {
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    await h.provided.get('feiyuMemory').snapshot();

    const file = path.join(dataDirFor(home), 'persona.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('## 说话方式', `## 说话方式\n\n${MARKER}`), 'utf8');

    // 写一条日记 —— 这必然触发一次 persist（也就是整份重写）
    await callNote(h, { text: '随便记一条，只为了触发落盘。' });

    const after = await readFile(file, 'utf8');
    assert.match(after, /该皮的时候皮/, '**人的改动被覆盖了** —— 这个文件就白说可编辑了');
  });
});

test('persona: 没人改的时候，落盘也不会把内存那份丢掉', async () => {
  // 反向保护：磁盘=基线时（没人动过），必须用内存的。
  // 焚毁就是把内存人格换成出厂默认 —— 那时候绝不能因为"磁盘跟基线一样"
  // 就把焚毁结果又换回旧的。
  await withHome(async (home) => {
    const h = makeHarness();
    apply(h.ctx, { dataDir: dataDirFor(home), debugLog: false });
    const svc = h.provided.get('feiyuMemory');
    await svc.snapshot();

    const before = await readFile(path.join(dataDirFor(home), 'persona.md'), 'utf8');
    assert.match(before, /feiyu:anchor:begin/);

    await svc.burn();
    const after = await readFile(path.join(dataDirFor(home), 'persona.md'), 'utf8');
    assert.match(after, /feiyu:anchor:begin/, '焚毁后人格结构还该在');
    assert.ok((await svc.snapshot()).diaryCount === 0, '焚毁该清掉日记');
  });
});
