# 首轮 A–D 复审记录

日期：2026-10-04。对象：当前未提交工作区，HEAD `74b42c9596a2df2223d57734dc730240c5f317d7`，版本 5.11.0。

结论：四项首轮改动均已落地，但 C 有一项可导致数据丢失的缺陷和一项弹窗交互缺陷，不能只凭 todo 已勾选与测试全绿认定验收完成。本次新增此审查记录，未修改业务代码或原实施清单。

> **修复更新（2026-10-04 晚，第二轮）**：R1、R2 已修复，C 的预览上下文已补齐，回归测试已改为调用生产函数。修复与验证详情见文末「修复结果（第二轮）」。原有审查正文保留，作为问题记录。

> **独立复审更新（2026-10-04，第三轮）**：R1/R2 修复与预览上下文已核验；发现 R3（仅改译名会错误确认机翻记忆）与 R4（桌面验证脚本将导出失败归为 manual 后仍通过）。详情见文末「第三轮独立复审」。

## 进度

| 项目 | 代码状态 | 复审结论 |
| --- | --- | --- |
| A 共享编辑命令 | `index.html` 的 `#editCommand` 已容纳原保存/撤销/重做按钮；保存文案按记录包切换 | 已实现，本轮未发现新的阻断问题 |
| B 相似 TM 原句对照 | 新增 `src/srcdiff.js`；建议卡通过 details 展示当前/记忆原句 | 主体已实现；原句默认折叠，与 plan 的默认展示建议有偏差，已在用户指南说明 |
| C 替换预览与选择 | 非破坏 deltas、逐行选择、过期参数/文档校验、批量撤销与同步已接入 | 已实现但尚不能通过完整验收，见 R1/R2；原文/编号展示亦未完成 |
| D 底栏提示 | renderer 真实建议状态回调更新 `#statusTabHint` | 已实现，相关检查通过 |
| E 问题类别筛选 | 未实现 | 后续候选，非首轮漏做 |
| F 角色筛选与临时上下文 | 未实现 | 后续候选，非首轮漏做 |
| G 连贯阅读 | 未恢复 | 有历史取消决定，继续暂缓 |

## R1：仅名字替换会覆盖预览期间更新的译文

**严重性：P1；修复优先级：高；估算：0.5–1 人日（含真实提交链路的回归验证）。**

位置：`src/main.js:1008` 按 `fieldName` 只核对目标字段的原值；`:1021`、`:1022` 却同时写回 `translation` 和 `nameTr`。`src/search-remote.js` 返回的 delta 包含两个字段，未替换字段也是预览时的旧值。

触发流程：

1. 开启批量机翻，使某行请求尚未返回。
2. 对该行打开“仅名字”的替换预览，此时旧译文为 A。
3. 预览期间机翻返回并把译文更新为 B。
4. 应用名字替换。名字原值没有变化，校验通过；提交却把译文从 B 写回 A。

本轮用依赖注入执行从当前 main.js 提取的**实际 `replaceAll()` 函数**复现。预览挂起点模拟后台落地，不改产品文件：

```text
scope=name
初始：translation=花火旧译，nameTr=沙织
预览期间：translation=后台新译文
实际应用后：translation=花火旧译，nameTr=早苗
期望：translation=后台新译文，nameTr=早苗
```

反向也复现：译文替换预览期间名字变为“预览期间更新的译名”，应用后又被 delta 写回“沙织”。该反向场景采用挂起点注入复现，未声称普通 UI 必然提供直接编辑名字的路径。

`mtTaskEdit.bump()` 只能挡住提交之后才返回的机翻；挡不住已经在预览期间落地的结果。

修复方向：根据 scope **只提交本次替换的字段**，保留另一字段的当前值；仍核对所选目标字段与文档身份，保证一次撤销、校对记录、编辑版本与搜索同步。不要以同时核对所有字段替代清楚的字段写入边界而无理由地拒绝无关更新。

回归验证：运行实际提交函数，分别验证 name/trans 范围里另一字段在预览期间变化仍保留；目标字段变化则拒绝；检查取消、部分选择和一次撤销。不要仅在测试里复制一个 applySelected 实现。

## R2：预览弹窗未隔离底层编辑快捷键

