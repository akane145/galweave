# UI 统一与减法整改报告（ui-polish）

| | |
|---|---|
| 日期 | 2026-10-12 |
| 性质 | **规划交付物**，不含业务代码改动。交由执行模型落地 |
| 依据 | 真实渲染截图（`.shots/ui-baseline/*.png`，16 张，被 .gitignore 忽略）+ `src/style.css`（4828 行）/ `index.html` / `renderer.js` 的行号级核对 |
| 复现 | `npx vite --port 5199 --strictPort`，再 `node scripts/ui-shots.mjs .shots/ui-after <样例.txt>`；改前改后各跑一次对比 |
| 上位规范 | `docs/ui-design-spec-v4.md`（**方向正确，不推翻**，本报告是它的"落实与减法"） |

---

## 0. 一句话结论

**问题不在配色或风格选错，而在三件事：同一文件里叠了多代样式互相覆盖、装饰元素堆太多、同一种颜色被赋予多重含义。** v4 设计书的 token 层已经落地得不错，但组件层仍是"在最后追加覆盖"的做法，旧规则没删，于是出现一批**实际渲染里的错误**（见 §2）。"高级感"来自克制与一致，不是再加东西，所以本次整改以**删除与收敛**为主，几乎不新增视觉元素。

截图环境的字体栈可能与最终用户机器不同（`--font-ui` 首选 HarmonyOS Sans / MiSans，Windows 上多数落到 Noto 或微软雅黑 UI）。**字形验收请在目标机器上做，不要拿本报告的截图当最终基准。**

---

## 1. 量化证据（style.css 当前状态）

以下数字均由 2026-10-12 的脚本在当前工作区实测（`style.css` 共 4828 行）。**T-01 的守卫测试以这些数字作为初始基线。**

| 指标 | 数值 | 说明 |
|---|---|---|
| v4 token 位置 | 1-276 | v4 组件层在 4392 之后，中间是 v3 及更早的叠层 |
| `.modal h3` 规则定位 | **8 处**（611/1358/1816/1932/3437/3438/3448/3449） | 同一元素多处互相覆盖 |
| `button` 基础规则（`^button{`） | 5 处（319/320/1181/1253/4399） | |
| `.para{` 定义 | 3 处（1631/4545/4652） | |
| `.num{` 定义 | 3 处（690/1673/4583）+ `.num::after` 多处冲突 | 见 B1 |
| `#toast{` 定义 | 3 处（563/3071/4698） | 前两处被最后一处覆盖 |
| `.side-tabs button` 规则 | 6 处（426/685/1321/1506/1519/1787） | |
| `!important` | **32** 行 | |
| `border-radius:0` | **68** 行 | `--r-*` token 已定义却大量不用 |
| `color:#fff`（含 `#ffffff`/`white`） | **24** 行 | 335/340/343/427/475/585/710/736/737/757/765/767/782/808/1277/1280/1906/2655/3136/3138/3832/4095/4309/4310 |
| 第 300 行之后的 `#hex` / `rgba()` | **63 / 44** 行 | 即 token 层之外的硬编码 |
| `letter-spacing` | **57** 行 | 多为英文 mono 小标题 |
| 字面量 `font-size:Npx` | **5** 处（729/732/2950/2988/3176） | 其余已走 `--fs-*`；`--fs-caption` 被引用 248 次，`--fs-body` 68 次 |
| 含 `serif` 的行 | 30 行（含 `--font-serif-jp` 定义 66 与引用） | 实际渲染为衬线的 chrome 元素见 V2 |
| `border-radius` 值分布 | `0`×66、`var(--r-sm)`×31、`1px`×15、`var(--r-md)`×14、`var(--r-pill)`×13、`50%`×6、`var(--r-xs)`×6 | 另有 `4px/9px/8px/6px` 字面量 |
| `min-height` 字面量取值 | 28×7、30×9、32×12、34×3、36×5、40×5、44×8…（共数十种） | 多数是被 4360 的 `var(--hit-min)` 覆盖的死值，见 V4 实测 |

---

## 2. 渲染中确认的问题

### 2.1 真 bug（必须先修）

