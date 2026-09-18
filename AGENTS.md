# AGENTS.md — Galweave 工作约定

## 项目

- **名称**：Galweave（视觉小说 galgame 日译中辅助翻译工具）
- **形态**：Tauri 桌面版 + 单文件 HTML 双形态；前端原生 ES Modules，无框架
- **技术栈**：Vite + 原生 JS（ES Modules）+ Tauri（Rust 侧在 `src-tauri/`）
- **入口**：`index.html` → `src/main.js`；样式集中在 `src/style.css`
- **测试**：`tests/*.mjs`，`node --test`

## 目录职责

| 目录 | 内容 |
|---|---|
| `src/` | 前端源码（49 个 .js + style.css）。纯逻辑模块不得依赖 DOM |
| `src/workers/` | Web Worker（解析、搜索等重活，2 个 worker） |
| `docs/` | `DEVELOPMENT.md`（含**维护契约**：阈值/上限的约定值与改动纪律）、`USER_GUIDE.md`、`obsidian-integration.md`、`RELEASE_NOTES.md` |
| `tests/` | node --test 单测（35 个 .test.mjs） |
| `scripts/` | 构建 / 打包 PowerShell + mjs 脚本 |
| `src-tauri/` | Rust 侧（target/ 为构建产物，勿提交） |

## 工作方式（对 agent 的硬要求）

1. **先读后判**。任何界面/架构/重构建议，必须先读实现，结论要能指到 `文件:行号`。泛泛而谈的建议不写。
2. **规划与执行分离**。master 说"只规划"时，不写任何业务代码，只出方案。方案每一条必须带 **优先级（高/中/低）** 和 **工作量估算（人日）**。
3. **纯逻辑必须无 DOM 依赖**，配 `node --test` 单测，与项目既有约定一致。
4. **不阻塞式提问**。信息缺失时先做未受阻的部分，把卡住的问题集中列出来一次性问。
5. **凭据只记位置不记值**；代码里能查到的东西不复制到记忆文件。
6. **维护契约集中在 `docs/DEVELOPMENT.md`**。改动阈值/上限（qa/proof 检查阈值、快照份数与间隔、字节上限、撤销栈深等）必须同步该文档的「维护契约」节与对应单测——原 `docs/ROADMAP.md` 已于提交 096b28c 删除，不要再引用它。
7. **不重复实现既有能力**。新增检查/UI 前先确认是否已有同类逻辑（如 qa.js 的术语检查、proof.js 的漏翻检查、universal-parser.js 的控制符保护），复用优先，避免两套阈值两套说法。

## 已定前提（master 答复）

- **Q3 目标引擎：不做引擎预设。** 不硬编码任何具体引擎的规格常量；容量阈值一律走用户可配（对齐 `src/bytes.js` 的 `BYTE_LIMIT_DEFAULT`）。原建议书 §二.1 的引擎预设与 §二.2 的按引擎换算均作废。
- **Q4 协作模式：单人使用。** XLIFF / PO 等多人流水线交换格式不做；`docs/obsidian-integration.md` 的"不反向覆盖脚本"单向边界保持不变。
- **Q5 单文件行数规模：5000 行以内，多数 1000–3000。** 因此**小地图（原 E）与 Worker 扩展（原 H）整项取消** —— 该量级下收益不存在，共省 8.5 人日。若将来出现数万行单文件再按需启用。
- **Q6 机翻以逐行为主。** 上下文注入优先做单句链路；批次模式（`translateLinesBatched`）一次请求只能带一份语境，多角色混排会丢其余人设，属有意取舍。
- **Q7 背景图需要保留。**

## 项目事实（已固化）

- **目标平台**：Windows x64（构建目标是 `nsis` + `msi`；macOS 与 Linux 未验证）
- **代码规范工具**：**ESLint**（`eslint.config.mjs`，仅 `no-undef`(error) + `no-unused-vars`(warn)，不含格式化；`npm run lint`）。**不引入 Prettier** —— 引入会一次性重排大量既有文件、污染 `git blame`；现有约定够用
- **测试命令**：`npm test`（= `node --test "tests/*.test.mjs"`；注意 `node --test tests/` 在 Windows 上会参数解析失败）
- **文档分工**：`docs/` 放长期使用与维护文档；`tasks/` 放单个功能的设计与实施记录（完成后不删，取舍理由留档）

---

_本文件由 agent 创建并随项目演进维护；「已定前提」「项目事实」两节为固化内容，改动需在提交信息里说明理由。_