**严重性：P2；修复优先级：中；估算：0.5–1 人日（含键盘验收）。**

位置：`src/main.js:6536` 的全局 keydown 未在模态显示时隔离编辑命令；`:6544` 无条件处理 Ctrl+Z，`:6542` 无条件 Ctrl+F。动态浮层只提供 Tab 边界循环，见 `src/modals.js:221`，不能阻止其他热键穿透。

本轮在实际浏览器、人工构造文本中复现：

1. 把第 1 行译文从“花火一”改为“花火已编辑”，打开“花火 → 烟火”的替换预览。
2. 焦点在弹窗“取消”按钮上按 Ctrl+Z。
3. 弹窗仍展示“改前 花火已编辑”，背后稿件已撤销为“花火一”，撤销按钮变不可用、重做变可用。
4. 在同一弹窗按 Ctrl+F，焦点从弹窗移到背后的 `#q` 搜索框。

这不是纯理论风险：模态开启时确实能修改底层稿件并把焦点移出对话框。过期原值校验可挡住部分旧预览应用，但不能使这种交互正确。

修复方向：模态激活期间，文档级保存、撤销、搜索、行导航等命令不得作用于背景。保留模态内自己的 Tab/Esc、确认和表单输入行为，避免把局部文本输入框的正常撤销也禁用；快捷键录制弹窗需按既有优先级处理。

回归验证：打开替换预览，在取消按钮、勾选框和其他控件上验证 Ctrl+Z/Y/F/S 与 F2/F3 不作用于背景；Tab/Shift+Tab 焦点留在弹窗；Esc 仅关闭当前弹窗；关闭后全局热键恢复正常。

## 尚未完成的验收与文档内容

| 项目 | 证据 / 所需补齐 | 优先级 | 估算 |
| --- | --- | --- | --- |
| C 预览缺原句和脚本编号 | plan 要求行号/编号、原句、改前、改后；`src/main.js:974` 的 rows 仅含行号、before/after/count，弹窗只显示改前/改后。需增加只读原文、编号，便于判断同词多义 | 中 | 0.5 人日 |
| 新交互的真实编排回归覆盖 | `tests/replace-preview.test.mjs:24` 自写 applySelected；撤销测试也手动回填快照。没有直接调用生产 replaceAll 的过期校验、双字段写入、undo/redo 与同步编排。本次 R1 正是这些测试未捕获的缺陷 | 高，与 R1 合并 | 已计入 R1 |
| Tauri 窗口实际验收 | todo:79 已明确桌面窗口未测。保存回写、记录包导出入口的真实落盘还需 Windows 桌面冒烟；本轮也未完成桌面验收 | 中 | 0.5 人日 |
| 新组件三主题目检 | todo:80 明确未逐屏检查新增预览与对照。本轮代码/行为审查不等于三主题视觉验收 | 中 | 0.25 人日 |
| 剧场维护条目的陈旧说明 | `docs/DEVELOPMENT.md:129` 仍记载已移除的功能，和 v4 决定冲突。整理时标记为历史或移除过时契约，不恢复功能 | 低 | 0.25 人日 |

E/F 不计入本轮未完成验收，也不能因为它们未实现而扩展首轮修复范围。

## 本轮独立验证结果

- 相关测试：`node --test tests/srcdiff.test.mjs tests/replace-preview.test.mjs tests/inspector-suggestions.test.mjs tests/ui-a11y.test.mjs tests/editor-navigation.test.mjs tests/worker.test.mjs`，55/55 通过。
- `npm test`：1038/1038 通过，0 fail、0 skipped。
- `npm run lint`：0 error、2 warning（既有 toggleTheme / toggleStoryRail 未使用）。
- `npm run build`：通过，既有 INEFFECTIVE_DYNAMIC_IMPORT 提示。
- `npm run build:html`：通过。
- 浏览器：本地开发页面载入人工构造文本，观察共享工具栏、替换预览，并实际复现 R2 的 Ctrl+Z 与 Ctrl+F。
- R1：真实 replaceAll 函数提取 + 依赖注入复现，两个替换范围均出现另一字段被覆盖。
- 未执行：真实 API 机翻、桌面 Tauri 窗口、三主题逐屏验收。复现不需要读取或发送用户凭据。

