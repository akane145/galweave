# Galweave

视觉小说（galgame）日译中辅助翻译与校对工具。当前发布版本：**v5.4.0**（2026-10-25）。

## 下载

前往 [GitHub Releases](https://github.com/akane145/galweave/releases/tag/v5.4.0) 下载：

- Galweave_5.4.0_x64-setup.exe：Windows x64 安装版。
- Galweave_5.4.0_x64_en-US.msi：Windows x64 MSI 安装包。
- Galweave_5.4.0_x64.exe：直接运行版，需要 WebView2 运行时。
- Galweave_5.4.0_browser.zip：浏览器版，解压后保留全部文件并打开 index.html。
- SHA256SUMS.txt：下载文件的 SHA-256 校验值。

## 主要功能

- 原文只读，译文与译名编辑；搜索替换、撤销重做、自动保存与本地版本快照。
- 文本格式识别、规范化与还原，保护原文及引擎标记。
- MDX/MDD、JSON、HTTP 词典，项目术语、快捷片段与翻译记忆。
- 通用大模型与 Sakura 机翻，支持术语及批量翻译；上下文参考与角色人设用于通用大模型，Sakura 使用专用提示词。
- 校对状态、批注、漏翻检查与修改对比；每行每字段只保留首次修改前和最新文本，中途输入自动合并，不设 500 条上限，列表完整展示。
- 校对意见导出 Markdown、选定改译收藏到 Obsidian。
- 多标签编辑、主题、字体和背景设置。

## 文档

- [使用指南](docs/USER_GUIDE.md)
- [Obsidian 联动](docs/obsidian-integration.md)
- [开发说明](docs/DEVELOPMENT.md)
- [更新日志](CHANGELOG.md)
- [本版发布说明](docs/RELEASE_NOTES.md)

## 开发与构建

仓库保留源码、测试、长期文档和可复用工具：

| 目录 | 用途 |
|---|---|
| `src/` | 前端源码与 Web Workers |
| `src-tauri/` | Windows 桌面端与构建资源 |
| `tests/` | 自动化测试 |
| `docs/` | 使用指南、维护契约和发布说明 |
| `scripts/` | 构建、格式工具与集成验证 |
| `vscode-extension/` | 可单独使用的 VS Code 辅助插件 |

安装包与浏览器版放在 Releases；任务过程记录、个人 agent 配置、临时截图和运行数据只保留在本地。

安装支持 Vite 8 的 Node.js（建议 22.12+）、Rust stable、Windows C++ Build Tools 和 WebView2。

```sh
npm ci
npm run tauri -- dev
npm test
npm run lint
npm run tauri -- build --bundles nsis
```

程序位于 src-tauri/target/release/galweave.exe；安装包位于其 bundle/nsis/ 目录。
浏览器版执行 npm run build:html，发布时保留 dist-single 内全部文件。
无机翻版本执行 npm run tauri:build:no-mt。本次 Release 提供标准桌面版。

## 数据说明

桌面校对数据保存在源文件目录的 .galweave 内；浏览器版使用 IndexedDB。
旧版被截断的历史无法自动恢复；升级会合并仍存的旧记录。清除进度会删除对应校对数据。
源码不包含个人配置、词典、临时截图或新增的真实游戏脚本。
