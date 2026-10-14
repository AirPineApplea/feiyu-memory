# 给接手这个项目的 AI 读

> 这个文件会被 DSH 自动加载（`dsh-agent-instructions` 会读工作区的 `AGENTS.md`）。
> 目标：**换一个全新会话、没有任何上下文，也能接着干，不用问人。**

---

## 这是什么

`feiyu-memory`（肥鱼日记）—— 一个 DeepSeek Harness 插件。
让新开一个对话，用户依然感觉是**同一条蓝色大肥鱼**。

三层记忆：人格内核 / 关系状态 / 情景日记。
每轮结束在本地判断值不值得记（零 token），值得才调一次便宜模型，
一次产出日记 + 关系 patch。下次对话把记忆渲染成约 700 token 注入系统提示词。

**当前版本 `0.1.0`：只有 Host 半边，没有界面。** 日记在磁盘上，能直接用记事本看。

## 先读这些（按顺序）

| 文件 | 内容 |
|---|---|
| `SPEC.md` | **唯一基准。** 决策、理由、冻结清单、变更记录。**第 18 节最重要** |
| `README.md` | 对外门面：安装、配置、隐私、原理 |
| `docs/本地开发与验证.md` | 操作手册：装、测、调参、排错、日志逐行解读 |
| `.refs/API-CHEATSHEET.md` | DSH 接口速查（侦察产出，**不是冻结内容**） |

**动手前先读 `SPEC.md`。** 里面写清了哪些是冻结的、哪些只是参数，
以及每一个取舍的理由 —— 包括那些"看起来可以更正规但故意没那么做"的地方。

## 硬约束（别破坏）

1. **段名 `feiyu:memory`、order 100、`interpolate: false`** —— 冻结。
   与任何人设插件正交共存，不碰 `deployment:persona-prefix` / `-suffix`。
2. **零运行时依赖、零构建步骤。**
   绝不 `import` 任何 `@deepseek-ai/dsh-*` 包。
   绝不加 `prepare` / `postinstall`（pnpm 11 会拦住 GitHub 安装）。
3. **`peerDependencies` 只写 `@deepseek-ai/cordis`。**
   写任何 `@deepseek-ai/dsh-*` 都会触发安装期兼容性硬校验，写错就装不上。
4. **`schemastery` 只能试探性 require，不能静态 import。**
   静态 import 在解析不到时会让整个插件加载失败。
5. **降级优先。** 记忆坏了绝不能挡住聊天。所有事件回调与注入函数包 try/catch。
6. **注入预算 700 token 封顶。** 成本与使用年限解耦是核心设计，别让它长。
7. **隐私三默认**：本地-only 是架构承诺（不是设置项）、第三方隐私泛化、密钥硬拦。
8. **调试日志绝不落盘对话正文**（`debugLog` 只打形状）。
9. **`日记.md` 是单向派生视图，绝不从它读回。**
   它是给人看的窗口；真相源永远是 `diary/*.jsonl`。
   双写两个真相源 = bug 工厂（索引落盘那件事已经踩过一次）。
   它不进 `.dshpack`，写失败只 warn，改它等于白改。

## 怎么跑测试

```bash
node --test            # 105 项，零依赖
npm run check          # 校验 cordis.patch.yml 结构
```

Windows 上 `node` 不在 PATH 里，**双击 `selfcheck.cmd`**（它会去找 DSH 自带的 node）。
那个 `.cmd` 刻意写成**纯 ASCII** —— cmd.exe 用 GBK 读批处理文件，UTF-8 中文会把语法搞坏。

## ⚠️ 最重要的一条：测试全绿 ≠ 插件能用

**105 项测试曾经全绿，然后在真实 DSH 里一跑，抓出 5 个致命问题。**

它们全都在「插件 × 运行时 × 生命周期」的交界处，纯逻辑测试永远碰不到：

1. `ctx.logger` 在 headless 下没人接 → 调试日志完全看不见
2. **`llm.stream` 永不返回且不报错** → 在 `agent/turn-stopping` 的事件回调栈里
   **同步**发起了嵌套模型请求，死等回合锁。用 `setImmediate` 推出那个调用栈
3. **日记时好时坏** → 带外工作没有东西拖住事件循环，一次性会话直接退进程。
   第一版修法用了 `unref()` 的定时器，**等于没人在等**，依然是在赌。
   正确做法是反过来：有活时 hold 一个 **ref 的 interval**
4. 词汇表被词频污染（`java`/`python`/`文件` 进了"我最近常说的"）
   → 梗是语义判断，不是词频统计，只认模型点名的
5. 模型把跨会话的事说成"上一轮" → 注入的旧事要带模糊时间词

**所以：改完代码，除了跑测试，必须真的装上用一次。** 方法见 `SPEC.md` §18。

### 怎么在真实 DSH 里验证（不碰用户的 desktop profile）

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 建一个临时 profile（headless 模板 = 跑一个任务就退出）
& $dsh feiyu-verify --from-default-profile headless --dump-config

# 用 link: 装本地源码（不需要 GitHub）
& $dsh plugin --profile feiyu-verify add "link:D:\肥鱼日记"

