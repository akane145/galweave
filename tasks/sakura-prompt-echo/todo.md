# 实施清单

- [x] 回归测试先见红，再修复 Sakura 消息构造与旧端点回退。
- [x] 验证用户异常响应被拒绝，正常译文、流式聚合和控制标签保护可用。
- [x] 同步 Sakura 表单、语境设置、角色人设的适用范围说明。
- [x] 同步使用文档与维护契约。
- [x] 审查实际 diff，完成相关测试、lint、双形态构建。

## 验证结果（2026-10-24）

- 执行代理先运行新增回归用例，确认原实现失败，再修复；最终 `node --test tests/mt-sakura.test.mjs tests/mt.test.mjs tests/core.test.mjs` 共 109 项通过，含既有停止/超时、通用模型语境与控制符保护用例。
- 主代理审查新增测试及 `src/mt.js` 的实际修改：仅 Sakura 不再注入通用语境；非流式与流式聚合结果均在返回前校验；旧端点沿用当前版本的消息。界面修改仅适用范围文案。
- `npm run lint`：0 错误，2 条既有未使用函数警告（`toggleTheme`、`toggleStoryRail`）。
- `npm run build` 与 `npm run build:html`：均成功。普通构建仍提示 `src/fs.js` 同时静态/动态导入，未阻断产物生成。
- 单文件 HTML 入口：`dist-single/index.html`。

## 遗留说明

验收使用请求/响应替身；未连接用户实际 Sakura 服务。已有异常译文不会自动覆盖，需在新版重新翻译相关行。

## Windows 重新打包（2026-10-24）

- 用户后续要求重新打包，执行 `npm run tauri -- build --bundles nsis,msi`，退出码 0，保持 5.11.0 完整功能版。
- 新产物已整理至 `release-v5.11.0/`：NSIS 安装包 2,255,701 字节、MSI 安装包 2,924,544 字节、直接运行 EXE 4,994,048 字节。
- 主代理核验直接运行 EXE 的 PE x64 架构及产品版本 5.11.0，MSI 的版本 5.11.0 与模板 `x64;0`；逐一比较原始构建文件与分发副本 SHA-256，并重新读取 `SHA256SUMS.txt` 验证全部匹配。
- 旧的三个标准产物及校验清单备份于 `release-v5.11.0/backup-before-repackage-20261024-190904/`，备份复制时均核对哈希。同目录的设置、数据库及会话文件未覆盖、未加入安装包。
- NSIS SHA-256：`9ae6bce952669c664ece6b2f48e251e79bb066c91f45001e34c83a1a807279d1`。
- MSI SHA-256：`f3315154c3d6af3ad45ca2f60c3048c75c60f8a0bcb4c61e8237c7f4ec6397e6`。
- 直接运行版 SHA-256：`5fa353eaaac0208d99d144416847f74166151578731fc3cf74ea72eea7197b9c`。
- 本次未执行安装或启动桌面应用，不将打包成功表述为真实 Sakura 服务验收通过。

## v5.11.1 发布准备（2026-10-25）

- 用户要求更新版本号并上传 GitHub；版本统一为 5.11.1，覆盖 package.json、package-lock.json 的项目字段、Tauri 配置、Cargo.toml 和 Cargo.lock 的根项目字段，不调整依赖版本。
- 全量 Node 测试 1098 项通过（0 失败、0 跳过），Rust 库测试 38 项通过，lint 0 错误（2 条既有警告），NSIS / MSI / 浏览器版均重新构建成功。
- 分发文件位于 `release-v5.11.1/`；主代理核验 EXE / MSI 的 5.11.1 版本与 x64 架构，复制前后哈希一致。浏览器 ZIP 仅含 index.html 与两个 worker；四个分发文件的 SHA-256 已写入校验清单。
- GitHub 发布目标为 `akane145/galweave` 的 `v5.11.1`；源码标签须对应当前经过测试的产品源码，附件先以草稿上传并核对远端摘要后再公开。
- 个人设置、数据库、会话文件、真实游戏样本、构建缓存和本地 agent 配置均不加入发布附件或本次源码暂存清单。此前本地的其他产品改动已在 README / CHANGELOG / 发布说明中明确列入此版。
