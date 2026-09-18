# Galweave for VS Code —— 规划

> 状态：P0 进行中。本文件是这份扩展的规划基线与决策记录，实现推进时同步更新。

## 1. 形态定位

**不做表格，不做 Webview。** 这是一个 VS Code 原生编辑器内的辅助扩展，不是把 exe 搬进来。

用户在原生编辑器里直接编辑脚本文件，扩展只做三件事：

1. **识别** —— 按用户配置的前缀/后缀，把每一行判成原文/译文/注释，把每一段判成人名/对话/旁白。
2. **呈现** —— 用 VS Code 原生能力（装饰器、hover、大纲、折叠、诊断）把识别结果视觉化。
3. **不越界** —— 任何写入操作只落在译文行，原文行永远只读。

这样定位的收益：原计划里最重的两块（Webview 构建 + 21 个 Tauri 命令平替，约 16 人日）整体消失，且用户能继续用 VS Code 原生的撤销、查找替换、多光标、Vim 键位、git diff。

## 2. 已确认的决策

| 决策 | 内容 |
|---|---|
| 界面形态 | 只用原生编辑器，不做表格、不做 Webview |
| 标记来源 | 由用户**手动添加前缀、后缀**（对应 `parseConf.open/close/regex`） |
| 识别产出 | 人名 / 对话 / 旁白 三类 + 原文/译文行角色 |
| 旁白判定 | **正文不带「」即旁白**；带「」即对话 |
| 空说话人 | `☆0002☆☆正文` 与无说话人段 `☆TEXT\|0☆正文` **都归入旁白** |
| 机器翻译 | **不做**（`mt.js` 不接入） |
| 词典 | JSON/HTTP 先行；MDX/MDD 走 napi-rs 可选，优先级低 |

## 3. 识别规则

### 3.1 行角色（`ROLE`）

| 角色 | 判定 |
|---|---|
| `blank` | `line.trim() === ''` |
| `comment` | 行首命中 `commentPrefixes`（默认 `#`、`;`、`//`、`%`） |
| `orig` | 空行切段后，段内第一个非注释行 |
| `trans` | 段内第二个非注释行 |
| `other` | 段内第三个及以后（现有 `parseFile` 会丢弃这些行，本扩展不丢） |

### 3.2 段落类型（`KIND`）

| 类型 | 判定 | 例子 |
|---|---|---|
| `name` | `isNameRowId(id)` 命中 `nameIdPatterns` | `☆NAME\|11☆李四` |
| `dialogue` | 原文正文**含** `「` 或 `」` | `☆000007☆藍☆「おはよう」` |
| `narration` | 其余（正文不含 `「`） | `☆000001☆俺はキッチンに立ち…` |

**「对话/旁白」用「含」判断，不是「首尾包裹」判断。** 这两条规则在真实数据上结果不同，实测 258 段里有 2 段判定相反：

```
☆000010☆直哉☆「そうか？　喜んでもらえて幸いだ。冷めないうちに食べてくれ。
```

这行显然是对话，但它以 `「` 开头却没有收尾括号 —— 按首尾包裹会误判成旁白，按含判断则正确判成对话。

**「锁定括号」（`isBracketed`）是另一个判断，不能与分类混用。** 它看整段首尾是否完整包裹 `「」`（与 `src/parsers.js:205` 同源），用途是把括号外置到译文输入框之外；分类则用 `hasQuote`。两者在 `lineparse.js` 中是两个独立导出的函数，且都在段落对象上保留（`brackets` 字段供桌面版口径对齐，`kind` 字段供分类）。

**「对话/旁白」只看原文正文，与有没有说话人段无关。** 这是与旧引擎的差异点 —— 旧引擎按说话人段有无来区分，新规则下 `☆0002☆☆「心声」`（空说话人 + 带括号）判成 `dialogue`，而 `☆0002☆☆雨が降る。` 判成 `narration`。

### 3.3 前缀拆解

前缀形如 `☆0007☆藍☆`，被标记字符切成若干段，段序即语义：

```
☆  0007  ☆  藍  ☆
↑          ↑        ↑
段0(编号)   段1(说话人)  正文从这里开始
```

- 只有 1 段（`☆000001☆正文`）→ 无说话人段，`speakerRange = null`
- 有 2 段但第 2 段为空（`☆0002☆☆正文`）→ `speakerRange` 为零宽区间

拆段逻辑与 `src/parsers.js` 的 `segsOf` 同源（同样是"标记字符按单字符字符类处理"的语义），保证与桌面版段数一致。

## 4. 架构与代码复用

扩展自包含于本目录，**识别规则一律复用 `src/parsers.js`，不另写一套**：

| 复用的导出 | 用途 |
|---|---|
| `parsePrefix` | 行 → `{prefix, content, id, name}` |
| `isNameRowId` | 判定 NAME 条目 |
| `computeDone` | "是否已翻译"的**唯一口径**（与桌面版同源，避免口径分裂） |
| `getParseConf` | 读取当前解析配置 |
| `isBracketed`（本扩展） | 与 `parsers.js:205` 的 `brackets` 同源 |

`src/parsers.js` 是纯逻辑、无 DOM 依赖，可直接被本扩展 import。

**不改动 `src/` 下任何文件** —— 现有应用与其 545 个单测不受影响。

### 4.1 与 `parseFile` 的分工

`parseFile`（`src/parsers.js:319`）是**行号无损之外**的解析：它按空行切块、剥离注释行挂在 `p.comments`、只取段内前两行，返回段落数组但**丢失行号**。VS Code 的装饰器、hover、诊断全部需要原文件的行号与列区间，所以本扩展新增 `parseLines`：

