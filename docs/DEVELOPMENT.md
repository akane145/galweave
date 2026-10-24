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

⚠️ **构建前必须清空输出目录**。`vite.config.js` 设了 `emptyOutDir: false`（原因见该文件注释：
WorkBuddy 环境给 node 的 rmSync 套了 safe-delete shim，删除计数超阈值会要求交互确认，
在 tauri 的非交互子进程里直接抛错），清空改由 `scripts/clean-dist.mjs` 负责，且已接进
`npm run build` / `build:no-mt` / `build:html` 三个脚本。

**不要绕过这三个脚本直接跑 `vite build`** —— 输出目录不清空时，上一版带哈希的资源会留在
`dist/` 里**并被原样打进安装包**。实际踩过：`dist/assets` 积了 72 个文件（其中 17 个是历次构建的
`index-*.js`），安装包因此虚增约 600 KB。排查判据：`dist/assets` 里出现多个 `index-*.js`。
`clean-dist.mjs` 清空失败时**只告警不中断打包**（清空是优化，不该阻断发版），但会把剩余文件数说清楚。

纯逻辑模块应保持无 DOM 依赖。修改记录的测试位于 tests/proof.test.mjs，包含超过 500 行、反复输入、状态恢复和输入结算等场景。

## 发布约定

源代码提交到 Git，二进制放在 GitHub Releases；不提交 node_modules、target、个人配置、真实词典、临时截图或新增真实游戏脚本。发布标签对应被测试的源码提交。

