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
- 两者可同时生效。`llmContext` 是模块级全局，**不跨文档保留**：打开/切换文档必须调 `resetLlmContext()`（`main.js` 在 `finishLoadSource` 与 `afterDocActivated` 两处调用），否则上一篇对白会串味。

### 界面模块拆分（src/ui/）

- 从 `main.js` 拆出的编排/表单模块放 `src/ui/`。它们**不得反向 import `main.js`**（会成环），需要主模块的能力时由 `main.js` 通过 `initXxx(deps)` 注入。
- ⚠️ `src/ui/` 是**下一级目录**，引用 `src/` 下的模块必须写 `../foo.js`。写错 `./foo.js` 时 **lint 与 node --test 都不会报**，只有 `vite build` 会失败——因此有 `tests/ui-modules.test.mjs` 专门加载每个 UI 模块，把这类错误提前到测试阶段。