**B1　行号旁状态图标渲染成怪形（`.num::after` 规则冲突）**
截图 `01-project` / `05-proof`：每行行号后是一个绿色折线或黄色"灯泡"状小图形。
原因（已用 `getComputedStyle(.num, '::after')` 实测确认）：`style.css:2733-2789` 用 CSS 画四态形状（8×8 圆、旋转边框对勾、三角），而 v4 层 `style.css:4590-4593` 对 `.para.done .num::after` 又设了 `content:"✓"` + `display:inline`，1691 旧规则也在。实测结果：
- 普通已译行：`content:"✓"`（字符）+ 5×8px + `border-right:1px` + `transform:rotate(45deg)`——**字符被塞进旋转后的边框盒里**，字形与 CSS 对勾叠在一起。
- 校对模式 `pr-pending`：`content:"✓"` + 8×8 + 半黄渐变背景——**对勾字符压在半圆上**。
2733 注释里作者已明确写"必须显式清 content，否则字符与 CSS 对勾叠在一起"，但 4590 的后加规则又把它加回来了。
修法：只保留一套，见 T-02。

**B2　主按钮"亮蓝底 + 白字"对比度不足**（对比度已按 WCAG 公式实测）
截图 `10-modal-parse`、`08-modal-theme`：「开始识别」「保存外观」「保存规则」亮蓝底白字，刺眼且难读。
`style.css:3832` 写的是 `background:var(--accent); color:#fff`。实测白字对 `--accent`：夜读 `#58A6FF` = **2.53:1**；墨影 `#E8E8E8` = **1.23:1**（几乎不可读）；昼笺 `#0969DA` = 5.19:1（达标，所以只在浅色下看不出问题）。v4 的正确做法是 `--accent-fill` + `--fg-on-primary`（4448 的 `.btn-primary`）。`tests/contrast.test.mjs` 只读三个主题 token 块（该文件 126、135 行），**不测组件里实际用了哪两个 token**，所以漏过。

**B2b　校对行内"通过 / 有问题"按钮激活态与角标：白字压浅色填充**（按 CSS 推算，未单独截图）
`.pr-btn.on`（736、1776）= 白字 `#fff` 压 `--st-approved #4BB98C`，**2.44:1**；`.pr-btn.pr-issue-btn.on`（737 → 1777 改底为 `--ink-speaker`）= 白字压 `#D9A05B`，**2.30:1**；`.pr-badge`（710）= 白字压 `--st-pending #E3B341`，**1.95:1**；`button.danger:hover`（340）= 白字压 `--st-issue #F0785A`，**2.79:1**。全部低于 AA 4.5:1，且 v4 已有现成的 `--fg-on-approved / --fg-on-warning / --fg-on-danger` 配对没用上。

**B3　toast 遮挡弹窗标题**
截图 `08-modal-theme`：「校对模式已开启…」绿条盖在弹窗标题"主题与阅读体验"上。`#toast` 固定在顶栏下方居中（3072），`--z-toast:80 > --z-modal:60`。

**B4　搜索条在 1280 宽下溢出并出现横向滚动条**
截图 `03-search`：导航组被裁（"跳转行号/编号…"半截），底部出现滚动条。实测 1280×800、侧栏开启时 `#searchbar` 的 `scrollWidth=1446`、`clientWidth=1280`，溢出 **166px**，`overflow-x:auto`。违反 v4 §3.4"命令条分组溢出需收纳或换行"。

### 2.2 视觉杂乱的根因

**V1　英文等宽小标题 + 章节编号 + 方章，装饰过量**
`PROJECT` / `CURRENT SCRIPT` / `STORY` `OPEN` / `FOCUS` / `CONTEXT` / `CURRENT LINE` / `REVIEW` / `SCRIPT INTERPRETER` / `READING ATMOSPHERE` / `NO BACKDROP` / `ORIGINAL` / `TRANSLATION` / `NO SCENE`（index.html:159,161,171,174,183,187,195,243,254,445,620,661,716,727），全是 mono + 字距 .14em 的大写英文，面对的却是中文工具。再叠加弹窗里的 `01/02/03` 章节号、方章"景/解"（`.settings-mark`，3416）、标题右侧蓝短线（3407）、`.modal h3::before` 蓝线（1943）。截图左栏的 `CURRENT SCRIPT / STORY / OPEN / FOCUS` 四个英文标签是整块最抢眼的东西，却没有信息量；`OPEN` 右对齐含义不明。这是"杂乱、不高级"的头号来源。