发版前需同步四处版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`
（`Cargo.lock` 随构建自动更新）。三处不一致时产物版本会与预期不符。

打包产物放入 `release-vX.Y.Z/`（该目录被 `.gitignore` 的 `release-v*/` 忽略，不入库）：
`Galweave_X.Y.Z_x64-setup.exe`（NSIS 安装包）、`Galweave_X.Y.Z_x64.exe`（直接运行版，
即 `src-tauri/target/release/galweave.exe`）、`SHA256SUMS.txt`（两行的 SHA-256 校验值）。

当前校对记录按行号、原文标识和字段合并；首次记录的 before 保留，后续只更新 after。旧版数据按原有最新在前的顺序合并。若旧版已丢失最早记录，只能保留尚存的最早文本，不能重建已丢失内容。

部分解析与格式识别测试使用本地游戏样本；样本不随源码公开分发，缺少时只跳过这些样本测试，内置构造数据测试照常执行。

## 维护契约

### 自定义标点规则（src/textnorm.js）

- `MAX_CUSTOM_NORM_RULES = 100`；`MAX_CUSTOM_NORM_LENGTH = 200`（匹配和替换各自的 UTF-16 码元数），由 `tests/textnorm.test.mjs` 锁定。空匹配拒绝；空替换表示删除。
- `MAX_NORMALIZED_TEXT_LENGTH = 1000000` 限制单行自定义替换的结果长度；在分配拼接结果前检查，防止链式扩写耗尽内存。这是操作安全上限，不是目标引擎字节上限。
- 内置规则先执行，自定义规则按列表顺序各执行一次，使用 split/join 字面替换，`$&` 没有特殊含义，不支持正则。
- 复用 tokenizeInline 保护控制符；不能匹配/插入控制符或换行，替换后再校验完整受保护序列。
- collectNormalizable 返回完整 translation，应用时不能再包一层引号。提交前检查段落数组和原译文与预览一致。
- 本机设置位于 settings.ui.normRules / customNormRules。记录包携带 normRules（内置选择与自定义列表），导入后只作用于独立记录包项目。

代码里多处阈值与上限是**经过取舍的约定值**，改动它们需要同步本表与对应单测。原先这些契约挂在 docs/ROADMAP.md 上，该文档已在提交 096b28c 中删除，故集中到此处。

UI 视觉与交互规范（Design Tokens、三主题、字阶、热区、焦点环）的权威源是 `docs/ui-design-spec-v4.md` + `src/style.css` 头部 token 块；三主题色对比度由 `tests/contrast.test.mjs` 验证，改色必须过该测试。本表继续管阈值类契约，两处冲突时以本表为准（视觉 token 不属于阈值）。

UI 整改验收（2026-10-13）：不引入基于 CSS 行号或字面量总次数的“卫生阈值”。颜色修改同时检查语义前景配对和浏览器实际计算样式；搜索/侧栏布局在 1280×800 与 960×600 验证。行号状态以 `data-state` 的四态为准，不能用 `.done` 代替已定稿。行间距保留 compact/cozy/loose = 6/12/20px，与 `renderer.js` 的 `ROW_GAP_BY_DENSITY` 同步；行内 padding/border 由现有实际测高处理，改布局后仍须检查滚动和换行。背景图变量与容量阈值不变。复核及脚本入口见 `tasks/ui-polish/review.md`、`todo.md`。

2026-10-14 补充：状态栏 token `--statusbar-h` 按 v4 为 32px，toast 使用它定位于底栏上方；token 必须有可解析的定义。`main.js` 在模式切换时重算主区高度，并用 ResizeObserver 观察顶栏、底栏的 border box，防止搜索换行或字体变化后主区越过窗口底部。

### 质量检查阈值（src/qa.js、src/proof.js）

总原则：**宁漏报不误报**。清单是给人看的，噪音会让人直接放弃它。因此每条检查都限制每行报告条数，且单字词条这类高命中项一律不查。

- qa.js `MIN_TERM_LEN = 2` —— 「私」「僕」这类单字词条命中率过高，不做"未应用"检查。
- qa.js `MAX_TERM_HITS_PER_ROW = 3`、`MAX_TOKEN_HITS_PER_ROW = 3`、`MAX_PUNCT_HITS_PER_ROW = 3` —— 每行每类最多报几条。
- qa.js `MAX_BRACKET_LEN = 20` —— 【…】超过此长度视为正文，不当占位符。
- qa.js 控制符核对**默认关闭**（`analyzeRowQA` 的 `opts.checkControls` 缺省假，开关存 `settings.ui.checkControls`）—— 断行标签本就要重排，默认报是噪音。
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
- ⚠️ **行级提示默认关闭**（`analyzeRowQA(p, entries, { checkControls })`，`opts.checkControls` 缺省为假）。
  理由：断行类标签（`[r]` / `<r>` / 字面量 `\n`）译文本就要按中文长度重新断行，
  把它们当"丢失"逐行报出来多数是噪音；大部分控制符译者本就可以删。
  需要时（目标引擎的**命令类**标签确实不能动）在「主题与字体 → 文本排印」里开启，
  存 `settings.ui.checkControls`，开关变化即时重算已挂载行。
- ⚠️ **`analyzeRowQA` 的判定不能被术语表的有无连带**。曾以 `entries.length` 作总开关，
  导致没有术语表时避头尾/标点/占位符检查全部不跑 —— 它们与术语表无关。
  现在的条件是 `hasGlossary || checkControls`：术语表非空时跑前四类，开启控制符核对时补第五类。

### 机翻上下文（两种机制，刻意分开）

- **多轮历史**（`mt.js` `llmContext`，设置 `mt.providers.llm.contextTurns`）：把上一轮的原文/译文作为对话轮次喂回，跨句累积。
- **语境参考块**（`mt.js` `buildContextBlock`，设置 `ui.mtAround`）：把当前句左右邻居一起发过去，同一批。解决单句孤立翻译时代词指代不明。
- **角色人设**（`glossary.personas`）：按当前行说话人查人设，经 `mt.buildSpeechPrompt` 与语境块合并成一段注入（人设在前、语境在后）。
- 三者在**通用大模型**中可同时生效。`llmContext` 是模块级全局，**不跨文档保留**：打开/切换文档必须调 `resetLlmContext()`（`main.js` 在 `finishLoadSource` 与 `afterDocActivated` 两处调用），否则上一篇对白会串味。
- **Sakura 使用按版本的专用翻译模板与术语表，不注入上述语境参考块或角色人设。** 这类模型可能将状态标记、邻居台词与说明指令一并翻译/复述；不得把通用模型的参考块直接拼入其 user 消息。旧 `/completion` 回退必须由相同版本的 messages 构造 ChatML，避免端点变化时提示词版本丢失。
- Sakura 返回包含应用翻译指令/语境标记、且输入正文中没有对应片段时，按异常响应拒绝返回可写入译文；流式聚合结果同样检查。不得靠删掉指令后的文字或截取第一句猜译文；普通“未翻译”“术语表”等词本身不是拒绝依据。回归见 `tests/mt-sakura.test.mjs`。

⚠️ **人设靠 `p.name` 匹配**，而 `p.name` 来自脚本前缀解析（`parsers.parsePrefix`，需 `☆编号☆角色名☆台词` 这类格式）。解析不出说话人时人设**静默失效**——因此术语面板的「角色人设」区有一行匹配情况提示，无说话人时显示警告。改动解析规则或人设逻辑时不要删掉该提示，它是用户判断"人设到底有没有生效"的唯一入口。

批次模式（`mt.translateLinesBatched`）一次请求发多行，**只能带一份语境**（取组内首行）。多角色混排的批次会丢失其余角色的人设——有意为之：拆成多请求会成倍增加往返。需要严格人设时用逐行模式。

### 历史快照的触发条件

三档触发，互为补充：**时间**（5 分钟节流）、**改动量**（自上次留档起满 50 行）、**显式**（保存前 / 批量机翻前 / 恢复前 / 手动）。

- `history.shouldSnapshot(lastAt, now, reason)` —— 时间维度；`'force'` 与 `'manual'` 不受节流限制。
- `history.shouldSnapshotByChanges(changedRows)` —— 改动量维度，阈值 `HISTORY_CHANGE_THRESHOLD = 50`。按**行去重**计数（同一行反复输入只算一行），语义是"有多少行与上次快照不同"，不是按键次数。
- 留档后必须 `resetChangeCounter()`；写盘失败也要清零，否则每次输入都会重试写盘、越积越慢。

### 量尺寸并写 inline 样式的函数（历史教训）

「剧场视图」已于 2026-09-19 整功能移除（见 `docs/ui-design-spec-v4.md`），本节只保留它留下的通用经验，不再有对应代码。

- ⚠️ **凡是用 `getBoundingClientRect()` 量尺寸、再把结果写进 inline 样式的函数，量到 0 时不得写回**。元素被 `display:none`（或祖先被隐藏）时所有矩形都是 0，据此算出的位移是垃圾值；而 inline 样式写上去就**留在元素上**，显示态恢复后依旧生效。
- 已踩过一次：原文行 `left` 被算成 566px，退出该显示态后原文行整体右推、超出显示边界 388px（v5.6.0 引入，v5.9.0 修复）。修法是入口跳过隐藏态，且量到 0 也不写回。
- 新增同类函数时照此办理；排查判据是"切到隐藏态 → 切回 → 看 `element.style` 有无残留"。
- 另一条同源经验：给 body 加 class 改字号/布局后，同一任务内 `scrollHeight` 仍是旧值，需**下一帧再测一次**（`autoResize` 会量到旧字号的高度）。

### 保存安全（`src-tauri/src/lib.rs` + `src/fileguard.js` + `src/encoding.js`）

三条保护互相补充，缺一条都会留下"成果静默丢失"的口子：**原子写出**、**外部修改检测**、**编码承袭**。

- **原子写出**（`lib.rs` `write_atomic`）：先写同目录临时文件（`.名字.galweave-tmp<pid>`）→ `sync_all` → `fs::rename` 替换。
  同目录是硬要求：`rename` 只在同卷内原子，跨盘会退化成复制+删除。Windows 上走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，可直接替换已存在文件。
  rename 失败时**返回失败并保留原文件，禁止退回直接覆盖**。临时文件使用进程号和时间戳并以 create_new 创建。目录创建或任何写盘步骤失败均返回 Err，包括 settings.json 写入。
- **备份失败必须上报**：`.bak` 只是保险（真正的保护是原子替换 + 历史快照），但失败不能装作成功。
  `WriteResult.backup` 取 `created / exists / skipped / failed`，`failed` 时带 `backupError`，前端用 `fileguard.describeWriteResult` 翻成"原文件已替换但没留下备份，可用历史找回"。
- **外部修改检测**：打开时 `file_stat` 记指纹（size + mtime + FNV-1a 内容散列），写盘前再取一次比对。
  **散列才是判据**，size/mtime 只是快筛 —— 外部编辑器可能保留 mtime，只比时间会漏报覆盖。
  取不到指纹时归为 `UNKNOWN` 且**不阻断保存**（浏览器版没有 file_stat，不能因此天天弹窗）。
  判定为变化时给三个选项，`conflictChoices()` 里 **`SAVE_AS` 永远排第一并获得默认焦点**（"默认不覆盖"是安全属性，改顺序前先看 `tests/fileguard.test.mjs`）。
  第一版**不做自动合并**：脚本有编号、控制符、镜像格式的原文/译文配对，做不彻底的三方合并比不做更危险。
- **编码承袭**：读入编码记在 `model.sourceEncoding`，保存默认沿用它（`encoding.suggestWriteEncoding`）。
  曾经写出固定 UTF-8 —— Shift-JIS 的脚本存回去变 UTF-8，引擎读出来全是乱码而用户以为保存成功。
  `encoding.js` 只管名字/可写性/提示文案，真正的编解码在 Rust（浏览器 `TextEncoder` 只有 UTF-8）。
- ⚠️ **UTF-16 不能走 `encoding_rs` 的 `encode()`**：WHATWG 把 UTF-16LE/BE 的编码器定义为「UTF-8 编码器 + 对应 BOM」，于是 `UTF_16LE.encode("あ")` 得到 `FF FE E3 81 82`（UTF-8 字节顶着 UTF-16 的 BOM，别的程序读是乱码）。必须自己按码元拼，这是本文件唯一手写编码的地方。
- ⚠️ **无法表示的字符默认拒绝写出**：`encoding_rs` 会把它们写成 `&#12345;` 实体，属静默损坏。`encode_text` 用 `had_errors` 报错中止，`allowLossy` 才放行；UI 在报错时给"改用 UTF-8 / 强制写入 / 取消"三个出路。
- `.galweave/` 下的内部数据文件一律 `noBackup`（否则套出 `.galweave/.galweave/*.bak`）；进度/proof 文件仍按后缀豁免。

