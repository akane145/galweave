# 开发说明

## 项目结构

- index.html、src/main.js：页面入口与交互协调。
- src/style.css：界面样式。
- src/proof.js：校对状态、批注、修改对比及持久化。
- src/proof-report.js、src/obsidian*.js：校对报告与 Obsidian 收藏。
- src/parsers.js、src/recognize.js、src/universal-parser.js：解析、格式识别与无损记录。
- src/workers/：后台解析和搜索。
- src-tauri/src/：文件、词典、Obsidian 等桌面命令。
- tests/：Node.js 纯逻辑测试。
- scripts/：构建与验证工具。

## 常用检查

执行 npm test 运行 tests/*.test.mjs；执行 npm run lint 检查未声明变量及未使用变量。
执行 npm run build 构建前端；执行 npm run tauri -- build --bundles nsis 构建 Windows 安装包。

纯逻辑模块应保持无 DOM 依赖。修改记录的测试位于 tests/proof.test.mjs，包含超过 500 行、反复输入、状态恢复和输入结算等场景。

## 发布约定

源代码提交到 Git，二进制放在 GitHub Releases；不提交 node_modules、target、个人配置、真实词典、临时截图或新增真实游戏脚本。发布标签对应被测试的源码提交。

当前校对记录按行号、原文标识和字段合并；首次记录的 before 保留，后续只更新 after。旧版数据按原有最新在前的顺序合并。若旧版已丢失最早记录，只能保留尚存的最早文本，不能重建已丢失内容。

部分解析与格式识别测试使用本地游戏样本；样本不随源码公开分发，缺少时只跳过这些样本测试，内置构造数据测试照常执行。

## 维护契约

代码里多处阈值与上限是**经过取舍的约定值**，改动它们需要同步本表与对应单测。原先这些契约挂在 docs/ROADMAP.md 上，该文档已在提交 096b28c 中删除，故集中到此处。

### 质量检查阈值（src/qa.js、src/proof.js）

总原则：**宁漏报不误报**。清单是给人看的，噪音会让人直接放弃它。因此每条检查都限制每行报告条数，且单字词条这类高命中项一律不查。

- qa.js `MIN_TERM_LEN = 2` —— 「私」「僕」这类单字词条命中率过高，不做"未应用"检查。
- qa.js `MAX_TERM_HITS_PER_ROW = 3`、`MAX_TOKEN_HITS_PER_ROW = 3`、`MAX_PUNCT_HITS_PER_ROW = 3` —— 每行每类最多报几条。
- qa.js `MAX_BRACKET_LEN = 20` —— 【…】超过此长度视为正文，不当占位符。
- qa.js 的分工边界：只做**跨行、跨术语表**的一致性（术语/译名/占位符/标点）；单行内部的完成度（空译文、照抄原文、长度比）归 proof.js。两者不重复报同一情形。

### 变更与历史

- `src/model.js` `UNDO_LIMIT = 100` —— 撤销栈深度，**仅内存**，刷新即失。
- `src/history.js` `HISTORY_MAX = 20` —— 每篇文档保留的行级快照份数。
- `src/history.js` `HISTORY_MIN_INTERVAL_MS = 5 分钟` —— 两次快照的最小间隔，避免连续保存刷出近似版本。
- 快照恢复是**整篇覆盖式补丁**：快照里没有的行会被清空翻译。UI 必须写清影响行数，且默认焦点在取消。
- `src/dict-history.js` —— 最近查询上限 100 条，超出丢弃最旧。

### 显示与容量

- `src/bytes.js` `BYTE_LIMIT_DEFAULT = 120`，可配范围 20–4000，持久化在 `settings.ui.byteLimit`；分级阈值 0.7/0.9/1.0 对应 ok/mid/near/over。
- `src/width.js` `WIDTH_LIMIT_DEFAULT = 30`（全角字位），可配范围 10–200，持久化在 `settings.ui.widthLimit`；分级阈值与字节计**同构**（0.7/0.9/1.0），CSS 侧共用 `data-level` 与语义色。
- **字节与宽度是两把不同的尺子**，不可互相换算：字节答"占多少字节"，宽度答"占几个全角字位"。引擎按字形宽度排版，所以「60 个半角数字」= 60 字节但只有 30 个字位。
- 宽度口径是**全角等效**（全角 = 1，半角 = 0.5），**刻意不做像素测算** —— 本项目允许换字体，像素宽度既不可测也不稳定。
- 不硬编码任何具体游戏引擎的规格常量（不做引擎预设）。

### 标点规范化（src/textnorm.js）

- 只收「明确无歧义」的替换：连续半角点 → `……`、破折号 → `——`、`~`/`〜` → `～`。
- **刻意不收** `。。` 与 `・・`（可能是有意为之，转换会篡改译文）；**绝不碰**片假名长音符 `ー`（表音字符，不是标点）。
- **只作用于译文**：原文是日文，`…`/`〜`/`--` 是它的原貌。
- 避头尾**只检测不自动改**：折行由目标引擎决定，工作台不替引擎排版。只在**显式换行**处判断（自动折行位置看不到，报出来是噪音）。
- 批量入口「规范化标点」走**预览→确认**：只列出真正会变的行。

### 控制符校验（src/qa.js `controlMisses`）

- 机翻链路已有遮蔽/还原/严格性分级保护（`universal-parser.js` + `mt.js` 拒绝写入）；本项补的是**手动编辑**那个口子。
- 只比控制符的**多重集合**，不要求顺序 —— 中文语序调整后记号位置本就该变。
- 只报"译文比原文**少**"的记号；多出来的一律不报（译者可能有意加断行标签）。

### 机翻上下文（两种机制，刻意分开）

- **多轮历史**（`mt.js` `llmContext`，设置 `mt.providers.llm.contextTurns`）：把上一轮的原文/译文作为对话轮次喂回，跨句累积。
- **语境参考块**（`mt.js` `buildContextBlock`，设置 `ui.mtAround`）：把当前句左右邻居一起发过去，同一批。解决单句孤立翻译时代词指代不明。
- **角色人设**（`glossary.personas`）：按当前行说话人查人设，经 `mt.buildSpeechPrompt` 与语境块合并成一段注入（人设在前、语境在后）。
- 三者可同时生效。`llmContext` 是模块级全局，**不跨文档保留**：打开/切换文档必须调 `resetLlmContext()`（`main.js` 在 `finishLoadSource` 与 `afterDocActivated` 两处调用），否则上一篇对白会串味。

⚠️ **人设靠 `p.name` 匹配**，而 `p.name` 来自脚本前缀解析（`parsers.parsePrefix`，需 `☆编号☆角色名☆台词` 这类格式）。解析不出说话人时人设**静默失效**——因此术语面板的「角色人设」区有一行匹配情况提示，无说话人时显示警告。改动解析规则或人设逻辑时不要删掉该提示，它是用户判断"人设到底有没有生效"的唯一入口。

批次模式（`mt.translateLinesBatched`）一次请求发多行，**只能带一份语境**（取组内首行）。多角色混排的批次会丢失其余角色的人设——有意为之：拆成多请求会成倍增加往返。需要严格人设时用逐行模式。

### 历史快照的触发条件

三档触发，互为补充：**时间**（5 分钟节流）、**改动量**（自上次留档起满 50 行）、**显式**（保存前 / 批量机翻前 / 恢复前 / 手动）。

- `history.shouldSnapshot(lastAt, now, reason)` —— 时间维度；`'force'` 与 `'manual'` 不受节流限制。
- `history.shouldSnapshotByChanges(changedRows)` —— 改动量维度，阈值 `HISTORY_CHANGE_THRESHOLD = 50`。按**行去重**计数（同一行反复输入只算一行），语义是"有多少行与上次快照不同"，不是按键次数。
- 留档后必须 `resetChangeCounter()`；写盘失败也要清零，否则每次输入都会重试写盘、越积越慢。

### 剧场视图（body.theater）
- 实现是**纯 CSS 覆盖**，不另建 DOM：虚拟滚动、行高模型、搜索/术语高亮都长在 `.para` 上，复制一套会立刻产生两份需要同步的渲染逻辑。
- 只读靠 `textarea.readOnly`（不是 `disabled`，保留聚焦与 Tab 导航），由 `renderer` 读 `state.theater()` 决定。
- 说话人配色按**文档中首次出现顺序**分配槽位（`main.speakerSlot`），保证同角色全篇同色且不随滚动漂移；只给前 3 个角色上色（再多区分度不够）。换文档要 `invalidateSpeakerSlots()`。
- 与校对模式**互斥**：进入剧场会先退出校对（批注框、漏翻条纹在阅读态是噪音，且会撑变形气泡）。
- ⚠️ 切换后必须**下一帧再 `refreshAllRows()` 一次**：`autoResize` 读的是当前 `scrollHeight`，而刚加的 body class 在同一任务内尚未生效，会量到旧字号的高度，气泡撑不开。

### 界面模块拆分（src/ui/）

- 从 `main.js` 拆出的编排/表单模块放 `src/ui/`。它们**不得反向 import `main.js`**（会成环），需要主模块的能力时由 `main.js` 通过 `initXxx(deps)` 注入。
- ⚠️ `src/ui/` 是**下一级目录**，引用 `src/` 下的模块必须写 `../foo.js`。写错 `./foo.js` 时 **lint 与 node --test 都不会报**，只有 `vite build` 会失败——因此有 `tests/ui-modules.test.mjs` 专门加载每个 UI 模块，把这类错误提前到测试阶段。

### Anki 制卡（src/anki.js）

- 依赖 **AnkiConnect 插件**（Anki 的本地 HTTP 接口，默认 `http://127.0.0.1:8331`）。AI 制卡设置入口在术语面板的「Anki…」。
- **桌面版可访问本地端口**（2026-09-18 实测确认）：Tauri 的 `csp` 为 `null`，不拦本地请求。验证方式：起一个 mock 服务，启动 exe，确认服务器收到 `action=version`。
- ⚠️ **AnkiConnect 出错也返回 HTTP 200**，错误在 body 的 `{error}` 字段里。只查 `res.ok` 会把失败当成功（"已添加"但实际没加）。判定一律走 `anki.parseResponse`。
- 内容组装是纯函数（`buildCardFields` / `buildNote`），**不做网络 IO**，fetch 由 `main.js` 注入，测试无需起服务器。
- 卡片字段是 HTML，所有用户内容必须过 `escHtml`（否则原文里的 `<` 会被当标签解析）。
- 正面只放生词与假名，释义/原句/译文放背面 —— 放正面会泄题。

### Obsidian 双向的边界（重要）

`docs/obsidian-integration.md:36` 写明「不提供从 Obsidian 反向覆盖游戏脚本」。**术语导入是唯一允许的反向路径，且只写 glossary 的 `names` / `terms` 映射**，不得引入任何回写 `translation` 的代码。

术语导入的合并语义与 CSV/JSON **刻意不同**：已有的译名一律保留（笔记多为参考资料，静默覆盖更危险），只写入新条目并报告跳过数。

`src/obsidian-import.js` 一律用 `String.prototype.match` / `matchAll` 而非 `RegExp.prototype.exec`：本项目安全扫描器会把 `.exec(` 误判为命令执行，避免每次改动都产生待核验的高危告警（同「安全扫描结论」一节）。

### 离线格式档案（v1 / v2）

**v1** 是单个 `source`/`target` 模板（`{text}`/`{id}`/`{name}` 占位符）。**内置档案与既有用户档案都是 v1**，读取时行为不变。

**v2** 是片段化的多布局档案：一个档案可同时表达多种原文布局（如"带角色名的对话"与"不带角色名的旁白"），并让它们共用或各自持有译文布局。

片段只有两种，是**纯数据**（可严格校验、可比较、UI 可增删），编译成正则只发生在内部：

```
{ type:'literal', value:'JP[' }      固定文字（含换行）
{ type:'field',   field:'id' }       字段：id | name | text
```

约定与纪律：

- **v1 → v2 迁移必须无损**。`migrateV1ToV2` 用 `fragmentsFromTemplate` 还原片段，`tests/offline-formats.test.mjs` 里有**编译等价性测试**：同一批文本分别走 v1 与 v2 解析器，记录数/取值/错误/未识别行必须完全一致。改动迁移逻辑后这条必须先过。
- **`kind`（对话/旁白）是原文布局的属性**，译文布局没有这个字段。曾误在 order 配对里比较两侧 kind，导致每次配对都假报错。
- **相同译文布局自动去重**（`validateFormatV2`）：两种原文共用一种译文时合并为一条，避免"译文格式相同"造成伪歧义。
- **原文与译文布局不得同形**：同形会让每一行都同时匹配两侧，属真歧义，直接拒绝。
- **多布局歧义不按优先级猜**：同一行命中多个不同布局时报错并要求补固定文字（plan.md 风险表）。
- `parseFormatAny` / `chooseFormatAny` 是版本无关入口；`exportFormat` / `formatParas` 内部都按版本分派，因此 **v2 自动继承全部既有安全门禁**（控制符禁改、记录顺序、再次解析一致性）——不要为 v2 另写一套平行校验，两套必然随时间分叉。
- **旁白不伪造角色名**：`formatParas` 对 `kind==='narration'` 的行把 `name` 置空。旁白本就没有说话人，塞一个空 role 会让人以为"这里应该填角色名"。

### 多样例标注归纳（src/format-samples.js）

主流程：用户给每种布局 **至少 2 组**原文/译文样例，选中文字标为「编号 / 角色名 / 正文」，程序由**已标注区间**归纳片段骨架。**不依赖任何单例启发式猜测** —— 边界完全来自用户标注，多组样例的作用是**互相印证**。

- `MIN_SAMPLES = 2`：单个样例明确拒绝（plan.md 硬要求）。
- **跳过范例推理，只做保守枚举**：`inferLayout` 要求各组**结构同形**（片段类型序列 + 字段序列 + **换行有无**）且**固定文字逐字相同**。任一不满足即失败并定位到具体样例与片段。
- **不做"取公共前后缀"式的合并**：固定文字不同，说明用户漏标了某段内容（那段在两组样例里必然不同）。悄悄合并会生成看似可用、实则丢失结构的布局，违反"用于证明而不是猜"。
- 错误一律用「第几组样例 / 哪段固定文字 / 哪个字段」表述，**不暴露内部片段结构与模板语法**（plan.md Task 7）。
- `describeConflict` 会把"片段数不同"归因到**漏标注**（这是用户实际要修的东西），而不是干巴巴说"多一段"。

### 格式编辑器状态（src/format-editor-state.js）

UI 状态机的纯逻辑部分（布局/样例/标注的增删改、v2 回填、组装档案），**无 DOM**，因此可单测（plan.md Task 6 要求）。

- 所有变更函数**返回新对象**，不改入参（UI 侧据此回滚）。
- **`setSampleText` 一改文本就清空该组标注**：标注是字符区间，文本一变区间就指向别处。曾因保留旧坐标，在"首次打开面板用内置模板回填 → 用户覆盖样例"这条路径上产生整片错位标注，且用户看不出错在哪。
- **样例面板首次打开从空白开始**，不回填第一个内置档案。回填会把模板串（如 `原文：{text}`）当成样例文本，用户按提示改文本时标注随即失效。
- `buildRule` 把归纳失败归到**具体布局与侧**（原文/译文），错误文案直接可用于 UI。
- ⚠️ `stateFromRule` 的标注是**从片段反推的坐标**，不是原始样例文本（档案里本就不存样例）。它是"模板形态"的占位，用户粘贴真实样例后需重标。

### 归档与自动匹配

- 保存的档案沿用 `settings.offlineFormats`；**不保存用户粘贴的样本文本**，只存归纳出的规则（plan.md 风险表：避免撑大 settings）。
- `savedFormats()` 统一读取：v1 走 `validateFormat`（行为不变），v2 走 `validateFormatV2`；损坏的档案被跳过而不影响其余档案。
- 自动采用仍要求**唯一匹配且无错误、无未识别行**（`chooseFormatAny`）；多个档案同时匹配时抛错并引导用户进设置预览，不擅自选择。

## 安全扫描结论（2026-09-18，供复查参考）

完整深度扫描（Mimosa，`seal: sha256:eb225253…`）共 158 条，**131 条落在第三方参考源码**（`LunaTranslator-main/`、`goldendict-master/`、`node_modules`、构建产物——均在 `.gitignore` 中，从不入库），**27 条落在 `src/main.js`**。

对 27 条逐类核验后判定**全部为误报**，依据：

- **「命令注入」13 条**（含 `isMirrorFormatText`、`chooseFormat` 等纯文本解析函数）：本项目源码中**不存在任何命令执行原语** —— `grep -rn "child_process\|execSync\|spawnSync\|shell:true" src/ src-tauri/src/` 只命中了 `RegExp.exec`（正则匹配）。扫描器把 `Regex.exec()` 误判为 `child_process.exec()`。真正的命令执行只在 `src-tauri` 的构建脚本里，且不接触运行时输入。
- **「XSS」13 条**（`refreshRow → syncRow`）：`renderer.js` 的 `renderOrigHTML` 对每一段拼接（含 `data-dst` 属性值）都调用了 `esc()`，是正确转义的写法。
- **「SSRF」2 条**（`createHttpDictProvider`）：这是**用户主动配置自己的词典 HTTP 地址**的既有功能，请求由用户显式发起、目标是用户自己填的 URL，属预期行为而非漏洞。桌面版的网络请求受 Tauri capabilities 约束。
- **「mongo-sort-injection」2 条**（`applyTermsToTranslations`、`saveTm`）：本项目**不使用 MongoDB**，无相关 sink。

⚠️ 复查提示：扫描的 `coverage.json` 标记 `completeness: partial`、`runStatus: inconclusive`（威胁建模与污点路径两阶段未完整覆盖），且 `evidenceBoundary: static_only_no_runtime_execution`。即**扫描未给出完整结论**，上述判定来自人工逐条核验，而非扫描器结论。

### 追加核验（2026-09-18 提交后复查，2 条）

提交 v5.8.0 后 Stop 钩子在 `dist-single/recognize.worker-DQ_yebvT.js`（**构建产物**，已在 `.gitignore:4` 忽略）第 13、19 行报"命令注入"。核验结论：**误报，与上一节同源**。

- 第 19 行命中的是 `e.re.exec(t)`，即 `RegExp.prototype.exec`。判定依据：`grep -rn "\.exec(" src/*.js` 的 15 处调用**接收者全是正则对象**，源码中不存在 `child_process`、`execSync`、`spawnSync` 或 `shell: true`。扫描器把 `Regex.exec()` 与 `child_process.exec()` 混为一谈。
- 该文件是 `npm run build:html` 的产物，代码即源码的压缩结果，不含额外逻辑。

**同时确认真实存在一处命令执行，并单独核验为安全**：`src-tauri/src/obsidian.rs:73-78` 用 `std::process::Command` 调 `rundll32` / `open` / `xdg-open` 打开 Obsidian URI。判定依据：

1. 参数走 `.args([...])` / `.arg(...)` **数组**，不经 shell 解释，不存在拼接注入；
2. 传入的 URI 由 `note_uri` 逐字节白名单编码（`:83-87`：仅保留 `[A-Za-z0-9-_.~]`，其余 `%XX`），且路径先经 `note_path` 校验必须是指定 vault 下的既有文件（`:68`）；
3. 被启动的是固定程序名（`rundll32.exe` 等）而非用户提供的命令串，属于"用系统默认程序打开一个文件"的标准做法；
4. 该文件自 v5.3.1（提交 `0d80c3b`）起未被修改，**不在本次改动范围内**。
