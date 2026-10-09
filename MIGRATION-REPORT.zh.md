# 侧边对话 → 官方桌面端：可行性结论、污染治理与上游清单

日期：2026-10-09（第三版：加入模型摘要）
桌面端：`G:\Program\Dsh`（Electron 44.0.0，NSIS，nightly 通道），内置 DSH **0.2.0-rc.2**
源码 checkout：`G:\Program\SoftProgram\dsh`（**0.1.3-alpha.2**，分支 `windows-0.1.3`，HEAD `82a5fd6`）

**约束遵守**：`G:\Program\Dsh` **零改动**（`app.asar` 哈希 `983CA711…B23BC2`，所有安装文件时间戳仍为 2026/9/29）；`~/.dsh` 只写了 `profiles/desktop/`。

---

## 〇、三版演进

| 版本 | 上下文来源 | 问题 |
|---|---|---|
| v1 | `session.fork` | fork 归入项目 workspace、复制整段对话（MB 级）、每次提问重发全部历史、一创建就进会话列表 |
| v2 | DOM 读屏上 2 轮正文 | 治好了污染，但摘要只是机械截取，理解语境能力弱 |
| **v3（本版）** | **宿主半用模型写摘要**（失败回落 v2 的摘录） | 语义质量到位；代价是每次侧边对话多一次模型调用 |

### v3 的核心发现：我之前说"插件调不到模型"只对了一半

- **浏览器半**确实调不到 `ctx.llm`（宿主专属服务）—— 所以 v2 只能用 DOM 摘录；
- **但宿主半可以，而且不需要创建任何会话。**

官方 `dsh-session-title-first-prompt-llm` 就是现成范例：`inject: ["sessionTitle","llm","sessions"]`，
然后 `for await (const chunk of ctx.llm.stream(options))`。

我核了 `LlmRuntime.resolveCallConfig`：**`provider` 和 `model` 是仅有的必填项**，
`maxTokens` 会回落到模型默认值，`sessionId` 根本不参与校验（只是记账）。
路由从 `ctx.agentDefaultModel.currentSelection()` 取，正好对上 profile 里的
`provider: deepseek-official` / `model: deepseek-flash`。

**所以摘要可以在不创建会话的前提下由模型生成** —— 这是本轮的关键解锁。

---

## 一、"关闭即删除"为什么做不到（你新增的第三条）

你要的是**删除**而不是归档（"多归档而不删除会导致磁盘空间积累"——这个判断是对的，归档不释放空间）。我把删除这条路查到底了，四层证据：

1. **持久化后端没有删除原语。** `dsh-session-persistence-jsonl` 全包里 `rm(` 只用于写入过程的临时文件（`removeTemporary` / `removeCommittedTemporary`，即 staged-write 清理）；**没有任何 unlink 会话日志的代码路径**。
2. **没有删除的 RPC。** 会话控制器只发 `api-session/removed`，而它只在 `session/disposed` 时触发 —— 那是**进程内**会话销毁通知，不是删除请求。整个服务面上只有 workspace 有 `delete(workspaceId)`。
3. **`session/disposed` 不等于删除。** 那是 store 里的 entry 销毁（`emitDisposed`），对应文件仍在。
4. **插件从运行中的应用里删文件是危险的。** 一个还在内存里的活会话，它的 JSONL 写句柄指向那个文件；删掉目录会让宿主握着一个已消失的文件继续 append。

**结论**：会话删除必须上游。这也是唯一能真正满足你"关闭即删"的地方。

### 在删除 API 到位之前，我给了你一个离线清理器

`clean-side-chat.mjs`（随包发布，也可从 `.build/side-chat/` 直接跑）：

```powershell
# 审计（默认只读）
$env:DSH_SIDE_CHAT_CWD = 'G:\Program\Dsh'
node clean-side-chat.mjs

# 按 id 删除（桌面必须已关闭）
node clean-side-chat.mjs --delete --id <session-id> --yes
```

安全设计：默认只读；**检测到 `DeepSeek Harness.exe` 在运行就直接拒绝**（删活进程的日志会出事）；只删你**显式点名**的 id，且工作区认领的会话一律拒绝；同时清掉对应的 `storages/session_projcache/sessions/<id>.json`。