- 保留每行的 `index` 与角色
- 保留每段的行号数组与列区间（`contentRange` / `speakerRange` / `idRange`）
- 段落对象是 `makePara` 的**超集**（字段名对齐），可直接喂给 `buildExport` / `exporter.js` / `qa.js`
- `done` 由 `computeDone` 回填，口径与桌面版一致

两者的**段落数与 `done` 一致性由单测交叉验证**（对 `test text/` 下全部真实样本）。

### 4.2 列区间的三条计算路径（`rangesOf`）

标记字符扫描只能推出"前缀内部按标记切的段"，推不出用户自定义正则的结构（例如说话人在正文 `[[ ]]` 里）。所以按可用性分三条路径，结果记录在段落的 `rangeSource` 字段：

| `rangeSource` | 条件 | 区间来源 |
|---|---|---|
| `regex-named` | 自定义正则 + 命名捕获组 | 正则的 `d` 标志读 `m.indices`，最精确 |
| `regex-legacy` | 自定义正则 + 旧约定（2 组） | 前缀取 group1（段在其内按标记切并偏移），正文取 group2 |
| `auto` | 无自定义正则 | 标记字符扫描切段，正文取行尾 |

`regex-named` 依赖正则的 `d` 标志（`m.indices`），Node 16+ / 现代 Chromium 均支持，项目要求 Node ≥ 20。

### 4.3 每文档独立规则（已解决，见 §5.3）

`src/parsers.js` 的配置是模块级可变状态（`setParseConf` / 模块级正则缓存），同一时刻只有一份生效。而一个工作区里常常混着多种标记体系：实测 `test text/` 的 13 个样本里 11 个用 `☆`/`★`，2 个用 `○`/`●` + `[[名字]]`。

解法分三层：

1. **`parseLines(text, { conf })` 开出口子**。`parseLines` 全程同步（没有任何 `await`），所以"就地灌入配置 → 同步解析完"之间不可能被别的调用插进来，一次解析用的必然是一套规则。代价是调用方必须**始终显式传 conf**，不能依赖"当前生效配置"这种隐式状态。
2. **规则库 + 自动选择**（`src/rules.js`，纯逻辑）。维护一个规则库，对每个文档算"哪条规则最能解释它"。
3. **指纹缓存**。选规则要对每条规则各解析一遍，所以用廉价的"标记指纹"（逐行 `includes` 计数）判断要不要重选；未命中任何规则时**不缓存**，否则新建的空文件会永远停在"未识别"。

评分是三项字典序比较：**能解释的行数 → 取出的说话人数 → 取出的编号数**。

`marked` 的判据是**正文比原行短**，不是"前缀非空" —— 用命名捕获组的规则没有位置捕获组，`parsePrefix` 返回的 `prefix` 是空串，但它确实解释了这一行。这个判据对任何形态的规则都成立。

## 5. 阶段计划

| 阶段 | 内容 | 人日 | 状态 |
|---|---|---|---|
| **P0** | 行保真解析器 + 字符偏移 + 单测（对真实样本交叉验证） | 2–3 | ✅ **已完成**，见 §5.1 |
| **P0.5** | 扩展骨架：能按 F5 跑起来、两个命令、三类语义着色、状态栏、规则文件 | 1–1.5 | ✅ **已完成**，见 §5.2 |
| **P1** | 每文档独立规则：规则库 + 自动选择 + 指纹缓存 | 2 | ✅ **已完成**，见 §5.3 |
| **P1** | hover 原文⇄译文对照 + 段落折叠 + 按说话人的大纲 | 2–3 | ✅ **已完成**，见 §5.4 |
| **P2** | 诊断：结构校验 + 原文基线比对 + 术语一致性（复用 `qa.js`） | 2 | ✅ **已完成**，见 §5.4 |
| **P3** | 命令与 CodeAction：复制原文到译文 / 补译文行 / 跳转 / 清空 | 3 | ✅ **已完成**，见 §5.4 |
| **P4** | 术语 hover（`glossary.js`）+ 导出（`exporter.js`） | 2 | ✅ **已完成**，见 §5.4 |
| **P5** | 词典：**只做 MDX**（js-mdict 在 Node 下直接可用，不需要 shims）；MDD / JSON / HTTP 未做 | 2 | ✅ **已完成**（MDX），见 §5.7 |
| **P6** | 打包：内联共享逻辑，出可安装 VSIX | 2–3 | ✅ **已完成**，见 §5.5 |
| **P7** | 逐行导航（Enter/Tab/Shift+Tab）+ 原文锁定就地阻止 + 基线自动记录 | 2 | ✅ **已完成**，见 §5.6 |
| **P8** | 译文行前后缀锁定 + 换行居中 + MDX 词典 | 2 | ✅ **已完成**，见 §5.7 |
| **P9** | 镜像格式（dc4ph）：`//` 原文行 + 普通译文行，与规则库分流 | 1–1.5 | ✅ **已完成**，见 §5.8 |
| **P10** | 文件编码：Shift-JIS / EUC-JP 检测、乱码提醒与一键改 VS Code 编码、导出写回编码 | 2 | ✅ **已完成**，见 §5.9 |

主线 **P0–P10 已完成**，产物是可安装的 VSIX。词典只做了 MDX（按需求确认），MDD/JSON/HTTP 未接。

### 5.1 P0 完成情况与实测数据

**交付物**