### 批量机翻任务（`src/mt-task.js` + `src/mt.js` + `src/main.js`）

状态机在 `mt-task.js`（纯逻辑、有单测），`main.js` 只驱动与渲染。三条验收点：

- **停止保留已完成**：`requestStop` 只把 `PENDING` 改标 `STOPPED`，`DONE` 原样保留。停止**不算失败**（不进重试清单）。
  `MtAbortError` 是独立类型（`isMtAbort` 判定）：UI 对"用户停止"要静默保留，"失败"要进清单等重试，混成一种会让按停止报出一片红错。
- **重试只请求失败行**：`retryIndexes` 只取 `FAILED`（不含 `DONE / STOPPED / EDITED`）。重试用同一套状态机，所以"重试里又失败的行"还能再重试。
  `EDITED`（等待期间被人工改过）**不重试** —— 用户已经自己写了，重试等于再覆盖一次。
- **迟到结果不覆盖人工修改**：`createEditTracker` 给每行一个递增版本号，`main.js` 的人工写入路径（`onRowInput`）调用 `mtTaskEdit.bump(i)`；发请求前 `beginRow` 记版本，回来时 `settleStale` 比对，不一致就 `markEdited` 丢弃结果。
  用版本号而不是"译文是否为空"，是为了识别"改了又改回原样"和"用户故意清空"——那都仍属人工介入。