**它故意不做自动识别，这点必须说清楚。** 我最初写了个按 `cwd` 自动分类的版本，实测**立刻误判**：它把本次对话自己的两个 **subagent** 会话（`228c09bd…`、`794dcd2b…`）标成了侧边会话——因为它们恰好共享同一个 `cwd`。原因是侧边会话与任何"未挂载 Workspace 的会话"在 header 上完全同形：`isSeeded: false`、无 `parentSession`、`cwd` 由宿主选定。所以最终版只给证据（创建时间、体积、cwd 匹配标记），不替你下结论。读表时的可用启发式：

- 侧边会话**很小**，个位数 KB；
- 几百 KB 的绝不是侧边会话；
- 记得先关桌面。

---

## 二、v3 的摘要实现（本轮新增）

### 形态

宿主半在 `lib/index.js` 里注册**一个**路由 `POST /side-chat/summarize`：

| 项目 | 值 |
|---|---|
| `inject` | `webServer`、`llm`、`agentDefaultModel`、`clientModules` —— **刻意不含 `sessions`/`agents`** |
| 路由类型 | `kind: 'exact'` |
| 输入上限 | 默认 24000 码点，硬顶 48000，**超限保留尾部**（对话当前状态在尾部） |
| 输出上限 | `maxTokens: 400` |
| 超时 | 60 秒（`AbortController`） |
| 请求体上限 | 4 MB |
| 调用形状 | 照抄 `dsh-session-title-llm`：`ctx.llm.stream({provider, model, system, messages, maxTokens, purpose, signal})` + `BlockAssembler` |

浏览器半：点击「问一下」时读屏上正文（上限 24000 码点）→ POST 该路由 → 拿到摘要 →
摘要 + 引用 + 问题作为**一条**消息发出；摘要**只随首问**发送。

### 八条失败路径全部回落，面板如实说明

| 失败 | 行为 | 面板显示 |
|---|---|---|
| 宿主半未挂载（404/500） | HTTP 错误 → 摘录 | "a transcript excerpt (no briefing available)" + 原因 |
| 提供商/凭据失败 | `{summary:'', error}` → 摘录 | 同上 |
| `max-tokens` 收尾 | 报为失败 → 摘录 | 同上 |
| 模型要求工具调用 | 报为失败 → 摘录 | 同上 |
| 流中途抛错 | 捕获并记日志 → 摘录 | 同上 |
| 超时 | abort → 摘录 | 同上 |
| 返回空文本 / 全空白 | 报为失败 → 摘录 | 同上 |
| 返回非 JSON | 捕获 → 摘录 | 同上 |

**回落用的摘录**：上限 4000 码点、最多 2 轮；容不下的轮次**整轮丢弃**（含"round 后什么都不剩"这种情况——v3 修掉了一个 v2 遗留的 bug：`renderTurns` 返回空串时"整段放得下"的判断会误判，导致 `contextTurns` 谎报 2 而实际载荷为空）。

### 代价（明确说明）

**每次侧边对话多一次模型调用**：输入由上面的截断封顶，输出 400 token 封顶。
摘要与创建侧边会话**并行**发出，所以等待时间大部分被 create 的往返掩盖。

---

## 三、复核结论（对第一版的修订）

| 你的原始结论 | 复核 |
|---|---|
| 桌面是 0.2.0-rc.2 | ✅ `dsh/desktop-runtime.json` 与各包 manifest 均为 `0.2.0-rc.2`，`sharedPackages` 287 个 |
| 更新走 nightly、整体替换 app 目录 | ✅ `app-update.yml`：`provider: generic`、`channel: nightly` |
| `ui-side-chat`/`Side chat`/`Ask about this`/`closeEphemeral`/`watch(id:` 都不存在 | ✅ 更强：解出 asar 全部 12 967 个文件、提取 297 个 `@deepseek-ai/*` 包（1 063 个 `.js`）全树检索，`closeEphemeral` **0 处**；`ephemeral` 仅 3 处且全不相关；`sessions` 服务只有 `retain/using/retainInfo/refreshProjections/search/fork/scope/binding`，无 `watch` |
| `session.fork` 存在 | ✅ 但 `SessionForkRequest = { sessionId, atSeq? }`，且创建的是**持久化**会话并 attach 到源 workspace |
| 官方更新不动 `~/.dsh` | ✅ |

