# Galweave 翻译编辑体验：实施清单

方案：[plan.md](plan.md)。交接日期：2026-10-04。实施日期：2026-10-04（首轮 A–D）。

## 本轮交接交付

- [x] 核对当前源码与已有 task，说明未提交工作区基准与既有能力。
- [x] 写清推荐首轮的范围、优先级、估算、复用 owner 与验收。
- [x] 记录历史剧场取消决定，修正连贯阅读建议的默认实施状态。
- [x] 写清后续候选与停止条件。

## 推荐首轮：A、B、C、D（约 4–6.5 人日）——已实施

- [x] 接手检查：读项目指导、相关 task、实际 diff，核对本文证据仍成立。
- [x] A（高，0.5–1 人日）：移动原保存/撤销/重做按钮到共享命令组，保留唯一 ID 与接线。
- [x] A 验收：四工具页、无文档、普通保存、记录包导出、撤销可用状态、窄屏。
- [x] D（中，0.5 人日）：底栏 Tab 提示跟随真实补全状态，显示/隐藏生命周期统一通知。
- [x] D 验收：建议打开、采纳、Esc、IME、切行、切标签、虚拟行卸载后提示准确。
- [x] B（高，1–2 人日）：相似 TM 展示记忆原文与可展开原句对照，保留角色/确认状态标签。
- [x] B 验收：否定/数字/称呼差异、长文本、特殊字符、NAME/空状态、采用与撤销。
- [x] C（高，2–3 人日）：复用非破坏 deltas 计算，形成逐行可选择预览，不提前改 Worker shadow。
- [x] C 提交：身份/原值/参数核对后，仅应用所选，一次撤销，统一人工修改与同步 bookkeeping。
- [x] C 行为测试：部分选择、取消、同值/空查找、字面替换、NAME、过期结果、撤销/重做。
- [x] C 浏览器验收：长列表、键盘、取消焦点、切文档/编辑冲突、后台机翻人工保护、搜索同步。
- [x] 整合检查：运行一次 lint、npm test、npm run build、npm run build:html，记录真实结果。
- [x] 检查最终 diff，按实际变更同步用户指南与必要维护决策，标明未验证项。

## 实施结果（2026-10-04）

### A. 保存、撤销、重做跨工具页常驻

- 新增 `#editCommand`（`data-panel="shared"`），从搜索栏与项目组**移动**（非复制）`btnSaveFile` / `btnUndo` / `btnRedo`；ID 唯一，接线与快捷键不变。
- `main.js` 新增 `updateSaveCommandLabel()`：记录包文档显示「导出记录包」，普通文档「保存原文件」；在载入、切标签、清空、启动四处刷新。
- 实测：四模式可见可点、1280/900/390 三档都在视口内、命中测试通过、ID 各 1 个、撤销/重做状态随输入与切换更新。

### B. 相似记忆的原句对照

- 新增纯逻辑模块 `src/srcdiff.js`（`diffSourcePair`）：连续公共前后缀求变动区间，按**码点**对齐不劈开代理对。
- `renderInspectorSuggestions()` 的相似卡片加折叠「原句对照」：当前原句 / 记忆原文两行，变动区间 `<mark class="src-changed">`；全部用文本节点生成，`< > &` 与 emoji 安全。
- 精确命中与机翻基线不加对照（原句相同，重复无意义）；相似度算法、阈值、结果数量与采用路径未改。
- 单测 `tests/srcdiff.test.mjs`（9 项）；浏览器实测否定/数字/称呼/emoji/markup 五类差异、NAME 与空状态、展开折叠可聚焦。

### C. 全部替换逐行预览与勾选

- `replaceAll()` 重写：用 `search-remote.replaceAllInParasDeltas` **非破坏计算**预览，**不再调用** `wkr.searchReplaceAll`（该接口会改 Worker shadow）。
- deltas 增加 `count`（逐行「替换 N 处」）；同值替换过滤，不出现在预览也不产生撤销项。
- 新增 `modals.showReplacePreview()`：逐行勾选、全选/全不选、选中行数/处数、无选择禁用、取消/Esc/遮罩关闭、默认焦点在取消、关闭后焦点回编辑位置。
- 应用路径：核对文档身份 + 段落数组 + 查找/替换参数 + 每行原值（全部同步），只写选中行；一次 `pushUndo`、`p.src='human'`、`demoteApproved`、`mtTaskEdit.bump`、`noteRowChanged`、`markDirty`、`refreshProofUI`、强制全量同步搜索影子。
- 途中发现并修复 `search-remote.js` 的**真实缺陷**：空查找串在 `replaceAllText` 中死循环（`search.js` 有防护、remote 版没有）。现已两处都防护。
- 单测 `tests/replace-preview.test.mjs`（13 项）；浏览器实测部分选择、取消/全不选非破坏、一次撤销/重做、过期预览拒绝（改行/改参数）、NAME 范围、大小写、markup 安全、5000 行预览可滚动、机翻人工保护与搜索影子一致性。

