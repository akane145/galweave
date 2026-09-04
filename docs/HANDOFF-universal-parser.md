# Galweave 通用解析器实施交接

状态：核心实现完成，尚未提交<br>
日期：2026-09-04<br>
目标：让 `test text/` 中不同 Galgame 文本格式通过统一扫描器识别为对白、旁白、名字、标题、指令、注释与未知模块，同时保护行内引擎标签并保持原文件无损。

## 1. 已确认的架构决策

不要用“一条万能正则”，也不要直接改写旧 `parseFile()` 契约。

采用两层模型：

1. `src/universal-parser.js`：新的无损物理行扫描与语义记录层。
2. `src/parsers.js` / `src/recognize.js`：保留现有 API 和规范化/还原流程，作为兼容层。

原因：现有 UI、进度恢复、搜索、校对和导出都依赖旧 `para` 字段语义。直接替换会改变行索引、名字行行为和进度匹配。

新模型的稳定键采用 `id#occurrence`，不能只用裸 ID；样本存在重复或同序号不同类型，`NAME|7` 与 `TEXT|7` 也不能视为同一记录。

## 2. 本轮已完成

### 2.1 新增无损解析核心

文件：`src/universal-parser.js`

已提供：

- `tokenizeInline(text)`：识别并保护 `<r>`、`[n]`、`[r]`、`[np]`、`%p...;`、`%f...;`、字面 `\n` / `\\n`、`[名称,数字]`。
- `splitPhysicalLines(text)`：逐行保留 LF、CRLF、CR 和无尾换行。
- `parseDocument(text, options)`：不依赖空行分块，按相邻 source/target 标记扫描记录。
- `serializeDocument(document)`：未编辑时按物理行严格还原原字符串。
- `enrichDetectionProfile(text, profile)`：向旧 profile 增量添加 `formatProfile` 与 `modules`，不更名旧字段。

当前语义类型：

- `dialogue`
- `narration`
- `speaker`
- `title`
- `directive`
- `named-text`

记录包含 source/translation 各自 ID、说话人、原始行、token、行号、置信度和 diagnostics。

### 2.2 样本规则

当前能识别：

- `☆/★` 与 `○/●` 标记对。
- 数字、十六进制、管道复合 ID、`TEXT|n / NAME|n`、`N/T/R` 后缀。
- 前缀说话人、`[[说话人]]`、`【说话人】`、独立 N/NAME 名字行。
- N/NAME 设置说话人状态，后续无显式名字的对白记录得到 `speaker.mode = "inherited"`。
- `R` 后缀分类为指令，`标题/標題/title` 前缀段分类为标题。
- 样本 9 中“無名 + 下一行对白”作为低置信推断，附带 `inferred-speaker`。
- 正文中出现标记字符时，若没有明确对白/标题证据，不再直接当作说话人分隔，附带 `ambiguous-marker-in-payload`。

### 2.3 识别流程接入

- `src/workers/recognize.worker.js`：`detect` 返回前通过 `enrichDetectionProfile()` 增强。
- `src/main.js`：worker 失败时的同步回退同样增强 profile。
- `src/recognize.js`：`renderReport()` 增加模块统计与低置信数量。

因此解析规则界面的识别报告会出现类似：

```text
模块: 对白 20  旁白 7  名字 2  指令 1  低置信 2
```

### 2.4 测试

新增 `tests/universal-parser.test.mjs`，当前 21 项通过：

- 13 份现有样本 `detect → canonicalize → restore` 字节级一致。
- 13 份样本经新 document 模型 `serializeDocument()` 严格一致。
- 行内 token 顺序和字面值保持。
- 标题、N 名字行、R 指令、括号说话人分类。
- 低置信名字推断。
- 无空行的连续原译文对可扫描为多条记录。
- 正文包含标记字符不会被误拆。
- 混合换行、重复 ID、显式空注释规则。
- 系统性编号偏移及两侧原始 ID 保留。

测试命令：

```powershell
node --test tests/universal-parser.test.mjs
```

最后一次完整结果：项目测试 323/323 通过。

此外已完成：

