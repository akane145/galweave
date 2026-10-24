# 检查队列按类别筛选 + 桌面确认框修复 + 剧场旧文档清理

日期：2026-10-11。基线：未提交工作区，v5.11.0，HEAD `74b42c9`。
本轮是三件互不依赖的小改动，按"现存缺陷 → 新能力 → 文档收尾"排序。

## 1. 桌面端原生 confirm()/alert() 修复（高）

来源：`tasks/translation-ux-handoff/review.md` 第四轮附带发现。

- `src-tauri/capabilities/default.json` 只授权 `dialog:allow-open` / `dialog:allow-save`。WebView2 下 `window.confirm` 被 ACL 拒绝，返回 Promise（恒真），确认框不显示且默认同意。
- 5 处 `confirm()`（恢复进度、笔记术语合并、CSV 术语合并、应用术语表、批量机翻开始）改用既有 `modals.showConfirm`；3 处 `alert()` 改 `toastError`。
- 取舍：
  - 不给 Tauri 加 capability：`showConfirm` 与浏览器版同一实现，两种形态行为一致，也不扩大 ACL 面。
  - `alert` 改 toast 而非新对话框，不扩公共 API。
  - 沿用 `showConfirm` 默认焦点落在取消（v3 §8.5 L3）。"恢复进度""开始批量机翻"这类建设性确认下，Enter 因此等于取消——这是相对原生 `confirm`（Enter=确定）的行为变化，如要改需给 `showConfirm` 增加焦点选项。
  - 批量机翻"TM 先套用、后确认"的既有顺序不动。
- 回归防护：`tests/no-native-dialogs.test.mjs` 静态禁止 `src/**/*.js` 出现裸 `confirm(` / `alert(` / `prompt(`。

## 2. E：检查队列按问题类别筛选（中）

来源：`tasks/translation-ux-handoff/plan.md` §5 后续候选 E。

- 纯逻辑在 `src/editor-navigation.js`：`reviewQueue(paras, kind, diagnostics, category)` 的 `diagnostics` 兼容行号数组（旧）与 `{i,kind}[]`（新）；新增 `issueCategoryCounts`、`ISSUE_CATEGORIES`。
- 类别：`all`（原并集）/ 7 种自动诊断 / `manual`（人工标记）/ `annotation`（未解决批注）。人工与批注独立成类，不冒充自动诊断。
- 计数口径：队列与下拉计数按**行**去重；诊断清单仍按**条**。两者不混用。
- 不新增阈值、不改诊断：全部来自 `proof.analyzeRows()` / `qa.analyzeQA()`，计数复用 `refreshProofUI` 里已算好的 `missingIssues()`，不重复分析。
- 状态：按标签页保存（`flushDocToTab` 的 `reviewCategory`），`afterDocActivated` 恢复；`finishLoadSource` 载入新文档时复位 `all`；「下一问题」按钮复位 `all`（其语义是"任意问题"）。
- 类别无命中时 toast 区分"该类别下没有问题"与"队列已完成"。
- 不做：问题类别的持久化（跨重启）。下拉只在 `kind==='issues'` 时显示。

## 3. 剧场旧文档清理（低）

- 功能已于 2026-09-19 整功能移除，`src/`、`tests/` 无任何残留。
- `docs/DEVELOPMENT.md`「剧场视图」整节改写为通用教训「量尺寸并写 inline 样式的函数」，去掉对已不存在符号（`state.theater()`、`speakerSlot` 等）的引用，保留有价值的排查经验。
- `docs/ui-design-spec-v4.md` 图标必备集由 16 枚改为 15 枚。
- 不恢复功能；G（连贯阅读）仍暂缓。