- ⚠️ **超时必须覆盖正文读取**（`mt.js` `openGuardedRequest` / `makeAbortGate`）：计时器以前在 fetch 返回后就清除，`res.json()` 与流式读取再无保护，服务返回响应头后挂住就永远不返回、"停止"也停不掉。
  现在用 `Promise.race` 强制兑现截止时间；**gate 必须排在数组第一位** —— 两边都已 settle 时 race 由数组顺序决定胜负，请求放前面会让"已中止"的请求以正常结果胜出，停止失效。
  `gate.throwIfAborted()` 在发请求前先拦一次（已停止就不必白发请求、白算一轮）。
- 超时默认 `MT_TIMEOUT_DEFAULT = 90 秒`（`normalizeTimeoutMs` 钳到 5–600 秒，存 `mt.providers.*.timeoutMs`）。定 90 秒是因为本地 7B 模型冷启动常需 30–60 秒，太短会把正常冷启动判成失败。

### 翻译记忆的分级与角色变体（`src/tm.js`）

- **审核分级**：条目带 `status`，`draft`（机翻写入，未复核）/ `confirmed`（人工确认）。
  **自动套用只认 `confirmed`**（`findConfirmed`）—— 机翻结果原本无门槛入库并自动扩散到全篇，错就错成一片。
  草稿仍能精确命中供人工挑选（`findExact`），侧栏建议与行菜单都标注来源（`entrySourceLabel`）。
