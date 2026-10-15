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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  normalizeDiaryEntry,
} from '../core/archive.mjs';
import { evaluateGate, SUPPRESS_RE, DEFAULT_GATE_OPTIONS } from '../core/gate.mjs';
import { buildIndex, selectMemories, DEFAULT_RECALL_OPTIONS } from '../core/recall.mjs';
import { overlap } from '../core/keywords.mjs';
import { scrub } from '../core/privacy.mjs';
import { renderMemoryBlock, DEFAULT_BUDGET, MAX_NOTES } from '../core/persona.mjs';
import { calendarDaysBetween, stripTimeWords } from '../core/timeline.mjs';
import { renderDiaryFile } from '../core/render-diary.mjs';
import { selectHandNotes, HANDNOTE_FILE, HANDNOTE_TEMPLATE } from '../core/handnote.mjs';
import {
  buildConsolidationInput,
  parseConsolidation,
  applyConsolidation,
  decayArchive,
  makeDiaryId,
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
  /**
   * **加载时磁盘上有哪些日记 id** —— 三路合并的"基线"。
   *
   * 只在这里赋值一次，之后**永不更新**。它是判断"谁删了什么"的唯一依据：
   *
   *   内存没有、磁盘没有、基线有 → 我们删的
   *   内存没有、基线没有、磁盘有 → 别人刚加的
   *
   * 详见 `mergeArchives` 的表格。
   */
  let loadedIds = new Set();
  /** 倒排索引 —— 纯派生，每次加载档案后重建，不落盘 */
  let index = buildIndex([]);
  let ready = false;
  /** 档案是否处于"读失败所以只读"状态（SPEC §10 降级优先） */
  let degraded = false;

  /**
   * 日志出口。
   *
   * 三份去向，理由各不相同：
   *  - `ctx.logger`：正式渠道，桌面端界面/日志能看到
   *  - `stderr`：headless / 无人值守时 ctx.logger 可能没人接
   *  - **`feiyu.debug.log` 文件**：进程被硬退出时前两份都会丢
   *
   * 第三份是端到端验证逼出来的：headless 跑完一个任务会**直接退进程**，
   * stderr 缓冲区来不及刷，于是"它卡在哪一环"完全看不见 ——
   * 明明日志代码写了，就是一片空白。落文件才留得住。
   *
   * 只有 `debugLog: true` 才写，且**只写形状、绝不写对话内容**（SPEC §6.3）。
   */
  const DEBUG_LOG_FILE = 'feiyu.debug.log';
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
    try {
      mkdirSync(archiveDirectory, { recursive: true });
      appendFileSync(
        path.join(archiveDirectory, DEBUG_LOG_FILE),
        `${new Date().toISOString()} ${line}\n`,
        'utf8',
      );
    } catch {
      // 写不了就算了，日志不该影响功能
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
      // 基线只在这里定一次：之后落盘前的三路合并全靠它判断"谁删了什么"
      loadedIds = new Set(archive.diary.map((e) => e.id));
      ready = true;
      log(`档案就绪：${archive.diary.length} 条日记`);

      // 顺手刷新人读版。这样即使这次什么都没记，衰减后的状态也是对的；
      // 也从别人那儿导入档案之后，立刻就有可读的一份。
      await writeReadableDiary(archive);

      // 手记文件不在就建一份带说明的空壳 —— **文件自己就是文档**。
      // 用户（或任何一个肥鱼）打开就知道该往里写什么。
      try {
        const notePath = path.join(archiveDirectory, HANDNOTE_FILE);
        if (!existsSync(notePath)) writeFileSync(notePath, HANDNOTE_TEMPLATE, 'utf8');
      } catch (err) {
        warn(`建手记文件失败（不影响别的）：${err instanceof Error ? err.message : String(err)}`);
      }
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
   * ── 第二个坑（也是端到端验证抓的）──
   *
   * 这个上限原来写的是 20 秒，而**单任务自己的超时是 60 秒**。
   * 也就是说：只要固化耗时超过 20 秒，这里就会先动手把它砍掉 ——
   * 那个 60 秒的超时永远轮不到生效。
   *
   * 提示词短的时候侥幸没撞上（几秒就答完了）；把提示词写详细、
   * 要求带 evidence 之后，输出变长、耗时跨过 20 秒，就必然丢日记。
   *
   * 所以这个值**必须大于单任务超时**，它只是"进程已经要死了"的最后一道保险，
   * 不是任务的时间预算。任务的时间预算归 JOB_TIMEOUT_MS 管。
   */
  const FLUSH_TIMEOUT_MS = 180000;
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

  /**
   * 落盘前，把**磁盘上别的会话刚写的**东西并进内存。
   *
   * ── 为什么必须有这一步 ──
   *
   * `archiveToFiles()` 是**整份重建**：内存里有什么就写什么，磁盘上多出来的一律抹掉。
   *
   * 单会话时没事。但同一份档案会被**很多个会话**同时打开 ——
   * 实测有 **10 个会话**往同一个档案里写过。每个会话启动时把档案读进内存，
   * 落盘时整份重写：
   *
   *   会话 A 写了 X，落盘
   *   会话 B 内存里没有 X，写 Y，落盘 → **X 被抹掉了**
   *
   * 谁后落盘谁赢。而且这种丢失**检测不出来**：B 覆盖 A 的第 5 条时，
   * 编号照样是 1..10 连续的 —— 不撞号也不断号。
   *
   * 所以写之前先读一遍，按 id 并一下。**内存优先**（它对已知的条目最新），
   * 磁盘补充内存没有的。`mergeArchives` 就是干这个的。
   *
   * ── 这个修法换来了什么、代价是什么 ──
   *
   * 换来：**新增的条目不会再被静默抹掉。** 这是唯一会真吃掉用户数据的路径。
   *
   * 代价：**删除在并发下可能被翻回来。** 会话 B 内存里还留着用户刚在会话 A
   * 删掉的那条，B 一落盘它就回来了。这个取舍是故意的 ——
   * *恢复一条看得见的删错，比丢一条看不见的东西便宜。*
   * 要根治得给删除加墓碑（tombstone），那是另一个量级的改动，先记着。
   */
  async function mergeDiskEntries() {
    try {
      const { files } = await readArchiveDir(archiveDirectory);
      // ⚠️ **读不到就别合。** 磁盘读失败时传个空基线，会让
      // `mergeArchives` 把"内存有、磁盘没有"全判成"别人删了它"，
      // 一个档案瞬间清空。宁可这一次不防丢，也不能把档案写没。
      if (files.size === 0) return 0;
      const entries = [...files].map(([n, text]) => ({ name: n, text: () => text }));
      const { archive: disk } = archiveFromFiles(entries, { now: Date.now() });
      const before = archive.diary.length;
      archive = mergeArchives(archive, disk, { baselineIds: loadedIds });
      index = buildIndex(archive.diary);
      const gained = archive.diary.length - before;
      if (gained > 0) log(`落盘前并进了 ${gained} 条别的会话刚写的日记`);
      return gained;
    } catch (err) {
      // 读不到就照常写 —— 合并是**尽力而为的防丢**，不能因为它失败就不落盘
      warn(`落盘前合并失败（继续写，但可能覆盖别的会话）：${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  function persist() {
    if (!ready) return writeChain;
    writeChain = writeChain
      .then(async () => {
        // ⚠️ 顺序要紧：**先并、再改时间戳、再写。**
        // 合并会把 archive 换成新对象，所以 snapshot 必须在合并之后取。
        await mergeDiskEntries();
        const merged = archive;
        merged.manifest.updated_at = Date.now();
        await writeArchiveDir(archiveDirectory, archiveToFiles(merged));
        await writeReadableDiary(merged);
      })
      .catch((err) => {
        warn(`写档案失败：${err instanceof Error ? err.message : String(err)}`);
      });
    return writeChain;
  }

  /* ── 注入 ── */

  /**
   * 「主动记一条」的工具名。
   *
   * 声明在这里（而不是跟工具定义放一起），是因为 `renderFor` 要把它写进
   * 注入里的那句提示。**放在后面虽然在运行时也能用（TDZ 只在 apply 早期
   * 才可能触发），但太脆** —— 谁把 renderFor 提早调一次就炸。
   */
  const NOTE_TOOL_NAME = 'feiyu_note';

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

      // ── 判断和事件，分开放 ──
      //
      // 这是这次改动的核心。**内容早就在了，只是放错了格子。**
      //
      // `feiyu_note` 写出来的东西（"别把前一种的辛苦当成功德"）是**判断**，
      // 不是事件，却一直被当成事件渲染在「最近的事」里，格式跟流水账一模一样 ——
      // 连我自己都分不出哪句是我写的。一位读者把这个毛病说得很准。
      //
      //   事件 → 「最近的事」/「突然想起来」（会被召回）
      //   判断 → 「我自己想的」（永远在场，不进召回池）
      //
      // ⚠️ **"永远在场"这个前提在高频下失效了。** 判断段只放得下
      // `MAX_NOTES` 条（8 → 4，因为 8 条会吃光预算、把日记段挤到 0%）。
      // 被挤出窗口的判断如果还不进召回池，那就不是"以后想起来"，
      // 是**彻底看不见** —— 而这个区是"是我"，丢了最可惜。
      //
      // 所以分流改成两截：
      //   最近 MAX_NOTES 条 → 「我自己想的」（永远在场）
      //   更早的那些        → **加入召回池**，相关时能被想起来
      const allNotes = archive.diary.filter((e) => e?.kind === 'note');
      const events = archive.diary.filter((e) => e?.kind !== 'note');
      const shownNotes = allNotes.slice(-MAX_NOTES);
      const olderNotes = allNotes.slice(0, -MAX_NOTES);

      const { chosen } = selectMemories([...events, ...olderNotes], index, query, s, s.turn, {
        highSim: config.highSim,
        maxShow: config.maxShowPerTurn,
        wanderChance: config.wanderChance,
        // 旧事的随机池门槛。注意下限降到 0.15 是为了跟"降门槛"一致 ——
        // 门槛降到 0.15 却在这里卡 0.25，等于白降。
        minSalience: Math.max(0.15, config.minSalience),
        now: Date.now(),
      });

      // 「最近的事」—— 按时间取最近的几条，不走相似度。
      // 这是让注入区读起来像日记而不是像检索结果的关键：
      // 最近发生的事本来就在脑子里，不需要被"想起来"。
      //
      // 取的是 **events**，不是整个日记 —— 判断归「我自己想的」管。
      const recentCount = Number.isFinite(config.recentEntries) ? config.recentEntries : 8;
      const recent = recentCount > 0 ? events.slice(-recentCount) : [];

      // 手记是**只读**的，所以每轮都重新读一遍 —— 别的肥鱼或用户刚写进去的
      // 那行，下一轮就在注入里，不用重启。文件很小，而且整块渲染按轮缓存。
      let handNotes = [];
      try {
        const notePath = path.join(archiveDirectory, HANDNOTE_FILE);
        if (existsSync(notePath)) handNotes = selectHandNotes(readFileSync(notePath, 'utf8'));
      } catch {
        // 读不到就当没有 —— 绝不因为手记坏了挡住记忆
      }

      const rendered = renderMemoryBlock({
        persona: archive.persona,
        relationship: { ...archive.relationship, since: archive.manifest.created_at },
        lexicon: archive.lexicon,
        // 第三区：**我自己想的**（判断）。最近几条永远在场，
        // 更早的那些走召回（见上面 allNotes 的分流）。
        notes: shownNotes,
        recent,
        recalled: chosen,
        handNotes,
        // 这句是**唯一**能让别的肥鱼知道"可以主动记"的渠道 ——
        // 它们每轮都会读到这块记忆，不会去翻文档。
        handNoteHint: `想给后面的我留话，用 ${NOTE_TOOL_NAME} 工具说一声就行 —— 不用管格式，也别为了记事去动文件。`,
        includePersona: config.includePersona,
        budget: config.budgetTokens,
        now: Date.now(),
      });
      text = rendered.text;
      log(
        `会话 ${sessionId} 第 ${s.turn} 轮：最近 ${recent.length} 条在场 · 想起 ${chosen.length} 条` +
          ` · 注入 ${rendered.tokens} token` +
          (rendered.dropped.length > 0 ? ` · 裁掉 ${rendered.dropped.join('/')}` : ''),
      );
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
    // ── 思考档位：**显式关掉，绝不继承用户在聊天里选的档位** ──
    //
    // 这一条是端到端验证用命换来的。原来的写法是"没配就跟随当前默认模型"，
    // 而用户在桌面端把聊天档位设成了 high —— 于是后台的固化调用也在疯狂思考，
    // 900 个 maxTokens 全烧在推理上，正文一个字都没产出。
    //
    // 症状极具迷惑性：日志显示"已收 600 个 chunk / **0 字符**"，
    // 请求正常发出、chunk 正常到达、进程正常退出、没有一条报错，
    // 就是什么都不记。
    //
    // 固化是结构化抽取，不是创作。思考在这里是纯浪费，而且会挤掉答案。
    if (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim() !== '') {
      opts.reasoningEffort = config.reasoningEffort.trim();
    }

    let text = '';
    let finish;
    let chunks = 0;
    log(
      `调用模型（system ${built.system.length} 字 / user ${built.user.length} 字` +
        ` / maxTokens ${config.maxTokens} / 思考 ${opts.reasoningEffort ?? '默认'}）`,
    );

    // 有的 provider 不认这个档位会直接抛 UNSUPPORTED_REASONING_EFFORT。
    // 那就退回"不指定"，而不是让整个记忆功能瘫痪。
    const runStream = async (o) => {
      let t = '';
      let f;
      let n = 0;
      for await (const chunk of llm.stream(o)) {
        n++;
        if (n === 1) log(`收到第一个 chunk（${chunk?.type ?? '?'}）`);
        if (n % 200 === 0) log(`…已收 ${n} 个 chunk / ${t.length} 字符`);
        if (chunk?.type === 'text-delta') t += chunk.text;
        else if (chunk?.type === 'finish') f = chunk;
      }
      return { text: t, finish: f, chunks: n };
    };

    let run;
    try {
      run = await runStream(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.reasoningEffort !== undefined && /REASONING_EFFORT/i.test(msg)) {
        warn(`provider 不接受思考档位 ${opts.reasoningEffort}，退回不指定重试一次`);
        delete opts.reasoningEffort;
        run = await runStream(opts);
      } else {
        throw err;
      }
    }
    text = run.text;
    finish = run.finish;
    chunks = run.chunks;
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

  /**
   * 忘掉某一条日记 —— 面板上那个「忘掉」按钮，以及服务上的同名方法。
   *
   * 抽成独立函数而不是写在 `ctx.provide` 的对象字面量里，是因为
   * **HTTP 路由也要用它**。路由跟服务都在 apply 作用域内，
   * 直接调本地函数比 `ctx.feiyuMemory.forget(...)` 绕一圈清楚得多，
   * 也少一次"服务到底注册上没有"的隐式依赖。
   *
   * 这一条是这个插件必须有的：在那之前，想删一条记忆得自己去编辑
   * 日记的 jsonl 文件。会做这件事的人不需要面板，需要面板的人不会做这件事。
   *
   * @returns {Promise<boolean>} 是否真的删掉了（id 不存在时说 false，让界面能说实话）
   */
  async function forgetEntry(id) {
    await loadPromise;
    if (typeof id !== 'string' || id === '') return false;
    const before = archive.diary.length;
    archive.diary = archive.diary.filter((e) => e?.id !== id);
    if (archive.diary.length === before) return false;
    // ⚠️ **删了就得立碑。** 不立的话，落盘前的三路合并会读一遍磁盘 ——
    // 那条还在磁盘上，内存里没有，基线里可能也没有（本会话刚加的）
    // → 判成"别人刚加的" → **捞回来**。面板上的「忘掉」当场失效。
    // 详见 mergeArchives 的说明。
    const tombstones = new Set(archive.manifest.deleted_ids ?? []);
    tombstones.add(id);
    archive.manifest.deleted_ids = [...tombstones];
    // 索引是纯派生的，必须跟着重建 —— 否则"忘掉"的条目还能被召回
    index = buildIndex(archive.diary);
    for (const s of sessionStates.values()) s.renderCache = { turn: -1, text: '' };
    await persist();
    return true;
  }

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

      if (mode === 'replace') {
        // ⚠️ **replace 必须顺手撤碑，还要重置基线。**
        // 否则：焚毁立碑 → 导入同一个包 → 那些 id 全在墓碑上（而且
        // 磁盘上的墓碑会被并回来）→ **导入等于没导**。端到端测试抓到的。
        //
        // 导入是"我明确要这些东西回来"，墓碑该让位。
        // 基线也要重设：替换之后"谁删过什么"那段历史就不成立了，
        // 不重设的话导入进来的老条目会被判成"别人删了它"。
        archive = { ...incoming, manifest: { ...incoming.manifest, deleted_ids: [] } };
        loadedIds = new Set(archive.diary.map((e) => e.id));
      } else {
        // merge 模式：并进来的东西同样要撤碑，不然"导入一个之前删过的条目"永远fail
        const incomingIds = new Set(incoming.diary.map((e) => e.id));
        const kept = (archive.manifest.deleted_ids ?? []).filter((id) => !incomingIds.has(id));
        archive = mergeArchives(archive, incoming);
        archive = { ...archive, manifest: { ...archive.manifest, deleted_ids: kept } };
      }

      index = buildIndex(archive.diary);
      for (const s of sessionStates.values()) s.renderCache = { turn: -1, text: '' };
      await persist();
      return { warnings, diaryCount: archive.diary.length, mode };
    },
    /** 一键焚毁：清空全部记忆，不可恢复 */
    async burn() {
      await loadPromise;
      // ⚠️ **焚毁要把清掉的 id 全部立碑。** 换一份新档案不等于删除 ——
      // 落盘前的三路合并会读磁盘，而那些 id 既不在新内存里、基线里又可能
      // 没有（本会话刚写的），会被判成"别人刚加的"捞回来。有测试盯着。
      const tombstones = new Set(archive.manifest.deleted_ids ?? []);
      for (const e of archive.diary) tombstones.add(e.id);
      const persona = ensurePersonaStructure(readBundledDefaultPersona());
      archive = createEmptyArchive(Date.now(), persona);
      archive.manifest.deleted_ids = [...tombstones];
      index = buildIndex([]);
      for (const s of sessionStates.values()) {
        s.diaryCount = 0;
        s.renderCache = { turn: -1, text: '' };
        s.lastShownTurn = new Map();
      }
      await persist();
      return true;
    },
    /**
     * 忘掉某一条日记 —— 面板上那个「忘掉」按钮。
     *
     * 这一条是这个插件**必须要有的**：在那之前，想删一条记忆得自己去编辑
     * 日记的 jsonl 文件。会做这件事的人不需要面板，需要面板的人不会做这件事。
     *
     * 返回是否真的删掉了（id 不存在时返回 false，让界面能说实话）。
     */
    forget: forgetEntry,
    /** 供将来的客户端面板用 */
    listDiary(limit = 50) {
      return archive.diary.slice(-limit).reverse();
    },
  });

  /* ── 客户端面板的数据通道 ── */

  /**
   * 面板要显示日记，就得让浏览器拿到主机上的档案。
   *
   * 【为什么走 HTTP，而不是 Cordis RPC】
   * 这是端到端侦察换来的结论，别推翻它：
   *
   *  1. 已安装的客户端插件**没有"自己的 host RPC"**。那个
   *     `host.call(method, args)` 只对「动态包」开放 —— 即
   *     `dsh-tool-cordis` 现场写、用户当场批准运行的那种临时插件。
   *  2. Typert Remote（`@Remote`）那套是**构建期固定**的第一方能力。
   *     官方文档原话：「Client 不会在运行时发现 Host 中已启用的服务或
   *     Remote 定义 … 若要增加能力，必须显式导入相应的 `/remote` 值并
   *     在此组合中挂载」。第三方插件加不进去。
   *  3. 但 host 半边能注册 HTTP 路由（`ctx.webServer.register`），
   *     而客户端本来就是个普通浏览器模块，`fetch` 是它的同源请求。
   *
   * 于是：host 开三个接口，客户端的 `fetch` 直接取。零依赖、零额外模块。
   *
   * 【权限，想清楚再改】
   * 路由挂在应用自己的源上，**故意不设 CORS 头** —— 浏览器里别的网站
   * `fetch` 它拿不到响应体（默认跨源策略读不到），这条是真正有意义的防护。
   *
   * 本机其他进程当然能 curl 它。但它们本来就能直接读
   * `~/.dsh/feiyu-diary/` 里的明文 jsonl —— **威胁面没有变大**。
   * 所以不要因为"怕被读"就往这里加自创的鉴权：那是假的安全感，
   * 真正的秘密（密钥）在发给模型之前就已经被拦掉了（SPEC §6.3）。
   */
  const PANEL_BASE = '/feiyu-diary';

  /** 面板接口统一响应头：不缓存、不嗅探类型 */
  function panelReply(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(body));
  }

  /** 读一个很小的 JSON 请求体。超过 8KB 直接拒 —— 我们只收 id */
  async function readPanelBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * 面板要的那一份状态。
   *
   * **只挑界面用得上的字段**，不把整个档案倒出去 —— 注入用的
   * keywords 索引之类的东西对界面没有意义，多传只是多暴露。
   */
  function panelState() {
    const rel = archive.relationship ?? {};
    const since = archive.manifest?.created_at;
    return {
      ok: true,
      ready,
      degraded,
      count: archive.diary.length,
      diary: archive.diary
        .map((e) => ({
          id: e?.id ?? '',
          text: e?.text ?? '',
          kind: e?.kind ?? 'chat',
          tags: e?.tags ?? [],
          created_at: e?.created_at ?? 0,
          salience: e?.salience ?? 0,
        }))
        .reverse(),
      traits: (rel.traits ?? [])
        .filter((t) => t && typeof t.value === 'string')
        .map((t) => ({
          value: t.value,
          evidence: typeof t.evidence === 'string' ? t.evidence : '',
          about: t.about === 'self' ? 'self' : 'user',
        })),
      grievances: (rel.grievances ?? [])
        .filter((g) => g && g.resolved !== true)
        .map((g) => g.what),
      facts: {
        // 跟注入层用同一把尺子（timeline.mjs）—— 面板说"认识 1 天"、
        // 注入里说"2 天前"，是同一类 bug 换了个出口
        days: calendarDaysBetween(since, Date.now()),
        nickname: typeof rel.nickname === 'string' ? rel.nickname : '',
        lexicon: (archive.lexicon?.items ?? [])
          .filter((i) => i && typeof i.term === 'string')
          .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
          .slice(0, 8)
          .map((i) => i.term),
      },
    };
  }

  /**
   * 注册面板路由。
   *
   * 用 `ctx.inject` 而不是 `ctx.get` —— webServer 是 web 组合才有的服务，
   * headless 里根本不存在。inject 的语义正好：服务在就注册，不在就永远不注册，
   * **不影响插件其余部分**（降级优先，SPEC §10）。
   */
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const routes = [
        {
          kind: 'exact',
          path: `${PANEL_BASE}/state`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return panelReply(res, 405, { ok: false, error: 'method' });
            await loadPromise;
            return panelReply(res, 200, panelState());
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/forget`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return panelReply(res, 405, { ok: false, error: 'method' });
            try {
              const body = await readPanelBody(req);
              const removed = await forgetEntry(body?.id);
              return panelReply(res, 200, { ok: true, removed, count: archive.diary.length });
            } catch (err) {
              return panelReply(res, 400, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        },
        {
          kind: 'exact',
          path: `${PANEL_BASE}/export`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return panelReply(res, 405, { ok: false, error: 'method' });
            try {
              // 等到挂起的写盘落定，导出的是**磁盘上那份**档案
              await loadPromise;
              await drainPromise;
              await writeChain;
              const bytes = packArchive(archive);
              const name = `feiyu-diary-${new Date().toISOString().slice(0, 10)}.dshpack`;
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/octet-stream');
              res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
              res.setHeader('Cache-Control', 'no-store');
              res.end(Buffer.from(bytes));
            } catch (err) {
              return panelReply(res, 500, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        },
      ];
      const disposers = routes.map((r) => scope.webServer.register(r));
      log(`面板接口已注册：${PANEL_BASE}/{state,forget,export}`);
      return () => {
        for (const d of disposers.reverse()) {
          try {
            d();
          } catch {
            // 注销失败不该影响卸载
          }
        }
      };
    }, 'feiyu: 面板数据接口');
  });

  /* ── 主动记一条：给鱼用的工具 ── */

  /**
   * 固化那条路是**插件自己判断 + 模型生成**的。这个工具是另一条：
   * **哪一棒想到了什么，自己说一声就记下。**
   *
   * 【为什么是工具，而不是让鱼去写文件】
   * 一开始我设计的是让鱼直接往 `日记/*.jsonl` 追加。那条路有两个洞：
   *
   *  1. **静默丢数据** —— `archiveToFiles()` 是整份重建，内存副本会把
   *     外部追加的行整份盖掉，没有报错。
   *  2. **`id` 漏了就撞车** —— `normalizeDiaryEntry` 里是 `id: String(raw.id)`，
   *     少写就变成字符串 "undefined"，两条日记同 id，删一条删两条。
   *
   * 交给插件办，这两个洞都不存在 —— 鱼只管说话，格式、id、关键词、
   * 写盘全由这里负责。**鱼不该为了记事去操作文件系统。**
   *
   * 【为什么不做成"进后台队列"】
   * 用户的说法是"不是自己切后台搞"。所以这里是**当场写**：
   * 工具调用返回之前，条目已经落盘，下一轮注入里就有。
   * 不进带外队列、不等低峰时段 —— 那是固化那条路的事。
   *
   * 定义形状是手写的 JSON Schema（`defineTool` 转出来的就是这个形状），
   * 因为**我们不能 import `@deepseek-ai/dsh-tools`**（零依赖铁律）。
   * 名字 `NOTE_TOOL_NAME` 声明在 renderFor 那边 —— 注入里要引用它。
   */

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () =>
        scope.tools.register({
          name: NOTE_TOOL_NAME,
          description:
            '给自己留一条记忆。想到了什么值得让后面的我记得的，直接写进来就行 —— 不用管格式，也不要为了记事去动任何文件。' +
            '不适合记的：能从档案里推出来的、一次性的技术细节、对别人的评价。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: {
                type: 'string',
                description:
                  '一句话，第一人称，像跟后面的自己说话。**不要写"今天/昨天"这类时间词**（时间由系统另外标注）。',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: '可选，两三个词，用来日后检索。',
              },
            },
            required: ['text'],
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean' },
                id: { type: 'string' },
                count: { type: 'integer' },
              },
            },
            render: (_args, value) =>
              value?.ok === true
                ? [{ type: 'text', text: `记住了。（档案里现在 ${value.count} 条）` }]
                : [{ type: 'text', text: '没记成。' }],
          },

          async execute(args, exec) {
            await loadPromise;
            if (!ready) {
              // 档案坏了就说实话，别假装记下了（SPEC §10 降级优先）
              throw new Error('档案现在读不了（可能是坏的），这条没记下。');
            }
            const raw = typeof args?.text === 'string' ? args.text.trim() : '';
            if (raw === '') throw new Error('要记什么？text 不能是空的。');

            const now = Date.now();
            const tags = (Array.isArray(args?.tags) ? args.tags : [])
              .filter((t) => typeof t === 'string' && t.trim() !== '')
              .map((t) => t.trim().slice(0, 12))
              .slice(0, 4);
            if (tags.length === 0) tags.push('手记');

            const sessionId = exec?.agent?.id;
            const entry = normalizeDiaryEntry({
              id: makeDiaryId(now, archive.diary),
              text: stripTimeWords(raw.slice(0, 400)),
              tags,
              kind: 'note',
              // 主动写下的东西比自动筛出来的更该被想起来，给高一档
              salience: 0.7,
              created_at: now,
              ...(typeof sessionId === 'string' ? { session: sessionId } : {}),
            });

            archive.diary.push(entry);
            index = buildIndex(archive.diary);
            for (const s of sessionStates.values()) s.renderCache = { turn: -1, text: '' };
            await persist();

            // 和固化那条路一样：**只打形状，绝不打正文**
            log(`主动记下一条 ${entry.id}（note），共 ${archive.diary.length} 条`);
            return { ok: true, id: entry.id, count: archive.diary.length };
          },

          presentCall: (args) => ({
            card: 'generic',
            title: '记住一条',
            kind: 'other',
            rawInput: args,
          }),
        }),
      'feiyu: note tool',
    );
    log(`已注册工具 ${NOTE_TOOL_NAME}`);
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
