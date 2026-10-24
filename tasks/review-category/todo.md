# 实施清单

方案：[plan.md](plan.md)。实施日期：2026-10-11。

## 1. 原生 confirm()/alert()

- [x] 5 处 `confirm()` 改 `showConfirm`（恢复进度、笔记合并、CSV 合并、应用术语表、批量机翻）。
- [x] 3 处 `alert()` 改 `toastError`。
- [x] 新增 `tests/no-native-dialogs.test.mjs`。
- [ ] 桌面 WebView2 实机确认：恢复进度弹窗可见且"不恢复"生效；无 `not allowed by ACL` 页面错误。
- [ ] 浏览器手测：CSV / 笔记 / 空 CSV / 非法词典 JSON / 术语表应用 / 批量机翻取消。

## 2. E 类别筛选

- [x] `editor-navigation.js`：`reviewQueue` 类别参数、`issueCategoryCounts`、`ISSUE_CATEGORIES`。
- [x] `tests/editor-navigation.test.mjs`：6 项新增（类别过滤、去重、manual/annotation 独立、回退 all、旧签名兼容、计数一致）。
- [x] `index.html`：`#reviewQueueCategory`；`main.js`：编排、每标签状态、提示、复位。
- [x] `tests/ui-a11y.test.mjs`：下拉标签与标签页保存/恢复的静态断言。
- [ ] 浏览器交互：逐类验证队列/计数/上一条/下一条/通过并继续、切标签恢复、390px 窄屏。

## 3. 剧场旧文档

- [x] `DEVELOPMENT.md` 剧场节改写为通用教训。
- [x] `ui-design-spec-v4.md` 图标必备集去掉 theater。

## 4. 文档

- [x] `USER_GUIDE.md`、`CHANGELOG.md`、`tasks/README.md`。

## 遗留说明

- 未执行浏览器与桌面交互验收的项目均未勾选，不视为通过。
- 行为变化提示：应用内确认框默认焦点在取消，原生 `confirm` 的 Enter 是确定。