| 文件 | 说明 |
|---|---|
| `src/lineparse.js` | 行保真解析器（`parseLines` / `paraAtLine` / `isBracketed` / `hasQuote`），约 300 行 |
| `tests/lineparse.test.mjs` | 30 个用例，含对 13 个真实样本的交叉验证 |
| `scripts/inspect.mjs` | 用真实文件检查识别结果的 CLI（调规则时用，不必启动 VS Code） |
| `rules/circle-inline-speaker.json` | `○/● + [[名字]]` 格式的规则样例 |

**验收结果**：`npm test` → 30 项全过。

**与桌面版引擎的一致性**：13 个真实样本（258 段）逐段比对 `parseLines` 与 `parseFile` —— 段落数、`orig`、`id`、`name`、人名行判定、`translation`、`nameTr`、`brackets`、`done` 全部一致。

**识别分布（默认 ☆/★ 规则，258 段）**：对话 121、旁白 109、人名 28；行角色里注释行 11、段内多余行 0。

**自定义正则路径实测**：`test text/新建 文本文档 (13).txt` 是 `○/●` + `[[名字]]` + `[np]`/`[r]` 标签的引擎格式，默认 ☆/★ 规则下全部段落被判成旁白（标记匹配不到，整行当正文）。套用 `rules/circle-inline-speaker.json` 后：

```
段落 20   人名 0   对话 19   旁白 1   已翻译 20   未翻译 0
说话人 5 位：照 久遠 静流 こなつ 成
区间来源：regex-named
```

结论：**"手动配前缀/后缀 + 自定义正则"这条路能覆盖真实文件**，不需要为每种引擎写专门的解析器。`规则` 是可交付给用户的配置文件。

### 5.2 P0.5：扩展骨架（已可运行）

**交付物**

| 文件 | 说明 |
|---|---|
| `extension.cjs` | 扩展入口：两个命令、三类装饰器、状态栏、规则文件载入 |
| `.vscode/launch.json` | F5 开发宿主配置 |
| `.vscode/tasks.json` | 把 `inspect.mjs` 配成任务，作用于当前打开的文件 |
| `README.md` | 使用说明（怎么跑、命令、设置、规则文件、限制） |
| `tests/extension.test.mjs` | 13 个集成测试（用 mock 的 `vscode` 模块真正激活扩展） |

**入口为什么用 CommonJS + 动态 `import()`**：扩展宿主对 ESM 入口的支持随 VS Code 版本而异，而「CJS 入口 + 动态 import ESM」在 1.85 到当前的所有版本上都成立。所以 `extension.cjs` 是 CJS，纯逻辑模块（ESM）在 `activate()` 里动态载入。

**验收结果**：扩展单测 43 项全过（30 项解析器 + 13 项集成），连跑三次无竞态。集成测试覆盖：命令注册、三类装饰器落到正确行号、未翻译标记、普通代码文件不误伤、着色开关、`autoHighlight=false`、规则文件切换（在真实文件上验证 `regex-named` 与 5 位说话人）、规则文件读不到时不崩。

**集成测试抓出的一个真实缺陷**：`onDidChangeActiveTextEditor` 的处理器原本写成 `() => { refreshActiveEditor(); }`，**没有返回 promise**，事件回调里的异步工作成了游离 promise —— 既无法等待也无法捕获失败。改用隐式返回后测试才稳定（前三轮是靠微任务顺序侥幸通过，属于竞态）。

**打包阻塞（P6 的前置）**：识别逻辑在扩展目录之外（`../src/parsers.js`、`../src/universal-parser.js`），VSIX 无法包含包外文件，所以现阶段**只能按 F5 跑，不能打包安装**。P6 要先加一步内联（esbuild 之类）把共享逻辑打进扩展包。这也是当初决定"不改 `src/`、只复用"的代价，换取的是现有应用与其 540 个单测不受影响。

### 5.3 P1：每文档独立规则（已完成）

**交付物**

| 文件 | 说明 |
|---|---|
| `src/rules.js` | 规则库：归一化、校验、评分、自动选择、指纹（纯逻辑，约 160 行） |
| `tests/rules.test.mjs` | 25 个用例 |
| `rules/circle-inline-speaker.json` | 补充 `id`/`label`，成为规则库的一员 |

**规则库**（开箱三条，无需配置）：

| id | 适用格式 |
|---|---|
| `default-star` | 标准 `☆`/`★` + 空行分段，说话人在前缀段 |
| `star-bracket-speaker` | `☆`/`★`，说话人在正文 `【名】` 或 `[[名]]` |
| `circle-inline-speaker` | `○`/`●` + `[[名]]` + `[np]`/`[r]` 标签 |

**验收结果**：扩展单测 73 项全过（30 解析 + 25 规则 + 18 集成）。

核心验收用例「同一会话内 ☆/★ 与 ○/● 两个文档各用各的规则，无需任何设置」通过：文档 A 选中 `default-star`、文档 B 选中 `circle-inline-speaker`，切回 A 仍是 `default-star`（规则跟着文档走，不被前一个文档污染）。

真实样本上的实测（`新建 文本文档 (13).txt`，○/● 格式，零配置）：

```
规则：○/● + [[名字]]（自动选择）
评分：命中 20 行 · 说话人 19 · 编号 20
段落 20   人名 0   对话 19   旁白 1   已翻译 20   未翻译 0
说话人 5 位：照 久遠 静流 こなつ 成
```

**本轮抓出的两个真实缺陷**（都由测试暴露）：

