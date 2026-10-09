# HANDOVER — dsh-side-chat（交给 Codex 接手）

面向对象：接手修改这个插件的另一位工程师 / 另一个智能体。
本文件是**唯一权威的现状描述**：改动、已修 bug、未修 bug、硬约束、验证方式。
仓库：https://github.com/AkatsukiIride/dsh-side-chat
本地：`G:\Program\SoftProgram\dsh-side-chat`（分支 `main`，与 origin 同步，工作树干净）

---

## 0. 一句话背景

DSH 官方桌面端（`G:\Program\Dsh`，内置 DSH **0.2.0-rc.2**）没有"侧边临时对话"功能。
本插件把它做出来：选中正文 → 浮出「提问」→ 对话进**侧栏**，不打扰主会话。
原功能在 DSH 源码 checkout（`0.1.3-alpha.2`）里存在，但它依赖的 host API 在 0.2.0-rc.2 **不存在**，
所以这里是一个**行为等价但机制不同**的移植，并且明确记录了差异（见 §4）。

---

## 1. 硬约束（**违反会直接坏事，请先读完再改**）

### 1.1 绝对不要修改 `G:\Program\Dsh`

那是 Electron 安装目录，nightly 更新会**整体替换**，且需要重打 asar。
本插件从不碰它，只用它**读取**自带 pnpm 的位置。任何"临时打个补丁看看"的想法都要放弃。

### 1.2 只允许写 `C:\Users\wumas\.dsh\profiles\desktop`

profile 是官方更新**不动**的地方。允许改的只有：
`package.json`（`dependencies` + `dsh.profile.bundles`）、`pnpm-lock.yaml`、`node_modules/`。
**不要动** `sessions/`、`settings.yaml.imported`、`.credentials.yaml`、`attachments/`、`storages/`。

### 1.3 写文件必须用 UTF-8 忠实的写入器 —— 不要用 PowerShell 的 `Set-Content`

这条是**踩过三次的坑**，不是理论风险。本仓库里有中文和 em dash（`—`）。
`Set-Content` 会按控制台代码页解码 UTF-8，把 em dash **变成乱码**（U+9225 加一个 `?`），**静默损坏文件**。
正确做法：用 `write` / `edit` 工具，或 Node 的 `fs.writeFileSync(p, text, 'utf8')`。
校验：`node scripts/check-encoding.mjs`（18 个文件应全过；本文件**故意不写**那段乱码字面量，否则检查会把它当成真损坏并误报）。

### 1.4 浏览器 bundle **没有构建步骤**，但它被 shell 按元数据缓存

`lib/client.js` 是手写的 UMD 风格文件，由 shell 在运行时加载，格式必须是
`window.__ModuleLoader__.load({ id, factory })`。**不需要、也不应该引入打包器。**

**关键陷阱**：shell 的 `artifactRevision`（`dsh-client-modules/lib/index.js`）哈希的是
**`mtimeMs + ctimeMs + size`，不是文件内容**：

```js
function artifactRevision(baseline) {
  return framedHash("plugin-artifact", [
    String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size),
  ])
}
```

而 pnpm 复制 `file:` 依赖时会**保留源文件时间戳**（实测 source 与 installed 的 mtime/ctime/size 完全相同）。
所以**一次不改变文件大小的编辑，可能不改变缓存键**，重启也看不到变化。

**强制规则：每次改 `lib/client.js` 都提升 `BUILD_MARKER`**（现在 `b8`）。
它渲染在面板标题里，重启后一眼就能确认跑的是哪份代码。这条救过两次命。

### 1.5 样式只能用 `--dsw-alias-*` token，且必须有 fallback

`--dsh-*` 这个名字**不存在**。曾经因为写了 `var(--dsh-surface, #1b1b1b)`，
在浅色主题下渲染出**近黑色卡片**——CSS 对未定义变量静默回退，所以代码评审看不出来。
用 `scripts/check-tokens.mjs` 校验（已接入 `npm test`）。

### 1.6 `file:` 依赖会被**复制**，改源码后必须重装

只改源码 → profile 仍跑旧版。`scripts/install.mjs` 已处理（会先 remove 再 add），
但如果你手工 `pnpm add` 则要注意。

### 1.7 shell 与插件的边界（不要越界）

