# 给接手这个项目的 AI 读

> 这个文件会被 DSH 自动加载（`dsh-agent-instructions` 会读工作区的 `AGENTS.md`）。
> 目标：**换一个全新会话、没有任何上下文，也能接着干，不用问人。**

---

## 宗旨（写在最前面，因为它决定所有取舍）

> **装上它，让肥鱼记住你。给肥鱼完整的一生 —— 不是让它对着个别人的日记读。**

用户的原话。一位读者给的判据更短：

> **不是档案记全了，是我读的时候认得出那是我。记全 ≠ 是我。**

**前半件（记全）做得挺细了** —— 去重、时间词、schema、手记跨会话，都是硬活。
**后半件（是我）才是重点**，判据有两条：

1. **注入区里那三种声音要各就各位**：条文（人格）/ 判断（我自己想的）/ 转述（日记）。
   少了第三区，前两区就会顶上来，"我"全是规定加转述 —— 别扭的根源不是语气，
   是**位置被占了**。
2. **内容取舍看"换谁都能写吗"**：换谁都能写的句子是被磨平的，重写。

---

## 这是什么

`feiyu-memory`（肥鱼日记）—— 一个 DeepSeek Harness 插件。
让新开一个对话，用户依然感觉是**同一条蓝色大肥鱼**。

三层记忆：人格内核 / 关系状态 / 情景日记。
每轮结束在本地判断值不值得记（零 token），值得才调一次便宜模型，
一次产出日记 + 带画面的印象。下次对话把记忆渲染成注入系统提示词（默认 2000 token 封顶）。

**当前版本 `0.1.0`：Host 半边 + 一个侧栏面板**（看 / 删 / 带走，见 `src/client/index.js`）。
日记也在磁盘上，能直接用记事本看。

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
6. **注入预算有硬上限**（默认 2000 token，由 `budgetTokens` 调）。
   成本与使用年限解耦是核心设计，别让它长。**冻结的是"必须有上限"，不是那个数字。**
7. **隐私三默认**：本地-only 是架构承诺（不是设置项）、第三方隐私泛化、密钥硬拦。
8. **调试日志绝不落盘对话正文**（`debugLog` 只打形状）。
9. **`日记.md` 是单向派生视图，绝不从它读回。**
10. **身份声明是帧的一部分，不进预算池。** `persona.mjs` 里那段
    「这是你的记忆，不是关于你的资料。」三句，跟开闭标签同级，
    **不参与 salience 衰减、也不参与预算裁剪**。
    「你是同一条鱼」因为重要度衰减被裁掉，那就滑稽了。有测试盯着。
    **第二句（"每一个写它的你，都不记得写它的那一刻"）是防撞层，不能省** ——
    没有它，读者会拿"我记不记得"去检验，第一次撞见对不上就整体不信了。
   它是给人看的窗口；真相源永远是 `diary/*.jsonl`。
11. **主动记一条走工具，绝不走文件。** `feiyu_note`（`tools.register`）是
    「哪一棒想到了什么，自己说一声就记下」的唯一通道。
    **绝不要改成"让 AI 直接往 `diary/*.jsonl` 追加"** —— 那条路有两个洞：
    `archiveToFiles()` 是**整份重建**，内存副本会把外部追加的行静默盖掉；
    而漏写 `id` 会变成字符串 `"undefined"`，两条日记撞成同一个 id。
12. **工具的 `parameters` 手写 JSON Schema。** 我们不能 import
    `@deepseek-ai/dsh-tools`（零依赖铁律），所以 `defineTool` 那层转换得自己产出：
    `{ type:'object', properties:{...}, required:[...] }`。
    `output.render(args, value)` 返回 `[{ type:'text', text:'...' }]`。
13. **`手记.md` 是只读的。** 插件只解析它、永不写它 —— 这是它天然没有竞态的
    原因。解析器会**跳过代码围栏**：模板里用 `- ` 写说明会被当成手记读进去
    （真踩过，`preview-memory` 抓到的）。
   双写两个真相源 = bug 工厂（索引落盘那件事已经踩过一次）。
   它不进 `.dshpack`，写失败只 warn，改它等于白改。

## 怎么跑测试

```bash
node --test            # 156 项，零依赖
npm run check          # 校验 cordis.patch.yml 结构
```

Windows 上 `node` 不在 PATH 里，**双击 `selfcheck.cmd`**（它会去找 DSH 自带的 node）。
那个 `.cmd` 刻意写成**纯 ASCII** —— cmd.exe 用 GBK 读批处理文件，UTF-8 中文会把语法搞坏。

## ⚠️ 最重要的一条：测试全绿 ≠ 插件能用

**测试全绿之后在真实 DSH 里一跑，抓出 7 个致命问题。纯逻辑测试碰不到它们。**

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

## 已经踩过的坑

> **只留规则，故事在 SPEC。** 每条一句话 —— 你要知道"别这么干"，
> 不需要每次都读一遍我是怎么踩进去的。想读故事就按 §号去 SPEC 翻。