1. **坏正则会静默回退**。`src/parsers.js` 的 `getPrefixRe()` 在正则编译失败时静默退回自动生成的正则，坏规则会"看起来能跑"却实际用了另一套规则。规则库因此在 `validateRule` 里显式编译校验，并区分"缺失字段填默认"与"非法值原样保留交给校验拒绝"—— 若把 `open:""` 悄悄换成 `☆`，用户永远不知道自己写错了。
2. **强制规则不匹配时仍会着色**。对话/旁白按"正文是否含「」"判定，与前缀匹不匹配无关，所以一条完全不匹配的规则照样能产出一堆"段落"。自动选择路径由 `pickRule` 的 `marked>0` 兜住，强制路径没有 —— 现加 `ruleExplains()` 双重检查，`inspect` 里也会显式告警（避免拿"整行当正文"的假数据糊弄人）。

`scripts/inspect.mjs` 同步改为走同一套规则库（`--list-rules` / `--rule <id>` / `--config`），保证终端调好的规则与编辑器里结果一致。

### 5.4 P1 剩余 + P2 + P3 + P4（已完成）

**交付物**

| 文件 | 说明 |
|---|---|
| `vscode/core.cjs` | 状态与解析缓存、规则库、术语表、基线。所有 vscode 层模块的唯一状态源 |
| `vscode/decorations.cjs` | 三类语义着色 + 未翻译标记 |
| `vscode/providers.cjs` | hover / 折叠 / 大纲 / 诊断四类 provider |
| `vscode/commands.cjs` | 10 个命令 + CodeAction |
| `src/validate.js` | 结构校验 + 原文基线比对（26 用例） |
| `src/glossary-file.js` | 术语表文件解析与归一 |
| `src/export-text.js` | 导出收尾 + 往返自检 |
| `tests/helpers/mock-vscode.mjs` | 共用 vscode mock（假文档可变，`applyEdit` 真改文本） |
| `tests/roundtrip.test.mjs` | 导出保真（10 用例） |

`extension.cjs` 缩为只做装配的入口。

**验收结果**：扩展测试 124 项全过，连跑四次无竞态；仓库根 540 项单测仍全过。

**这一轮抓出的真问题**（都由测试或真实样本暴露）：

1. **`buildExport` 总是补一个结尾换行**（`parsers.js:401` 的 `lines.join(nl) + nl`），所以末尾无换行的文件回写后会多出一个 —— 桌面版一直如此。扩展侧用 `endsWithNewline` + `restoreTrailingNewline` 抹平，不改共享代码。

2. **`buildExport` 的模块级配置陷阱**。`buildStarPrefix` 读的是 `src/parsers.js` 的 `parseConf.close`，不显式对齐时导出结果取决于"最后一次解析的是哪个文件" —— 打开文件 B 之后导出文件 A，就会拿 B 的标记字符写 A 的译文行。`exportOriginalFormat` 因此要求显式传 conf，并配了专门的回归用例。

3. **`lineparse` 的 `comments` 曾是对象数组**，而 `buildExport` 里是 `lines.push(...p.comments)` —— 会把 `[object Object]` 写进导出文件。改成字符串数组（`makePara` 口径）。

4. **译文行编号系统性偏移是引擎约定，不是错误**。实测 `新建 文本文档 (11).txt` 全部 33 对都是 `★ = ☆ + 1`。原实现会刷 33 条假警报；且**进制不能假定**（按十六进制读会让 `000009→000010` 算成 +7）。改为：两种进制各算一遍取众数、至少 3 对才承认约定、只报不合群的行。真实样本上现在 **0 条 error 级发现**。

**P5 词典未做的原因**：JSON/HTTP 词典本身不到 1 人日，但桌面版的词典体验主要在 MDX/MDD（`mdict.rs` 805 行 + napi-rs 原生模块 + 平台专用 VSIX）。只接 JSON/HTTP 会给出一个"词典功能基本没用"的半成品，不如整体留到下一步按需决策。

### 5.5 P6 打包（已完成）

**做法**：不上打包器，而是把用得到的共享纯逻辑**拷进来并改写导入路径**（`'../../src/` → `'../shared/`）。依赖闭包由 `collectShared()` 自动走依赖图收集，不手工维护清单 —— 第一版手工列 5 个文件，漏了 `universal-parser.js → recognize.js` 这条边，打包产物一激活就 `ERR_MODULE_NOT_FOUND`。

**产物**：`dist/galweave-vscode-0.2.0.vsix`（21 个文件，83.75 KB）。

**验证**（`tests/package.test.mjs`，8 项）：dist 目录结构、无指向包外的导入、**在 dist 里真激活扩展**、自带规则从包内载入、**识别真实样本的结果与源码路径逐字段一致**、○/● 规则在 dist 下生效、诊断与编辑命令端到端闭环。

"在 dist 里真激活"这条是关键 —— 导入路径改写对不对，只有真跑一次才能证明。

### 5.6 P7：逐行导航与原文锁定（v0.3.0）

**背景**：v0.2.0 漏掉了 Galweave 的核心交互 —— `Enter`/`Tab` 逐行推进；"锁定"也只做成了事后检测。
这一版补齐。

**交付物**

| 文件 | 说明 |
|---|---|
| `src/nav.js` | 导航落点计算（纯逻辑，18 用例）：段落定位、上下段落点、选区是否碰到原文行 |
| `vscode/cursor.cjs` | 上下文键（isScript / onOrigLine / onTransLine / origSelected / locked）+ 行状态状态栏 |
| `package.json` | 17 条 keybindings：3 条导航 + 10 条输入拦截 + 4 条原有命令 |

**关键设计**