- **确认的两种来源**：`p.src === 'human'`（人工输入/改写机翻）或该行 `pr.status === 'approved'`（通过校对即确认，不必再点一次）。
  `collectFromParas` 按此归因；**已确认条目不会被同句的机翻草稿降级**（人工的确认是定论）。
- 套用记忆（`applyTmToRow`）即视为认可该译法 → 顺手 `confirmEntry` 标为已确认；行菜单另有「确认这条记忆」只标状态不改译文。
- **角色多变体**：条目主键从 `key` 升级为 `key + name`（`entryId` 用 `\u0001` 拼接，避免 ("あ","い") 与 ("あい","") 撞号），同一句不同说话人的译法**共存**而不是互相覆盖。
  查找规则：指定说话人 → 优先该角色；该角色没有 → 退回未标注说话人的**通用**条目；只有别的角色的条目 → 返回 null（可能是别人的语气，交给相似命中当建议）。未指定说话人时只看通用条目，**不拿某个角色的译法顶上**。
- **v1 → v2 迁移**：v1 条目没有 status/name。**v1 一律迁为 `confirmed`** —— 那时入库路径是"人工翻译完成后收割"，与现在的机翻自动入库不同，降级成草稿会让老用户已有的记忆突然不再自动套用。
- `TM_MAX_VARIANTS = 6`：一句口头禅被反复用在不同角色身上时不再无限堆积。
- ⚠️ `normalizeStatus` **只认 `confirmed`，其余一律当草稿**（宁可多让人看一眼，不可当标准答案扩散）。
- ⚠️ `findSimilar` 同分时**已确认优先**排序 —— 用户已在别处确认过的说法更值得先看。

### 跨设备记录包（src/record-pack.js）

给「桌面版 ↔ 浏览器版」一个可搬运的载体：浏览器版的记录全在 IndexedDB，
不随 HTML 文件走，所以需要**显式导出成一个文件**。反过来说，桌面版用同步盘/git
同步 `.galweave/` 已有路径，记录包是补上跨形态那条。

- **白名单序列化，不做排除法**：`createRecordPack` 逐字段显式挑选。排除法会随上游
  加字段而**默认泄漏**新字段；白名单默认不漏。测试直接断言序列化结果里不出现
  API Key 与本机路径。
- **不打包设备配置**：`settings.json`（含机翻 API Key）与词典源（`galweave.db`，存绝对路径）都不进包；
  导入后这些仍在本机各自配置。
- **不打包进度文件**（`*.progress.json`）：包内已有 `rows[].translation`（最终译文），
  两者同携带会出现"该信哪个"的歧义。
- ⚠️ **导入靠逐行比对原文校验，不信任包内行号**：重新解析 `rawText` 后逐行比
  `p.orig === saved.orig`，任一行不符或行数不一致就**整体拒绝**。译文按行号套用，
  套错行等于把一个角色的台词写到别人嘴里 —— 比导入失败严重得多。
- ⚠️ **解析规则只在同步调用内临时生效并 `finally` 还原**（`setParseConf(包内)` → 解析 → 还原）。
  留在全局会让**当前打开的其他文档**也用错规则解析。测试断言失败后 `getParseConf()` 与导入前一致。
