# dsh-quote

> 一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web 插件：把引用变成**输入框上方的多张引用卡片**，发送时再合并成带出处的引用块。
>
> A DSH Web plugin that collects quotes as **cards above the composer** and sends them as one attributed blockquote.

## 为什么重写

原来的引用插件把整段原文以 `> …` 直接塞进输入框：引用一多，输入框就被原文淹没，删起来也费劲。`dsh-quote` 把「选什么」和「写什么」分开：

- 引用时只往输入框上方加一张小卡片，不动你正在写的草稿；
- 可以连续引用多段，逐条预览、逐条删除；
- 真正发送时，才把卡片和草稿合并成一条带发言人/时间的引用消息。

## 特性

- 🗂 **多段引用卡片**：最多同时收集 8 段，卡片显示来源（助手 / 选中文字）、时间和摘要，可单条移除或一键清空；
- 💬 **整条回复引用**：悬停任意 AI 回复，操作行里的「引用」按钮把整条回复加入卡片；
- ✂️ **划词引用**：在对话区域内选中任意文字（包括你自己发的消息），松开鼠标后点选区旁的「引用」按钮；
- ✍️ **草稿零污染**：引用不再预填进输入框；输入框里始终只有你自己写的内容；
- 🚀 **发送时合并**：按 Enter / 点发送时，自动把卡片合并为引用块，然后正常提交（附件、队列等行为仍走官方输入状态机）；
- 🌏 中英双语文案，跟随 dsh 语言设置；
- 🎨 使用 dsh 主题 token，自动适配明暗主题。

## 交互

1. 悬停一条 AI 回复 → 点操作行的「引用」；或选中一段文字 → 点选区旁浮出的「引用」；
2. 输入框上方出现引用卡片，可继续引用更多段；
3. 在输入框写下你的回复；
4. 按 Enter 或点发送 → 发出的消息形如：

```markdown
> **引用 · 助手 · 14:22**
> 原来的那段话……

> **引用 · 选中文字**
> 另一段被选中的话……

我的回复。
```

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:ZenithJoyH/dsh-quote
```

桌面端 profile 使用：

```bash
dsh plugin --profile desktop add github:ZenithJoyH/dsh-quote
```

安装后重启 `dsh web` / 桌面端（或刷新页面）。

### 手动安装（本机）

1. 把本仓库复制到 dsh profile 的 `node_modules` 下，例如：

   ```bash
   cp -R dsh-quote "$DSH_HOME/profiles/desktop/node_modules/dsh-quote"
   ```

2. 在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 `insert:` 列表中加入：

   ```yaml
   - insert:
       - id: quote-dock
         name: "dsh-quote"
   ```

   如果之前装过旧的 `dsh-quote-reply`，把对应条目删掉，避免两个引用按钮同时出现。

3. 重启 `dsh web` / 桌面端，刷新页面。

### 卸载

```bash
dsh plugin --profile web remove dsh-quote
```

或手动删除 `cordis.patch.yml` 中的 `dsh-quote` 条目和 `node_modules/dsh-quote` 目录，重启即可。

## 兼容性与权限

- 目标版本：DeepSeek Harness 0.2.x；
- 平台：Web / 桌面端（client 插件，`platform: web`）；
- 权限：仅使用客户端槽位、locale 与输入状态机；不发起网络请求、不读取文件、不执行命令；
- 数据：引用卡片只保存在当前页面内存中，不上传任何内容；
- 分类：会话与消息（Session & Messages）。


## 实现说明

- 以 dsh client 包（`dsh.client`，`platform: web`）形式提供，挂载两个官方槽位：
  - `conversation.input.dock`：输入框上方的引用卡片；
  - `conversation.chat.assistant-actions`：AI 回复操作行的「引用」按钮。
- 引用内容存放在按 session 隔离的内存 store 中；卡片通过 `useSyncExternalStore` 订阅。
- 发送拦截只做两件事：识别「有引用 + 输入框非空 + 输入状态为 plain」时的 Enter / 发送按钮，然后 `inputActions.setDraft(合并结果)` + `inputActions.submit()`；其余情况完全放行。
- 划词按钮监听 `mouseup` / `selectionchange`，只响应聊天区域内的选区。

### 已知限制

- 合并发送使用 `setDraft` 重写草稿，因此草稿里如果已经有 `@文件` 之类的富文本引用 chip，会被替换为纯文本；纯文字草稿和附件不受影响。
- 只引用文本块，不引用图片 / 工具调用卡片。
- 卡片状态只保存在当前页面内，刷新后清空。

## 开发

无构建步骤，`lib/client.js` 是手写的 dsh client-bundle 格式。Node 冒烟测试（无需浏览器）：

```bash
node test/client.smoke.cjs
```

测试覆盖引用合并、去重、上限、卡片增删、发送路径和槽位注册。

## 致谢

- 引用图标取自 [Lucide](https://lucide.dev) 的 `quote`（ISC 许可）；
- 插件挂载方式参考 dsh 官方 `dsh-client-ui-conversation` 与 `dsh-client-ui-message-feedback`。

## License

MIT