1. **落点是译文行，且「」包裹时停在收尾括号之前** —— 复刻桌面版的"每行都有输入框"和"锁定括号"。
2. **目标段落没有译文行时自动补一条**（`galweave.autoInsertTransLine`）——
   否则"下一行"会落到一个被锁住的原文行上，形成死路。
3. **导航键只在 `galweave.isScript` 时接管**，且排除 `inSnippetMode` / `suggestWidgetVisible`，
   不破坏代码片段展开与补全。
4. **锁定靠接管输入命令**，配 `galweave.lockOriginal` 开关与「开关原文锁定」命令做逃生口。
5. **基线改为自动记录**（`galweave.autoBaseline`），让第二层防线默认就生效。

**验收**：162 项测试全过，连跑三次无竞态；打包产物同样验证了导航与锁定可用。

**这一轮抓出的问题**：

- 测试 mock 漏清 `vscode/cursor.cjs` 的 require 缓存 —— 它缓存后继续持有**上一个 mock** 的 `vscode` 实例，
  于是 `setContext` 与状态栏都写到上一个测试身上。改成动态清空整个 `vscode/` 目录。
- mock 的假 Selection 少了 `start`/`end`/`isEmpty`，与 VS Code 真实对象不符，读它们的代码会炸。

### 5.7 P8：译文行锁定、换行居中、MDX 词典（v0.4.0）

**三项需求**：译文行的前后缀也锁、换行时把目标行滚到视口正中、只支持 MDX 词典。

**交付物**

| 文件 | 说明 |
|---|---|
| `src/nav.js` | 新增 `transEditRange` / `lockedZoneAt` / `blockStateAt` / `blockStateForSelection` / `selectionTouchesLocked` |
| `src/dicttext.js` | 词条 HTML 清洗（纯正则，不用 DOMParser）+ 光标处日语取词候选 |
| `vscode/dict.cjs` | MDX 载入与查询；结果开在只读虚拟文档标签页 |
| `package.json` | 19 条 keybindings、右键菜单、`mdxPaths` / `centerOnNavigate` 设置 |

**关键设计**

1. **锁定按操作分别判定边界**。只看"位置在不在可编辑区内"会放过两种破坏：光标停在正文起点时退格吃掉 `「`、停在终点时删除吃掉 `」`。所以 `editBlocked` / `blockBackspace` / `blockDelete` 是三个独立的上下文键。
2. **词条清洗自己写**，不复用 `src/mdx.js` 的 `sanitizeMdxHtml` —— 那个走 DOMParser，在扩展宿主里 DOMParser 不存在，它会**原样返回输入**，等于没洗。
3. **词典结果用只读虚拟文档**（`TextDocumentContentProvider`）而不是 Webview：保持"只用原生界面"的形态，反复查询复用同一个标签。
4. **MDD 不做**：词条内嵌资源需要一整套水化，按需求确认跳过。

**验收**：204 项测试全过；VSIX 101 → 240 KB（多了 js-mdict 及其传递依赖）。

**这一轮抓出的问题（都是"只验中间产物"导致的漏检）**

1. **VSIX 里没有 js-mdict**。`.vscodeignore` 里写着排除 `node_modules`，而我的打包测试只验了 `dist/` —— 目录完整、测试全绿，但 vsce 过滤之后的 VSIX 少了词典引擎，装上去功能直接失效。修法是加一条测试：**把 `.vscodeignore` 的 glob 规则套到文件清单上核对运行时必需文件是否幸存**（含 `**/` 匹配零级目录这条容易写错的语义）。
2. **`dict.cjs` 在模块顶层调用 `vscode.Uri.parse`**，mock 里没有这个方法，require 时整个扩展就炸。改成惰性构造，顺带给 mock 补齐 `Uri.parse` / `EventEmitter` / `registerTextDocumentContentProvider`。
3. **mock 的 `getText()` 不支持传范围**，返回整篇（含换行），于是"读取选中文本"的代码拿到全篇、走了错误分支。补上区间重载。
4. **mock 把 `registerTextDocumentContentProvider` 加到了 `languages` 下**，真实 API 在 `workspace` 上。

### 5.8 P9：镜像格式 dc4ph（v0.5.0）

**背景**：`test text/dc4ph/` 下 5 个真实样本、1946 段此前是"打开也认不出来"——
文件里没有 ☆/★ 标记，规则库三条规则能解释的行数全为 0，`pickRule` 返回 null，`getParsed` 直接判成"不是脚本"。
桌面版早就支持这个格式（`src/parsers.js:264` 的 `MIRROR_RAW_LINE_RE` + `parseMirrorFile`），扩展没接。

**交付物**

| 文件 | 说明 |
|---|---|
| `src/lineparse.js` | `parseMirrorLines`（行保真镜像解析）、`isMirrorDoc`（探测）、`mirrorPlainLineOf`（补行用）；`finalize()` 让标准路径与镜像路径共用收尾字段 |
| `vscode/core.cjs` | 解析前分流：镜像文件不查规则库，`result.rule` 用人造的 `mirror-dc4ph`（下游读 label/conf 的地方不用改） |
| `vscode/commands.cjs` | 「补上译文行」按镜像格式补出普通行；「检查识别结果」的标记行改报镜像结构 |
| `vscode/providers.cjs` | hover 把"预填原文"说成未翻译，而不是显示一段假译文 |
| `scripts/inspect.mjs` | 与扩展同一条分流，终端看到的与编辑器一致 |

**关键设计**

1. **收尾字段抽成 `finalize()`**（`nl`/`trailingBlank`/`endsWithNewline`/`summary`）——
   标准路径与镜像路径各算一遍就是等着分叉，而"导出无损还原"全靠它们。