- **记录包文档走独立存储命名空间**（`model.setRecordKey('record:<uuid>')`，
  `getStateKey()` 优先返回它）。各模块 IO 层据此分流到 IndexedDB：
  `glossary` 用 `portableKey`、`history`/`stats`/`tm`/`mtbaseline` 用 `isAbsPath`（`record:` 不是绝对路径）、
  `proof` 用 `proofKey`。**这样导入绝不会写用户的真实项目文件或覆写全局术语表。**
- **导入不覆盖当前工作**：先把活动文档 `flushDocToTab` 冻结，再开新标签；重复导入同名包 = 多个独立标签。
- **导入后 `docDirty = true`** 且保存按钮重定向到「导出记录包」（`saveDirect` 开头的 `if (recordContext)`）——
  这种文档没有磁盘路径，"保存原文件"无从谈起。导出成功只在**确认没再改动**时才 `clearDirty`。
- 上限 `RECORD_PACK_MAX_BYTES = 64 MiB`；`JSON.parse` reviver 拒绝 `__proto__` / `constructor` / `prototype`。
- **不做** WebDAV/自动同步、整项目打包、导入时自动合并（两份离线改动的合并需要脚本结构级理解，
  同「保存安全」不做事三方合并的理由）。

### 浮层模块（src/modals.js）

- `showConfirm` 是"做/不做"；`showChoice` 是"怎么做"（保存冲突、编码拒绝这类三选一且没有明显是非的场景）。
- ⚠️ **`showChoice` 按 `c.id` 认选项，没有 `id` 的项被静默过滤**。`fileguard.conflictChoices()` 的返回值直接喂给它，字段名曾写成 `action` —— 结果是**最需要选择的时刻弹出三个按钮一个都没有的空对话框**。`tests/fileguard.test.mjs` 有一条测试专门锁这个字段名。
- `showChoice` 的**默认焦点固定在第一个选项**上；调用方必须把最安全的那个放第一位（`conflictChoices` 把"另存为"排第一）。
- `showMtTaskPanel` 是**常驻浮层而非 toast**：批量机翻可能跑几分钟，用户要随时看到进度、失败行数并能立刻停止；toast 两秒就消失。它每次刷新都从任务对象全量重画，避免两处各记一份进度而说法不一。
- `showMtTaskPanel` 的 Esc **只关面板不停任务** —— 后台继续跑是合理预期，想停就点停止按钮（有明确语义的动作不该藏在 Esc 里）。

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

- **v1 → v2 迁移必须无损**。v1 先由 `fragmentsFromTemplate` 还原片段，再与 v2 共用 `compileFragments` 和同一套全文扫描、配对核心；v1 包装层只保留历史返回形状与错误文案。`tests/offline-formats.test.mjs` 的编译等价性测试要求两种入口的记录数、取值、错误和未识别行完全一致，改动迁移或核心逻辑后这条必须先过。
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

### 日文变形还原（src/deinflect.js）

词典按**辞书形**索引，剧本里却全是活用形。本模块把活用形还原成原形候选，交给词典去命中。

- **核心原则：宁可多生成，让词典去过滤。** 假候选查一次返回空，代价极小；漏掉真活用才是问题。规则表因此可以宽松，但必须有上限。
- 规则表由「五段段对应表」生成（`GODAN_ROWS`），不是逐条手写 —— 九个行 × 四段共 36 条，手写必然出错。
- `MAX_CANDIDATES = 20`。**这个值不能小**：候选按步数升序排，**深层原形必然排在最后**；曾用 8，结果 `食べさせられなかった` 需要的 `食べる`（第 4 步）被浅层噪音挤掉，功能等于失效。
- 展开时已展开集合的键必须是 **`(词, 步数)`**，不能只用词。同一个词可能在不同深度出现，更深的那个可能通向更长链 —— 只按词去重会让 `食べさせられなかった` 在第 1 步就停住，永远到不了 `食べる`。
- `describePath` 给 UI 显示还原链（`食べたくなかった → 食べたい → 食べる`），对译者有参考价值。
- 明确不做：古典/文语活用、方言、形态分析。