- 浏览器半**拿不到** `ctx.llm`（宿主专属），**没有** DOM 选区扩展点，**没有**会话列表过滤钩子；
- 宿主半**可以**调用 `ctx.llm.stream()`，但**绝对不要创建 Session**（见 §4.1）；
- 右侧栏的窗口控件（`− □ ×`）是 **shell 自己的**，不是本插件的。

---

## 2. 仓库结构与职责

```
lib/index.js        HOST 半：一条路由 POST /side-chat/summarize（写简报）
lib/client.js       BROWSER 半：启动器 + 侧栏标签页 body（+ 浮层兜底）
cordis.patch.yml    把 host 行插进 profile 的树（inject: webServer/llm/agentDefaultModel/clientModules）
package.json        dsh.client（platform: web）+ dsh.bundle.patch
scripts/install.mjs      安装/升级/卸载 profile 依赖（自动定位桌面 pnpm）
scripts/scan-sim.mjs     复刻 client-modules 的发现规则，校验包能被扫到
scripts/compose-check.mjs 复刻 app-boot 的组合规则，校验行进了组合树
scripts/extract-asar.mjs 从 app.asar 提取文件（Electron 在归档内解析，离线校验需要）
scripts/check-tokens.mjs 校验引用的 CSS token 在设计系统里存在
scripts/clean-side-chat.mjs 离线清理遗留会话（默认只读，桌面运行时拒绝执行）
test/client-harness.mjs  147 项：浏览器半（离线，零模型调用）
test/host-harness.mjs     33 项：宿主半（LLM 运行时为桩）
```

**架构要点**：两个"座位"渲染**同一个** `SideChatPanel` 组件，靠 `props.floating` 区分：
- **首选座位**：shell 自带右侧栏。`sidebarRightTabs.register({id,kind,priority:'extension',title})`
  + 键控插槽 `sidebar.right.pane.tab`（`key: 'side-chat'`）+ `registerCloseHandler`；
  点「提问」时 `sidebarRight.openTab(kind, {revealIfOpened:true})`。
- **兜底座位**：`shell.overlay` 里的固定浮层，用于**没有挂** `ui-sidebar-right` 的树。
  侧栏服务用 `ctx.get()` 查，缺失就降级，不会在 apply 阶段抛错。

---

## 3. 全部改动（以文件为单位）

### 3.1 `lib/client.js`（浏览器半，约 52 KB）

| 改动 | 原因 |
|---|---|
| 用 `sessions.create({})` 建**游离空白会话** | 不用 `fork`：fork 会复制整段对话（MB 级）、`attachSession` 进项目 workspace、且带 seed 所以一创建就进会话列表 |
| 首问携带**有界上下文** | 宿主没有"给我摘要"的 API，浏览器半也调不到模型 → 从屏上 `[data-chat-turn]` 读，上限 4000 码点 / 2 轮，**容不下的轮次整轮丢弃** |
| 首问优先携带**模型简报** | 见 §3.2；失败回落上面的摘录 |
| 面板体抽成 `SideChatPanel`，两个座位共用 | 避免两套界面漂移 |
| 注册右侧栏标签类型 + body + close handler | 浮层占地方、且不参与 frame 布局与 `Ctrl+Alt+B` |
| `props.floating` 区分座位 | 浮层在停靠时让位；侧栏 body 永远渲染 |
| 停靠时**不画自己的标题栏** | shell 的标签页标题已经在上面，再画一次是"第二行标题" |
| 折叠键只在浮层出现 | 侧栏自带 collapse/fullscreen/close |
| 启动器只依赖"有没有选区"，**不依赖面板是否关闭** | 停靠后 `view.open` 恒为真，否则**再也无法对新选区提问** |
| 全部样式改用 `--dsw-alias-*` token | 见 §1.5 |
| 标签文案 `问一下` → `提问`（en: `Ask about this` → `Ask`） | 用户要求 |
| `BUILD_MARKER` 渲染进标题 | 见 §1.4 |
| `vendor`「提问」启动器加 hover | 交互反馈 |
| **不使用** `Node.ELEMENT_NODE` 等浏览器全局，改比数值 `1` | 该全局缺失时直接抛错 |

### 3.2 `lib/index.js`（宿主半，约 7.8 KB）

- 注册 `POST /side-chat/summarize`（`kind: 'exact'`），`inject: ['webServer','llm','agentDefaultModel']`
  ——**刻意不含 `sessions`/`agents`**，因为**绝不能创建 Session**。