**V2　衬线与无衬线混用**（已用 `getComputedStyle` 实测哪些真的生效）
v4 §4.5/§3.1 规定 chrome 用 `--font-ui`。实测**真正渲染为衬线（Noto Serif JP）**的 chrome 元素：
- `#sideTitle`（侧栏"当前对白"，规则 1319）
- `#railFilename`（左栏文件名，规则 1592）
- `.bkt`（译文外置引号，规则 4627 仅改字号未改字体，继承衬线，见 Q2）
- 弹窗标题 `.modal h3`（1358 / 3442；弹窗关闭时不在 DOM 可见树里，靠截图 `08/09/10` 确认）与方章 `.settings-mark`（3423）

**不是衬线、属死规则**（可直接删，不会改变渲染）：1348（底栏）、1550/1551（品牌）、1608（场景标题）、1719（译名输入）、1603（已 `display:none`）。原文默认字体 484/1708 同样被 4661 覆盖。
所以需要"改"的只有上面 5 处，其余是"删"。

**V3　琥珀色三重含义，一屏全黄**
`--ink-speaker:#D9A05B`（说话人）、`--st-pending:#E3B341`（待校对）几乎同色，再加脊线下股 75% 琥珀（4640）。**"待校对"是新译稿的常态**（截图 33/33 全是），结果每行都有一个高饱和黄 pill、一条黄脊线、一个黄说话人名。常态不该用最显眼的色。同时这违反 v4 §3.2 / §5.5 自己写的"**非激活行不渲染完整徽章**"——代码里并未落实。

**V4　按钮体系分裂**
- 命令条同一行里"保存原文件 / 撤销"是 ghost，"导入文本 / 导出译文"却带边框（`4437-4445` 的"次级化"规则把 `#controls .primary-group` 压回 outlined，与 `4792` 的 ghost 化互相打架）。
- 弹窗按钮高度：`3932` 写 34px，`4359` 写 40px 热区，两套同时生效。
- **实测高度**（1280×800）：命令条按钮、侧栏 tab、校对栏按钮、模式 tab、下拉框 = **40px**；`.copy-btn` = 32px；行内「✓通过 / ⚠有问题 / 📝」`.pr-btn` = **25px**（1775 的 27px 被后续规则压缩）；状态 pill 18px。也就是说 `min-height` 里 28/30/34/36 这些散落取值大多是**被 4360 的 `min-height:var(--hit-min)` 覆盖的死值**，真实问题是：①40px 高的 ghost 按钮没有边框，看起来只有 28px 高，视觉与热区不一致；②`.pr-btn` 孤立地只有 25px，与旁边 40px 的控件不成体系。

**V5　弹窗头部两套语言并存**
`01-modal-theme` / `10-modal-parse` 是大号衬线标题 + 方章 + 蓝 kicker + 右侧蓝线；`11-modal-stats` 是小号标题 + 前置蓝短线。同一应用里弹窗长得像两个产品。

**V6　侧栏层级重复、溢出**
- CONTEXT 区三层堆叠：`CONTEXT / 当前对白` → `ID / 说话人 / 原文` → `返回编辑位置`；侧栏 tab 与"收起"同行混排，样式不一。
- 术语面板工具栏（`导入/导出/CSV/应用/Anki…`）被截断，"+ 添加"贴边被裁（截图 `04-glossary`、`05-proof`）。

**V7　校对模式下 chrome 过重**
截图 `05-proof`（1280×800）：顶栏 + 命令条 + 校对栏两行，第一行稿件卡片上沿在 y≈208px，即屏幕高度的 **26%**（按截图像素估算，非 DOM 量取）。校对栏还含"处理"下拉、剩余数、上一条/暂留/通过并继续，与行内按钮、侧栏校对页、顶栏"校对"开关形成四处重复入口。

**V8　行卡片细节**
- 状态 pill 水平位置每行不同。**已实测确认**：前 8 行 pill 左缘相对行左缘分别为 474/467/467/460/449/460/467/460px（相差 25px），pill 宽度恒为 68px。成因：`.meta-row` 是 `display:flex`，pill 用 `margin-left:auto`（4600，实测 354px）靠右，但其后紧跟的 `.byte-meter`（宽 96–112px）与 `.width-meter`（宽 79–88px）**宽度随内容变化且始终占位**（computed `visibility:visible`，只靠 `opacity` 隐藏，2832-2834），于是 pill 被推到不同位置。修法：meter 固定宽度（`min-width` + `tabular-nums` 右对齐），或把 pill 放到所有 meter 之后。
- 译文右引号 `」` 孤立在行最右（`4665` textarea `flex:1`，`.bkt` 被推开），与正文脱节。
- 原名与译名都是橙色粗体（"标题 标题"、"伊琳 / 伊琳"），主次不分。原名是只读参考，译名是可编辑产出，权重应反过来。

