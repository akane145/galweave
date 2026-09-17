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

纯逻辑模块应保持无 DOM 依赖。修改记录的测试位于 tests/proof.test.mjs，包含超过 500 行、反复输入、状态恢复和输入结算等场景。

## 发布约定

源代码提交到 Git，二进制放在 GitHub Releases；不提交 node_modules、target、个人配置、真实词典、临时截图或新增真实游戏脚本。发布标签对应被测试的源码提交。

当前校对记录按行号、原文标识和字段合并；首次记录的 before 保留，后续只更新 after。旧版数据按原有最新在前的顺序合并。若旧版已丢失最早记录，只能保留尚存的最早文本，不能重建已丢失内容。

部分解析与格式识别测试使用本地游戏样本；样本不随源码公开分发，缺少时只跳过这些样本测试，内置构造数据测试照常执行。