### D. 底栏快捷键提示随建议状态更新

- renderer 新增 `onSuggestChange` 回调（只在可见性真变化时触发），在 `renderSuggest` / `hideSuggest` / `fullRender` 三处通知。
- `main.js` 的 `updateStatusTabHint(open)` 切换 `#statusTabHint` 文案「采纳 / 下一行」。
- 实测：打开、Tab 采纳、Esc、IME 开始/结束、切行失焦、虚拟行卸载、切文档（`fullRender` 复位）后均正确恢复「下一行」。

### 范围偏差与取舍

- `renderInspectorSuggestions` 的对照逻辑留在 main.js（约 30 行），未抽到 `src/ui/`：该函数与 `tmData`/`writeRowTranslation` 同文件耦合，抽取收益小于跨文件依赖成本。
- `showReplacePreview` 放在 `modals.js`（与 `showConfirm`/`showHistoryList` 同址），复用 `mountModal` 的焦点循环与 `esc()`。
- 预览的"真正改变"判定为**同值替换不算改动**；这与既有 replaceAll 行为略有差异（旧版会算作命中并写入）。属有意收紧，避免无意义撤销项。
- `search-remote.js` 空串防护属范围外修复，但它直接决定预览正确性，故一并处理。

## 执行结果（2026-10-04 首轮）

| 检查 | 命令或场景 | 实际结果 / 未执行原因 |
| --- | --- | --- |
| 分项测试 | `node --test tests/srcdiff.test.mjs` / `tests/replace-preview.test.mjs` / `tests/ui-a11y.test.mjs` / `tests/inspector-suggestions.test.mjs` | 通过（9 + 13 + 6 + 6） |
| lint | `npm run lint` | 通过：0 error，2 warning（`toggleTheme` / `toggleStoryRail`，改动前既有） |
| Node 测试 | `npm test` | 通过：1033 / 1033 |
| 常规前端构建 | `npm run build` | 通过（Vite 8，仅既有 INEFFECTIVE_DYNAMIC_IMPORT 提示） |
| 单文件 HTML 构建 | `npm run build:html` | 通过；`dist-single/index.html` 783.50 kB |
| 浏览器验收 | Chromium（chrome-devtools）1280×800、1280×900、900×800、390×844 | 通过：A/D/B/C 全部场景见上；单文件 HTML 产物另做冒烟（四模式编辑组可见、无 pageerror） |

## 第二轮修复（2026-10-04 晚，复审 R1/R2 + C 上下文）

复审记录见 [review.md](review.md)。本轮处理 R1、R2、C 的预览上下文与真实回归覆盖；未实施 E/F/G，未改阈值，未提交。

- [x] 复现 R1（名称/译文两个方向的字段覆盖）与 R2（Ctrl+Z/Y/F/G/S、F2/F3 穿透）。
- [x] R1 修复：新增 `src/replace-apply.js`，按替换范围**只提交目标字段**，撤销快照仍在写入前捕获两个字段。
- [x] R2 修复：新增 `src/shortcut-guard.js`，模态显示期间拦截文档级命令；模态内表单与录制保留原生行为。
- [x] 同类通道：`palette.openPalette()` 在模态期间拒绝打开。
- [x] C 补齐：预览每行增加只读原句与脚本编号，保留行号/改前/改后/命中次数/勾选。
- [x] 回归测试改为调用生产函数：`tests/replace-apply.test.mjs`（真实撤销栈）、`tests/shortcut-guard.test.mjs`；`tests/replace-preview.test.mjs` 删除自写 `applySelected`。
- [x] 浏览器验收：R1 双向、撤销/重做、R2 六个键、Tab 循环、Esc、关闭后恢复、模态内表单、预览上下文、三主题计算样式。
- [x] 桌面 Tauri 冒烟：构建 NSIS + WebView2 CDP 驱动真实窗口，验证保存回写落盘与记录包导出；脚本固化为 `scripts/verify-desktop.mjs`（第三轮修正判定分类后由 `tasks/` 迁至 `scripts/`）。
- [x] 整合检查：lint、npm test、build、build:html 各一次，结果见下。

### 第二轮执行结果

| 检查 | 命令或场景 | 实际结果 / 未执行原因 |
| --- | --- | --- |
| 分项测试 | `node --test tests/replace-apply.test.mjs tests/shortcut-guard.test.mjs tests/replace-preview.test.mjs` | 通过：33 / 33 |
| lint | `npm run lint` | 通过：0 error，2 warning（既有） |
| Node 测试 | `npm test` | 通过：**1061 / 1061** |
| 常规前端构建 | `npm run build` | 通过 |
| 单文件 HTML 构建 | `npm run build:html` | 通过；785.80 kB |
| 单文件产物冒烟 | `dist-single/index.html` 导入→预览→应用→Ctrl+Z 隔离 | 通过，含编号/原句，无页面错误 |
| 桌面 Tauri | NSIS 构建 + `verify-desktop.mjs` | 通过：保存真实落盘、记录包可解析、模态隔离生效、无页面错误 |

