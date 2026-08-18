# 更新日志

## [未发布] - MDX/MDD 附属资源完整兼容

- MDX 词条附庸资源完整加载: 外部 CSS(`<link rel="stylesheet">` 指向 MDD)、内联 `<style>`、字体(woff/ttf)、背景图 等经 `url()` 水化为 data URL;图片/音频/视频/object/use 的本地资源同步水化。
- `sanitizeMdxHtml` 保留样式与媒体标签,新增 `sanitizeCss` 去除 `@import`/`expression()`/可执行 `url()` 保障安全;新增纯函数 `extractCssUrls`/`hydrateCssUrls`。
- `mimeFromExt` 扩展 css/字体/视频/PDF 类型;`.dc-html` 补音视频显示样式。
- 浏览器(无 MDD)版自动移除本地 stylesheet link 避免 404,功能不受影响。

## [未发布] - 多文档标签页

- 顶栏新增标签条：一次打开多个 `.txt`，每个标签对应一个文件，点击/✕ 切换关闭；同一文件再次打开聚焦已有标签。
- 快照/恢复机制（`model.js`/`proof.js`/`tabdock.js`）：切换标签时冻结当前文档的段落/撤销栈/校对态/术语表，切回时恢复并重渲染；各标签进度与校对数据仍按文件路径持久化。
- 浏览器会话文件、格式识别导入（canonical）、autoload 保持原路径不进标签体系。

## [未发布] - 校对增强 + 词典增强 + AI 批次上下文

### 校对: 漏翻/异常检测

- 新增「漏翻/异常」清单(校对面板第三个视图 + 顶栏 ⚠ 漏翻 计数): 漏翻(译文空)、占位(译文照抄原文)、长度可疑(译文/原文长度比越界)。
- 校对模式下漏翻/异常行右侧加色条(缺失=红、长度异常=黄);清单条目点击跳转对应行,实时随翻译刷新。

### 词典: 模糊搜索 + 结果分组 + 收藏

- 查词新增「包含匹配」(模糊): 精确/前缀无结果后可做包含式搜索。JSON 词典走内存 contains;MDX 走 Rust 新增 `mdx_search` 词表扫描命令。
- 多词典命中同一词头 → 合并为一张卡片,组内按来源分段展示。
- 新增词典收藏(★): 结果卡片标题旁收藏/取消,侧栏词典面板新增「★ 收藏」视图;持久化在 settings.json(桌面/浏览器一致)。

### 机器翻译: 批次上下文一致性

- 通用大模型「多轮上下文」默认值由 0 调整为 3,翻译当前行/批量自动附带最近 N 句原文+译文;更新配置弹窗说明。

## [5.1.0] - 2026-08-17

### 机器翻译: 通用大模型 + Sakura 离线

- `src/mt.js` 重构为双引擎架构:
  - **通用大模型**(OpenAI 兼容): 自定义接口地址/API Key/模型名/系统提示词,支持温度/top_p/max_tokens/frequency_penalty 采样参数、**SSE 流式输出**(翻译当前行逐字显示)与**多轮上下文**(附最近 N 句原文/译文历史,翻译更连贯)。
  - **Sakura 本地**: 专用离线翻译模型,按模型名自动识别提示词版本(v0.9/v0.10/v1.0/v1.5/GalTransl),术语表按版本格式(v1.0 `<|sep|>` / 其余 `->`)。
  - **llama.cpp 兼容**: 两引擎都直连 llama.cpp 的 OpenAI 兼容端点 `/v1/chat/completions`(默认 127.0.0.1:8080),Sakura 保留旧式 `/completion` 回退。
- 配置迁移: 旧 `settings.mt.sakura` 结构首次启动自动迁入 `settings.mt.providers.*`;旧 Sakura 配置与行为完全保留。
- 机翻配置弹窗改为按引擎动态表单,支持测试翻译(当前引擎,不落盘)、端口检测。
- 新增 `tests/mt.test.mjs`(13 项: URL 归一化/请求体/SSE 解析/提示词/版本识别/配置迁移)。

### 主题: 背景 + 黑白整合 + 字体控制

