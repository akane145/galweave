# Galweave

> 视觉小说（galgame）文本 日译中 辅助翻译工具。
> 原文锁定、译文可编辑，逐段翻译 + MDX/JSON/HTTP 词典 + 项目术语与片段 + 本地 Sakura 机翻 + 校对工作流。

## ✨ 主要特性

- **机器翻译双引擎**：通用大模型（OpenAI 兼容，流式输出、多轮上下文、自定义提示词）+ Sakura 本地离线模型，兼容 llama.cpp。
- **词典生态**：MDX / JSON / HTTP 三类词典统一接入，原文/译文划词查询，第三方词条 HTML 安全消毒；桌面版记住路径、重启自动恢复。
- **主题与排版**：深色 / 浅色 / 黑白主题、背景图片；原文与译文可分别设置字体、字号、颜色。
- **术语与片段**：项目术语表（JSON/CSV 导入导出）自动填充人名；译文输入时术语/片段浮层提示。
- **校对工作流**：待校对 / 有问题 / 已通过三态、批注、修改记录、过滤与可定制快捷键。
- **大文件编辑**：变高行虚拟滚动，只挂载可视窗口；撤销重做、自动保存、编码自动检测。

完整操作见 [使用教程.md](使用教程.md)；格式适配见 [使用说明-格式识别与正则.md](使用说明-格式识别与正则.md)；词典适配见 [docs/dictionary-plugins.md](docs/dictionary-plugins.md)；历史版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## ✨ 功能