2. **`done` 不另立口径**：镜像行未翻译时译文行预填原文，`computeDone` 已按 `isPlaceholderTrans` 处理
   （parsers.js:167），扩展直接复用 —— 1946 段全判为未翻译，与桌面版一致。
3. **探测复用 `isMirrorFormatText`**（universal-parser.js:409），不另写一套结构判定。
4. **不做说话人归属**：dc4ph 里"正文就是一个名字"的行是换说话人的约定，但桌面版 `makeMirrorPara`
   也把 `name` 留空 —— 猜错比不猜更坏，这里同样不猜。
5. **命中镜像格式就不查规则库**，连带绕开"按指纹重选规则"那条慢路径（文档每次变化都要重跑一遍）。

**与桌面版的两处有意差异（都有测试锁定）**

1. **译文正文原样存**：`makeMirrorPara` 会在"原文带「」而译文不带"时替译文补上 `「」`，
   而补出来的括号源文件里没有 —— `buildExport` 写回后往返自检必然失败，等于把这个文件挡在导出之外。
   扩展保存原样，`brackets`（锁定括号）判定不变。
2. **尾部截断按"原文行 + 缺译文行"处理**：导出中断的文件最后一条缺普通行时，桌面版把整行当正文；
   扩展识别成缺译文行的段落，「补上译文行」能补出 `★◎  002  ◎★おやすみ` 这样格式正确的一行，
   而不是写出引擎读不出来的 ☆/★ 前缀。

**验收（全部通过）**

- 5 个真实样本、1946 段与 `parseFile` 的 `orig`/`id`/`content`/`translation`/`brackets`/`done` 与
  `mirror.plainPrefix`/`plainBody`/`indent` **逐字段一致**
- 5 个样本经 `buildExport` 重建后与原文件**逐字节相同**（原格式导出那道关卡能过）
- 结构校验在 5 个样本上 **0 条发现**（预填原文不刷噪音），QA 四类检查同样为 0
- 行角色：#0x → 注释行、`//` 行 → 原文行、普通行 → 译文行，段内多余行 0
- 锁定与导航在镜像行上照常生效（前缀锁住、正文可编辑；Enter 落到下一段译文行）

**这一轮抓出的问题**

- **`finalize()` 之前是两份实现**：镜像路径若各算一遍 `trailingBlank`，两个字段迟早分叉，
  而它们正好是"导出无损"的判据 —— 干脆抽成一处。

### 5.9 P10：文件编码（Shift-JIS / EUC-JP）（v0.6.0）

**背景**：扩展此前把一切按 UTF-8 读。日语脚本里有相当一部分是老引擎导出的 Shift-JIS / EUC-JP，
在 VS Code 里就是成片乱码 —— 规则匹配不上、着色与导航全失效，用户还不知道为什么。
桌面版在读的时候就做了编码检测（`src-tauri/src/lib.rs:63`，encoding_rs 逐字节试解），扩展没接。

VS Code 侧有个硬约束：**没有编码 API**（`microsoft/vscode#8242`）。TextDocument 是按 `files.encoding`
解出来的字符串，扩展改不了它。所以这一版按"能做的做满、不能做的说清楚"分三层：

| 层次 | 能力 | 落点 |
|---|---|---|
| 判定 | 从**磁盘字节**判编码（UTF-8 / BOM、UTF-16、Shift-JIS、EUC-JP、ISO-2022-JP），拿不准返回 unknown | `src/encoding.js` |
| 读 | 打开文件时判定；不是 UTF-8 且当前显示像乱码 → 提示一次，给「设为工作区默认编码 / 打开编码选择器 / 忽略」 | `vscode/encoding.cjs` |
| 写 | 导出按源文件编码写回字节（可选）；编不出来的字符**拒绝写盘**并给「以 UTF-8 导出」 | `vscode/commands.cjs` |
| 终端 | `inspect.mjs` 按检测结果解码，Shift-JIS 脚本在终端也能调规则 | `scripts/inspect.mjs` |

**关键设计**

1. **不能"试解一下，成功就是它"**。`TextDecoder` 对任意字节几乎都能给出字符串，而 A1-DF 在 Shift-JIS 里是合法半角片假名 ——
   一份 EUC-JP 文件用 Shift-JIS 解也"成功"。所以判定分两步：先用**字节结构**筛候选（ASCII / SJIS 引导+尾字节 / EUC 双三字节），
   候选冲突时再用**解出来的文本像不像日语**（`scoreJapanese`：半角片假名汤与替换字符都扣分）裁决。
2. **反向表用宿主的解码器反推**，不手抄 JIS 映射表：扫一遍候选字节序列，让 `TextDecoder` 自己交代"哪些字节是这个字"。
   于是"能解的都能编回去"，也不会与宿主分叉。CP932 下 SJIS 表 7389 字、EUC-JP 表 13175 字（含 JIS X 0212 补字面），
   建表 25–35ms，按编码缓存一次。
3. **拿不准就什么都不做**：unknown / 置信度 low 时不提醒、不按猜测重写文件。结构统计与打分都摊在「检查文件编码」的输出面板里。
4. **写回编码默认关**（`galweave.exportEncoding` 默认 `utf8`）。依据是实测：`test text/` 13 个样本的中文译文
   **全部**含有 JIS X 0208 表示不了的汉字（每个 27–72 个，如「这、们、发、咖、啡」）。默认与桌面版一致写 UTF-8；
   引擎只吃原编码时把设置改成 `source`，那时编不出来的字会被拒绝并给一次改 UTF-8 的机会（绝不写问号顶替）。
