# 实施记录

来源：与 ChatGPT 讨论"前端和后端还有什么需要增加的功能或优化"后，master 选定要一起实现的一组可靠性改动。
设计决策与取舍理由见同目录 `plan.md`；阈值与纪律已同步到 `docs/DEVELOPMENT.md`。

## 保存安全

- [x] Rust `write_atomic`：同目录临时文件 → `sync_all` → `fs::rename` 替换，不留残文件。
- [x] 后续回归修正：rename 失败立即返回错误，保留原文件，禁止退化为直接覆盖；目录创建失败同样不能报告成功。
- [x] `backup_once` 返回 `created/exists/skipped/failed`，失败带原因；前端翻成可读提示。
- [x] `write_app_file`（settings.json）同样改走原子替换。
- [x] 单测：原子路径无残留、备份状态四态、缺父目录自建、编码往返。

## 外部修改检测

- [x] Rust `file_stat`：size + mtime + FNV-1a 内容散列。
- [x] `src/fileguard.js` 纯逻辑：指纹归一化 / 同内容判定 / 四种情形判定 / 冲突文案 / 选项顺序。
- [x] 打开时记指纹，写盘前比对；变化时弹三选项，**"另存为"排第一并获得默认焦点**。
- [x] 取不到指纹归 `UNKNOWN` 且不阻断保存（浏览器版无 file_stat）。
- [x] 单测：散列优先、缺维度不误报、UNKNOWN 不阻断、字段名契约、默认不覆盖。

## 机翻停止与重试

- [x] `src/mt-task.js` 任务状态机（pending/done/failed/stopped/edited）+ 单测。
- [x] `mt.js` `MtAbortError` / `isMtAbort`：停止与失败分开。
- [x] abort 贯通 provider 链（`translateText` / `translateBatch` / `translateTextProtected` / `translateLinesBatched`）。
- [x] **超时覆盖正文读取**：`openGuardedRequest` + `makeAbortGate`，gate 排数组第一位；发请求前 `throwIfAborted`。
- [x] 超时可配（默认 90 秒，5–600 秒），配置面板加"单次请求超时（秒）"。
- [x] 停止保留已完成结果；未处理行标 STOPPED（不算失败、不进重试清单）。
- [x] 只重试失败行，可反复重试到成功。
- [x] 迟到结果不覆盖人工修改（行编辑版本号 `createEditTracker`，人工写入路径 `bump`）。
- [x] `showMtTaskPanel` 常驻面板：进度条 + 失败清单（可点击跳行）+ 停止 + 重试按钮。
- [x] 单测：停止保留、只重试失败、迟到保护、超时覆盖正文读取、signal 透传、空任务安全。

## 编码选择

- [x] `src/encoding.js` 纯逻辑：编码清单 / 别名归一 / 可写性 / 沿用原编码 / 风险提示。
- [x] Rust `decode_with_name`：按指定编码强制解码（自动检测猜错时纠正）。
- [x] Rust `encode_text`：**UTF-16 手写码元**（不能用 encoding_rs 的 encode）；无法表示的字符默认拒绝。
- [x] `read_file` / `write_file` 接受 encoding 参数；`fs.js` 透传。
- [x] 保存默认沿用读入编码（`model.sourceEncoding`，随标签快照）。
- [x] 顶栏显示"编码：读入 → 写出"，不一致时显式标出；点击可纠正（含按指定编码重新解码）。
- [x] 保存因编码失败时给三个出路：改用 UTF-8 / 强制写入 / 取消。
- [x] 单测：别名归一、可写性、沿用原编码、中文+非 UTF-8 警告、BOM 提醒；Rust 侧 UTF-16/BOM/拒绝 lossy 往返。

## 翻译记忆改进

- [x] 条目加 `status`（draft/confirmed）与 `name`（说话人）；`TM_VERSION` 升到 2。
- [x] **自动套用只认已确认**（`findConfirmed`）；草稿仍可人工挑选。
- [x] 收割归因：`p.src === 'human'` 或行已通过校对 → confirmed；其余 → draft。
- [x] 已确认条目不被同句机翻草稿降级。
- [x] 同句不同说话人变体共存（主键 `key + name`）；查找退回通用条目，不拿别的角色顶上。
- [x] 侧栏建议显示来源与审核状态，并列出同句全部角色变体。
- [x] 核对准确：套用记忆即标为已确认；行菜单加「确认这条记忆（以后自动套用）」。
- [x] v1 → v2 迁移：老数据缺 status 迁为 confirmed，不让老用户记忆失效。
- [x] 单测：分级、只自动套用已确认、变体共存、说话人匹配三条规则、v1 迁移、收割归因、幂等。

## 验证

- [x] `cargo test --lib` —— 36 项通过。
- [x] `npm test` —— 999 项通过。
- [x] `npm run lint` —— 0 error（2 个既有 warning 与本次无关）。
- [x] `npm run build` / `npm run build:html` —— 均通过。
- [x] 浏览器实测：冲突对话框、机翻任务面板、TM 分级与变体、编码选项与提示。

## 遗留说明

- 测试过程中暴露并修复了三个**真 bug**（UTF-16 编码器语义、race 顺序导致停止失效、超时未从配置传入）；
  浏览器实测又暴露一个**接线 bug**（`conflictChoices` 的字段名与 `showChoice` 的契约不一致 → 空对话框）。
  四者都记在 `plan.md`，因为它们正是"纯逻辑单测全绿也不代表功能可用"的实例。
- 未跑 `tauri build`：桌面安装程序未重新打包（需要完整的 Rust 链接环境与较长耗时）。
  二进制行为已在 `cargo test` 覆盖（原子写、编码往返、指纹），但**端到端 exe 验证留待打包时**。
- 冲突检测与多编码写出**仅桌面版**有效；浏览器版把不支持的能力显式标为 disabled 并说明原因，不假装支持。
- 未做机翻自动重试（带退避）与三方合并 —— 有意取舍，理由见 `plan.md`。