### 结构性发现：桌面端就是 Web 应用

`dsh-web-app/cordis.patch.yml` 里满是 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` 这类桌面开关。**所以 Web 的浏览器插件机制在桌面上完全适用** —— 这是"更新安全"轨成立的根据。

### 关于 `--dump-config`

我试过用 `dsh --profile desktop --dump-config` 验证组合树，被
`rejectElectronProfile` 拦住：`error: profile "desktop" is managed exclusively by the Electron application`。
只有桌面自己的入口（`dsh-desktop-host/lib/cli.js`，以 `manageDesktopProfile: true` 调 `runCli`）才有这个权限。
所以我改用 `compose-check.mjs` 复刻 `app-boot` 的组合规则来验证（见第五节）。

---

## 四、0.2.0-rc.2 源码：这台机器上没有

checkout 是 `0.1.3-alpha.2`，`git tag --list "*0.2*"` 为空。桌面只发编译产物：asar 里**没有任何 `.d.ts`/`.ts`**（`session-controller` 的 `package.json` 声明了 `"./src/*"` 导出，但那个路径指向不存在的文件）。

移植需要你提供 0.2.0-rc.2 源码，或授权我按 asar 反推接口。**本次没被卡住**：产物保留了完整 JSDoc、`//#region lib/types/fork.js` 这类源码分节标记，本报告所有宿主结论都来自真实产物。

---

## 五、必须上游清单（针对 0.2.0-rc.2）

每条都是插件**在原理上**做不到的，不是"难做"。

### 1. `packages/core/session/src/types.ts` + `src/index.ts`
- `CreateSessionOptions.ephemeral?: boolean`；`Session.ephemeral` 仅作进程内标记，**永不写入 header**（header 校验只认 `origin: 'subagent'`，加字段会破坏格式兼容）。
- **插件做不到**：`SessionHeader` 的字段与校验在 `dsh-session` 内部，插件无法传未被 schema 承认的选项。
- **不上游**：无法区分临时与普通会话，后续判断无依据。

### 2. `packages/core/agent/src/index.ts` + `packages/core/agent-loop/src/index.ts`
- 把 `ephemeral` 透传到 `createStoredSession`，临时会话**直接返回、不取持久化写句柄**。
- **插件做不到**：`createStoredSession` 从 `this.runtime.ctx` 读 `sessionPersistence`，源码注释明确说这个持有者是为了**阻止调用方遮蔽依赖上下文**；`CreateAgentOptions` 也没有任何 ephemeral 字段。
- **不上游**：临时会话照样落盘、照样有 header。

### 3. `packages/session/session-projection-cache/src/index.ts`
- 临时会话不写检查点、不挂定时器。
- **插件做不到**：它的 `static inject = ["storageDomain","sessionProjections","sessions"]` **没有 `sessionPersistence`**，根本不知道会话是否持久化；插件也没有钩子能拦它的写入。
- **不上游**：即便第 2 条改了，`storages/session_projcache/` 仍会留下投影行。

### 4. `packages/api/session-controller/src/{types,commands,index,list}.ts`
- `SessionForkRequest` 增加 `ephemeral?`；`closeEphemeral` 命令；`SessionSummary` 加 `ephemeral` 标记并把临时会话排除在持久化列表之外。
- **插件做不到**：请求 schema 由宿主定义，多传字段被丢弃；`closeEphemeral` 这个 Remote 方法不存在；列表由宿主 `session.list` 决定，插件没有过滤权。
- **不上游**：`fork` 子会话必然挂 workspace 并进列表（就是你看到的现象）。

### 5. 🆕 **会话删除**（你新增的需求，本版新增的上游项）
- **改动**：在会话控制器上加 `session/delete`（或 `closeEphemeral(id, {delete: true})`），由宿主负责：停止/驱逐活会话 → 释放写句柄 → 删除 `$DSH_HOME/sessions/<bucket>/<id>/` → 清理 `storages/session_projcache/sessions/<id>.json` → 从 `workspace.json` 与会话目录里摘除该 id。
- **插件做不到**：见第一节四层证据 —— 没有删除原语、没有删除 RPC、`session/disposed` 不等于删除、且插件在活进程里删文件的句柄会失效。
- **不上游**：侧边会话只能靠离线脚本手工清理，且**用户无法在应用内删掉任何会话** —— 这本身就是 0.2.0-rc.2 的一个能力缺口。