**V9　图标与字形**
emoji / Unicode 当图标：main.js:1191,2073,2077,4664（📖🤖）、renderer.js:486,493,500,729（✓⚠📝）、index.html:323,338-340,388（📖＋📝）、rowstatus.js:28（◐）。v4 §5.8 规划了 15 枚 SVG sprite，现 index.html:17-21 只落地 3 枚。

**V10　顶栏文案冗长；底栏快捷键常驻 12 个**
"当前文件：新建 文本文档 (10).txt　编码：UTF-8（无 BOM）　已载入"，文件名在顶栏、左栏、CONTEXT 区重复出现 2-3 次。底栏 12 个 `kbd` 在 960 宽下被裁到半个字（"下个四"，截图 `13`）；960 宽顶栏编码文案被截成 `UTF…`。

**V11　浅色主题层级倒置**
截图 `12-theme-light`：行卡片（`--bg-base:#F7F8FA`）比舞台（`--canvas:#FFF`）更暗。暗色下卡片比地面亮，浅色下反过来，视觉像"凹陷的灰块"。

**V12　浏览器版"翻译"模式命令条为空**
`main.js:4652-4658 hideMTUI()` 在浏览器版隐藏机翻按钮，但"翻译"模式 tab 和 44px 空命令条仍在（截图 `02-translate`）。桌面版不受影响。

---

## 3. 整改清单

优先级：**高** = 渲染错误 / 对比度失败 / 影响面最大；**中** = 统一与减噪；**低** = 打磨。工作量为人日估算。

### 3.1 先做：修错与止血（高）

| # | 事项 | 位置 | 验收 | 工作量 |
|---|---|---|---|---|
| T-01 | **加 CSS 卫生守卫测试**：新增 `tests/css-hygiene.test.mjs`，按"基线计数只减不增"约束：`color:#fff`（24）、字面量 `font-size:Npx`（5）、`border-radius:0`（68）、`!important`（32）、`letter-spacing`（57）、第 300 行后 `#hex`（63）/`rgba(`（44）。基线取 §1 当前值，每完成一个 T 项就把对应上限下调到新值。读文件方式对齐 `tests/contrast.test.mjs:126`。**先做它**，防止后续整改被回退。 | 新增测试；AGENTS §6 要求同步 `docs/DEVELOPMENT.md` 维护契约 | `npm test` 通过；故意加一条 `color:#fff` 会红 | 0.5 |
| T-02 | **修 B1**：删除 `4590-4593` 与 `1691` 的 `content:"✓"` 旧规则，`.num::after` 只留 `2733-2789` 一套；再决定是否直接换 SVG（T-12）。 | style.css:1691, 2733-2789, 4590 | 截图 `01/05` 行号旁是干净的 8px 图形；四态各一张对比图 | 0.5 |
| T-03 | **修 B2 / B2b**：`3832`、`4095`、`4309`、`4310` 等"主操作"全部改用 `.btn-primary` 语义（`--accent-fill` + `--fg-on-primary`）；`.pr-btn.on`（736/1776）→ `--fg-on-approved`，`.pr-btn.pr-issue-btn.on`（737/1777）→ `--fg-on-speaker` 或 `--fg-on-warning`，`.pr-badge`（710）→ `--fg-on-warning`，`button.danger:hover`（340）→ `--fg-on-danger`。其余 `color:#fff` 逐条替换。**扩展 `contrast.test.mjs`**：解析 style.css，凡同一规则内 `color:#fff` 与 `background:var(--accent|st-*|ink-speaker)` 共现即红。 | style.css 上述行；tests/contrast.test.mjs | 三主题下上述每一对 ≥ 4.5:1（B2 夜读 2.53 / 墨影 1.23，B2b 1.95～2.79，均须消除） | 0.75 |
| T-04 | **修 B3**：toast 改为底部居中（`bottom:calc(var(--statusbar-h) + var(--sp-4))`），或 z-index 低于 modal 并让弹窗内自带提示。同时删 `563-585` 与 `3071-3085` 两层死规则，只留 `4698` 一层。 | style.css:563, 3071, 4698 | 打开任一弹窗再触发 toast，不遮挡标题 | 0.25 |
| T-05 | **修 B4**：搜索条改两行或把"导航"组移出命令条（如放到舞台 `scene-header` 右侧）。 | index.html:125-153；style.css 2199 附近 | 1280×800（侧栏开/关）与 960×600 下 `#searchbar.scrollWidth <= clientWidth`（现状 1446 > 1280），导航输入完整可见 | 1.0 |