- `maskProtectedTokens()` / `restoreProtectedTokens()`，标签丢失、重复、重排、未知占位符均拒绝写入。
- `renderDocument()`，通过 `id#occurrence` 定点回写正文和说话人。
- `canonicalizeDocument()` / `restoreCanonicalDocument()`，13 份样本均可规范化后还原。
- `canonicalizeProfile()` / `restoreProfile()`，增强 profile 经 JSON 序列化后仍能跨进程恢复。
- `src/mt.js` 的 `translateTextProtected()`，测试翻译、当前行翻译和批量翻译已统一接入。
- `scripts/recognize-format.mjs` 已接入增强 profile 与新规范化/还原流程。
- `tests/recognize-cli.test.mjs` 覆盖 CLI 跨进程往返。
- `tests/recognize.test.mjs` 的旧样本名已指向现有第 12/13 号文件，全量测试恢复为全绿。

## 3. 有意保留的安全边界

1. 完全没有译文标记的 source-only 新格式，无法凭空判断目标 marker；必须由用户规则或引擎 profile 指定。
2. 存在无法归类的物理行时，新规范化流程返回 `unsupported-line`，不会静默删除内容。
3. 删除已有译文、向原本没有译文侧的记录新增译文，目前返回明确错误；需在目标引擎语义确定后单独设计。
4. 标题、舞台指令和无标记名字仍可能语义歧义，必须依赖 `confidence/diagnostics` 或用户确认。
5. 旧 `parseFile/buildExport/canonicalize/restore` 保留供旧 profile 兼容；新增强 profile 自动使用 lossless 路径。

## 4. 后续可选增强

- 在解析预览中增加逐记录模块表和低置信人工改类。
- 为确定的目标引擎增加 source-only 译文行插入策略。
- 给大型文件增加 profile 体积与扫描性能基准（等待 Q5 行数规模）。
- 待 Q3 明确后，把模块类型映射到 KAG / Ren'Py / NScripter / Unity 的专用导出器。

## 5. 必须守住的不变量

1. 未编辑输入必须严格等于输出。
2. 编辑一条记录只能改变该记录指定 payload。
3. source 和 translation 的 ID、marker、空白分别保存，不能互相覆盖。
4. 未知行、注释、控制行和全部 EOL 必须保留。
5. 控制 token 的数量、顺序和字面值必须稳定。
6. 低置信分类必须暴露 diagnostics，不能伪装成确定结果。
7. 旧 `parsePrefix/makePara/parseFile/buildExport` 的现有测试行为保持不变。
8. worker 返回值只能包含可 structured-clone 的普通对象/数组/字符串，不能含 RegExp 或函数。

## 6. 动态工作流记录

生成文件：

```text
.codex-flow/generated/universal-parser.workflow.ts
```

日志：

```text
.codex-flow/journal/universal-parser.jsonl
```

全局命令实际安装在：

```text
E:\Cluade Code\codex-flow.cmd
```

当前终端 PATH 未包含它。工作流启动后，三个 agent 都因本机 Codex 配置中的旧值失败：

```text
service_tier="default"
```

当前 CLI 只接受 `fast` 或 `flex`。没有修改用户全局配置；随后使用内置协作工具完成了三路只读审视。

如修好全局配置，可重跑：

```powershell
& 'E:\Cluade Code\codex-flow.cmd' run '.codex-flow\generated\universal-parser.workflow.ts'
```

## 7. 当前工作区注意事项

开始本任务前工作区已经有大量未提交修改，包括前一轮主题/解析规则 UI 改造。不要 reset、checkout 或整体覆盖这些文件。

本轮新增/修改的主要文件：

- `src/universal-parser.js`（新增）
- `tests/universal-parser.test.mjs`（新增）
- `src/workers/recognize.worker.js`
- `src/recognize.js`
- `src/main.js`
- `src/mt.js`
- `scripts/recognize-format.mjs`
- `tests/worker.test.mjs`
- `tests/mt.test.mjs`
- `tests/recognize.test.mjs`
- `tests/recognize-cli.test.mjs`
- `.codex-flow/generated/universal-parser.workflow.ts`（临时工作流）
- `.codex-flow/journal/universal-parser.jsonl`（运行日志）

前一轮相关但已在本任务开始前处于修改状态：

- `index.html`
- `src/style.css`
- `src/parsers.js`
- `tests/core.test.mjs`
- `tests/settings-ui.test.mjs`

本轮没有创建 Git 提交，避免把用户原有脏工作区混入自动提交。