- 调用形状照抄官方 `dsh-session-title-llm`：
  `ctx.llm.stream({ provider, model, system, messages, maxTokens, purpose, signal })`
  + `BlockAssembler`，`finish.kind !== 'stop'` 视为失败。
- 路由从 `ctx.agentDefaultModel.currentSelection()` 取（profile 里是 `deepseek-official` / `deepseek-flash`）。
- 输入截断：默认 24000 码点、硬顶 48000、**超限保留尾部**（对话当前状态在尾部）。
- 输出上限 `MAX_OUTPUT_TOKENS`：400 → 800 → **2000**（见 §4.2，仍可能不够）。
- 超时 60s（`AbortController`）、请求体上限 4MB。
- **八条失败路径全部返回 `{summary:'', error}` 而不是崩**：404/500、提供商失败、`max-tokens`、
  工具调用、流中途抛错、超时、空文本、非 JSON。

### 3.3 `scripts/*`、`test/*`、`cordis.patch.yml`、`package.json`

见 §2 表格；`package.json` 另有 `scripts.test` 等入口（`npm test`）。

---

## 4. 未修 / 未实现的问题（**Codex 的主要工作**）

### 4.1 【最重要】侧边会话仍然持久化，且**无法删除**

**现象**：侧边会话虽然不继承上下文、不归 workspace、提问前不进列表，
但**第一次提问后**会作为一个真实会话落盘并出现在会话列表里；关闭面板**不删除**它。

**根因（已核实，不要重新摸索）**：
1. 0.2.0-rc.2 **没有**会话级 `ephemeral`：`CreateSessionOptions` 无此字段；
2. 持久化是**部署级**事实——`dsh-agent-loop/lib/index.js` 的 `createStoredSession` 从
   `this.runtime.ctx`（刻意设计成调用方无法遮蔽）读 `sessionPersistence`，
   只有该服务**全局缺失**时才 `return void 0` 不取写句柄；
3. `dsh-session-projection-cache` 对每个 `session/created`/`turn/end` **无条件**写检查点，
   且它的依赖里根本没有 `sessionPersistence`；
4. **没有删除 API**：`dsh-session-persistence-jsonl` 里 `rm(` 只用于写入过程的临时文件；
   `api-session/removed` 只在 `session/disposed`（进程内销毁）时发；只有 workspace 有 `delete`；
5. **归档不能替代**：`archived-session-gate` 会 `reject` 被归档会话的模型步进 → 侧边对话将无法回答。

**可选做法（有风险，需自己评估）**：
- **A**：在插件宿主半实现删除（删 `$DSH_HOME/sessions/<bucket>/<id>/` +
  `storages/session_projcache/sessions/<id>.json`），**但必须先驱逐内存中的活会话释放 JSONL 写句柄**，
  否则宿主会握着已消失的文件继续 append。**该驱逐入口尚未验证存在**——这是 A 的唯一前置条件。
- **B（推荐）**：上游补 `session/delete`（或 `closeEphemeral(id,{delete:true})`），
  由宿主负责：停/驱逐活会话 → 释放写句柄 → 删目录 → 清 projcache → 从 `workspace.json` 摘除。
- **临时手段**：`scripts/clean-side-chat.mjs`（离线、只读默认、桌面运行时拒绝执行）。
  **注意它故意不做自动识别**：侧边会话与任何"未挂载 Workspace 的会话"在 header 上完全同形
  （`isSeeded:false`、无 `parentSession`、`cwd` 由宿主选定）。早期版本按 `cwd` 自动分类，
  实测**立刻误判**本次对话自己的两个 subagent 会话。所以它只给证据、只删显式点名的 id。

**上游清单全文**（6 项，含每项"为什么插件做不到"）见 `MIGRATION-REPORT.zh.md` §五。

### 4.2 简报仍可能 `max-tokens` 失败

**现象**：面板显示「摘要失败，已改用会话片段：summarization did not finish cleanly: max-tokens」。
**已做**：上限 400 → 800 → **2000**。
**未做（真正解法）**：**分块摘要**——长对话先分段归纳、再归并。
固定的输出上限本身就是错的形状：长对话的简报天然更长，"紧到能控成本"就"紧到会截断"。
**建议**：输入超过某阈值（例如 12k 码点）时走 map-reduce；或改为"先出 200 字要点，再按需追加"的两段式。
失败**不会静默骗人**（面板写明原因并回落摘录），所以这是质量问题、不是功能故障。