### 6. `packages/api/session-controller/src/client/contract/sessions.ts` + `client/sessions/{service,manager,lineage}.ts`
- `ISessions.watch/unwatch`（`retain` 已够本次实现，故**优先级最低**）；`ephemeral` 标记在客户端 `fork()` / `projectList()` 里透传。
- **插件做不到**：客户端契约与实现都在 app 包内（编译后的 `lib/client.js`），插件只能消费服务，不能改方法集合。

---

## 六、已在桌面端跑起来的插件（轨 1 交付物）

安装位置：`C:\Users\wumas\.dsh\profiles\desktop`（**只动了这里**）

```
profiles/desktop/
  package.json          dependencies: "dsh-side-chat": "file:.../dsh-side-chat-0.1.1.tgz"
                        dsh.profile.bundles: [... "dsh-side-chat"]
  pnpm-lock.yaml        带 integrity 校验和
  node_modules/dsh-side-chat/
    package.json        dsh.client = { platform: "web", inject: [".../dsh-api-session-controller"] }
    cordis.patch.yml    insert 一行，inject: [webServer, clientModules]
    lib/index.js        宿主半（空实现，只为让 client-modules 扫到 dsh.client）
    lib/client.js       浏览器 bundle（手写、无构建步骤、只依赖 react）
    clean-side-chat.mjs 离线清理器
  package.json.bak-* / pnpm-lock.yaml.bak-*   回滚备份
```

### 验证证据（全部可复核）

| # | 验证 | 命令 | 结果 |
|---|---|---|---|
| 1 | 浏览器半离线全绿 | `node .build/side-chat/harness.mjs` | **107/107 PASS**，0 次模型调用。含真实手势（选区→浮出→点击→提问）、detached 保证（从不 fork、无 workspace、无 cwd）、摘要采纳、**7 种失败模式全部回落**、摘录有界规则、面板渲染与如实披露 |
| 2 | 宿主半离线全绿 | `node .build/side-chat/host-harness.mjs` | **33/33 PASS**，LLM 运行时为桩。含请求校验（GET/空文本/非字符串/坏 JSON）、输入截断（默认顶、调用方顶、硬顶、**保留尾部**）、`maxTokens=400`、默认路由取值、`inject` **不含 sessions/agents**、以及 6 类失败全部被容纳 |
| 3 | 扫描器接受该包 | `node .build/side-chat/scan-sim.mjs <已安装目录>` | `ACCEPTED` |
| 4 | 组合树带上了这一行 | `node .build/side-chat/compose-check.mjs <profile> <install>/dsh` | **PASS**：4 层 patch 按 `dsh.profile.bundles` 顺序应用，290 行，`row "dsh-side-chat" inserted` |
| 5 | 宿主半的 import 可解析 | 查 `desktop-runtime.json` | `@deepseek-ai/dsh-llm` 在 287 个 `sharedPackages` 中 **PRESENT**；宿主半只 import 这一个 specifier |
| 6 | 安装 / 升级 / 幂等 / 卸载 | `node .build/side-chat/install.mjs …` | 全部通过；升级路径先 remove 旧 spec，避免 lockfile 同时留两个构建；`--uninstall` 已验证完全还原 |
| 7 | 清理器安全行为 | `node clean-side-chat.mjs` | 默认只读；桌面运行时拒绝删除；工作区认领的 id 拒删；`--dry-run` 不落盘 |

**v3 在离线 harness 里抓到的两个真实缺陷**（都已修）：
1. 浏览器半 `readSelection` 用了 `Node.ELEMENT_NODE` 这个浏览器全局 —— 该全局缺失时直接抛错；已改为比较数值常量。
2. `renderTurns` 返回空串时，"整段放得下"的判断会误判，导致 `contextTurns` 谎报（面板说附了 2 轮、实际载荷为空）。已改为按**实际渲染成功**的轮次计数。

### 还没验证的一件事

**桌面运行时的实际挂载与界面表现，我没验证** —— 你正在用这个桌面应用和我对话，重启会中断本次会话。桌面没有日志文件（输出到终端），`--dump-config` 被 `rejectElectronProfile` 拦住，没有免重启的确认手段。

**请重启后端到端确认**：