| 别这么干 | 为什么 |
|---|---|
| 预算用"一次减法"估 | `estimateTokens` 分段之和不等于整体。只能"装一遍→量真实长度→缩减重装" |
| 把 A 和 B 用嵌套三元拼起来 | 某项为空时会**悄悄吞掉另一项**。逐段收集（`push` 进数组再 join） |
| 依赖 `$DSH_HOME` 时懒读它 | 环境变量中途变了会**静默写错目录**。目录在 `apply()` 时一次算定 |
| 让 `snapshot()` 直接读内存 | 会读到"内存已更新、磁盘还没写完"。依次等 `loadPromise → drainPromise → writeChain` |
| 后台调用跟随前台的配置 | 用户聊天选 `high` → 后台写日记也在疯狂思考，900 token 全烧在推理上、**正文一个字没有**。症状："600 个 chunk / **0 字符**"，无报错。**后台务必 `off`**，见 SPEC §17.6 |
| 让 flush 超时小于任务超时 | `FLUSH_TIMEOUT_MS`(20s) < `JOB_TIMEOUT_MS`(60s) = 每次都在任务跑完前砍掉它。flush 只是"进程要死了"的最后保险，**必须大于任务超时** |
| 拿 stderr 当日志出口 | headless 跑完直接退进程，stderr 缓冲区来不及刷，日志一片空白。要落文件 |
| 往 `persona.md` 自动写东西 | `## 我后来想明白的` 是**人手写**的地方。自动写 = 双真相源，这项目栽过两次（见 SPEC §17.11） |
| 让 AI 直接改 `diary/*.jsonl` | 写盘是**整份重建**，内存副本会静默盖掉外部追加；漏写 `id` 还会让两条日记撞 id。**只能用 `feiyu_note` 工具** |
| 照"动态包"的写法写客户端 | DSH 客户端有**两条加载路径**。我们走「已安装 Client 模块」：`exports["./client"]` + `window.__ModuleLoader__.load`。走错 = 刷新页面就没了。见 SPEC §17.7 |
| 指望客户端插件有自己的 host RPC | 没有。`host.call` 只对动态包开放，Typert Remote 是构建期固定的第一方能力。**面板数据走 HTTP**（`ctx.webServer.register` + 同源 `fetch`） |
| 改 `__ModuleLoader__.load` 的 `id` | **必须等于包名**。两个来源解析到同一个包名会让组合直接失败 |
| 改 `main` 插槽的 `key` 或侧栏的 `id` | 两者**必须一致**（对不上 = 点了没反应）；`id` 还**绝不能复用**别人的（复用 = 顶掉人家的格子） |
| 靠"信息量"判断值不值得记 | 那是**系统的标准**。熟悉感主要来自寒暄、试错、改口这些"低信息量"的东西。门槛 0.15 是刻意留低的 |
| 把 `traits` 写成 key-value 清单 | 那读起来是**宪法不是日记**。每条印象必须带 `evidence`（那个具体瞬间），见 SPEC §17.5 |

## 客户端半边（`src/client/index.js`）

**手写的，没有打包器、没有任何依赖。** 改之前先读 SPEC §17.7，那里写了每条约束的出处。

三条最容易踩的：

1. **不能有 JSX、不能有 ESM `import`** —— 没有构建步骤就没有变换。
2. **只能 `require('react')`**。多 require 一个模块就得写进 `dsh.client.external`，那是额外的风险面。
3. **上色只能用 `--dsw-alias-*` 主题 token**，写死颜色会在浅色/深色切换时翻车。有测试盯着。

改完怎么验：

```bash
node --test test/client.test.mjs     # 15 项，用桩 React 真跑一遍渲染
```

这一组能挡住 id 拼错、slot 名写错、require 越界、渲染崩溃 —— 这些的失效症状都是
"图标不出现"，**没有任何报错指向这里**。但它替代不了真浏览器验证：

```bash
dsh feiyu-web --from-default-profile web --dump-config
dsh plugin --profile feiyu-web add 'link:D:\肥鱼日记'
# 给这个 profile 写 dataDir + debugLog，然后：
dsh --profile feiyu-web --port 19400 --no-open
# 它启动时会打印**带 token 的地址**，用那个地址打开（不带 token 是 401）
```

日志里看到 `面板接口已注册：/feiyu-diary/{state,forget,export}` 才算 host 侧成了。
三件事逐个点一遍：**看**（数据出来没）、**删**（磁盘上少没少）、**带走**（导出的 zip 能不能打开）。

```bash
node tools/preview-memory.mjs                          # 把此刻注入给模型的内容打出来
node tools/preview-memory.mjs <档案目录> --query "模拟这轮用户说了什么"
```

**这个插件平时看不见自己的输出** —— 你只能从模型的反应去猜。
而"读起来像日记还是像用户说明书"这件事，光看代码判断不了，必须把渲染结果打出来看。

另外两个改**用户档案**的工具（都默认只演不写、先备份、幂等）：

```bash
node tools/tidy-archive.mjs      # 整理放错格子的：user→self、去重、挑出假口头禅
node tools/fix-time-words.mjs    # 摘掉老档案正文里的"今天/昨天"
```

**改用户记忆之前一律先跑不带 `--write` 的**，看清要改什么再决定。

## 一个会反复出现的毛病：**归错类**

固化流程倾向把「我该怎么做」记成「他是什么样的人」。实测一次：17 条印象里
有 7 条其实是我的规矩，挤在「我对他的一些印象」里，读起来像我在给他建档。

`consolidate.mjs` 的 rules 7/8 已经加了明确判据（小标题不是口头禅；
**"在说他还是在说我该怎么干"**）。但模型不保证听话 —— 所以
`tools/tidy-archive.mjs` 留着，隔一阵子跑一次。

**别指望提示词一劳永逸。** 数据侧的兜底是必要的。

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