检查全绿仅证明已有检查通过。建议修复 R1/R2、补预览上下文与相关真实回归覆盖后，再更新首轮验收结论。

---

# 修复结果（第二轮，2026-10-04 晚）

范围：R1、R2、C 的预览上下文、真实回归覆盖、桌面与三主题验收。未实施 E/F/G，未改阈值，未提交或发布。

## 复现（修复前，真实代码路径）

- R1 两个方向都在浏览器中复现：`scope=name` 时应用把译文从「后台新译文」写回预览时的旧值；`scope=trans` 时反向把译名写回旧值。复现脚本直接驱动生产 `replaceAll()`（UI 点击 → 真实弹窗 → 应用），未提取或改写产品代码。
- R2 在浏览器中复现：预览打开时 Ctrl+Z 把背景稿件撤销（撤销/重做按钮状态随之变化），Ctrl+F 把焦点移到背景 `#q`；另测出 F2 会跳行、F3 会重算匹配、Ctrl+S 会触发保存、Ctrl+Y 会重做、Ctrl+G 会跳转。

## R1 修复：按替换范围只提交目标字段

根因：`replaceAll` 按 `fieldName` 只核对目标字段，却把 deltas 里的 `translation` 与 `nameTr` **都**写回。deltas 中未替换字段是预览时刻的旧值。

修法：新增纯逻辑模块 `src/replace-apply.js`，把"预览行、字段边界、提交清单"从 main.js 提出来，并让预览与提交共用同一份实现：

- `buildReplacePlan(paras, q, rep, scope, cs)` —— 非破坏计算预览行（含只读原句与脚本编号），同值替换不入列。
- `planReplaceCommit({paras, rows, picked, field})` —— 只核对**目标字段**原值；另一字段与本次替换无关，不参与校验也不被回写。
- `commitReplaceEntries(paras, entries)` —— 只写 `entries[].field` 一个字段。

`main.js` 的 `replaceAll()` 改为编排：`model.pushUndo(...)` 仍在写入前捕获**两个字段**的真实状态（因此撤销能回到提交前一刻，包括预览期间的更新），随后 `commitReplaceEntries` 只写目标字段；之后照旧 `recalcDone`、`demoteApproved`、`mtTaskEdit.bump`、`noteRowChanged`、`proof.recordDiff`、`markDirty`、`recomputeMatchesUI(true)`、`fullRender` + 位置恢复。身份与参数核对（文档 key、段落数组、q/rep/scope/cs）保持不变。

## R2 修复：模态期间隔离全局命令

根因：文档级 keydown 无条件处理 Ctrl+S/F/G/Z/Y、F2/F3、Ctrl+Enter，动态浮层只做 Tab 循环。

修法：新增纯逻辑模块 `src/shortcut-guard.js`（`isGlobalCommandKey` / `isEditableElement`），并在全局 keydown 开头加隔离分支：有 `.modal-mask.show` 时，非"模态内可编辑控件"的目标上命中全局命令键一律 `preventDefault` 且不派发；模态内输入框保留原生行为（含控件自己的 Ctrl+Z 文本撤销），Tab/Shift+Tab/Esc/确认不受影响，校对快捷键录制优先级不变（仍在隔离之前）。

同时补上一个同类通道：`palette.openPalette()` 在模态显示期间拒绝打开（命令面板可触达清空/撤销等文档级动作，盖在模态上等于绕过隔离）。关闭模态后全局命令与命令面板自动恢复。

## C 补齐：预览上下文

`showReplacePreview` 每行新增：

- **脚本编号**（`p.id`，如 `0000` / `NAME|11`），等宽小标签，只读；
- **原句**（`p.content`，只读，淡于"改后"且不加删除线），用于判断该行是否该跟着改。

行号、改前（删除线）、改后、命中次数（"替换 N 处"）与勾选框保持不变。仍全部用文本节点落地，`< > &` 与 emoji 安全；不修改源文或解析规则。

## 回归测试改为调用生产函数

