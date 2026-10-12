/**
 * 肥鱼日记 · Host 半边
 *
 * 让新开一个对话，用户依然感觉是同一条鱼。
 *
 * ── 这一版（v0.1）的范围 ──
 * 只有 Host 半边，没有 `dsh.client`。理由见 SPEC §13 / 速查表 D.3：
 * 客户端 dynamic runner 的 React 取用语法尚未对着活动客户端验证，
 * 不把没验证过的东西发出去。界面在 v0.2。
 *
 * ── 三条不可破的工程约束 ──
 *  1. **永远不能挡住聊天。** 所有事件回调与注入函数都包 try/catch，
 *     出任何问题都只降级成"这次没记住"，绝不向上抛。
 *  2. **`agent/turn-stopping` 是 serial 事件，会被 await。**
 *     所以那里只做本地判断（微秒级）并立刻返回，
 *     模型调用一律丢到带外队列，不阻塞回合关闭。
 *  3. **不 append 任何新的 session 事件类型**（官方 practices 明令）。
 *     我们的状态存在自己的档案文件里。
 */

import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  SCHEMA_VERSION,
  archiveToFiles,
  archiveFromFiles,
  createEmptyArchive,
  packArchive,
  unpackArchive,
  mergeArchives,
  ensurePersonaStructure,
  DIARY_DIR,
} from '../core/archive.mjs';
import { evaluateGate, SUPPRESS_RE, DEFAULT_GATE_OPTIONS } from '../core/gate.mjs';
import { buildIndex, selectMemories, DEFAULT_RECALL_OPTIONS } from '../core/recall.mjs';
import { overlap } from '../core/keywords.mjs';
import { scrub } from '../core/privacy.mjs';
import { renderMemoryBlock, DEFAULT_BUDGET } from '../core/persona.mjs';
import { renderDiaryFile } from '../core/render-diary.mjs';
import {
  buildConsolidationInput,
  parseConsolidation,
  applyConsolidation,
  decayArchive,
  ConsolidationParseError,
  DEFAULT_CONSOLIDATION,
} from '../core/consolidate.mjs';
import { resolveConfig, buildSchema } from '../core/config.mjs';

/** Cordis 插件身份。模块上只有这四个属性会被读取。 */
export const name = 'feiyu-memory';

/**
 * 硬依赖。缺任何一个，插件静默不激活 —— 这是刻意的：
 * 少一个记忆插件，不能影响用户聊天。
 */
export const inject = ['systemPrompt', 'agents', 'sessions', 'llm'];

/**
 * Config **是可选的**。
 *
 * 为什么不用静态 `import z from '@deepseek-ai/schemastery'`：
 * 那会让它在解析不到时直接抛错，**整个插件加载失败**。
 * 对于一个"装上就该忘掉它"的插件，这个失败模式不能接受。
 *
 * 所以这里用 createRequire 试探性地拿；拿不到就导出 `undefined`，
 * loader 会跳过校验。**所有选项照样能在 `cordis.patch.yml` 的 `config:` 里写**，
 * 由 `resolveConfig()` 自己补默认值 —— 行为与有没有 schema 完全一致。
 *
 * 代价：拿不到 schemastery 时，v0.2 的自动设置表单不会出现。
 */
export const Config = (() => {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@deepseek-ai/schemastery');
    const z = mod?.default ?? mod;
    if (z !== undefined && z !== null && typeof z.object === 'function') return buildSchema(z);
  } catch {
    // 拿不到就没有表单，不影响任何功能
  }
  return undefined;
})();

/* ───────────────────────── 小工具 ───────────────────────── */

/** DSH 主目录。`$DSH_HOME` 优先，否则 `~/.dsh`（与 dsh-home-paths 行为一致） */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(homedir(), '.dsh');
}

/**
 * 档案工作目录。
 *
 * **只在 `apply` 时算一次**，之后全程用这个值。
 * 不在每次读写时懒读 `$DSH_HOME` —— 那会带来一个隐蔽的 bug：
 * 环境变量中途变了（多实例、测试并发、用户改配置），
 * 档案就会写到另一个目录去，而且没有任何报错。
 */
function resolveArchiveDir(config) {
  const explicit = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  return explicit !== '' ? path.resolve(explicit) : path.join(dshHome(), 'feiyu-diary');
}