- 统一「主题」设置弹窗(原「背景」),主题模式深色/浅色/**黑白**三态,`#btnTheme` 快速切换循环;旧 `localStorage` 主题键首次启动自动迁入 `settings.ui.mode`。
- 黑白模式为独立灰阶配色变量集(非整页 filter),背景图同步变灰(`body.theme-bw #bgLayer{filter:grayscale(1)}`)。
- 原文/译文**分别**的字体选择、字号(8–72)与颜色设置,存 `settings.ui.font`,经 CSS 变量 `--orig-*`/`--trans-*` 应用到 `.orig` 与 `textarea.trans`(默认跟随主题)。
- 新增 `src/theme.js` 纯函数与 `tests/theme.test.mjs`(5 项)。

### 验证

- JS 160 项测试全通过(新增 18 项);vite 构建通过;Rust 侧无改动。

## [未发布] - Rust 词典引擎 + SQLite 词典源

### Rust 原生 MDX/MDD 引擎

- `src-tauri/src/mdict.rs`：纯 Rust 实现 MDX/MDD 解析（内存映射，参照 js-mdict 6.0.8 算法）。
- 消除 Base64 over JSON IPC 膨胀：词典不再整体进 WebView，改为句柄式 `mdx_open/lookup/prefix/close` + `mdd_open/resource/close`，查询在 Rust 进程内完成。
- 支持 `@@@LINK` 跨词条跟随（≤3 跳）与大小写兜底（Rust 端）；`Encrypted="2"` 的 key-info 加密（RIPEMD-128 + fast_decrypt）已实现，新世纪讨论版可读；`Encrypted="Yes"` 需密码的词典明确报错。
- Rust 单测 11/11：6 本真实词典（小学馆/新世纪×2/大词泉/Jitendex/明镜）打开、查询、前缀、加密、MDD 资源与损坏文件回归全部通过。

### SQLite 词典源注册表

- `src-tauri/src/dict_cmds.rs` + `src/db.js`：词典源（JSON/HTTP/MDX）注册表迁入 `galtrans.db` 的 `dict_sources` 表（exe 同目录），首次启动自动从 settings.json 迁移旧数据。
- 命令：`dict_list_sources / dict_add_source / dict_remove_source / dict_set_enabled`。
- 浏览器版降级回 settings.json（与 v5.0 一致）。

### 前端适配

- `src/mdx.js`：桌面版走 Tauri 句柄命令（惰性 `mdx_open`），浏览器版保留 js-mdict + node-shims 路径；`createMdxProvider/createPathMdxProvider` 签名不变，`dict.js`/`renderer` 无需改动。
- 未命中时桌面版与浏览器版一致地走前缀补全（≤6 条）。

### 加固与修复

- 修复首次启动 settings.json → SQLite 迁移时 HTTP 词典源丢失 `urlTemplate/map/headers` 配置的问题（`src/db.js` 统一打包 `extra`）。
- `mdict.rs` 全面补边界检查：损坏/截断的 MDX/MDD 一律返回错误而非 panic（新增损坏文件回归测试）。
- 修复 `dispose()` 关闭句柄时误传 `handle: null` 的问题（异步闭包捕获变量）。

### 验证

- JS 142 项测试全通过（含新增 `db`、Tauri Provider 桩测试）；Rust 11 项测试通过（含损坏文件回归）；浏览器版 js-mdict 路径回归通过；桌面 exe 构建成功（含全部 Rust 引擎）。

## [5.0.1] - 2026-08-16

### 性能优化

- 搜索（匹配/计数/全部替换/跳转）移入 Web Worker，输入框防抖 180ms；大文件搜索不再阻塞主线程，Worker 不可用（如单文件 HTML 的 file:// 场景）自动降级为同步路径。
- 格式识别（检测/规范化/还原/编辑器模拟）移入 Web Worker，识别期间界面不卡顿。
- 人名列宽计算加缓存，仅结构性变更时重测（消除搜索路径上的 O(n) 重算）。
- 搜索命中高亮改用 Set 索引，由 O(挂载行 × 匹配数) 降为 O(挂载行)。

### 新增

- `src/debounce.js`（debounce/throttle 工具）、`src/workers/search.worker.js`、`src/workers/recognize.worker.js`、`src/workers-client.js`（Worker 调度器 + 降级）。
- `tests/worker.test.mjs`（11 项：debounce/throttle、worker 消息协议、替换 deltas）。

### 验证

- 全量 128 项测试通过；浏览器实测 5000 行文件搜索 1/5000 处命中与 F3 跳转正常，识别报告含编辑器模拟无损还原 ✓。

## [5.0.0] - 2026-08-16
### 新增

- 统一词典 Provider 接口，支持并发查询多个已启用词典源。
- 支持本地 MDX 词典、galtrans-dict-v1 JSON 词典和可配置 HTTP 词典 API。
- 支持原文/译文划词查询，结果展示词头、读音、词性、释义和例句。
- 支持 MDX `@@@LINK` 变体词跳转、内部 ID 隐藏和第三方词条 HTML 消毒。
- 桌面版持久化 MDX 文件路径，重启后自动恢复，首次查询时懒加载。
- 新增项目快捷片段（缩写展开）和术语/片段输入建议浮层。
- 术语表支持 CSV 导入导出，CSV 使用 UTF-8 BOM 兼容 Windows Excel。
- 新增变高行虚拟滚动，支持大文件滚动、过滤和远距离跳转。
- 新增侧栏拖拽伸缩、宽度记忆和双击复位。
- 新增格式识别 GUI：检测标记、编号、说话人、标签和结构问题，支持规范化/还原。
- 新增校对模式：三态管理、批注、修改记录、过滤、统计和可自定义快捷键。

### 改进

- 术语表人名/词条添加栏移到列表顶部，输入框均分宽度，窄侧栏自动换行。
- 翻译进度改为桌面端 `<源文件>.progress.json`，校对数据改为 `<源文件>.proof.json`。
- 恢复进度改为合并模式：文件自带译文优先，缓存只补空白项。
- 支持 Shift-JIS / EUC-JP 自动检测，原文件保存前自动创建 `.bak`。
- 自动保存防抖统一为 500ms。
- 优化搜索、词条高亮、输入法组合输入和虚拟列表焦点保护。
- README、词典开发指南和测试说明全面更新。

### 验证

- 117 项核心逻辑测试全部通过。
- 实测 Jitendex、大词泉、小学馆日中、新世纪日汉双解和明镜国语辞典等 MDX 词典。
- 同时提供 Tauri 桌面版、NSIS/MSI 安装包和单文件 HTML 版。

## [4.0.1]

- 修复前端动态导入错误、行节点未挂载和进度恢复覆盖文件译文等问题。
- 桌面端进度改为随源文件保存的 JSON 文件。
- 重构为冷灰/深蓝工具型界面。