### 词典查词的「直接命中」判定（src/dict.js `hasDirectHit`）

**⚠️ 不能用「results 非空」判断查到了没有。** MDX provider 在精确未命中时会返回**前缀补全**（`src/mdx.js:535-544`，最多 6 条），于是「查 食べた 得到 食べすぎる/食べ物…」这种情况 results 非空，但没有一条是 食べた。

`hasDirectHit(results, word)` 要求**词头或读音精确等于查询词**才算命中。变形还原兜底（`main.js` 的 `doDictLookup`）靠它决定是否试原形 —— 用错判定会让兜底永不生效。

兜底的编排要点：

- 只做**兜底**，不做替换：有直接命中时行为与以前完全一致（零回归）。
- 候选**并行查**（`Promise.all`），取序号最小且有直接命中的那个。串行遇上 HTTP 词典（8 秒超时）会变成分钟级等待。
- 命中后在结果列表顶部插一条提示（`.dict-deinflect`），说明"未直接命中 X，已按原形 Y 显示（完整链路）"。

### 词典释义 → 纯文本（src/mdx.js `htmlToPlainText`）

供"一词一件"的用途（Anki 卡片、加入术语表）。MDX 释义是带样式与结构的 HTML，直接塞进 Anki 字段会被当标签解析、塞进术语表会带一堆标记。

- **刻意用正则而非 DOMParser**：本函数要在 `node --test` 里可测（项目硬规则），而 Node 无 DOMParser。代价是不认识嵌套语义，只做"去标签 + 保留文本"，对"取释义文字"足够。
- 处理顺序有意义：先去 `<style>`/`<script>` 整块（否则 CSS 被当释义）→ 块级标签转换行 → **去 `rt`/`rp` 注音**（混进释义会读不通）→ 去标签解实体 → 压平空白。
- `decodeHtmlEntities` 对非法码点原样返回，不产出乱码。

### 词典与外部工具的联动

词典卡片头部的两个按钮（与 ☆ 收藏并排）：

- **🃏 做成 Anki 卡片**：复用 `ankiAddCard(card, label)`；释义经 `dictEntryPlainText` 取纯文本，语境取**当前行**（`currentActiveIdx`），未打开文档时优雅缺省。**不需要改 anki.js** —— 入参形状本就兼容。
- **＋ 加入术语表**：走 `modals.showGlossQuickAdd`，写入 `glossData.terms` 后经 `mutateGloss()` 自动落盘刷新。
  **译名留空不预填**：词典释义是"解释"不是"译名选择"，预填会让人顺手保存，往术语表塞进一句解释 —— 比空着更糟。
- 按 master 决定，**不提供"把释义插入译文"**。

### 词典格式文档

`docs/dictionary-plugins.md` 是 JSON / HTTP / MDX 三种词典源的格式说明，被界面三处引用（`index.html` 的词典源页与 HTTP 配置弹窗、`main.js` 的解析失败提示）。**改词典格式时必须同步更新它** —— 在此之前这个文档不存在，界面一直在指向一个不存在的文件。

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

### 编辑导航与连续校对

- `src/editor-navigation.js` 是无 DOM 的按键决策、选区裁剪、队列筛选和双向导航逻辑。IME (`isComposing` / 229) 不触发切行；修饰键 Enter 留给全局动作。
- `renderer.captureEditorPosition` / `restoreEditorPosition` 使用会话内选区及虚拟列表的顶部行锚点；由标签快照持有，不存入脚本和进度文件。全文重建时清空旧文档选区，恢复时再注入。
- 校对队列复用 `missingIssues()` 的 proof/qa 结果，不定义新检查阈值。人工通过不隐式关闭批注或忽略自动检查；暂留不改变状态。
- 手动输入在内容确实变化时撤销旧通过状态；通过并继续前先 `settleInput`，防止延迟结算把刚通过的状态再次降级。
- 底栏 Tab 提示（`#statusTabHint`）由 `renderer` 的 `onSuggestChange` 回调驱动：建议浮层可见时显示「采纳」，隐藏后回到「下一行」。新增建议显示/隐藏路径时必须走 `renderSuggest` / `hideSuggest`，不要直接改 `sgPop.style.display`，否则提示会残留。