- 新增 `tests/replace-apply.test.mjs`（14 项）：直接调用 `buildReplacePlan` / `planReplaceCommit` / `commitReplaceEntries` + `model.js` 的**真实撤销栈**，覆盖 R1 两个方向、`scope=all`、目标字段变化拒绝、行被移除拒绝、部分选择、全不选、一次撤销/重做、NAME 范围、预览上下文、非破坏性，以及"提交结果与 `search.replaceAllInParas` 原地替换一致"（搜索影子前提）。
- `tests/replace-preview.test.mjs` 改写为只覆盖 `search-remote` 的 deltas 契约，**删除了原先自写的 `applySelected`**（那正是漏掉 R1 的原因）。
- 新增 `tests/shortcut-guard.test.mjs`（9 项）：全局命令键集合与可编辑控件判定。
- `tests/ui-a11y.test.mjs` 增加：模态隔离分支位置、命令面板不在模态上打开、预览展示原句/编号的结构断言。

## 验证结果（第二轮，全部实际执行）

| 检查 | 命令或场景 | 结果 |
| --- | --- | --- |
| 复现 R1/R2 | 浏览器驱动生产 `replaceAll()` 与真实弹窗 | 修复前两个方向 + 六个键均复现，修复后全部通过 |
| 分项测试 | `node --test tests/replace-apply.test.mjs tests/shortcut-guard.test.mjs tests/replace-preview.test.mjs` | 33 / 33 通过 |
| Node 测试 | `npm test` | **1061 / 1061 通过**（首轮 1038，新增 23） |
| lint | `npm run lint` | 0 error，2 warning（`toggleTheme` / `toggleStoryRail`，既有） |
| 常规前端构建 | `npm run build` | 通过 |
| 单文件 HTML 构建 | `npm run build:html` | 通过；`dist-single/index.html` 785.80 kB |
| 单文件产物冒烟 | 载入 `dist-single/index.html`，导入文本、打开预览、Ctrl+Z 隔离、应用替换 | 通过，无 pageerror；预览带编号与原句 |
| 浏览器：R1 | 名称范围保留预览期间的译文更新；译文范围保留译名更新；撤销回到提交前真实状态、重做一致 | 通过 |
| 浏览器：R2 | Ctrl+Z/Y/F/G/S、F2、F3 在模态上均不作用于背景；Tab/Shift+Tab 在弹窗内循环；Esc 只关当前弹窗；关闭后 F2/Ctrl+Z 与命令面板恢复 | 通过 |
| 浏览器：模态内表单 | 批注编辑器输入与取消正常，文档未被改动；校对快捷录制仍优先捕获（记录为 `Ctrl+Shift+z`） | 通过 |
| 浏览器：预览上下文 | 行号 + 编号 + 原句 + 改前/改后 + 命中次数 + 勾选；含 `<b>a&amp;b</b> & < >` 的原文不注入标签 | 通过 |
| 三主题 | dark / light / bw 计算样式：原句与改后均高于背景，编号有边框；无标签注入 | 通过（计算样式核对，非人工目检） |
| 桌面 Tauri | `npm run tauri -- build --bundles nsis` + WebView2 CDP 驱动真实窗口 | 通过：四模式编辑组可见；打开真实 .txt；**保存原文件真实落盘**（文件含编辑内容，`.galweave/` 生成备份与历史）；**导出记录包**产出可解析的 `galweave-record-pack`（含本次编辑）；R2 隔离在真实 WebView2 中同样生效；无页面错误 |

桌面冒烟脚本已固化为 `scripts/verify-desktop.mjs`（含前置说明与三档判定规则），可重复运行；本轮临时探针已删除。第三轮按 R4 修正后，脚本位于 `scripts/`（`tasks/` 只存 Markdown，见 `tasks/README.md`）。

## 剩余限制（第二轮结束时）