# 给它加一段覆盖配置：临时档案目录 + 开日志 + 用登录态 provider
# （headless 模板默认走 deepseek-official，需要 API key；这台机器是登录态）
#   写到 ~/.dsh/profiles/feiyu-verify/cordis.patch.yml：
#     - id: feiyu-memory
#       config:
#         dataDir: 'D:/肥鱼日记/.verify-archive'
#         debugLog: true
#     - id: agent-default-model
#       config: { provider: deepseek-account, model: deepseek-flash, reasoningEffort: low }

# 跑一个会开闸的任务（带"纠正"信号）
& $dsh --profile feiyu-verify "不对，你搞错了。我说的是 Python，你怎么上来就写 Java 了？"

# 看档案有没有落盘 + 日志
# 验完删干净：Remove-Item ~/.dsh/profiles/feiyu-verify -Recurse -Force
```

日志里应该依次出现：`已加载` → `档案就绪` → `注册记忆段` → `开闸` →
`固化开始` → `模型返回` → `记下一条`。**哪一行断了，问题就在那一行之后。**

## 已经踩过的坑（不用再踩）

| 坑 | 说明 |
|---|---|
| `estimateTokens` 分段之和不等于整体 | 预算只靠一次减法必然偶尔超标。改成"装一遍→量真实长度→缩减重装" |
| `ensurePersonaStructure` 不幂等 | 每次读档案多一个尾部换行，人格文件缓慢长胖。统一 `trimEnd()` |
| 懒读 `$DSH_HOME` | 环境变量中途变了会**静默写错目录**。目录必须在 `apply()` 时一次算定 |
| 快照与磁盘不一致 | `snapshot()` 要依次等 `loadPromise → drainPromise → writeChain` |
| 中文 bigram 噪声顶爆分母 | 相似度别用"命中 ÷ 查询词总量"，用饱和函数 `1 − exp(−Σgain/τ)` |
| 中文 `.cmd` 文件 | cmd.exe 按 GBK 解析，UTF-8 中文会破坏语法。批处理一律纯 ASCII |
| `cordis.patch.yml` 的 config | **整体替换，不是深合并**。覆写时要写全，或依赖插件自己的默认值层 |
| **后台调用继承了聊天的思考档位** | 用户在桌面端选 `high`，后台写日记也在疯狂思考，900 个输出 token 全烧在推理上，**正文一个字都没产出**。症状："已收 600 个 chunk / **0 字符**"，请求正常、chunk 正常、进程正常退出、**一条报错都没有**。修法：固化档位默认 `off`，**绝不继承**聊天设置。**后台任务和前台对话的配置必须解耦。** |
| **flush 超时比任务超时还短** | `FLUSH_TIMEOUT_MS` 20 秒 < `JOB_TIMEOUT_MS` 60 秒 → 固化只要超过 20 秒，卸载时的 flush 就先把它砍掉，那个 60 秒永远轮不到生效。提示词短时侥幸没撞上；一写详细就必然丢日记。flush 必须**大于**单任务超时，它只是"进程要死了"的最后保险 |
| **stderr 日志会随进程一起丢** | headless 跑完任务直接退进程，stderr 缓冲区来不及刷 —— 日志代码明明写了却一片空白。`debugLog: true` 时同时落 `feiyu.debug.log` 文件才留得住 |
| **注入"像宪法不像日记"** | `traits` 是 key-value → 天生是规格；分号串行 → 读着像条款；条款压过日记 → 我读到规格就按规格执行。修法：每条印象必须带 `evidence`（那个具体瞬间），`about` 区分"对他的印象"和"我自己的规矩"，印象只留 2 条，并新增不走相似度的「最近的事」段 |
| **"寒暄=无信息=不值得记"是错的** | 那是**系统的标准（信息量）**，不是**鱼的标准（辨识度）**。熟悉感恰恰主要来自寒暄、试错、改口这些"低信息量"的东西。门槛因此从 0.3 降到 0.15 |

## 开发时最该用的工具

```bash
node tools/preview-memory.mjs                          # 把此刻注入给模型的内容打出来
node tools/preview-memory.mjs <档案目录> --query "模拟这轮用户说了什么"
```

**这个插件平时看不见自己的输出** —— 你只能从模型的反应去猜。
而"读起来像日记还是像用户说明书"这件事，光看代码判断不了，必须把渲染结果打出来看。

## 接下来该做什么

按 `SPEC.md` §13 的分期：

- **v0.2**：睡眠批处理（去重 / 衰减 / 内核提案）、词汇升降级、
  日记浏览面板、好奇心限流、情绪慢变量、低峰排队持久化
- **v0.3+**：向量检索（可选）、多档模型路由

**客户端界面（v0.2）动手前必读** `dsh-agent-preset/skills/cordis-plugin-development/`
里的官方规范 —— DSH 客户端插件有两条加载路径（自带包的 `__ModuleLoader__`
与运行时插件的 dynamic Cordis runner），React 的取用方式在两者间不同。
**这条在侦察时没能对着活动客户端确认，别照抄任何没验证过的写法。**

## 规矩

- 用户不是专业开发者。**说人话，给能照着做的步骤，别甩术语。**
- 用户给了很大自主权（设定直接定、测试自己决定做不做）。
  **但破坏档案兼容的改动、以及要动用户机器上别的东西时，先说一声。**
- 写代码前先看 `SPEC.md`；做取舍时问一句：
  **"这让我更像一条鱼，还是更像一套系统？"** 像系统的砍掉。