### 4.3 `lib/client.js` 单文件 52 KB，需要拆分（可选，但强烈建议）

现在一个文件里同时有：常量、中英文案、样式表、`foldTranscript`、迷你 markdown 渲染器
`AnswerText`、`createStore`、`createController`、DOM 读取、`SideChatPanel`、`SideChatLayer`、
`requestBriefing`、`apply`。
**注意**：拆成多个文件需要自己解决加载方式——shell 只加载 `./client` 这一个 bundle，
**没有构建步骤**。可选：把内部分区注释化（已经是 `// ── xxx ──` 分节），或引入一个极简的自执行拼装脚本。

### 4.4 打磨项（小）

- `AnswerText` 只支持段落 + 围栏代码 + 行内 code，**不支持列表/粗体/链接**（答案里的列表会变成纯文本）。
- 面板宽度硬编码 380px，**不可拖拽**（shell 侧栏本身可拖，浮层不可）。
- 简报与建会话**并行**发出，没有"取消简报"的 UI。
- `SUMMARIZE_TIMEOUT_MS = 70000` 与宿主 `TIMEOUT_MS = 60000` 不一致，有 10s 余量但值得对齐。
- 浮层的 z-index（50/60）是拍的，未验证与 shell 其它浮层（对话框 z1000、菜单 z1100）的关系。

### 4.5 尚未验证的运行时行为

**桌面实际表现只验证过部分**（用户截图确认）：标签页出现、body 渲染、构建标记可见。
**未验证**：折叠行为、关闭 handler 是否真的丢弃对话、多标签/多会话切换、
以及**没有侧栏的树**里兜底浮层是否真的可用（只在 harness 里测过）。

---

## 5. 验证方式（**改完必须全绿**）

```powershell
cd G:\Program\SoftProgram\dsh-side-chat
node test/client-harness.mjs    # 147 项，浏览器半，零模型调用
node test/host-harness.mjs      #  33 项，宿主半，LLM 为桩
node scripts/scan-sim.mjs       # 包能被 client-modules 发现

# 需要桌面 app.asar 的两项（先提取，因为 Electron 在归档内解析）
node scripts/extract-asar.mjs "G:\Program\Dsh\resources\app.asar" .tmp-asar `
  "dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"
node scripts/check-tokens.mjs   # 13/13 token 存在
node scripts/compose-check.mjs "$env:USERPROFILE\.dsh\profiles\desktop" .tmp-asar\dsh

# 安装（会自动定位桌面自带 pnpm；--dry-run 先看计划）
node scripts/install.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop"
```

**改完的固定流程**：
1. 提升 `BUILD_MARKER`；
2. 跑上面全部；
3. `node scripts/install.mjs`（必须重装，`file:` 是复制）；
4. **重启桌面**（profile 只在启动时应用 patch，无 HMR）；
5. 看面板标题里的 marker 是否变成新值——**变了才说明你的代码真的在跑**。

---

## 6. 环境事实（省得重新摸）

- 桌面：Electron 44.0.0，`resources/app.asar` ≈ 115.7 MB，内含 DSH `0.2.0-rc.2`（`dsh/desktop-runtime.json` 列出 287 个 sharedPackages）。
- 启动器：`G:\Program\Dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（Node 24.21.0）
  和 `...\resources\runtime\pnpm\bin\pnpm.cjs`（pnpm 11.7.0）。`install.mjs` 会自己找。
- 更新通道：`resources/app-update.yml` → `provider: generic`、`channel: nightly`。
- profile：`C:\Users\wumas\.dsh\profiles\desktop`，`nodeLinker: hoisted`、`autoInstallPeers: false`。
- 会话存储：`$DSH_HOME/sessions/<cwd-bucket>/<session-id>/session.v4.jsonl.zstd`（header 是首行 JSON）；
  投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`。
- **可复用线索**：`@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里有**机器生成的完整目录**——
  `SERVICE_API`(1125-1666)、`EVENT_API`(1667-1710)、`TYPE_API`(1712-2270)、
  完整插槽目录(2270-6210，含每槽 required 字段与示例)。
  **判断某个扩展点存不存在，查它最快**，比逐个 grep 可靠。

---