5. **提醒前先看当前显示**：`scoreJapanese` 判当前文档文本是否正常 —— 用户已经把 `files.encoding` 调对时不打扰，
   状态栏仍标出编码（桌面版文件栏也是这么标的）。
6. **`files.encoding` 的取值写死成表并注明出处**（`shiftjis` / `eucjp` / `utf8bom` …），从本机 VS Code 的编码注册表核对过；
   ISO-2022-JP 不在该注册表里 → 只提示、不写设置。

**验收（全部通过）**

- 纯逻辑 20 项：BOM / ASCII / 无 BOM UTF-16 / ISO-2022-JP / 严格 UTF-8 校验 / SJIS 与 EUC 的结构歧义 / 打分方向 /
  反向表候选字节数 / 往返一致 / 不可映射字符要报出来
- 集成 9 项：乱码只提醒一次、一键写 `files.encoding=shiftjis`、「已经调对就不打扰」、EUC-JP 识别、
  导出逐字节还原（SJIS 与 EUC 各一遍）、默认 UTF-8、不可映射拒绝写盘、改 UTF-8 回落、检查命令输出
- 真实样本端到端：把 dc4ph 真实样本（150 段 / 13056 字符）编成 Shift-JIS 后，检测 `shift-jis`（high）→ 识别 150 段
  → 导出 21510 字节**与源文件逐字节相同**；显示正常时 0 次提醒
- 终端：`inspect.mjs` 读同一个 Shift-JIS 文件，规则、说话人、段落计数与编辑器一致

**这一轮抓出的问题**

1. **打包漏文件**：新增 `src/encoding.js` / `vscode/encoding.cjs` 后 dist 里 `ERR_MODULE_NOT_FOUND` ——
   打包脚本用的是**手工清单**。已改成扫目录，并加了一条"dist 的 `src/`、`vscode/` 文件集合必须与源码一致"的回归测试。
   （与 §5.5 里 `collectShared()` 的教训同源，这次轮到扩展自己的模块。）
2. **"违规定义按绝对数"放过垃圾输入**：8 字节的二进制碎片只有 5 个违规，旧阈值（绝对 >8）会把它认成 EUC-JP。
   改成按比例（>5%）并给大文件留 64 个违规的余量。
3. **无 BOM 的 UTF-16 被当成 ASCII**：NUL 检测原先排在"纯 ASCII"之后，而 UTF-16 的 ASCII 文本满屏 NUL。
   顺序纠正，并给"含 NUL 却不像 UTF-16"的字节直接判 unknown。

## 6. 明确砍掉的项

| 砍掉的 | 原因 |
|---|---|
| Webview 表格、虚拟滚动接线 | 用户决策：只用原生界面 |
| 21 个 Tauri 命令平替（`read_file`/`write_file`/对话框/`.bak` 等） | 原生编辑器下文件读写由 VS Code 承担 |
| 拖拽导入、关窗拦截重设计 | 无对等物，且无表格后不需要 |
| 机器翻译（`mt.js` 接入） | 用户决策：不需要 |
| 多文档标签页（`tabdock.js`） | VS Code 编辑器 tab 已提供 |
| 命令面板（`palette.js` 自绘浮层） | VS Code 原生命令面板已提供 |
| 三主题/背景图（`theme.js`） | 与宿主主题体系冲突，改为跟随 VS Code 主题 |
| 自定义字体导入（`fonts.js` / `fontloader.js`） | 编辑器字体由 VS Code 设置管理 |

## 7. 关于"原文锁定"（v0.3.0 已按"就地阻止"重做）

VS Code **没有行级只读 API**（官方 feature request `microsoft/vscode#88885` 自 2020 年至今仍在 Backlog；Monaco 侧 `monaco-editor#953` 自 2016 年未实现）。且官方确认 `WorkspaceEdit` 可以写入只读文档 —— **"只读"不是安全边界**。

### 7.1 三层落实

1. **就地阻止（第一层）** —— `vscode/cursor.cjs` 把"光标在原文行上""选区覆盖到原文行"写成上下文键
   `galweave.onOrigLine` / `galweave.origSelected`，keybindings 据此把
   `type`（键盘输入）、粘贴、剪切、删除、删除行、回车（选区碰到原文行时）绑到空命令 `galweave.blockEdit` 上。
   键落不到文档里 —— 这是 VSCodeVim 一类扩展的通行做法，因为 VS Code 既没有行级只读 API
   （`microsoft/vscode#88885` 至今 Backlog）也没有 pre-edit veto。
2. **基线比对（第二层）** —— 首次识别到脚本时自动记一次原文行（`galweave.autoBaseline`），
   之后任何改动经 `validate.diffBaseline` 报进问题面板。这一层兜住第一层拦不住的路径。
3. **原生可回退（第三层）** —— VS Code 自带撤销与 git diff。

**明确拦不住的**：拖拽文本、其他扩展写入、`WorkspaceEdit`。这三条靠第二层报出来。

`diffBaseline` 的一个设计要点：先按行号对齐找差异，再用"内容是否仍在基线里"过滤 —— 只按行号比的话，
段中插入一行会把后面全部报成改动，噪音大到没人会看。测试里对这个场景有专门用例。

### 7.2 与桌面版的差异

桌面版的锁定是**结构性**的：原文根本不渲染成输入框，改不了就是改不了。
原生编辑器里只能在"输入命令"这一层拦，强度低一档，换来的是不放弃 VS Code 的原生能力
（撤销、查找替换、多光标、Vim 键位、git diff）。