## 第三轮修复（2026-10-04 晚，复审 R3/R4）

复审记录见 [review.md](review.md) 的「第三轮独立复审」与其后的「修复结果（第四轮）」。本轮处理 R3、R4；未实施 E/F/G，未改阈值，未提交。

- [x] 复现 R3：仅改译名会把 `src='mt'` 的未复核机翻升为 human，收割成 confirmed，撤销也无法回退来源。
- [x] R3 修复：`commitReplaceEntries` 按字段边界写归因（只改译名不动译文来源）；`model.rowSnapshot` 让撤销栈携带 `src`，`applyDeltas` 兼容老快照。
- [x] R3 对齐：`mtTaskEdit.bump` 只在改译文时推进（与逐行译名输入一致）。
- [x] R3 回归：`tests/replace-apply.test.mjs` 新增 6 项——生产提交函数 + 真实 model 撤销栈 + 真实 `collectFromParas`，覆盖 name-only 仍 draft、撤销后仍 draft、正文 human 与撤销/重做、部分选择、字段边界可见。
- [x] 复现 R4：`{valid:false, manual:true}` 被判为通过并以 0 退出；成功 toast 覆盖无效文件。
- [x] R4 修复：判定抽到 `scripts/desktop-smoke-result.mjs`（verified / failed / undetermined 三档互不覆盖），脚本改用之，退出码 0/2/1。
- [x] R4 归档：脚本按 `tasks/README.md` 约定迁到 `scripts/verify-desktop.mjs`，引用同步。
- [x] R4 回归：`tests/verify-desktop-classify.test.mjs` 2 项锁定三档判定。
- [x] 浏览器与桌面实测：R3 双向 + 撤销/重做 + TM 收割；R4 三档在真实 Tauri 窗口验证（干净 → partial；注入损坏包 → fail）。
- [x] 整合检查：lint、npm test、build、build:html。

### 第三轮执行结果

| 检查 | 命令或场景 | 实际结果 / 未执行原因 |
| --- | --- | --- |
| 分项测试 | `node --test tests/replace-apply.test.mjs tests/verify-desktop-classify.test.mjs` | 通过：21 / 21（另 `replace-preview` 契约测试一并通过） |
| lint | `npm run lint` | 0 error，2 warning（既有；新增脚本无 warning） |
| Node 测试 | `npm test` | 通过：**1069 / 1069** |
| 常规前端构建 | `npm run build` | 通过 |
| 单文件 HTML 构建 | `npm run build:html` | 通过；785.79 kB |
| 单文件产物冒烟 | `dist-single/index.html` 打开预览 + name 范围应用 | 通过：编号/原句显示、译文未被触碰 |
| 桌面 Tauri | `node scripts/verify-desktop.mjs`（真实窗口） | 干净运行 → `partial`（导出未自动确认，如实标出）；注入损坏包 → `fail`；保存回写与模态隔离通过 |

### 第三轮附带发现（未修，范围外）

- 桌面端**原生 `confirm()` 不可用**：capabilities 未授权 `dialog:allow-confirm`，WebView2 里 `window.confirm` 返回 Promise（恒真），确认框不显示、被静默当作同意。涉及 `main.js` 5 处（恢复进度、词典/CSV 导入、应用术语表、批量机翻范围）。**先于本轮存在**，修复需改用 `modals.showConfirm` 并补桌面验收，属新工作项，未纳入本轮。

## 遗留与偏差（截至第三轮）

- E、F 保留为后续候选，未自动实施；G 有历史取消决定，未恢复。
- **已消除**：R1 字段覆盖（第二轮）、R2 快捷键穿透（第二轮）、预览缺原句/编号（第二轮）、回归测试自写提交逻辑（第二轮）、桌面窗口未验收（第二轮）、R3 译名替换升格机翻（第三轮）、R4 脚本判定（第三轮）。
- 记录包导出的自动化确认依赖原生保存对话框（AppActivate + SendKeys），有时序/焦点竞争；第三轮起脚本对"未取得结果"标 `undetermined` 并判为 partial，对"取到文件但无效"判为 fail，不再把两者混同或谎报通过。
- 三主题为计算样式核对（颜色、删除线、边框、无注入），未人工逐屏目检。
- 桌面冒烟覆盖保存与记录包导出；未覆盖外部修改冲突（另存为三选一）与编码拒绝分支。
- 机翻"迟到结果不覆盖批量修改"由 `mtTaskEdit.bump` 承担，只做单元/编排级验证，未接真实 API。
- **第三轮新发现未修**：桌面端原生 `confirm()` 不可用（见上）；`docs/DEVELOPMENT.md:129` 残留剧场契约未处理。
- 预览在超长列表（5000 行）下会一次性渲染全部行 DOM（实测约 0.7s 打开、可滚动）；未做虚拟化——按 5000 行上限规模可接受，数万行需另议。
- 工作区仍有其他任务的未提交修改，本轮为增量修改，未 reset/覆盖/提交。