1. 选中正文文字 → 浮出「问一下 / Ask about this」；侧栏选中文字**不应**浮出（已限定 `[data-chat-turn]`）。
2. 点它 → 右侧出现「侧边对话」面板，显示「引用」+ 选中片段，以及两行状态：
   - 「随问附上：**a model briefing**」（摘要成功）或「**a transcript excerpt (no briefing available)**」+ 失败原因；
   - 「独立会话：不继承主对话、不归入项目工作区、不占用主会话上下文。」
   摘要生成期间应短暂显示「Summarizing this conversation…」。
3. 提问 → 侧边会话开始回答。**此时才会**在会话列表出现一行（KB 级、不属于你的项目 workspace）。
4. `Esc` 或 `×` 关闭 → 面板消失，本地引用全部释放。
5. 若没出现：把启动终端里有无 `skipping profile bundle "dsh-side-chat"` 之类输出告诉我。
6. 若面板显示摘要失败：原因会直接写在面板上；同时宿主终端应有 `side-chat: summarization failed: …` 一行。

### 回滚

```powershell
# 一键卸载
node G:\Program\Dsh\.build\side-chat\install.mjs `
  C:\Users\wumas\.dsh\profiles\desktop `
  G:\Program\Dsh\.build\dist\dsh-side-chat-0.1.1.tgz --uninstall

# 或从备份精确还原（改前备份路径见安装输出），然后在 profile 目录跑 pnpm install
```

卸载不会删除历史侧边会话（它们是普通会话）——用 `clean-side-chat.mjs` 清理。

---

## 七、给后续插件改动的"更新安全"结论

**能经受 nightly 更新的形态：**

1. profile 层依赖 + `dsh.profile.bundles` 登记（本做法）；
2. 包内自带 `dsh.bundle.patch`，靠 insert 行接入（别手改 profile 的 `cordis.patch.yml` 加行）；
3. 只用公开服务与插槽：`ctx.sessions`（`create/fork/retain/search/…`）、`ctx.slots.register`、`window.__ModuleLoader__` 约定；
4. **浏览器 bundle 手写、不依赖内部包** —— 本次特意不用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`/`MarkdownText`，自己实现迷你版；内部包改名/改导出不波及插件；
5. 注入依赖写进 `dsh.client.inject` 与 patch 的 `inject`；
6. **不要碰 `app.asar`**。

**本次踩到并修掉的一个真实缺陷**：原实现在 `readSelection` 里用了 `Node.ELEMENT_NODE` 这个**浏览器全局**。在浏览器里没问题，但任何该全局缺失的环境都会直接抛错。已改成比较数值常量（`anchor.nodeType === 1`）。这是离线 harness 的价值 —— 它抓到了一个只有真实手势路径才会走到的缺陷。

**一条可复用线索**：`@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里有机器生成的完整目录 —— `SERVICE_API`（1125–1666）、`EVENT_API`（1667–1710）、`TYPE_API`（1712–2270）、完整插槽目录（2270–6210，含每槽 required 字段与示例）。**判断某个扩展点存不存在，查这个文件最快。**

**另一条**：客户端**没有 DOM 选择扩展点**，也**没有读取会话文本的 API**；能读的只有事件流（`binding.eventSource.getSnapshot().entries`）。所以"从选区提问"这类功能必须自己听 `mouseup`/`selectionchange` 并做 DOM 归属校验。

---

## 八、下一步建议

1. **重启桌面**按第五节 5 条验收。
2. 决定轨 2 推进方式：给我 0.2.0-rc.2 源码，或让我按 asar 反推接口重做那 6 处 host 改动。做完后插件侧只需把 `sessions.create({})` 改成 `sessions.create({ ephemeral: true })`、关闭时调 `closeEphemeral(id, { delete: true })` —— **插件改动约 5 行**，面板、有界上下文、fold、生命周期全部已就位。
3. 可选增强（不改 host）：把面板从 fixed 浮层换成真正的右侧栏页签（`ctx.sidebarRightTabs.register({ id, kind, title, priority })` + `sidebar.right.pane.tab` 键控插槽 + `ctx.sidebarRight.openTab(...)`）。注意 `sidebar.right.*` 由 `@deepseek-ai/dsh-client-ui-sidebar-right` 提供，**该包不在 base 里**，需要 graceful fallback。