### 全部替换（预览 → 勾选 → 应用）

- **预览、字段边界与提交清单都在 `src/replace-apply.js`**（纯逻辑、有单测），`main.js` 只做编排。测试必须调用这些生产函数，**不要在测试里复制一份提交逻辑** —— 曾经因为测试自写 `applySelected`，漏掉了 R1（只勾名字却把译文写回预览时的旧值）。
- **预览与应用共用同一份规则来源**：`search-remote.replaceAllInParasDeltas` 的返回值。预览展示它，应用直接消费它 —— 不要为预览另写一份扫描逻辑（两套规则必然分叉）。
- ⚠️ **只提交本次替换的目标字段**（`replaceTargetField`：`name` → `nameTr`，其余 → `translation`）。deltas 两个字段都带预览时的值，未替换的那个可能在预览期间被机翻/人工更新过，回写它会丢数据。原值核对也只核对目标字段。
- ⚠️ **归因（`p.src`）同样按字段边界处理**（`commitReplaceEntries`）：只有**译文**被替换时才记 `human`；只改译名**不动**译文来源 —— 否则未复核的机翻草稿会在保存收割时变成 confirmed 并自动扩散（R3）。相应地 `mtTaskEdit.bump` 也只在改译文时推进（逐行译名输入本就不推进）。
- 撤销快照由 `pushUndo` 在写入前捕获**两个字段与 `src`**（`model.rowSnapshot`），因此一次 Ctrl+Z 能回到提交前一刻的真实状态（文本与归因一致）。`applyDeltas` 对缺 `src` 的老快照保持兼容：不写归因。
- ⚠️ **不得用 `workers-client.searchReplaceAll()` 做预览**：`search.worker.js` 处理该消息时会**同步改写自己的 shadow**，取消预览会留下与主线程不一致的 Worker 状态（幽灵匹配）。预览一律走非破坏计算。
- deltas 的 `count` 是该行命中次数（逐行「替换 N 处」）；同值替换（before === after）不算真正改变，既不进预览也不产生撤销项。
- 预览行携带只读上下文：行号、脚本编号（`p.id`）与原句（`p.content`）。只读展示，不写回、不改解析规则。
- 应用前核对：文档身份（`getStateKey`）、段落数组引用、查找/替换参数、所选行的目标字段原值。核对与写入之间**不放异步等待**。任一项不符整体拒绝，不覆盖新输入。
- 只把选中行压入**一次** `model.pushUndo`；写入走人工修改同一套 bookkeeping（`p.src='human'`、`demoteApproved`、`mtTaskEdit.bump`、`noteRowChanged`、`markDirty`、`refreshProofUI`、强制全量同步搜索影子）。
- `search-remote.js` 的空查找串必须防护（`q === ''` 与 `replaceAllText` 的 `find === ''`）：`i = j + find.length` 在空匹配下原地不动，会死循环。`search.js` 早有防护，remote 版曾缺。

### 模态浮层的键盘隔离（R2）

- 全局 keydown（`main.js`）在开头判定 `.modal-mask.show`；显示期间，非"模态内可编辑控件"的全局命令键（`shortcut-guard.isGlobalCommandKey`：Ctrl+S/F/G/Z/Y、F2/F3、Ctrl+Enter）只 `preventDefault`，不派发。
- 模态内输入框保留浏览器原生行为（含控件自己的 Ctrl+Z 文本撤销），Tab/Shift+Tab 焦点循环、Esc、确认键不受影响；校对快捷键录制仍在隔离分支之前。
- ⚠️ **新增"能触达文档级动作"的浮层时，必须具备同样的隔离或与模态互斥**。命令面板 `palette.openPalette()` 已按此在模态期间拒绝打开 —— 它盖在模态之上会绕过隔离并把焦点带出对话框。
- 关闭模态后无需显式恢复：隔离分支只在有 `.modal-mask.show` 时成立。