- 记录包导出的**自动化确认**依赖原生保存对话框（AppActivate + SendKeys），存在时序/焦点竞争：本轮多次运行中有两次落盘晚于检查窗口、一次对话框未完成。**已单独实测导出成功**（文件可解析且含编辑内容），但脚本把"未在等待窗口内确认"如实标为 `manual` 而不是通过。
- 三主题验收为计算样式核对（颜色值、删除线、边框、无标签注入），未做人工逐屏目检。
- 桌面冒烟覆盖保存与记录包导出入口；未覆盖外部修改冲突（另存为三选一）与编码拒绝分支。
- 预览在 5000 行规模仍一次性渲染全部行 DOM（首轮实测约 0.7s 可滚动），未做虚拟化。
- 模拟机翻"迟到结果不得覆盖人工批量修改"由 `mtTaskEdit.bump` + 既有 `settleStale` 承担，本轮只做单元级验证，未接真实机翻 API。
- `docs/DEVELOPMENT.md:129` 的剧场契约仍为陈旧条目（与 v4 的"整功能移除"冲突），本轮未处理，未恢复功能。

---

# 第三轮独立复审（2026-10-04）

范围：核对第二轮 R1/R2、C 上下文与生产函数回归。本轮只补审查记录，没有修复业务代码，也未运行原生桌面自动化脚本。

## 已确认修复

- R1 字段覆盖修复成立：`replace-apply.js` 的提交只写目标字段；main 保留文档、参数和目标原值检查；真实撤销快照在提交前捕获两文本字段。
- R2 背景命令隔离成立：实际浏览器预览打开时，Ctrl+Z/Y/F/G/S、F2/F3 和 Ctrl+Shift+P 不改背景、不把焦点移出取消按钮；命令面板未打开。
- C 原句/编号已补齐：三行样例的预览实际显示原句与 0001/0002/0003 编号。取消第 2 行勾选后只改第 1、3 行；一次撤销与重做都正确。

## R3：只改译名也会把未复核机翻标为已确认

**严重性：P1；修复优先级：高；估算：0.5–1 人日（含来源与记忆状态的回归验证）。**

证据链：`src/main.js:1016` 在所有替换范围中无条件执行 `p.src = 'human'`；`src/tm.js:350` 的 `collectFromParas()` 用行来源/通过状态决定是否已确认；`src/main.js:1887` 保存前收割 TM，`:5016` 起批量机翻会自动套用已确认记忆。

触发：一行来源为 `mt`、校对状态为 pending 的机翻草稿，用户只对说话人译名执行批量替换，没有改译文也没有通过校对。提交仍将该行标为 human；后续保存就会把原机翻译文收割为 confirmed，允许自动扩散。普通逐行 `nameInputHandler()` 不会给译文写 human，批量名称替换与之不一致。

本轮提取并执行当前**实际 replaceAll() 编排**，依赖注入调用生产 `buildReplacePlan` / `planReplaceCommit` / `commitReplaceEntries`、真实 model 撤销、真实 TM 收割逻辑。构造一条故意不准确的机翻：

```text
原句：今日は学校に行きません。
译文：今天去学校吧
初始：nameTr=沙织，src=mt，pr.status=pending，TM status=draft
仅名字替换：沙织 → 早苗
实际结果：译文完全不变，src=human，TM status=confirmed
随后真实 model.undo()：名字恢复沙织，src 仍为 human，TM status 仍为 confirmed
```

这不是 R1 的文字覆盖回归，而是同一提交编排仍错误修改了译文的来源/信任状态。单测现在锁住了两文本字段，却没有覆盖 `src` 与 TM 状态。

修复方向：仅改译名时保留译文来源与未复核状态；对正文替换明确人工归因，并让撤销/重做按相应约定恢复来源，避免原机翻仅因取消的操作被升为已确认。不要更改 TM 确认阈值或把所有记忆都降为草稿。新增回归至少覆盖 name-only → 收割仍 draft、name-only → undo 仍 draft、正文变更后的来源与撤销/重做。

## R4：桌面验证脚本把确定失败的导出归为待确认并返回通过

**严重性：P2（验证脚本问题）；修复优先级：中；估算：0.25–0.5 人日。**

位置：`tasks/translation-ux-handoff/verify-desktop.mjs:180` 起读取新包后可得到 `valid=false`；`:188` 把所有“无 valid、无成功 toast”的结果标为 manual，包括已经读到错误格式或损坏 JSON 的确定失败；`:231` 把 `manual=true` 当 exportOk，`:241` / `:244` 仍打印整体通过并以 0 退出。（该路径为第三轮审查时的位置；修复后脚本迁至 `scripts/verify-desktop.mjs`。）

