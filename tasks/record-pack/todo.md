# 实施记录

设计决策与取舍理由见同目录 `plan.md`。

## 记录包核心（src/record-pack.js）

- [x] `createRecordPack` 白名单序列化：脚本原文/译文、解析规则、离线格式档案、术语表、翻译记忆、机翻基线、快捷片段、历史快照、统计、修改记录、编辑位置。
- [x] `readRecordPack` 完整校验后再返回，任何一步失败都不改动现有状态。
- [x] 版本与类型校验（`galweave-record-pack` / `version: 1`）。
- [x] 64 MiB 上限（`RECORD_PACK_MAX_BYTES`）。
- [x] `JSON.parse` reviver 拒绝 `__proto__` / `constructor` / `prototype`。
- [x] 解析规则**临时生效并 `finally` 还原**，异常路径也还原。
- [x] 逐行比对原文 + 行数一致校验，任一不符整体拒绝。
- [x] 修改记录（changes）与脚本行/字段交叉校验。
- [x] 离线格式档案（v1 与 v2）随包携带，往返后导出仍只改译文字段。

## 存储隔离（不写用户真实文件）

- [x] `model.setRecordKey` / `getStateKey()` 优先返回记录键。
- [x] `glossary.activateGlossary(value, dir, key)`：有 key → `portableKey`，写 `record-gloss:<key>`。
- [x] `history` / `stats` / `tm` / `mtbaseline` 以 `isAbsPath` 分流 → 记录包文档走 IndexedDB。
- [x] `proof` 用 `proofKey` 而非路径。
- [x] 快捷片段写 `record-snippets:<key>`。
- [x] 标签快照携带并恢复 `recordContext` / `parseConf` / `glossProjectDir` / `browserHandle`。
- [x] 打开普通文档时清空 `recordKey` 与 `recordContext`。

## 界面接线（src/main.js、index.html）

- [x] 「导出记录包」/「导入记录包」按钮 + 隐藏 file input。
- [x] 导出前完整自校验（`readRecordPack(raw)`），确保另一设备能重建。
- [x] 导入先弹确认框展示摘要（行数 / 批注数 / 记忆数 / 历史份数）并说明"独立标签、不覆盖"。
- [x] 导入前冻结当前活动文档（`flushDocToTab`），当前工作不丢。
- [x] 导入后 `docDirty = true`，保存按钮重定向到导出记录包（无磁盘路径可写）。
- [x] 历史快照逐份写入本机，部分失败时明确提示保留原包。
- [x] 机翻任务运行中禁止导入/导出，避免与在途结果交叉。
- [x] 记录包文档的快捷片段面板显示"随记录包携带"而非项目路径。

## 顺带修掉的两个保存缺陷（检查待打包代码时发现）

- [x] **目录创建失败被报成成功**：`write_atomic` 建目录失败时仍继续，最终返回 OK。现在如实返回错误（`failed_parent_creation_is_not_a_successful_save`）。
- [x] **原子替换失败会退回直接覆盖**：原本 rename 失败后退化 `fs::write`，那正是"可能截断原文件"的路径。现在**失败即失败，保留原文件**并提示关闭占用程序或另存为；同时把临时文件名加上时间戳避免并发撞名（`failed_atomic_replace_preserves_original_without_direct_write_fallback`）。
- [x] `write_app_file` 同步：目录/写入失败上报，不再静默成功。

## 验证

- [x] `tests/record-pack.test.mjs` 4 项：往返保真与不泄漏设备配置、错误版本/错行/危险键拒绝且不改变解析配置、离线 v1/v2 档案往返、未通过格式门禁的草稿仍可打包（恢复后仍由导出门禁阻止破坏结构）。
- [x] `cargo test --lib` 38 项（含上述两个保存缺陷的回归测试）。
- [x] `npm test` 1007 项、`npm run lint` 0 error、`npm run build` 与 `npm run build:html` 通过。
- [x] 浏览器端到端（Playwright，真实 Chromium）：
  - 导入既有脚本 → 导入记录包 → 变成 3 个独立标签，原有未保存修改仍在；
  - 记录包文档里改译文 → 切走再切回，改动保留；
  - 导出 → 用 `readRecordPack` 审查导出内容：译文/批注/术语/片段/记忆（含 `confirmed` 状态）齐全，**不含 apiKey、不含本机路径**；
  - 重复导入同名包 → 第 3 个独立标签，先前的标签不受影响；
  - 校验门禁实测：行数多一条/少一条、原文被改、超 64 MiB、`__proto__` 注入全部拒绝，且全局 `Object.prototype` 未被污染。

## 打包

- [x] 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` → 5.11.0（`Cargo.lock` 随构建更新）。
- [x] `npm run tauri -- build --bundles nsis` 打包成功；`release-v5.11.0/` 放入安装包、直接运行版与 `SHA256SUMS.txt`。
- [x] exe 实机启动验证：进程存活、`FileVersion` / `ProductVersion` 均为 5.11.0。
- [x] **修复打包缺陷**：构建脚本从不清空输出目录（见下）。

## 顺带修掉的打包缺陷

`vite.config.js` 设了 `emptyOutDir: false`（WorkBuddy 环境给 `rmSync` 套了 safe-delete shim，
删除计数超阈值会要求交互确认，在 tauri 非交互子进程里直接抛错），并把清空交给注释里写的
"构建前的 shell `rm -rf dist`" —— **但那条命令从未存在过**。后果：每次构建都把上一版带哈希的
资源留在 `dist/` 并**原样打进安装包**。

实测：首次打包前 `dist/assets` 积了 **72 个文件**（其中 17 个是历次构建的 `index-*.js`），
安装包 3.31 MB；清空后重新打包 **2.25 MB**（功能更多反而更小，差额即陈旧资源）。

修法：新增 `scripts/clean-dist.mjs`，接进 `build` / `build:no-mt` / `build:html` 三个脚本，
并把三处版本号与产物约定写进 `docs/DEVELOPMENT.md` 的「常用检查」「发布约定」。
清空**失败只告警不中断打包**（清空是优化，不该阻断发版），但会列出剩余文件数。
已验证连续两次构建都不累积（均为 14 个文件 / 1 个 index 包）。

## 遗留说明

- **未做 WebDAV / 应用内自动同步**：两份离线改动涉及脚本结构级合并，做不彻底比不做更危险（同 `reliability-round` 不做事三方合并的理由）。
- **未做整项目打包**：第一版以「当前脚本及其记录」为单位。
- **进度文件不打包**：记录包已含最终译文；同时携带会与 `rows[].translation` 产生"该信哪个"的歧义。
- 浏览器验证脚本 `verify-browser.mjs` 需要 `PLAYWRIGHT_MODULE` 指向可用的 Playwright 运行时；本机没有独立安装，本轮改用 Playwright MCP 在真实 Chromium 中完成等价验证（步骤见上）。
- 顺手修正一处显示歧义：读入编码**未知**时不再显示成「未知 → 写出：UTF-8」（看着像编码被换掉了，其实只是无从得知）；只在两边都明确且确实不同时才标出箭头。