| 类别 | 功能 |
|---|---|
| **文本格式** | ☆/★ 两行一段解析（内联说话人 / TEXT / NAME / 空说话人旁白）；标记字符与识别正则可配置（⚙ 规则） |
| **翻译** | 原文只读锁定；译文自动增高软换行；译名框 + NAME 行只读跟随；「」括号锁定；复制原文 |
| **导航** | Tab/Enter/Shift+Tab 切行；Ctrl+G 跳转行；窗口化滚动 |
| **搜索替换** | 4 种范围（原文+译文 / 仅原文 / 仅译文 / 仅名字）；区分大小写；原文永不修改 |
| **术语表** | 项目制（存文件目录 glossary.json）；人名自动填充；词条高亮点击插入；批量应用；JSON/CSV 导入导出 |
| **词典** | 统一查询接口 + Provider 适配器（**MDX 词典** / 本地 JSON 词典 / 可配置 HTTP 词典）；划词查词；侧栏词典面板 |
| **片段** | 快捷片段（缩写→展开，项目制 snippets.json）；译文输入时术语/片段浮层提示，Tab 采纳 |
| **机器翻译** | 双引擎：通用大模型（OpenAI 兼容，流式/多轮上下文）+ Sakura 本地（提示词版本自动识别）；兼容 llama.cpp；携带术语表；端口检测；对话只发「」内原文 |
| **可靠性** | 撤销/重做（Ctrl+Z/Y）；500ms 防抖自动保存；Shift-JIS/EUC-JP 编码自动检测；保存前 .bak 备份 |
| **文件** | 保存写回原文件；导出译文副本；文件夹浏览器；拖拽导入；清空翻译 / 清除进度 |
| **界面** | 深色/浅色/**黑白**主题；背景图片；原文/译文分别的字体·字号·颜色 |
| **双形态** | Tauri 桌面 exe + 单文件浏览器 HTML（除本地机翻外全功能） |

## 📸 截图

> 待补充：导入文件 → 翻译界面；术语表面板；机翻配置；浅色主题。

## 形态与差异

- **桌面版**（exe / 安装包）：全部功能，含 Sakura 本地机翻。
- **单文件 HTML 版**：`npm run build:html` 产出 `dist-single/index.html`（全部内联），浏览器直接打开即用；
  除**本地机翻**外全部功能，并实现了浏览器内的：
  - Shift-JIS / EUC-JP 编码自动检测
  - 「保存原文件」直接写回（File System Access API，Chrome/Edge；不支持则另存为→下载）
  - 文件夹浏览器（showDirectoryPicker 递归树）
  - Firefox 等不支持文件系统 API 时自动降级

## 环境要求

- Node.js ≥ 20
- Rust 工具链（`rustup` + stable）
- Windows: VS 2022 Build Tools（C++ 桌面开发工作负载）
- WebView2 运行时（Win10/11 自带）

## 开发运行（热更新）

```bash
npm install                 # 前端依赖(含 @tauri-apps/cli)
npm run tauri dev           # 启动 Vite(1420) + Rust 调试窗口
```

## 构建安装包

```bash
npm run tauri build
```

产物（`src-tauri/target/release/bundle/`）：
- `nsis/Galweave_5.0.1_x64-setup.exe`（安装器）
- `msi/Galweave_5.0.1_x64_en-US.msi`（MSI）
- 裸可执行文件：`src-tauri/target/release/galtrans.exe`（免安装直接运行）

## 单元测试（核心逻辑，无需浏览器）

```bash
node --test tests/core.test.mjs       # 解析/术语表/搜索/撤销重做
node --test tests/recognize.test.mjs  # 文本格式识别/规范化/还原/校验
node --test tests/proof.test.mjs      # 校对模式(状态/批注/修改记录/统计)
node --test tests/virtual.test.mjs    # 虚拟滚动高度模型(前缀和/可见范围/隐藏行)
node --test tests/dict.test.mjs       # 词典Provider/CSV/输入建议/片段
node --test tests/mdx.test.mjs        # MDX适配器(fs/zlib shim/结果映射/消毒)
```

覆盖：文本解析（4 个示例文件全量 + 无损还原）、识别模块（13 个 test text 示例全量跑通：
12 个字节级无损还原 + 注释行文件内容保留）、校对模式（三态切换/批注联动/修改记录/还原）、
术语表、搜索替换、撤销/重做、虚拟滚动高度模型、词典框架/CSV/输入建议/片段。

## 目录结构

```
src/           前端 ES Modules
  parsers.js   解析/导出/词条扫描
  recognize.js 文本格式识别/规范化/还原(纯逻辑,CLI 与 GUI 共用)
  proof.js     校对模式(状态/批注/修改记录/持久化,纯逻辑,可单测)
  model.js     数据模型 + 撤销重做 + 防抖自动保存
  renderer.js  窗口化渲染 / 高亮 / 聚焦
  virtuallist.js 虚拟滚动高度模型(实测+估算+隐藏行,纯逻辑,可单测)
  search.js    搜索/替换/跳转
  glossary.js  术语表(人名/词条)
  dict.js      词典 Provider 框架(JSON/HTTP 适配器)
  suggest.js   输入建议匹配(术语/片段)
  snippets.js  快捷片段存储(全局+项目)
  csv.js       CSV 解析与术语表互转
  mdx.js       MDX 词典适配器(js-mdict + 浏览器 Node shim)
  node-shims/  js-mdict 的 node:fs/zlib/assert 浏览器替代
  mt.js        机器翻译 Provider 框架(通用大模型 + Sakura,兼容 llama.cpp)
  theme.js     主题/字体纯逻辑(模式循环/默认合并)
  fs.js        文件读写(Tauri 命令) + 进度存储(<源文件>.progress.json / IndexedDB 兜底)
  main.js      模块编排 / 事件 / 快捷键
scripts/       独立工具脚本
  recognize-format.mjs  文本格式识别 CLI(识别 / 规范化 ☆/★ / 还原 / 编辑器模拟校验)
src-tauri/     Rust 后端
  src/lib.rs   read_file(编码检测) / write_file(自动备份) / remove_file / list_dir(目录树)
tests/         核心逻辑单元测试
```

## 数据文件

- 翻译进度：**桌面版存 `<源文件>.progress.json`**（与源文件同目录的明文 JSON，随文件走、可随时备份/查看/手动恢复，彻底摆脱"进度锁死在浏览器缓存里"的问题）；源文件目录不可写时自动降级 IndexedDB（浏览器版固定走 IndexedDB）。恢复进度：打开文件时弹窗选「恢复」，或随时点「恢复进度」按钮；点「不恢复」不再删除进度文件。
- **术语表（项目制）**：以当前打开文件所在目录为"项目"，术语表存 **`<项目目录>/glossary.json`**——同目录多个文件共享一份术语表，随项目走。项目目录不可写时回退软件目录全局 `glossary.json`（再回退 localStorage）。未打开文件时用全局术语表。侧边栏术语面板顶部显示当前归属。
- 解析规则 / 机翻设置：`settings.json`（**与 exe 同目录**）
- 保存原文件前自动生成同名 `.bak` 备份（仅首次）

## 解析规则可编辑（合并「格式/规则」弹窗）

顶部「格式/规则」按钮打开合并弹窗：**① 自动识别格式**（选当前文件/粘贴 → 识别 → 一键
「应用为解析规则」或「规范化并载入编辑器」/ 下载档案），**② 手动规则**（原文/译文标记字符、
自定义前缀正则——第 1 捕获组=前缀、第 2 捕获组=正文——带测试框实时预览）。
保存后重新导入文件生效。默认：`☆` 原文 / `★` 译文。

## 校对模式（📋 校对）

顶部「📋 校对」开关（桌面 exe 与单文件 HTML 都带），提供三个协同功能，适合翻译后通读把关：

1. **状态管理**
   - 每行三种状态：待校对 / 有问题 / 已通过；行内「✓ 通过」「⚠ 有问题」按钮切换，行左侧色条标识。
   - 校对工具栏可按状态过滤列表、看统计、跳下一处问题。
2. **批注系统**
   - 行内「📝」按钮展开批注区，支持 问题/建议/疑问/备注 四种类型。
   - 侧边栏「校对 → 批注总览」集中查看、跳到、解决。
   - 新增未解决的「问题/疑问」批注 → 该行自动标「有问题」；全部解决 → 自动回「待校对」。
3. **修改记录**
   - 校对模式下记录译文/译名修改（整句粒度：输入停顿 1200ms 或失焦时结算；替换/撤销/重做/批量/还原也记录）。
   - 侧边栏「校对 → 修改记录」查看每次改动（修改前 → 修改后，最新 50 条，最多 500 条）。
   - 点「还原」把该行改回修改前，可 Ctrl+Z 撤销还原。

快捷键（可自定义，工具栏「⌨ 快捷键」）：默认 `Q` 通过并跳下一行、`W` 有问题、`A` 批注；
单键需在校对模式开启且焦点在译文/译名框时生效，组合键（如 Ctrl+Shift+K）任意位置可用。
设置存 `settings.json` 的 `proof.keys`。

校对数据（状态/批注/修改记录）：桌面版存 **`<源文件>.proof.json`**（随文件走，便携）；
浏览器版存 IndexedDB。「清除进度」会一并删除该文件的校对数据。
已通过行再次发生文本变化时，旧通过状态自动失效。

## 文本格式识别脚本（scripts/recognize-format.mjs）

**背景**：编辑器规则只支持「一对标记字符 + 一个 2 捕获组前缀正则」。`test text/` 里的
示例文件格式五花八门，直接导入会识别不准，例如：

| 示例文件 | 格式特征 | 直接导入的问题 |
|---|---|---|
| 新建 文本文档 (9).txt | `○`/`●` 标记 | 默认 ☆/★ 下全部行无编号 |
| 第二种.txt | `○00000\|000008\|003○ [[照]] 「…」[np]` | 名字在正文 `[[ ]]` 内，名字栏不可用 |
| 第一种.txt | `#NOTTRANS` 与正文同段 | 注释行被当作原文行，正文行丢失 |
| 新建 文本文档 (11).txt | ★ 行编号整体错位 | 编辑器盲目配对，导出会改写编号 |
| 新建 文本文档 (3).txt | `000001N` 后缀名字行 | 编辑器只认 `NAME|n` 前缀 |

**GUI（推荐）**：编辑器顶部「格式识别」按钮（桌面 exe 与单文件 HTML 都带）——
选「当前已打开文件」或粘贴/选择文本 → 点「识别」→ 报告显示结构、问题清单与编辑器模拟对比，
然后一键「**应用解析配置**」（保存识别规则）或「**规范化并载入编辑器**」（转成 ☆/★ 直接开翻），
还可下载 profile JSON / 规范化文本。

**CLI**（`scripts/recognize-format.mjs` 独立脚本，零依赖；识别/规范化/还原的纯逻辑在
`src/recognize.js`，GUI「格式识别」弹窗与 CLI 共用同一份代码）：

```bash
node scripts/recognize-format.mjs "test text/第二种.txt"            # 识别报告(默认)
node scripts/recognize-format.mjs "test text/第二种.txt" --json prof.json   # 输出识别档案 JSON
node scripts/recognize-format.mjs "test text/第二种.txt" --convert        # 生成 ☆/★ 规范化文本
node scripts/recognize-format.mjs "xx.canonical.txt" --profile xx.profile.json  # 还原原格式(简化: 只需 --profile)
node scripts/recognize-format.mjs "旧编码.txt" --encoding shift_jis       # 指定输入编码
```

完整选项见 `node scripts/recognize-format.mjs -h`：`--report` / `--json <file>` / `--convert [file]` /
`--restore`（等价 `--profile`）/ `--out` / `--encoding` / `--quiet`。还原默认输出 = 输入
`.canonical.txt` 换成 `.restored.txt`；用 `--out` 指定其他路径。

三种导入方式（见报告 [6]）：
- **方式 A**：在「格式/规则」弹窗 ①识别 →「应用为解析规则」，或 ②手动填入标记/正则；
- **方式 B**：桌面版 `settings.json`（与 exe 同目录）覆盖顶层 `parse` 字段；
- **方式 C（推荐）**：`--convert` 生成编辑器原生 ☆/★ 两行文本，直接「导入文本」打开——
  名字栏可用；**对话行正文只保留 `「…」` 内内容，`「」`外的标签（`[np]`/`[r]`/`<r>`/`%p…;%f…;`）不进入译文编辑区**（记录在档案里），翻译完 `--restore` 自动贴回并还原原格式。

**识别能力**：标记字符成对检测（☆/★、○/●…）；编号模式（纯数字/十六进制/`|` 管道/`TEXT|n`/
`NRT` 后缀）；说话人位置（前缀段 / 正文前 `[[名字]]`）；NAME 行、N 后缀名字行、`#` 注释行、
`APPEND` 控制行；正文标签统计；行分类（对话/旁白/有名文本）；问题清单（编号错位、译文独有、
原文独有、无法归类行等）；`--encoding` 支持旧编码输入（如 Shift-JIS）。GUI 弹窗内另有
「编辑器模拟」对比（用真实解析器验证识别配置与规范化文本的导入效果）。

## 注意事项

- 机器翻译/词典均为可插拔 Provider 架构（`src/mt.js` / `src/dict.js`），接入新服务见对应章节。
- 旧版单文件 HTML（`旮旯给木翻译工具.html`）保留未动，作为行为基准对照。

## 机器翻译（通用大模型 + Sakura 本地，兼容 llama.cpp）

内置双引擎架构（`src/mt.js`）：顶部「⚙ 机翻配置」里二选一。

### 通用大模型（OpenAI 兼容）

- 填**接口地址**（如 `https://api.openai.com/v1` 或各类中转/自建网关）、**API Key**（llama.cpp 本地可留空）、**模型名**。
- 可选自定义**系统提示词**（留空用内置默认翻译提示词）；采样参数：温度 / top_p / max_tokens / frequency_penalty。
- 支持 **SSE 流式输出**（翻译当前行时逐字显示）与**多轮上下文**（附最近 N 句原文/译文历史，翻译更连贯）。
- **llama.cpp 兼容**：直接填 `http://127.0.0.1:8080`、Key 留空即可使用 llama-server 本地模型。

### Sakura 本地（离线专用模型）

1. 用 **Sakura_Launcher_GUI** 加载 Sakura 模型并启动服务（或直接用 llama.cpp 的 llama-server，默认端口 8080）。
2. 「⚙ 机翻配置」选「Sakura 本地」：
   - 地址默认 `http://127.0.0.1:8080`，也可点「🔍 检测端口」自动扫描常见端口。
   - 模型名可填（用于**提示词版本自动识别**：v0.9/v0.10/v1.0/v1.5/GalTransl，未知回退 v1.0），也可手动指定。
   - 勾选「携带项目术语表」→ 翻译时把当前项目 glossary.json 的术语带给模型，人名/词条翻译更准。
   - 用「测试翻译」输入一句日文即时验证连接与效果（保存前不落盘）。
3. 保存后，「翻译当前行」/「批量翻译」按钮可用。

- **API 兼容**：优先 OpenAI 格式 `/v1/chat/completions`（SakuraLLM 官方 API / llama.cpp server），404 时自动回退 llama.cpp 的 `/completion`（ChatML prompt）。
- **配置结构**：存 `settings.json`（exe 同目录）的 `mt.providers.llm` / `mt.providers.sakura`；旧版 `mt.sakura` 首次启动自动迁移。
- 批量翻译串行调用（避免压垮本地推理）。
- 接入其他服务：实现 `{ id, name, isConfigured(), translate(text, glossary, onChunk?), translateBatch(texts, glossary?) }` 并 `registerProvider()` 即可。

## 词典查询（统一接口 + Provider 适配器）

侧栏「词典」标签：**查询 / 词典源 / 片段** 三个子页。

- **查询**：输入词回车，或**在原文/译文里选中词 → 点弹出的「📖 查词」**；并发查询所有已启用词典源，
  结果按词条/读音/词性/释义/例句展示。
- **词典源**：**MDX 词典**（.mdx 文件，词条 HTML 消毒渲染；桌面版走 Rust 原生引擎——
  内存映射 + 惰性索引、记住路径重启自动恢复、同名 .mdd 资源包图片/发音可用；浏览器版
  基于 MIT 的 js-mdict 6、会话内加载）+ **JSON 词典文件**（galtrans-dict-v1 格式，
  桌面版记住路径、浏览器版会话内有效）+ **HTTP 词典**（URL 模板 `{word}` 占位 +
  `$.a.b` 点路径字段映射 + 请求头，兼容任意自建/第三方 API，带测试查询）。
  格式与配置指南见 **docs/dictionary-plugins.md**。
- **片段**：快捷片段（缩写→展开文本），全局 snippets.json + 项目 snippets.json 两层（项目覆盖同名），
  打开文件后随项目目录保存。

**输入建议**：在译文框输入时自动匹配当前项目术语与片段，弹出浮层——
`Tab` 采纳、`↑↓` 选择、`Esc` 关闭；`Enter` 保持"切到下一行"原语义不变；中文输入法组合输入期间不弹出
（不与输入法候选窗冲突）。

## 术语表 CSV

「术语 → 导入」支持 **JSON 与 CSV**（自动识别）：CSV 支持 2 列（原文,译文 → 词条）或 3 列
（类型,原文,译文；`名词`/`人名` 进人名表，其余进词条），首行表头自动跳过，导入前显示解析计数、
合并进当前术语表（同名覆盖）。「CSV」按钮导出 3 列 CSV，Excel 可直接打开（Excel 表格请先另存为 CSV 再导入）。

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Tab` / `Shift+Tab` | 下一行 / 上一行 |
| `Enter` | 下一行 |
| `Ctrl+S` | 保存原文件 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+F` | 聚焦搜索框 |
| `F3` / `Shift+F3` | 下一个 / 上一个匹配 |
| `F2` | 跳到下一个未翻译的行（循环） |
| `Ctrl+Enter` | 替换当前匹配 |
| `Ctrl+G` | 聚焦跳转行输入框 |
| 译文输入时 `Tab` | 采纳输入建议（术语/片段浮层） |

## 📄 许可证

[MIT](LICENSE)