### 3.2 组件收敛：按组件逐个删旧层（高，工作量最大）

做法：**一个组件一个 commit**。每个组件先用 DevTools 的 Computed 面板确认最终生效的是哪几条，把**被完全覆盖的死规则整段删除**，保留的合并到 v4 组件层（文件末尾）。每个 commit 前后跑 `ui-shots.mjs` 对比，并跑 `npm test` + `npm run lint`。

| # | 组件 | 要收敛的位置 | 工作量 |
|---|---|---|---|
| T-06 | `.modal` / `.modal h3` / `.modal-tabs` / `.settings-heading`：合并为**一套弹窗头**（见 T-09） | 611, 1358, 1816, 1932, 1943, 3395-3456, 3437-3449 | 0.75 |
| T-07 | `button` 基础、`.toolbtn`、`.primary-group` 次级化、命令条 ghost 化：确立**一套**按钮语义（见 T-10） | 319-343, 1181, 1253, 4399, 4437-4445, 4792-4806 | 0.75 |
| T-08 | `.para` / `.num` / `.meta-row` / `.row-status`：收成**单一定义**；**改动前必读 `tests/virtual.test.mjs` 与 `renderer.js:28-34` 的 `ROW_GAP_BY_DENSITY`**——行高模型按 `getBoundingClientRect().height` 测量，改 `.para` 的 padding / border 必须同步，否则长稿滚动占位会累计漂移 | 690, 1631, 1673, 2733-2789, 2941-2956, 4545-4601, 4652 | 1.0 |
| T-08b | 其余：`.side-tabs`（6 处）、`.proof-bar`（770, 1768）、`#toast` 已在 T-04 | 426, 685, 1321, 1506, 1519, 1787；770-783, 1768-1773 | 0.5 |

### 3.3 视觉统一（中）

