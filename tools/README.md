# tools/

开发期工具。**不是运行时依赖** —— 插件本身零依赖、零构建。

## `asar-extract.mjs`

从 DSH 的 `app.asar` 里解包出内置插件的真实源码，当接口参考用。

为什么需要它：DSH 的插件 API 没有独立的公开文档，**权威来源就是已安装的运行时本身**。
升级 DSH 之后，本插件依赖的这些接口（`systemPrompt.section` 的入参、
`agent/turn-stopping` 的触发时机、`llm.stream` 的返回形状）都可能变，
那时候需要重新解包核对一遍。

```bash
node tools/asar-extract.mjs stat    "<...>/resources/app.asar" dsh/node_modules/@deepseek-ai
node tools/asar-extract.mjs list    "<...>/resources/app.asar" dsh/node_modules/@deepseek-ai/dsh-system-prompt
node tools/asar-extract.mjs extract "<...>/resources/app.asar" ./.refs/dsh "dsh/node_modules/@deepseek-ai" "libreoffice-kit|documentpack"
```

Windows 上 `app.asar` 在 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\`。

解出来的东西放 `./.refs/`（已 gitignore，不要提交 —— 那是别人的代码，而且很大）。

> 另外值得一提：DSH 内置了一份**官方插件开发规范**，就在解包结果里：
> `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
> 里面有 `SKILL.md` 和 `references/{host-plugin,ui-plugin,practices}.md`，
> 比任何第三方总结都权威。动手改这个插件之前值得先读一遍。

## `check-patch-yaml.mjs`

校验 `cordis.patch.yml` 的结构。

DSH 对 patch 文件的要求是硬的：**顶层必须是 YAML 数组**，
行键只有 8 个（`id` / `name` / `config` / `group` / `disabled` / `inject` / `intercept` / `isolate`）
加上 patch 自己的 `insert`。写错了 loader 会直接抛错、插件根本装不上，
而 YAML 的错误（缩进、`!!js` tag、没加引号的数字变成字符串）肉眼很难看出来。

顺带还会检查 `package.json` 里几个致命项：`prepare` / `postinstall` 脚本
（pnpm 11 会拦住 GitHub 安装），以及 `peerDependencies` 里有没有
`@deepseek-ai/dsh-*`（会触发安装期兼容性硬校验）。

```bash
# 先抽一份 js-yaml（本仓库不把它列为依赖）
node tools/asar-extract.mjs extract "<...>/resources/app.asar" ./.refs/tools node_modules/js-yaml

node tools/check-patch-yaml.mjs
```

## 约定

- `./.refs/` 是解包出来的第三方源码，**永不提交**
- 工具脚本不要写死本机绝对路径 —— 路径从命令行参数或仓库相对位置取