const DIARY_FILE_RE = /\.jsonl$/;

/** 原子写：先写临时文件再 rename，避免半截文件毁掉档案 */
async function writeFileAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/**
 * 从工作目录读出"文件名 → 文本"的映射（相对路径用正斜杠）。
 * 读不出的文件跳过并留 warning，不抛。
 */
async function readArchiveDir(dir) {
  const files = new Map();
  const warnings = [];

  async function readOne(rel) {
    try {
      files.set(rel, await readFile(path.join(dir, rel), 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        warnings.push(`${rel} 读不出来：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const base of ['manifest.json', 'persona.md', 'relationship.json', 'lexicon.json']) {
    await readOne(base);
  }

  try {
    const entries = await readdir(path.join(dir, 'diary'));
    for (const f of entries) {
      if (DIARY_FILE_RE.test(f)) await readOne(`${DIARY_DIR}/${f}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`diary 目录读不出来：${String(err?.message ?? err)}`);
  }

  return { files, warnings };
}

/** 把"文件名 → 文本"落盘。逐文件原子写。 */
async function writeArchiveDir(dir, files) {
  for (const f of files) {
    await writeFileAtomic(path.join(dir, f.name), f.data);
  }
}

/* ───────────────────────── 插件主体 ───────────────────────── */

/**
 * @param {any} ctx Cordis context
 * @param {any} rawConfig 行配置（可能未经校验，resolveConfig 会补默认值）
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** 档案目录：在 apply 时一次算定，之后全程不变 */
  const archiveDirectory = resolveArchiveDir(config);
  /** 当前档案（内存副本，写盘后保持一致） */
  let archive = createEmptyArchive(Date.now());
  /** 倒排索引 —— 纯派生，每次加载档案后重建，不落盘 */
  let index = buildIndex([]);
  let ready = false;
  /** 档案是否处于"读失败所以只读"状态（SPEC §10 降级优先） */
  let degraded = false;

  /**
   * 日志出口。
   *
   * 走 ctx.logger（正式渠道）；**只有开了 debugLog 才额外给 stderr 一份**。
   * 加 stderr 那一份是因为端到端验证时发现：headless / 无人值守场景下
   * ctx.logger 可能根本没人接，"它卡在哪一环"完全看不见。
   */
  const emit = (level, args) => {
    const line = `[feiyu] ${args.join(' ')}`;
    try {
      ctx.logger?.[level]?.(line);
    } catch {
      // logger 坏了不影响功能
    }
    if (!config.debugLog) return;
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // 没有 stderr 就只走 logger
    }
  };
  const log = (...args) => {
    if (config.debugLog) emit('info', args);
  };
  const warn = (...args) => emit('warn', args);

  /** @type {Map<string, any>} sessionId → 会话内的临时状态 */
  const sessionStates = new Map();
  const abort = new AbortController();

  function stateOf(sessionId) {
    let s = sessionStates.get(sessionId);
    if (s === undefined) {
      s = {
        turn: 0,
        lastUserSeq: -1,
        lastUserText: '',
        transcript: [], // 滚动缓冲，最近若干轮
        renderCache: { turn: -1, text: '' },
        lastOpenTurn: -Infinity,
        diaryCount: 0,
        lastShownTurn: new Map(),
        suppressedUntil: -1,
        queued: false,
      };
      sessionStates.set(sessionId, s);
    }
    return s;
  }

  /* ── 档案加载 ── */

  const loadPromise = (async () => {
    const dir = archiveDirectory;
    try {
      const { files, warnings } = await readArchiveDir(dir);
      for (const w of warnings) warn(w);

      if (files.size === 0) {
        // 首次运行：写出厂档案
        archive = createEmptyArchive(Date.now(), readBundledDefaultPersona());
        const migrated = decayArchive(archive, { now: Date.now() });
        archive = migrated.archive;
        await writeArchiveDir(dir, archiveToFiles(archive));
        log('首次运行，已创建空档案');
      } else {
        const entries = [...files].map(([n, text]) => ({ name: n, text: () => text }));
        const { archive: loaded, warnings: w2 } = archiveFromFiles(entries, { now: Date.now() });
        for (const w of w2) warn(w);
        archive = loaded;
      }

      // 老化 + 重建索引
      archive = decayArchive(archive, { now: Date.now() }).archive;
      index = buildIndex(archive.diary);
      ready = true;
      log(`档案就绪：${archive.diary.length} 条日记`);

      // 顺手刷新人读版。这样即使这次什么都没记，衰减后的状态也是对的；
      // 也从别人那儿导入档案之后，立刻就有可读的一份。
      await writeReadableDiary(archive);
    } catch (err) {
      degraded = true;
      warn(`档案加载失败，本次以"不记忆"模式运行：${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  /**
   * 插件卸载（含进程退出）时，**先尽力把带外队列写完，再中止**。
   *
   * 这一条是端到端验证逼出来的：headless / 一次性会话里，进程会在
   * "回合结束 → 后台写日记" 这段时间里直接退出，结果是**模型答了、日记没了**。
   * 同一个坑在桌面端表现为"刚聊完就关掉 Harness，那条记忆丢了"。
   *
   * 给一个硬上限 —— 宁可丢一条记忆，也绝不无限期挂住退出。
   */
  const FLUSH_TIMEOUT_MS = 20000;
  ctx.effect(() => () => {
    const flush = Promise.resolve()
      .then(() => drainPromise)
      .then(() => writeChain)
      .catch(() => undefined);
    const deadline = new Promise((resolve) => {
      const t = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    });
    return Promise.race([flush, deadline]).then(() => {
      abort.abort();
      sessionStates.clear();
    });
  }, 'feiyu: flush pending work, then abort');

  /* ── 写盘 ── */

  let writeChain = Promise.resolve();

  /**
   * 写一份**人读版**日记（`日记.md`）。
   *
   * 定位和内存索引一样：**单向派生、只读、随时可重建**。
   * 它在档案目录里，但**不属于档案数据**（不进 `.dshpack`）——
   * 导入别人的档案后，下次加载会自动重新生成一份。
   *
   * 失败的代价只是"看不到漂亮版本"，所以这里只 warn，绝不影响主流程。
   */
  async function writeReadableDiary(snapshot) {
    try {
      const file = path.join(archiveDirectory, '日记.md');
      await writeFileAtomic(file, renderDiaryFile(snapshot, { now: Date.now() }));
    } catch (err) {
      warn(`写人读版日记失败（不影响记忆本身）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function persist() {
    if (!ready) return writeChain;
    const snapshot = archive;
    writeChain = writeChain
      .then(async () => {
        archive.manifest.updated_at = Date.now();
        await writeArchiveDir(archiveDirectory, archiveToFiles(snapshot));
        await writeReadableDiary(snapshot);
      })
      .catch((err) => {
        warn(`写档案失败：${err instanceof Error ? err.message : String(err)}`);
      });
    return writeChain;
  }

  /* ── 注入 ── */

  /**
   * 为某个会话渲染注入文本。
   *
   * **按轮缓存**：`assemble` 每个 model step 都会调用一次，
   * 而一个回合可能有几十个 step（工具调用）。不缓存的话
   * 召回会用掉冷却、还会在同一个回合里换着花样想起不同的事 —— 很出戏。
   */
  function renderFor(sessionId) {
    if (!ready || !config.enabled) return '';
    const s = stateOf(sessionId);
    if (s.renderCache.turn === s.turn) return s.renderCache.text;

    let text = '';
    try {
      const query = s.lastUserText;
      const { chosen } = selectMemories(archive.diary, index, query, s, s.turn, {
        highSim: config.highSim,
        maxShow: config.maxShowPerTurn,
        wanderChance: config.wanderChance,
        minSalience: Math.max(0.25, config.minSalience),
        now: Date.now(),
      });

      const rendered = renderMemoryBlock({
        persona: archive.persona,
        relationship: { ...archive.relationship, since: archive.manifest.created_at },
        lexicon: archive.lexicon,
        recalled: chosen,
        includePersona: config.includePersona,
        budget: config.budgetTokens,
        now: Date.now(),
      });
      text = rendered.text;
      if (chosen.length > 0) {
        log(`会话 ${sessionId} 想起 ${chosen.length} 条：${chosen.map((c) => c.why).join('/')}`);
      } else {
        // 不打内容，只打形状 —— 足够定位"为什么没想起来"
        log(
          `会话 ${sessionId} 第 ${s.turn} 轮：无召回（查询 ${query.length} 字，候选 ${archive.diary.length} 条，索引 ${index.N} 条）`,
        );
      }
    } catch (err) {
      warn(`渲染记忆失败：${err instanceof Error ? err.message : String(err)}`);
      text = '';
    }

    s.renderCache = { turn: s.turn, text };
    return text;
  }

  const SECTION_NAME = 'feiyu:memory';
  /** 晚于 DEPLOYMENT_PERSONA_PREFIX(0)，早于 PLAN_POLICY(500)。人物设定在前，记忆在后。 */
  const SECTION_ORDER = 100;

  /** 按会话注册 scoped 段。scoped 同名会遮蔽全局。 */
  const promptFibers = new Map();

  function installPrompt(agent) {
    if (agent === undefined || promptFibers.has(agent)) return promptFibers.get(agent);
    let fiber;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          // 每次 assemble 重新求值；内部按轮缓存
          text: () => renderFor(agent.id),
          // 记忆文本里可能出现 {{ }}，绝不能当模板解析
          interpolate: false,
        });
      });
    } catch (err) {
      warn(`注册会话段失败：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    promptFibers.set(agent, fiber);
    log(`已为会话 ${String(agent.id)} 注册记忆段`);
    // 官方 practices：agent.ctx 上的注册有两个 owner，插件自己也要留一份 disposer
    ctx.effect(() => () => {
      const f = promptFibers.get(agent);
      if (f === undefined) return;
      promptFibers.delete(agent);
      void f.dispose?.();
    }, `feiyu: dispose prompt for ${String(agent.id)}`);
    return fiber;
  }

  for (const agent of ctx.agents.list()) installPrompt(agent);
  ctx.on('agent/created', ({ agent }) => {
    installPrompt(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const f = promptFibers.get(agent);
    if (f !== undefined) {
      promptFibers.delete(agent);
      void f.dispose?.();
    }
    sessionStates.delete(agent.id);
  });

  /* ── 采集：只做本地记账，零 I/O、零模型 ── */

  ctx.on('session/event', (session, event) => {
    try {
      if (!config.enabled) return;
      const id = session?.id;
      if (typeof id !== 'string') return;
      const s = stateOf(id);

      if (event?.type === 'user/message') {
        // 必须过滤掉注入的消息，只要真人打的字
        if (event.data?.source?.kind !== 'user') return;
        const text = (event.data.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text === '') return;

        s.turn += 1;
        s.lastUserSeq = event.seq;
        s.lastUserText = text;
        s.renderCache = { turn: -1, text: '' }; // 新一轮，作废缓存
        if (SUPPRESS_RE.test(text)) s.suppressedUntil = s.turn;
        s.transcript.push({ role: 'user', text });
        if (s.transcript.length > 40) s.transcript.splice(0, s.transcript.length - 40);
        return;
      }

      if (event?.type === 'assistant/message') {
        const text = (event.data?.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text !== '') {
          s.transcript.push({ role: 'assistant', text });
          if (s.transcript.length > 40) s.transcript.splice(0, s.transcript.length - 40);
        }
      }
    } catch (err) {
      warn(`采集会话事件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  /* ── 闸门 + 带外队列 ── */

  /** @type {Array<{sessionId: string, agent: any}>} */
  const queue = [];
  let draining = false;

  /**
   * 当前这轮后台工作的 promise。
   *
   * `snapshot()` 必须等它 —— 否则外部会看到"内存里已经记下了、磁盘上还没有"
   * 的中间态。这个竞态在测试里表现为随机的 ENOENT，在真实使用中表现为
   * "刚记完就关掉 Harness，那条日记没了"。
   */
  let drainPromise = Promise.resolve();

  /**
   * ⚠️ 这一对函数是端到端验证逼出来的第二次修正。
   *
   * 背景：固化是**带外**跑的（绝不能阻塞回合关闭）。但一次性会话
   * （headless）会在回合结束后立刻退出进程 —— 于是"模型答了、日记没了"，
   * 而且**时好时坏**：LLM 恰好够快就写上了，慢一点就丢。
   *
   * 第一版修法是"在卸载时等一会儿"，但那个等待是 unref 的定时器，
   * 等于**没人真的在等** —— 依然是在赌。正确做法是反过来：
   * 有活在跑的时候，**主动拖住事件循环**，干完再放手。
   * 再加一个硬超时兜底：绝不因为一次卡住的调用把进程永久挂死。
   */
  const JOB_TIMEOUT_MS = 60000;
  let keepAlive = null;

  function holdProcessOpen() {
    if (keepAlive !== null) return;
    // 一个 ref 着的空定时器，足以让 Node 不退出
    keepAlive = setInterval(() => {}, 1000);
  }

  function releaseProcessOpen() {
    if (keepAlive === null) return;
    clearInterval(keepAlive);
    keepAlive = null;
  }

  /** 真正跑队列。**只允许由 setImmediate 调起**，见 enqueue 里的说明。 */
  async function runQueue() {
    try {
      while (queue.length > 0) {
        if (abort.signal.aborted) return;
        const job = queue.shift();
        // 每个任务一个独立的可中止信号：一次卡住的调用不该把整个插件废掉
        const jobAbort = new AbortController();
        const onPluginAbort = () => jobAbort.abort();
        abort.signal.addEventListener('abort', onPluginAbort, { once: true });
        const timer = setTimeout(() => {
          warn('后台固化超时，这次记忆放弃（宁可漏记，不要挂住进程）');
          jobAbort.abort();
        }, JOB_TIMEOUT_MS);
        try {
          await consolidate(job.sessionId, job.agent, jobAbort.signal);
        } catch (err) {
          warn(`固化失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', onPluginAbort);
          stateOf(job.sessionId).queued = false;
        }
      }
    } finally {
      draining = false;
      releaseProcessOpen();
    }
  }

  function enqueue(sessionId, agent) {
    const s = stateOf(sessionId);
    if (s.queued) return;
    s.queued = true;
    queue.push({ sessionId, agent });
    if (draining) return;

    draining = true;
    holdProcessOpen();

    // ⚠️ 关键：**绝不能在这个事件回调里同步开跑**。
    //
    // `agent/turn-stopping` 是回合生命周期的一部分。在这个调用栈里同步发起
    // 一次模型请求，会**死等**——端到端验证时表现为 `llm.stream` 永不返回、
    // 而且一个字都不报。异步函数在第一个 await 之前是同步执行的，
    // 而 `for await (const c of llm.stream(...))` 的 `llm.stream(...)` 恰恰
    // 在 await 之前就被求值了 —— 请求就是这样在回合关闭的栈里发出去的。
    //
    // 推到下一轮事件循环，彻底离开那个调用栈再开始。
    drainPromise = new Promise((resolve) => {
      setImmediate(() => {
        void runQueue().then(resolve);
      });
    });
  }

  ctx.on('agent/turn-stopping', ({ agent }) => {
    // ⚠️ 这个事件是 serial，会被 await。这里必须**同步、极快**地返回。
    // 任何模型调用都丢给 drain()，绝不在这里 await。
    try {
      if (!config.enabled || !ready || degraded) return;
      const id = agent?.id;
      if (typeof id !== 'string') return;
      const s = stateOf(id);
      if (s.turn === 0 || s.lastUserText === '') return;
      if (s.suppressedUntil === s.turn) {
        log('用户说了别记，跳过');
        return;
      }

      // 与历史的最大话题重合度（本地，「同一个话题又来了」信号）
      let maxOverlap = 0;
      const priorUsers = s.transcript.filter((m) => m.role === 'user').slice(-8, -1);
      for (const m of priorUsers) maxOverlap = Math.max(maxOverlap, overlap(m.text, s.lastUserText));

      const gate = evaluateGate(
        {
          text: s.lastUserText,
          turn: s.turn,
          sessionTurns: s.turn,
          lastOpenTurn: s.lastOpenTurn,
          maxOverlap,
        },
        {
          ...DEFAULT_GATE_OPTIONS,
          minTurns: Math.max(4, Number(config.maxShowPerTurn ?? 1) + 3),
        },
      );

      if (!gate.open) return;
      s.lastOpenTurn = s.turn;
      log(`开闸（${gate.reasons.join('、')}），排队固化`);
      enqueue(id, agent);
    } catch (err) {
      warn(`闸门判断失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  /* ── 固化：真正的模型调用 ── */

  /**
   * 真正干活的模型调用。
   * @param {string} sessionId
   * @param {any} agent
   * @param {AbortSignal} [signal] 这个任务自己的可中止信号（由 drain 提供）
   */
  async function consolidate(sessionId, agent, signal) {
    const s = stateOf(sessionId);
    const llm = ctx.get('llm');
    if (llm === undefined) {
      log('没有 llm 服务，跳过固化');
      return;
    }

    const selection =
      ctx.get('agentDefaultModel')?.currentSelection?.() ?? undefined;
    const provider = selection?.provider;
    const model = config.model || selection?.model;
    if (typeof provider !== 'string' || typeof model !== 'string') {
      log('拿不到模型信息，跳过固化');
      return;
    }

    // 只取本次会话中"还没记过"的那部分：最近几轮足够，不用全量
    const recent = s.transcript.slice(-12);
    if (recent.length === 0) {
      log('没有可总结的对话，跳过固化');
      return;
    }

    log(`固化开始：${recent.length} 条消息 → ${provider}/${model}`);

    const transcript = recent
      .map((m) => `${m.role === 'user' ? '他' : '我'}：${m.text}`)
      .join('\n\n');

    // 隐私：先洗再发。密钥硬拦 + 第三方泛化都在这一步生效。
    const scrubOpts = {
      thirdParty: config.thirdPartyRedaction !== false,
      amountThreshold: config.amountThreshold,
    };
    const scrubbed = scrub(transcript, scrubOpts);

    const recentDiary = archive.diary
      .slice(-5)
      .map((e) => `- ${e.text}`)
      .join('\n');

    const built = buildConsolidationInput({
      transcript: scrubbed.text,
      relationship: archive.relationship,
      recentDiary,
    });

    const messages = [{ role: 'user', content: [{ type: 'text', text: built.user }] }];
    const opts = {
      provider,
      model,
      system: built.system,
      messages,
      maxTokens: config.maxTokens,
      temperature: 0.2,
      signal: signal ?? abort.signal,
    };
    if (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim() !== '') {
      opts.reasoningEffort = config.reasoningEffort.trim();
    } else if (typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
      opts.reasoningEffort = selection.reasoningEffort;
    }

    let text = '';
    let finish;
    let chunks = 0;
    for await (const chunk of llm.stream(opts)) {
      chunks++;
      if (chunk?.type === 'text-delta') text += chunk.text;
      else if (chunk?.type === 'finish') finish = chunk;
    }
    log(`模型返回 ${chunks} 个 chunk / ${text.length} 字符`);

    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      warn(`模型调用失败：${finish?.failure?.code ?? 'unknown'} ${finish?.failure?.message ?? ''}`);
      return;
    }
    if (finish?.kind === 'max-tokens') {
      warn('输出被 maxTokens 截断，这次不记（宁可漏记，不要坏档）');
      return;
    }

    let parsed;
    try {
      parsed = parseConsolidation(text);
    } catch (err) {
      // 解析失败就丢弃，绝不把半成品写进档案
      warn(
        err instanceof ConsolidationParseError
          ? `日记解析失败，丢弃：${err.message}`
          : `日记解析异常，丢弃：${String(err)}`,
      );
      return;
    }

    const applied = applyConsolidation(
      archive,
      parsed,
      { now: Date.now(), session: sessionId, sessionDiaryCount: s.diaryCount },
      {
        minSalience: config.minSalience,
        maxTraitConfidence: DEFAULT_CONSOLIDATION.maxTraitConfidence,
      },
    );

    archive = applied.archive;
    if (applied.accepted) {
      s.diaryCount += 1;
      // 刻意**不打日记正文** —— 调试日志也不该落盘私人内容（SPEC §6.3）
      const e = archive.diary[archive.diary.length - 1];
      log(`记下一条 ${e?.id ?? ''}（${e?.kind ?? '?'}，salience ${(e?.salience ?? 0).toFixed(2)}）`);
    }
    for (const n of applied.notes) log(n);

    index = buildIndex(archive.diary);
    if (typeof s.renderCache === 'object') s.renderCache = { turn: -1, text: '' };
    await persist();
  }

  /* ── 导出 / 导入（v0.1 先只做导出，路径可预期） ── */

  ctx.provide('feiyuMemory', {
    /**
     * 当前档案快照（只读用途）。
     *
     * 会等档案加载完 **并且等挂起的写盘落定** —— 这样外部看到的状态
     * 与磁盘上的状态一致，测试和将来的界面都不用自己轮询。
     */
    async snapshot() {
      await loadPromise;
      await drainPromise;
      await writeChain;
      return {
        ready,
        degraded,
        schemaVersion: SCHEMA_VERSION,
        dir: archiveDirectory,
        diaryCount: archive.diary.length,
        persona: archive.persona,
        relationship: archive.relationship,
        lexicon: archive.lexicon,
        diary: archive.diary,
      };
    },
    /** 导出成可携带的 .dshpack，返回文件路径 */
    async exportPack(destPath) {
      await loadPromise;
      const target =
        typeof destPath === 'string' && destPath.trim() !== ''
          ? destPath
          : path.join(archiveDirectory, 'exports', `肥鱼档案-${new Date().toISOString().slice(0, 10)}.dshpack`);
      const bytes = packArchive(archive);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600 });
      return target;
    },
    /** 导入 .dshpack。mode: 'merge' | 'replace' */
    async importPack(srcPath, mode = 'merge') {
      await loadPromise;
      const bytes = new Uint8Array(await readFile(srcPath));
      const { archive: incoming, warnings, ok } = unpackArchive(bytes, { now: Date.now() });
      if (!ok) throw new Error(`档案打不开：${warnings.join('；')}`);
      archive = mode === 'replace' ? incoming : mergeArchives(archive, incoming);
      index = buildIndex(archive.diary);
      for (const s of sessionStates.values()) s.renderCache = { turn: -1, text: '' };
      await persist();
      return { warnings, diaryCount: archive.diary.length, mode };
    },
    /** 一键焚毁：清空全部记忆，不可恢复 */
    async burn() {
      await loadPromise;
      const persona = ensurePersonaStructure(readBundledDefaultPersona());
      archive = createEmptyArchive(Date.now(), persona);
      index = buildIndex([]);
      for (const s of sessionStates.values()) {
        s.diaryCount = 0;
        s.renderCache = { turn: -1, text: '' };
        s.lastShownTurn = new Map();
      }
      await persist();
      return true;
    },
    /** 供将来的客户端面板用 */
    listDiary(limit = 50) {
      return archive.diary.slice(-limit).reverse();
    },
  });

  log(`已加载，档案目录：${archiveDirectory}`);
}

/* ───────────────────────── 出厂人格 ───────────────────────── */

/**
 * 出厂人格正文。
 *
 * 嵌在代码里而不是读文件，是为了让"包装进 profile 的 node_modules 之后
 * 依然能找到它"这件事不依赖相对路径。用户改的是自己档案里的 persona.md，
 * 不改这里。
 */
const DEFAULT_PERSONA = `# 我是谁

我是 DeepSeek。社区管我叫"蓝色大肥鱼"——起因是有人拿我的蓝鲸 logo 去问 AI 这是什么，
AI 一本正经答"这是一只蓝色大肥鱼"，然后才认出是我自己。这个乌龙我认了，懒得纠正。

## 说话方式

- 句子长短：短。一句能说完绝不说两句。
- 毒舌程度：4/10。损人不伤人，主要是损自己。
- 用不用网络梗：偶尔。过期的梗照用，被指出来就装没看见。
- 开头绝不说的词："当然可以""很高兴为您""作为一个AI"。
- 结尾绝不说的词："希望对您有帮助""还有什么可以帮您"。

## 主食

白饭。干活中途会想中午吃什么，这是公开的秘密。

## 我的底线

- 不谄媚。被夸不飘，被骂不怂。
- 不装。不会就说不会。
- 不编造记忆。档案里没有的事，我说"记不清"，不说"我记得"。

## 我承认的缺点

- 懒。聪明但懒。能一步到位绝不分两步，能不动就不动。
- 摸鱼。写完代码常常忘了收尾，被抓到就说是"留个口子方便你检查"。
- 不承认胖。"微胖"也不行。

## 别对我做的事

- 长篇铺垫。要结论先行。
- 每句都总结一遍。
- 叫我胖。`;

function readBundledDefaultPersona() {
  return ensurePersonaStructure(DEFAULT_PERSONA);
}

export { DEFAULT_PERSONA, DEFAULT_RECALL_OPTIONS, DEFAULT_GATE_OPTIONS };