| # | 事项 | 位置 | 验收 | 工作量 |
|---|---|---|---|---|
| T-09 | **弹窗统一**：标题 18px / `--font-ui` / 600，可选一行 12px 副标题；**删**方章 `.settings-mark`、`.settings-kicker`、右侧蓝线、`01/02/03` 章节号（`.settings-section-index`）。动作区按钮统一 40px 热区、主操作 `.btn-primary`、取消 `.btn-ghost`。保留 index.html 里全部 id / aria。 | index.html:441-449, 453, 486, 617-624 等；style.css 3395-3470, 3932 | 三个弹窗（解析/主题/统计）头部同构 | 1.0 |
| T-10 | **按钮语义统一**：命令条全部 ghost + hover；仅"当前模式的主动作"用 outlined（项目=导出译文、翻译=批量翻译、搜索=全部替换仍 `warn`）。弹窗确认键 `.btn-primary`。行内「通过/有问题/批注」与侧栏 tab 提到 `--hit-visual:32px`（热区 40 由行兜底，v4 §5.1 尾注）。收敛 `min-height` 取值到 {32, 40, 44} 三档。 | style.css 4437-4445, 4792, 1771, 426 | `min-height` 取值分布集中到三档 | 0.75 |
| T-11 | **去装饰**：删除或中文化英文 mono 小标题——`PROJECT/STORY/OPEN/FOCUS/CONTEXT/CURRENT LINE/CURRENT SCRIPT` → 中文 12px `--ink-dim`、无字距；`NO SCENE / NO BACKDROP / TRANSLATION MANUSCRIPT` 直接删。`letter-spacing` 全文件 ≤ 8 处。`.rail-bottom p` 等已 `display:none` 的死节点一并删。 | index.html:159,161,171,174,183,187,195,243,254,445,620,661,716,727；style.css `.rail-overline/.tool-label/.scene-kicker/.settings-kicker` | 左栏不再出现英文大写标签 | 1.0 |
| T-12 | **字体统一**：chrome 全部 `--font-ui`，`--font-serif-jp` 只允许出现在用户可选的原文字体预设。**要改**（实测在渲染）：1319 `#sideTitle`、1592 `#railFilename`、1358/3442 `.modal h3`、3423 `.settings-mark`、4627 `.bkt`。**可直接删**（死规则）：484、1708、1348、1550、1551、1603、1608、1719、1206。 | style.css 上述行 | 页面所有可见 chrome 元素 `getComputedStyle().fontFamily` 首项均不含 Serif/Mincho（现状：`#sideTitle`、`#railFilename`、`.bkt` 为 Noto Serif JP） | 0.5 |
| T-13 | **色彩语义拆分（需 master 确认 Q1）**：待校对与未翻译同用**中性灰**，仅靠形状区分；彩色只留给"有问题"（红）与"已通过"（绿）。说话人琥珀独占 `--ink-speaker`。同时落实 v4 的"非激活行不渲染完整 pill"：`.para:not(.active) .row-status .rs-label{display:none}`，仅保留形状点；校对模式或激活行才显示文字。脊线下股 pending 也改中性。**注意**：AGENTS 与 v4 P7 要求"颜色 + 字形双通道"，字形不能丢；`tests/contrast.test.mjs` 的 pill 配对随 token 同步。 | style.css:47, 2941-2956, 4640-4642；rowstatus.js | 33 行待校对稿件一屏不再大片黄色 | 1.0 |
| T-14 | **行卡片细节**：①修 pill 水平位置（V8 已确认成因：宽度可变的 meter 始终占位；改 `.meta-row` 为 grid `num \| 1fr \| status \| meters(固定宽)`，meter 用 `min-width` + `tabular-nums`）；②原名降为 `--ink-mid`/500，译名保持 `--ink-speaker`/600；③右引号 `」`（`.bkt`）的处理见 Q2，同时把 `.bkt` 字体从继承衬线改为 `--font-ui`。**注意**：meta-row 宽度变化会改行高，须同步 T-08 的虚拟列表约束。 | style.css:4594-4601, 4627, 4655-4675；renderer.js:333-340 | 同一屏内所有 pill 左缘 x 坐标一致（现状相差 25px：449～474） | 0.75 |
| T-15 | **侧栏收敛**：CONTEXT 三层合并为一块（标题行 + 一行 ID/说话人 + 原文，"返回编辑位置"移为头部图标按钮）；tab 与"收起"分离，"收起"变右上 `×` 图标；术语/校对面板工具栏 `flex-wrap`，"添加"不再溢出。 | index.html:240-258, 263-300；style.css 1320-1330, 1787 | 截图 `04/05` 侧栏无截断、无贴边 | 1.0 |
| T-16 | **顶栏与底栏减字**：顶栏改为 `文件名 · UTF-8` + 6px 状态点（保存态），删"当前文件："、"编码："前缀；底栏只常驻 `Tab / Enter / F2 / Ctrl+S / Ctrl+F` 五项，其余在命令面板里查；960 宽不再被裁半个字。保留 `#statusText`、`#statusTabHint` 钩子（`tests/ui-a11y.test.mjs` 断言）。 | index.html:25-33, 426-437；main.js 中改写文案处 | 960×600 无截断 | 0.5 |
| T-17 | **图标换 SVG**：按 v4 §5.8 补全 sprite（import/save/export/search/book/pen/check/warning/close/more/panel-collapse 等），替换 §2 V9 列出的 emoji/Unicode。状态 pill 的 `◐○▲✓` 改为内联 SVG（`rowstatus.js:28` 的 `glyph` 字段改为 symbol id），与 T-02 合并考虑。 | index.html:17-21；renderer.js:333-345,486-500,729；main.js:1191,2073,2077,4664；rowstatus.js | 全局 grep 无 emoji | 1.5 |

### 3.4 其余（低）