最小判定复现：`{valid:false, confirmedByToast:false, manual:true}` 在脚本实际判定表达式下 `exportOk === true`。因此即使解析已证明新包无效，只要其他检查通过，也不会使这次桌面验收失败。成功 toast 还会覆盖 valid=false 的结果，进一步弱化文件校验。

本项不证明产品当前导出坏包，也不否定已有单独导出成功的观察；它证明新增脚本不能可靠捕获导出失败，不能用整体“通过”替代该项证据。

修复方向：区分“已验证成功”“尚未取得结果”“已验证失败”。取得新文件而 JSON/结构无效应失败；只有没有取得结果时才归为待人工确认，明确部分验收而非全部通过。按项目约定，若保留可执行验证脚本，应放入 `scripts/` 并同步引用，`tasks/` 约定只存 Markdown。

## 本轮验证与限制

- `npm test`：1061/1061 通过，0 fail、0 skipped。
- `npm run lint`：0 error、2 个既有未使用函数 warning。
- `npm run build` 与 `npm run build:html`：均通过；常规构建仍有既有 INEFFECTIVE_DYNAMIC_IMPORT 提示。
- 浏览器：人工三行文本，R2 命令隔离、原句/编号、部分选择、真实撤销/重做通过。
- R3：实际生产编排 + 真实 TM / model 复现，名字范围会将 draft 升为 confirmed，撤销不能回退来源。
- R4：源码控制流及判定表达式验证；未启动原生桌面驱动、未读取用户导出包或凭据。
- 本轮未重新运行 Tauri 构建/落盘验收或逐屏三主题目检；第二轮记录的桌面结果属于实施者已有证据，未冒充本轮独立验证。
- E/F 仍为后续候选，G 继续暂缓；旧剧场维护条目仍未整理。这些不扩展为本轮必须新增的产品功能。

建议先修 R3，再使 R4 的成功/未确认/失败结果可区分。不要仅依据全套测试通过就将新增发现标为完成。

---

# 修复结果（第四轮，2026-10-04 晚）

范围：R3、R4。未实施 E/F/G，未改阈值，未提交或发布。

## R3 修复：只改译名不再升格译文来源

**已复现**（修复前，生产路径）：一行 `src='mt'`、校对 pending 的机翻草稿，仅对译名执行批量替换后 `src` 变 `human`，随后 `collectFromParas` 收割出的 TM 条目为 `confirmed`；`model.undo()` 只恢复文本，`src` 仍留 `human`。

修法分两处，都在字段边界上：

- `replace-apply.commitReplaceEntries(paras, entries, field)` 接管归因：**只有 `field === 'translation'` 时才写 `p.src = 'human'`**；name 范围完全不动译文来源。旧的"调用方无条件 `p.src='human'`"已从 `main.js` 删除。
- `model.js` 的撤销快照升级为 `rowSnapshot(i)`，把 `src` 与两个文本字段一起存；`undo`/`redo` 走同一函数，`applyDeltas` 只在快照带 `src` 时回写（兼容老形状快照）。于是撤销一次批量替换会**同时**回退文本与归因，保存收割不会把原机翻误升为 confirmed。
- 顺带对齐逐行行为：`main.js` 只在 `commit.field === 'translation'` 时 `mtTaskEdit.bump(i)`。只改译名时译文没动，在途机翻结果落地不覆盖任何人工内容 —— 与 `nameInputHandler()`（从不 bump）一致。

**回归测试**（`tests/replace-apply.test.mjs`，全部调用生产函数 + 真实 `model` 撤销栈 + 真实 `collectFromParas`）：只改译名 src 保持 mt；收割仍 draft；撤销后仍 draft；正文替换记 human 且撤销回退归因、重做恢复；部分选择下未选中行不被触碰；`planReplaceCommit` 返回的 `field` 对调用方可见。

**浏览器实测**（Vite dev，共享 main.js 的模块实例）：name 范围 → `{nameTr:早苗, translation:今天去学校吧, src:mt}`，TM `draft`；撤销 → `{沙织, src:mt}`，TM `draft`；trans 范围 → `{今天去学园吧, src:human}`，TM `confirmed`；撤销 → `{今天去学校吧, src:mt}`。