需要硬锁就只能回到自绘 Webview —— 那正是本方案一开始就否掉的形态（见 §1）。

## 8. 已知缺口

| 缺口 | 影响 | 说明 |
|---|---|---|
| 词典只做 MDX | 中 | MDD（词条内嵌图片/音频）与 JSON/HTTP 词典未接。MDD 需要一整套资源水化，浏览器路径下桌面版也只在 Tauri 侧支持 |
| 编码判定的盲区 | 低 | 整篇半角片假名的 Shift-JIS 会被打分判成 EUC-JP；无 BOM 的 UTF-16 只在 NUL 特征明显时才认。拿不准一律 unknown，不做任何动作 |
| 自定义正则规则只读 | 中 | 命名捕获组规则的译文行格式无法可靠构造，所以「补译文行」与原格式导出都拒绝执行（见 §5.4）。这是**有意保守**，不是遗漏 |
| 规则库是全局的 | 低 | 文档对规则的**选择**是每文档独立的，但规则库本身来自扩展内置 + `galweave.rules` 设置 |
| 大数据量 | 低 | 超过 `maxParagraphs` 的段落不再着色；未做"只着色可视区域"；诊断每次变更全量重算 |
| 固定行数分组 | 低 | `parseConf` 无分组字段，`使用教程.md` 9.1 的"固定行数分组"预设（每 N 行一组、无空行）不支持 |

## 9. 目录结构

```
vscode-extension/
├── PLAN.md                          本文件
├── README.md                        使用说明
├── package.json                     扩展清单（main / commands / keybindings / configuration / colors）
├── extension.cjs                    入口，只做装配
├── .vscodeignore 概念上见 dist/      打包排除项由 package.mjs 生成
├── .vscode/
│   ├── launch.json                  F5 开发宿主
│   └── tasks.json                   inspect.mjs 配成任务
├── vscode/                          vscode API 层（CJS）
│   ├── core.cjs                     状态、解析缓存、规则库、术语表、基线
│   ├── cursor.cjs                   上下文键与行状态提示（P7）
│   ├── decorations.cjs              语义着色
│   ├── providers.cjs                hover / 折叠 / 大纲 / 诊断
│   ├── commands.cjs                 命令与 CodeAction
│   ├── encoding.cjs                 编码检测缓存、乱码提醒、导出写回编码（P10）
│   └── dict.cjs                     MDX 词典查询（P8）
├── src/                             纯逻辑（ESM，node --test 可测）
│   ├── lineparse.js                 行保真解析器（前缀式 + dc4ph 镜像格式）
│   ├── rules.js                     规则库与自动选择
│   ├── validate.js                  结构校验 + 基线比对
│   ├── glossary-file.js             术语表文件解析
│   ├── export-text.js               导出收尾 + 往返自检
│   ├── nav.js                       逐行导航落点与锁定判定（P7/P8）
│   ├── dicttext.js                  词条清洗与取词候选（P8）
│   └── encoding.js                  编码检测、日语打分、反向表编码（P10）
├── rules/
│   └── circle-inline-speaker.json   ○/● + [[名字]] 规则
├── scripts/
│   ├── inspect.mjs                  规则检查 CLI（与扩展共用规则库）
│   └── package.mjs                  打包：内联共享逻辑 → dist/ → VSIX
├── tests/
│   ├── helpers/mock-vscode.mjs      共用 vscode mock
│   ├── lineparse.test.mjs           38 用例（含 dc4ph 镜像格式与真实样本交叉验证）
│   ├── encoding.test.mjs            20 用例（编码检测 / 日语打分 / 反向表编码）
│   ├── rules.test.mjs               25 用例
│   ├── validate.test.mjs            27 用例
│   ├── nav.test.mjs                 18 用例（导航落点）
│   ├── nav-lock.test.mjs            14 用例（前后缀/括号锁定）
│   ├── dict.test.mjs                25 用例（词条清洗 / 真实 MDX）
│   ├── roundtrip.test.mjs           13 用例（导出保真，含镜像格式逐字节还原）
│   ├── extension.test.mjs           69 用例（源码目录下的集成，含编码）
│   └── package.test.mjs             13 用例（打包产物自包含性）
└── dist/                            构建产物（gitignore）
```

`src/` 与 `tests/` 只依赖 `../../src/` 下的纯逻辑模块（无 DOM、无 Node 内置），**不改动 `src/` 下任何文件**。

常用命令：

```bash
cd vscode-extension
npm test                              # 262 项
node scripts/package.mjs --vsix       # 产出可安装 VSIX
node scripts/inspect.mjs --list-rules # 看规则库
```

## 10. 验收方式

- 纯逻辑：`npm test`（`node --test "tests/*.test.mjs"`）
- 真实样本交叉验证：对 `test text/` 下全部样本，比对 `parseLines` 与 `parseFile` 的段落数、字段与 `done` 口径
  （镜像格式样本在 `test text/dc4ph/`，同一套比法：字段逐段一致 + `buildExport` 重建逐字节相同）
- 规则调优：`node scripts/inspect.mjs` 直接看某个文件在新规则下的识别结果，不必启动 VS Code
- 视觉验收（P1 起）：在 VS Code 里打开真实脚本，人眼确认三类段落的着色正确
- 编码验收（P10 起）：`node scripts/inspect.mjs <文件>` 会先报编码；Shift-JIS 脚本应能正常识别，
  导出（`galweave.exportEncoding=source` 时）应与源文件逐字节相同