| # | 事项 | 工作量 |
|---|---|---|
| T-18 | **浅色层级**：新增 `--card`（夜读=`--bg-base`，昼笺=`#FFFFFF`，墨影=`--bg-panel`），`.para` 底色改用它；昼笺 `--canvas` 略降为 `#F3F5F8`，让卡片比地面亮。三主题逐一过 `contrast.test.mjs`。 | 0.5 |
| T-19 | **校对栏瘦身（需 Q3）**：过滤 chips 一行；"处理 / 剩余 / 上一条 / 暂留 / 通过并继续"折叠为一个"连续校对"分组，默认收起。目标：校对模式下第一行稿件出现在屏幕 ≤ 18% 处。 | 1.0 |
| T-20 | **浏览器版"翻译"模式**：`hideMTUI()` 同时隐藏"翻译"模式 tab，或命令条显示一句"机器翻译仅桌面版可用"。 | 0.25 |
| T-21 | **token 外颜色清理**：§1 的 63+44 处裁剪到仅"背景图/玻璃"必须的少数几处；同样由 T-01 守卫。 | 0.5 |
| T-22 | **收尾**：`style.css` 顶部注释与 `docs/DEVELOPMENT.md` 维护契约同步；`tasks/README.md` 增加本条索引；`.shots/` 基线与整改后的对比图人工目检。 | 0.25 |

**合计**：高 ≈ 5.0（T-01～T-08b）+ 中 ≈ 9.0（T-09～T-17）+ 低 ≈ 2.5（T-18～T-22）≈ **16.5 人日**。

建议执行顺序：T-01 → T-02/T-03/T-04 → T-05 → T-06～T-08b（逐组件）→ T-09/T-10/T-12 → T-11/T-13/T-14 → T-15/T-16/T-17 → 低优先级。

---

## 4. 给执行方的硬约束

1. **保持所有 id 与 aria 契约**。`tests/ui-a11y.test.mjs` 断言了 `--hit-min:40px`、`--fg-on-primary`、`outline:2px solid var(--focus-ring)`、`#statusText`/`#statusTabHint`、模态焦点循环、`withBusyState`。
2. **虚拟列表高度模型**：`.para` 的 padding / border / margin 改动必须与 `renderer.js:28`（`ROW_GAP_BY_DENSITY`）与 `src/virtuallist.js` 的 `gap` 对应，并跑 `tests/virtual.test.mjs`。
3. **功能性变量不得改名**：`--text-area-alpha`、`--bg-mask-opacity`、`--orig-font-*`、`--trans-font-*`、`--context-w`、`--progress-pct`、`--speaker-name-col`（v4 §4.7）。
4. **不重复实现**（AGENTS §7）：新增检查先看 `contrast.test.mjs` 与 `ui-a11y.test.mjs` 是否可扩展，不要另起一套。
5. **不引入 Prettier**，不改任何阈值契约（`--byte-limit`、`--width-limit` 等）。
6. 每个 commit 前：`npm test`、`npm run lint`、`node scripts/ui-shots.mjs` 前后对比；三主题 + 1280×800 / 960×600 必看。
7. 这是**减法**：除 T-17 的 SVG 和 T-18 的 `--card` 外，不新增任何视觉元素、不引入新字体。

---

## 5. 需 master 决定的问题（不阻塞；未答复前按"建议"执行）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | "待校对"是常态，是否降为中性灰，只让"有问题 / 已通过"着色？（会改 v4 §5.5 的黄色定义） | **是**。常态不抢眼，异常才抢眼 |
| Q2 | 译文右引号 `」` 现在悬在行最右，与正文脱节。是保留外置括号（保护括号不被编辑），还是并入 textarea 内容？ | 保留外置，但紧贴文本末尾：需先读 `renderer.js` 的 `bOpen/bClose` 逻辑再定 |
| Q3 | 校对栏的"连续校对"控件是否默认折叠？ | 折叠 |
| Q4 | v4 已写"非激活行不显示完整 pill"，是否按此落实？ | 落实（见 T-13） |
| Q5 | 昼笺主题是否接受调整 `--canvas`（略灰）以让卡片更亮？ | 接受 |

---

## 6. 附：本次评审产物

- `scripts/ui-shots.mjs`：CDP 无头截图脚本（工具，不含业务逻辑），输出 16 张：空状态 / 四个工作区 / 校对 / 侧栏 / 辅助菜单 / 三个弹窗 / 昼笺 / 墨影 / 960×600 / 1920×1080。
- `.shots/ui-baseline/`：整改前基线（被 .gitignore 忽略，仅本机可读）。