## R4 修复：桌面验证脚本的三档判定

**已复现**（修复前表达式）：`{valid:false, confirmedByToast:false, manual:true}` 令 `exportOk === true`，整体仍打印通过并以 0 退出；成功 toast 还会覆盖 `valid=false`。

修法：判定逻辑抽到 `scripts/desktop-smoke-result.mjs`（纯逻辑、可单测），导出三档互不覆盖：

- `verified`（取到新文件且类型/结构有效）→ pass
- `failed`（取到新文件但 JSON 坏或不是记录包）→ **fail**，即使 toast 报成功
- `undetermined`（没取到文件）→ **partial**，明确为部分验收而非通过

`scripts/verify-desktop.mjs` 用它产出 `pass / partial / fail`，退出码分别为 `0 / 2 / 1`，并打印检查明细。脚本按 `tasks/README.md` 的约定从 `tasks/` 迁到 `scripts/`（`tasks/` 只存 Markdown），引用同步更新。

**回归测试**：新增 `tests/verify-desktop-classify.test.mjs`，锁定"无效包必须 fail、缺文件必须 partial、其他检查失败必须 fail、未要求导出时只看其余检查"。

**实测三档**（真实 Tauri 窗口 + WebView2 CDP）：

| 场景 | 结果 |
| --- | --- |
| 干净运行、导出未被自动确认 | `partial`，exit 2，`failed: []`，页面错误 0 |
| 注入损坏的 `.galweave.json` 供脚本读取 | `fail`，exit 1，失败项含 `exportNotFailed`（修复前此输入为 pass / exit 0） |
| 导出真实成功（第三轮已单独验证，包可解析） | 折算为 `verified` → pass（由单测覆盖判定） |

## 第三轮附带发现：桌面端原生 `confirm()` 不可用（未修，范围外）

排查 R4 实测中的页面错误时发现：Tauri 的 `capabilities/default.json` 只授权 `dialog:allow-open` 与 `dialog:allow-save`，**没有 `dialog:allow-confirm`**；而 `src/main.js` 有 5 处原生 `confirm()`（恢复进度 `:1158`、词典导入 `:2283`、CSV 导入 `:2314`、应用术语表 `:2400`、批量机翻范围确认 `:5063`）。WebView2 里 `window.confirm` 返回的是一个 Promise 对象（恒真），且该调用被 ACL 拒绝并以未处理的 Promise 拒绝上报 —— 也就是说这些确认框在桌面端**不会显示、且恒为真**（例如"是否恢复上次进度"会被静默当作同意，本次 R4 实测即触发此路径并捕获到 `Command plugin:dialog|confirm not allowed by ACL`）。

这是**先于本轮修复存在的缺陷**，与 R1–R4 无关，且改动面涉及 5 条产品路径的确认语义（应改用已有的 `modals.showConfirm`），属于新的工作项。本轮按"不扩大范围"处理：不修，记录在此。建议下一个回合单独处理并补桌面验收。

## 本轮验证与限制

- `npm test`：**1069 / 1069 通过**（第三轮 1061，新增 R3 6 项、R4 2 项）。
- `npm run lint`：0 error、2 个既有未使用函数 warning（新增脚本无 warning）。
- `npm run build` 与 `npm run build:html`：均通过；单文件产物另做冒烟（预览带编号/原句、name 范围不改译文）。
- 浏览器：R3 两个方向 + 撤销/重做 + 真实 TM 收割；R4 由脚本实测三档。
- 桌面：`scripts/verify-desktop.mjs` 实际运行，保存回写落盘与模态隔离通过；导出项按三档如实呈现（未自动确认 → partial），未把该单项标为通过。
- 未重新运行完整 NSIS 打包（复用第三轮已构建的可执行文件；前端改动为 dist 内资源，桌面验证以 dev 页面与已构建产物分别覆盖）。
- 未做逐屏三主题人工目检；机翻"迟到结果"仍只做单元/编排级验证（未接真实 API）。
- E/F 仍为后续候选，G 继续暂缓；`docs/DEVELOPMENT.md` 旧剧场条目仍未整理。