## 7. 已修 bug 台账（**这些不要重新引入**）

### 7.1 功能性缺陷（都是真跑出来的）

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 浅色主题下弹出**近黑色卡片** | 用了不存在的 `--dsh-surface`/`--dsh-border`，CSS 静默回退到深色 fallback | 全改 `--dsw-alias-*`，加 `check-tokens.mjs` |
| 2 | 停靠后侧栏标签页**一片空白** | `SideChatPanel` 在 `view.docked` 时 `return null`（为了让浮层让位），但它**同时也是侧栏 body** | 引入 `props.floating` 区分座位；只有浮层让位 |
| 3 | 停靠后**无法对新选区提问** | 启动器渲染条件 `!view.open && offer` —— 停靠后 `view.open` 恒为真 | 只依赖 `offer !== null` |
| 4 | 停靠后**多出第二行标题 + 多余关闭键** | 停靠 body 仍在画自己的 header，而 shell 标签页标题已在上面 | `showHeader = floating`，停靠只渲染内容 |
| 5 | 面板没有折叠/关闭键（浮层时） | 初版只有 `×`，且占 420px | 加 `–`/`□` 折叠 + `×` 关闭；宽度 420→380；停靠时交给 shell |
| 6 | 回落时 `"2 前文轮次"` 谎报 | `renderTurns` 返回空串时"整段放得下"判断误判 | 按**实际渲染成功**的轮次计数 |
| 7 | 摘要一律用整段对话成本 | v1 用 `fork`（继承整段） | 改游离空白会话 + 有界上下文 |
| 8 | `Node.ELEMENT_NODE` 引用浏览器全局 | 该全局缺失时**直接抛错** | 比数值 `1` |
| 9 | `install.mjs` 改源码后不生效 | pnpm 对 `file:` 是**复制**且按 specifier 键 | 重装前先 remove |
| 10 | 样式表里两个属性挤在一行 | `contextNote` 与 `quoteText` 同行 | 分行 |

### 7.2 我（本会话）在重构中**自己制造又修掉**的缺陷 —— 同类错误请避免

| 缺陷 | 教训 |
|---|---|
| 用 `edit` 想"插到函数前面"，结果**把 `SideChatLayer` 的声明整个替换掉了** | 插入时锚点要包含**原有内容**，不要只匹配声明行 |
| 提取 `rowsRef` 时**只删了 `rowNodes`**，留下引用已删变量的滚动 effect（**会崩**） | 删除声明前先找出所有使用点 |
| 用 PowerShell `Set-Content` 改文件，**三次**把 em dash 变成乱码 | 见 §1.3，用 Node/工具写 |
| 用 `new Function(src)` 校验 **ESM** 文件，必然失败 | ESM 用 `node --check` |
| 自定义 brace-matcher 从 `)` 后的第一个 `{` 找起，**切错了块** | 括号匹配要处理数组与对象两种形态，或改用文本锚点 |
| harness 的 `useState` 是空实现 + hook 游标每轮漂移 → **断言在骗自己** | 测试替身必须真的实现状态，否则"全绿"没有意义 |
| harness 用 `this` 指针写 4 次才改对 | **先写一个独立复现脚本**确认缺陷，再改产品代码；不要一次改两处 |
| 花两轮追 `−` 按钮，**结果它是 shell 自己的控件** | 先确认"这个 UI 是谁画的"（一条 grep），再动手 |

---

## 8. 给 Codex 的建议顺序

1. **先跑 §5 全部命令**，确认基线全绿（147/33/token/组合）。
2. **§4.2 分块摘要** —— 收益明确、风险低、与宿主 API 无关，纯宿主半逻辑 + harness 可覆盖。
3. **§4.3 拆分 `lib/client.js`** —— 现在改任何一处都要在 52 KB 里找锚点，是我这次多次改错的直接原因。
4. **§4.5 补齐运行时验证**（折叠、关闭、多会话、无侧栏兜底）。
5. **§4.1 交给上游** —— 阅读 `MIGRATION-REPORT.zh.md` §五，那 6 项要么上游、要么明确接受现状；
   **不要在插件里硬塞删除**，除非先验证内存会话的驱逐入口存在。
6. **§4.4 打磨**按需。

**每次改动都要**：提 `BUILD_MARKER` → 跑全部测试 → 重装 → 重启 → 用 marker 确认新代码在跑。
