# Galweave 新版 UI 架构与视觉规范设计书（v4）

> **2026-10-13 实施修订**：本页保留原始设计推导与示例，以下修订优先于旧示例。实际主题值以 `src/style.css` 的 token 和 `tests/contrast.test.mjs` 为准；原稿中的行号不代表当前文件位置。
>
> - 界面标题统一无衬线，删去英文装饰标题、方章和章节编号；弹窗标题为 `--fs-h3` / `--font-ui` / 600。
> - 待校对行使用中性状态色，通过半圆与未翻译空心圆区分；已译不等于已定稿，行号图形、状态徽章和脊线均服从 `rowstatus.js` 的四态。全局 `--st-pending` 仍承担警告语义，不改成中性。
> - 普通非激活行仅显示状态图形，激活行与校对模式保留文字标签和可访问名称。徽章与容量表占位稳定，不能因聚焦切换挤动正文。
> - 行内独立动作各自保证 40px 热区，不能用整行的点击范围替代。连续校对默认折叠，展开后保留原有操作。
> - 卡片表面使用 `--card`；浅色画布略灰、卡片亮色。背景图与透明度仍按原功能变量工作。
> - 外置引号保留保护功能与全宽文本输入；不通过把引号放进 textarea 来解决排版。状态 SVG 仅在渲染层映射，纯逻辑返回接口不改。
> - 详细复核、原报告误判与取舍见 `tasks/ui-polish/review.md`，完成状态和验收结果见同目录 `todo.md`。

| | |
|---|---|
| 版本 | v4.0 · 设计定稿（未实施） |
| 日期 | 2026-09-19 |
| 状态 | **规划交付物** —— 本文档只做设计与规范，不含实施代码 |
| 取代 | `src/style.css:4` 注释引用的 `docs/ui-visual-spec.md`（该文件已不存在，权威源失联）；实施完成后 style.css 顶部注释应改指本文档 |
| 参考基线 | awesome-design-md 一手规范：Linear / Raycast / Cursor 三份 DESIGN.md；ui-ux-pro-max 技能规则表（a11y / 触控 / 排版优先级） |
| 契约关系 | 阈值类约定（字节上限、撤销深度等）仍以 `docs/DEVELOPMENT.md`「维护契约」为唯一权威；本文档只管视觉与交互规范 |

> 实施说明（对本项目 agent 的硬约束）：
> 1. `tests/ui-a11y.test.mjs:43-50` 断言了三个 token 名 —— `--hit-min:40px`、`--fg-on-primary`、`outline:2px solid var(--focus-ring)`。**v4 保留这三个名字**，实施时测试必须保持全绿。
> 2. 任何 token 落地后，`tests/ui-a11y.test.mjs` 与新增的对比度测试必须同步（AGENTS.md 工作方式 §6）。
> 3. 本文引用的现状行号以 2026-09-19 工作区为准。

---

## 1. 设计原则

以下七条是 v4 全部决策的裁决依据，冲突时按序裁决。

**P1 稿件即主角（The manuscript is the product）。**
借鉴 Raycast「页面即产品」的纪律：工作区中央的译稿是唯一主角，chrome 一律退后。chrome 表面不出现彩色填充（按钮的强调色填充是唯一例外），彩色只出现在「译者需要做决策的位置」——状态脊线、术语命中、机翻差异、校对状态。任何装饰性彩色（如现 `style.css:1263-1270` 顶栏顶部 2px 强调线）一律删除。

**P2 阶梯承载层级，阴影只给悬浮物（Linear 表面阶梯）。**
层级由「表面阶梯 + 1px 精细内描边」表达（canvas → base → panel → raised → overlay 五级），不靠阴影堆叠。微投影（micro-shadow）只允许出现在真正离开版面的东西上：弹窗、浮层、toast、拖拽中的侧栏。版内元素（卡片、行、按钮）零投影。

**P3 单一强调色纪律（One accent, scarce）。**
借鉴 Linear：强调色只允许四个用途——①键盘焦点环 ②当前编辑行标识 ③主 CTA ④可点击链接/术语下划线。禁止把强调色用作区块底色、边框主色或大面积标记。

**P4 说话人琥珀墨（Speaker amber ink）。**
现有 `--name:#D9A05B`（style.css:42）是产品已经形成的记忆点：说话人与译名用暖琥珀，衬在冷灰蓝的版面上。v4 将其升格为正式 token `--ink-speaker`，三主题全部保留该暖色锚点（墨影主题以字重与底纹替代色相）。**品牌记忆点不在按钮颜色，而在稿件本身的排印**——这是本设计书刻意的选择。

**P5 双股脊线（Dual-strand spine）——本设计的签名元素。**
每张行卡片左缘一条 2px 竖脊，分上下两股：上股 = 原文区间（灰，`--orig-bar`），下股 = 译文区间（当前校对状态色）。让 1000–3000 行的稿件在**余光扫读**时即可读出每行的校对状态，替代散落在行内的多枚状态徽章噪音。
*风险声明：这是 v4 唯一的激进改动。它改变行卡片的视觉语法，收益是「状态可被余光读取」——这是长稿校对场景的核心任务，值得为此冒险。若实施后试用感到噪音过大，降级方案是仅保留下股（状态股）。*

**P6 密度三层分离：热区 / 视觉 / 行距。**
可交互元素点击热区 ≥40px（`--hit-min`），密集列表中控件的**视觉**高度可以是 32px（`--hit-visual`），用透明内距补足热区；行与行的密度由三档 `data-density`（沿用 style.css:3474-3479 既有机制）调节，与控件高度、字阶解耦。

**P7 无障碍是基线，不是特性。**
12px 是全应用最小字号；每个彩色填充都有显式 `--fg-on-*` 前景配对；唯一焦点表达 = 2px 实体 `:focus-visible` 轮廓；`prefers-reduced-motion` 全局尊重；状态永远「颜色 + 字形/文字」双通道表达（墨影主题靠这条存活）。

---

## 2. 现状审计（先读后判）

结论：样式系统**骨架是好的**（v3 token 的五级画布、状态四色、动效曲线都有专业水准），坏在**三层历史沉积**与**执行不彻底**。以下每条都有行号证据。

| # | 问题 | 证据 | v4 对策 |
|---|---|---|---|
| A1 | **三代设计语言同文件共存**：v3 token 层 + 「旧暖褐陶土系」别名层 + 「旧朱红文稿系」别名层（`--ink/--vermilion/--paper/--smoke/--amber/--jade` 至今被 1621-1941 行之后约 800 行 CSS 取色）+ 4323 行起的「UX audit」补丁层重定义 `--text-dim`/`--focus-ring` | style.css:140-215（两套别名）、4323-4348（补丁层） | §4 单层纯净 token；别名层给出带删除条件的迁移映射（§4.8） |
| A2 | **10/11px 微字阶泛滥**：`--fs-2xs:10px`、`--fs-xs:11px` 全文件约 **120 处**引用；另有裸 `font-size:10px`（3085、3123）与 12px 字面量（813、816） | style.css:69-70（定义）、336/359/727/1419/1623/1760/1774/1843/1879/3085/3123 等 | §4.5 六档字阶 12/14/16/18/22/28；过渡映射 `--fs-2xs/--fs-xs/--fs-sm→12px` |
| A3 | **控件高度五种并存**：全局按钮 28px（396）、`--control-h` 覆盖（1324）、toolbtn 28px（416/1348）、侧栏 tab 26-29px（501/1860/1879）、行内按钮 20-30px（549/848/1831/1847）、页脚 26-27px（623/1883）；a11y 补丁层又对部分按钮强制 `min-height:40px`（4376-4393）——同一颗按钮的三条规则互相拉扯 | style.css:396/416/501/549/848/1831/1843/1847/1860/1879/1883、4376-4393 | §4.6 热区 40 / 视觉 32 双值制；规则收敛为「一处定义，无处覆盖」 |
| A4 | **圆角 token 定义了却不用**：`--r-xs~--r-pill`（99）已存在，但按钮、输入框、行名输入、译文框、复制钮、toast、弹窗全部 `border-radius:0`（399/426/575/594/612/649/672），二叠层改 `1px`（1327/1355）——「廉价扁平感」的直接来源 | style.css:399/426/575/594/612/649/672/1327/1355 | §4.6 圆角 4/6/8/12 四档，输入与按钮一律 6-8px |
| A5 | **焦点表达三处叠加**：输入框用 border+inset shadow（433），:focus-visible outline 2px（1252-1256），补丁层再次覆盖为 `--focus-ring`（4395-4405）；`.side-tab` 又独用 inset box-shadow（2625） | style.css:433/1252-1256/2625/4395-4405 | §5.2 全应用唯一焦点规则：`outline:2px solid var(--focus-ring)` |
| A6 | **硬编码逃逸 token**：toast 成功底 `var(--success)` + 字面量 `#07180f`、错误 `#b94444`（644/660）；errbox 内联样式 `#7e3030`（index.html:794-798）；`.pr-tag` 白字无配对保证（841） | style.css:644/660/841、index.html:794-798 | §4.2 `--fg-on-approved/--fg-on-danger` 配对；errbox 移入正式样式 |
| A7 | **图标用 emoji / 文本字符**：↩ ↪（index.html:125-126）、＋（234/241/247/303）、📖（272）、📝（337）；`✓` 伪元素（1762） | index.html:125-126/234/241/247/272/303/337 | §5.8 内联 SVG 图标集（Lucide 24px 网格），禁 emoji |
| A8 | **墨影主题焦点环灰对灰**：`--accent:#8a8a8a`（256）在灰阶界面上对比不足；三主题中仅暗色有对比度注释，亮/墨影无实测记录 | style.css:217-246/249-276 | §4.4 墨影改用「反白填充 + 深墨前景」；§6 对比度自动化测试补齐三主题 |
| A9 | **状态徽章文字色即状态色的反色缺失**：`--st-*-fg` 语义混乱——pending 底 #E3B341 上用 #F0C454（47）属「黄底浅黄字」同类缺陷 | style.css:46-54 | §4.2 状态 pill 一律「soft 底 + 深字」双 token 显式配对 |

骨架保留项（这些**不要**重写）：五级画布与三主题机制（1-276）、密度三档（3474-3479）、背景图玻璃行（194-202、306-314）、动效 token（108-111）、z-index 表（113-115）、忙碌态 spinner 与 reduced-motion（4429-4447）、skip-link / sr-only（4350-4374）、模态焦点循环（modals.js，测试 60-65 已断言）、`withBusyState` 忙碌守卫（main.js，测试 52-58 已断言）。

---

## 3. 信息架构与布局蓝图

### 3.1 五区拓扑（1280×800，Tauri 默认窗口，tauri.conf.json `width:1280 height:800`）

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ◆GW  prologue.txt · 就绪          │ 项目 │翻译│术语│搜索│        [◐校对][⇥侧栏] [⋯]        │ ① 顶栏 48px
├────────────────────────────────────────────────────────────────────────────────┤
│ 文件 ▸(导入/保存原文件/保存全部/导出▾)   进度 ▸(恢复/规范化/清除进度/清空)          │ ② 命令条 44px
├──────────────┬──────────────────────────────────────────────┬──────────────────┤
│ ③ 故事轨 220px │ ④ 译稿舞台（max 1080px 居中）                  │ ⑤ 语境侧栏 316px   │
│ PROJECT      │  第 3 幕 · 月下告白          NO.0312 · 42%    │ [项目│术语│词典│建议│校对]│
│ prologue ▓▓░ │  ┌────────────────────────────────────────┐  │ ──────────────── │
│  ch01 ▓░░░   │  │▒│ 0002   桐吾                    ○待校   │  │ 当前对白 · 0002   │
│  ch02 ░░░░   │  │▒│──────────────────────────────────────│  │ 「この物語を…」    │
│──────────────│  │▓│ 「この物語を、もう一度。」             │  │ 术语 ×3 · 机翻建议 │
│ STORY        │  │▓│ [桐吾▾]「将这个故事，再讲一次。」      │  │ 漏翻 2 · 批注 1   │
│ 打开的文档…   │  └────────────────────────────────────────┘  │ （随行滚动更新）   │
│──────────────│        （翻译稿滚动区，垂直呼吸 24px）          │                  │
│ FOCUS        │                                              │                  │
│ ▸ 下一句未翻译 │                                              │                  │
├──────────────┴──────────────────────────────────────────────┴──────────────────┤
│ ● 就绪 · 320/1024 行   Tab 下一行  F2 下一未翻译  Ctrl+S 保存          UTF8 118/120│ ⑥ 状态栏 32px
└────────────────────────────────────────────────────────────────────────────────┘
```

①③⑤⑥ 常驻；② 是**随工作模式切换**的上下文命令条（沿用现有 `data-panel` 机制，index.html:50-129：project/glossary/search 三套，加 translate）。顶栏内不再放模式相关按钮。

### 3.2 行卡片解剖（签名元素：双股脊线）

> **实施勘误（2026-09-20，第二版）**：行形态定稿为**独立卡片**——每行 1px 描边 +
> 8px 圆角 + 行间 12px 间距（`.para{ margin-bottom:var(--sp-3) }`）。间距由
> `virtuallist.js` 高度模型的 `gap` 参数在 `heightOf` 统一叠加（margin 不进
> getBoundingClientRect，模型必须补上，否则数千行滚动占位累计漂移）。
> 前版「连续条带」与首版「圆角浮动卡片」两个方案均据此作废。

```
 ┌ 脊线 2px：上股▒=原文区间(--orig-bar)，下股▓=译文校对状态色
 │
┌┼──────────────────────────────────────────────────────────────┐
│▒│ 0002 ·                                          ◔ 待校       │ ← 元信息行（12px caption）
│▒│ 桐吾： 「この物語を、もう一度。」                              │ ← 原名在正文前（默认原译同为无衬线 JP，17px）
│▓│ 桐吾　将这个故事，再讲一次。                                    │ ← 可编辑译名输入 + 译文 textarea，聚焦才现框
│▓│                                                    UTF8 24/120│ ← 字节指示（hover/激活显形，12px mono）
└┴──────────────────────────────────────────────────────────────┘
```

- 上股固定 `--orig-bar`；下股取行校对状态色（未译/待校/有问题/已通过四态，§5.5）。
- 状态徽章只在「激活行」完整显示（文字+字形）；非激活行仅凭下股脊线表达——这是 P5 的减噪承诺。
- 原名只读并随原文显示；译名是可编辑内联文本，紧邻译文输入框。姓名长短不影响其它行的正文起点；旁白直接从行首排版。

### 3.3 语义 DOM 骨架

保留现有全部 id 与 aria 契约（`tests/ui-a11y.test.mjs` 与 main.js 按 id 取元素，不得改名），只调整嵌套与类名：

```html
<body>
  <a class="skip-link" href="#main">跳到翻译稿</a>
  <div id="bgLayer" class="hidden"></div>            <!-- 背景图层：保留（AGENTS.md Q7） -->

  <header id="topbar">                               <!-- ① 48px，单行 -->
    <div class="topbar-left">
      <span class="brand-mark">GW</span>
      <span id="fname">未打开项目</span>              <!-- 文档名随开随换 -->
      <span id="headerSaveState" class="header-save-state">准备就绪</span>
    </div>
    <nav class="mode-switch" role="tablist" aria-label="工作台模式">  <!-- 4 档分段控件 -->
      <button data-workspace="project" aria-current="page">项目</button>
      <button data-workspace="translate">翻译</button>
      <button data-workspace="glossary">术语</button>
      <button data-workspace="search">搜索</button>
    </nav>
    <div class="topbar-actions">
      <button id="btnProof"   aria-pressed="false">校对</button>      <!-- toggle 组 -->
      <button id="btnSidebar" aria-pressed="false">侧栏</button>
      <button id="btnCommandPanel" aria-haspopup="menu" aria-expanded="false">⋯</button>
    </div>
  </header>

  <div id="commandStrip">                            <!-- ② 44px，data-panel 随模式切换 -->
    <div class="command-bar" data-panel="project">…</div>   <!-- 现有分组保留，样式重绘 -->
    <div class="command-bar" data-panel="translate">…</div>
    <div class="command-bar" data-panel="glossary">…</div>
    <div class="search-bar"  data-panel="search">…</div>
  </div>

  <main id="main">
    <aside id="storyRail" aria-label="故事与文档导航">…</aside>       <!-- ③ 220px / 折叠 52px -->
    <section id="stage" aria-label="翻译稿页">
      <header class="scene-header">…</header>
      <div id="proofbar" class="proof-bar hidden">…</div>
      <div id="list" role="list">
        <div id="empty">…</div>                     <!-- 空状态卡，§5.6 -->
        <!-- #vtop / .para×N / #vbot 虚拟滚动，结构不变；原名在原文前，译名输入在译文前 -->
      </div>
    </section>
    <aside id="sidebar" aria-label="语境侧栏">…</aside>              <!-- ⑤ 316px 可拖宽 / 抽屉 -->
  </main>

  <footer id="statusbar">…</footer>                  <!-- ⑥：状态与快捷键 -->
  <!-- 模态 ×5 + #toast：结构保留，样式重绘 -->
</body>
```

相对现状的骨架变化（只有三处）：
1. `header-project-meta`（index.html:28-33）拆两半：文档名/保存态上顶栏左，行进度留在状态栏，字数统计放在左侧项目区。
2. 校对/侧栏 toggle 聚合成一组分段 toggle，视觉上与主 CTA 隔开（原第四枚「剧场」已于 2026-09-19 应 master 要求整功能移除）。
3. 行卡片 DOM（renderer.js:257-335）增加脊线元素 `.spine`（两个 `<i>` 股）与元信息行，其余类名不变。

行内人名与正文采用共享说话人列：原名显示在原文前，可编辑译名位于译文前；姓名保持普通文字，不使用仿对话框名牌或背景。每行按当前字体实际测量原名与译名的较宽者，连同姓名前约 8px 内边距确定列宽；列间距为零，原文与译文正文起点一致。旁白原译互相对齐且不留人名列。过长姓名可截断，姓名列最多占行宽的 32%，避免挤压正文。四种文字默认字号与行高协调一致，用户在主题设置中分别指定原文或译文字体/字号时继续采用其设置。

字数统计显示在左侧 `.rail-project` 项目区，单行显示为“字数 译文字符数 / 原文字符数”，`#stats` 的标题与无障碍名称说明两个数值的含义；不显示字数比，空项目时隐藏。稿页不增加统计行。底部状态栏不显示“已翻译 N/N”数字，`#progress` 仅保留为隐藏的数据节点供既有同步逻辑使用。

### 3.4 断点与弹性（桌面弹性缩放，非移动端）

| 视口 | 行为 |
|---|---|
| ≥1280（默认） | 三栏全开；稿件行宽随视口扩展，常规桌面约 780px 起，4K 屏可增至 2000px |
| 1120–1279 | 侧栏 316px → 覆盖式抽屉（默认收起），命令条分组允许溢出收纳进 `⋯` |
| 960–1119（最小 960×600） | 故事轨折叠为 52px 图标轨；命令条换行两行；状态栏隐藏快捷键区只留状态与字节口径 |
| <960 | 不承诺（Tauri minWidth 已锁 960） |

侧栏抽屉化复用现有 `#sbResize`（index.html:191）拖宽机制 + overlay 模式，不新增浮层体系。

### 3.5 单主 CTA（已移除）

> **变更（2026-09-20，master 裁决）**：单主 CTA 与命令条按钮职责重复（如「导出译文」同时出现在顶栏与命令条），整功能移除。主动作一律回到各模式命令条；§5.1 的 `.btn-primary` 类保留给弹窗确认键与空状态主按钮使用。

| 优先级 | 状态判定 | CTA 文案 | 动作 |
|---|---|---|---|
| 1 | 批量任务进行中 | 进度胶囊 `批量翻译 37/210`（本体为进度，右侧附「取消」ghost） | — |
| 2 | 有未保存改动 | `保存全部` | 现有 btnSaveAll 逻辑 |
| 3 | 未打开文档 | `导入文本` | 现有 btnImport 逻辑 |
| 4 | 干净 · 模式=项目 | `导出译文` | 现有 btnSave 逻辑 |
| 5 | 干净 · 模式=翻译 | `批量翻译` | 现有 btnMTBatch 逻辑 |
| 6 | 干净 · 模式=术语 | `应用术语表` | 现有 btnGlossApply 逻辑 |
| 7 | 干净 · 模式=搜索 | 不渲染主 CTA（搜索无全局主动作） | — |

实现注：CTA 是**一个新按钮**承接状态文案，而非让四颗既有按钮轮流显隐——避免 main.js 里散落的 disabled 编排；`withBusyState` 守卫（main.js，测试已断言）套在 CTA 触发的动作上。

### 3.6 命令条随模式切换

沿用 `data-panel`（index.html:50-129 现状机制不变），v4 只做样式收敛：分组标签（文件/进度/服务/执行/查找/导航）用 12px overline；组间用 `--border-hair` 竖分隔；溢出收纳规则见 3.4。

> **变更（2026-10-04，翻译编辑体验首轮）**：命令条最左侧新增**跨模式常驻的「编辑」组**（`#editCommand`：保存原文件 / 撤销 / 重做，`data-panel="shared"`），不随项目/翻译/术语/搜索四页切换而显隐。理由：连续翻译时保存与撤销是最高频动作，原先它们分别长在项目组与搜索栏里，切页就消失。模式专属分组照旧切换，`#controls` 的文件组不再包含保存原文件。按钮 ID 保持唯一并沿用原接线；记录包文档里保存按钮文案改为「导出记录包」。窄屏（≤720px）下编辑组独占一行、模式条换行到下一行。

---

## 4. Design Tokens v4（纯净定义）

### 4.1 命名法

- 画布/表面：`--canvas`（编辑区地面）`--bg-base/panel/raised/overlay`（阶梯 1-4）
- 描边：`--border-hair/soft/strong`
- 墨水：`--ink-hi/ink/ink-mid/ink-dim`（文字四级）；内容语义 `--ink-orig/--ink-trans/--ink-speaker`
- 强调：`--accent`（图形/链接/焦点色相）`--accent-fill`（主 CTA 填充，暗色下用深靛保证白字对比）
- 前景配对：`--fg-on-primary / --fg-on-primary-hover / --fg-on-danger / --fg-on-warning / --fg-on-approved`
- 状态：`--st-{todo,pending,issue,approved}` + `-fg`（图形用）+ `-bg/-bd`（soft pill 用）
- 兼容保留：`--orig/--trans/--name`（renderer.js 与主题设置在用，别名指向新 token）

### 4.2 暗色 · 夜读 v4（默认主题）

```css
:root{
  color-scheme:dark;
  /* ── 表面阶梯 ── */
  --canvas:#0B0D12;  --bg-base:#11141B;  --bg-panel:#161A22;
  --bg-raised:#1C212B;  --bg-overlay:#222834;

  /* ── 1px 内描边 ── */
  --border-hair:#232936;  --border-soft:#2C3341;  --border-strong:#3A4354;

  /* ── 墨水四级（对 --bg-base 实测 ≥ AA）── */
  --ink-hi:#E6EAF2;   /* 16.1:1 标题/激活 */
  --ink:#C3CAD8;      /* 11.8:1 正文 */
  --ink-mid:#949EB0;  /*  7.2:1 次级 */
  --ink-dim:#8792A3;  /*  ≈6.3:1 占位/弱说明（采纳 a11y 补丁层上调值，style.css:4331） */

  /* ── 内容语义 ── */
  --ink-orig:#A9B4C6;  --ink-trans:#E6EAF2;  --ink-speaker:#D9A05B;
  --orig-bar:#3A4354;              /* 脊线上股 */
  /* 兼容别名（renderer.js 与主题设置在用旧名，见 §4.1）——三主题共享，只此一处 */
  --orig:var(--ink-orig);  --trans:var(--ink-trans);  --name:var(--ink-speaker);

  /* ── 强调（青金蓝，单一强调色）── */
  --accent:#58A6FF;                       /* 焦点环 / 链接 / 术语下划线 / 当前行 */
  --accent-fill:#2D5F9E;                  /* 主 CTA 填充（深靛，托白字 6.4:1） */
  --accent-fill-hover:#3D6FAD;
  --accent-dim:rgba(88,166,255,.14);  --accent-bd:rgba(88,166,255,.32);

  /* ── 前景配对（on-*）── */
  --fg-on-primary:#FFFFFF;        --fg-on-primary-hover:#FFFFFF;
  --fg-on-danger:#0B0D12;         --fg-on-warning:#0B0D12;   --fg-on-approved:#06130D;
  /* 实施勘误（2026-09-19）：--fg-on-danger 在暗色下应为深字 —— 实心 #F0785A 亮度较高，
     白字仅 ≈2.6:1；深字 ≈7.1:1。此前白字为文档笔误，与 a11y 补丁层原值一致。 */

  /* ── 状态四态（soft 底 + 深字双通道）── */
  --st-todo:#7A8698;      --st-todo-fg:#C3CAD8;
  --st-pending:#E3B341;   --st-pending-fg:#2A1F04;
  --st-issue:#F0785A;     --st-issue-fg:#2B0D05;
  --st-approved:#4BB98C;  --st-approved-fg:#06130D;
  --st-todo-bg:rgba(122,134,152,.14);     --st-todo-bd:rgba(122,134,152,.28);
  --st-pending-bg:rgba(227,179,65,.14);   --st-pending-bd:rgba(227,179,65,.30);
  --st-issue-bg:rgba(240,120,90,.15);     --st-issue-bd:rgba(240,120,90,.32);
  --st-approved-bg:rgba(75,185,140,.14);  --st-approved-bd:rgba(75,185,140,.30);

  /* ── 修复 A9：pending 类黄底一律深字（废除 #F0C454 黄底浅黄字）── */

  /* ── 覆盖层 ── */
  --ov-hover:rgba(255,255,255,.045);  --ov-press:rgba(0,0,0,.22);
  --ov-selected:rgba(88,166,255,.10); --ov-scrim:rgba(5,7,11,.66);

  /* ── 机翻差异 / 词典标记 ── */
  --diff-del:#F0785A;  --diff-add:#4BB98C;  --mt-mark:rgba(88,166,255,.10);
  --focus-ring:#B8D9FF;            /* 2px 焦点环（三主题各自定值） */

  /* ── 滚动条 ── */
  --scroll-thumb:#333A48;  --scroll-thumb-hover:#444D5E;
}
```

（字体、字阶、间距、圆角、投影、动效、z-index、布局尺寸见 4.5-4.7，主题无关。）

### 4.3 亮色 · 昼笺 v4

```css
:root[data-theme="light"]{
  color-scheme:light;
  --canvas:#FFFFFF;  --bg-base:#F7F8FA;  --bg-panel:#FFFFFF;
  --bg-raised:#F0F2F6;  --bg-overlay:#FFFFFF;
  --border-hair:#E8EBF0;  --border-soft:#D8DDE6;  --border-strong:#BFC7D4;
  --ink-hi:#0B0D12;  --ink:#2E3542;  --ink-mid:#5D6675;  --ink-dim:#767F8E;
  --ink-orig:#4A5568;  --ink-trans:#0B0D12;  --ink-speaker:#9A6115;
  --orig-bar:#D8DDE6;
  --accent:#0969DA;  --accent-fill:#0969DA;  --accent-fill-hover:#0A5CB8;
  --accent-dim:rgba(9,105,218,.10);  --accent-bd:rgba(9,105,218,.30);
  --fg-on-primary:#FFFFFF;  --fg-on-primary-hover:#FFFFFF;
  --fg-on-danger:#FFFFFF;   --fg-on-warning:#FFFFFF;  --fg-on-approved:#FFFFFF;
  --st-todo:#6B7688;     --st-todo-fg:#FFFFFF;
  --st-pending:#9A6700;  --st-pending-fg:#FFFFFF;
  --st-issue:#C4432B;    --st-issue-fg:#FFFFFF;
  --st-approved:#1A7F5A; --st-approved-fg:#FFFFFF;
  --st-todo-bg:rgba(107,118,136,.10);    --st-todo-bd:rgba(107,118,136,.24);
  --st-pending-bg:rgba(154,103,0,.10);   --st-pending-bd:rgba(154,103,0,.26);
  --st-issue-bg:rgba(196,67,43,.10);     --st-issue-bd:rgba(196,67,43,.28);
  --st-approved-bg:rgba(26,127,90,.10);  --st-approved-bd:rgba(26,127,90,.26);
  --ov-hover:rgba(15,23,42,.045);  --ov-press:rgba(15,23,42,.08);
  --ov-selected:rgba(9,105,218,.10); --ov-scrim:rgba(15,23,42,.38);
  --diff-del:#C4432B;  --diff-add:#1A7F5A;  --mt-mark:rgba(9,105,218,.08);
  --focus-ring:#0969DA;
  --scroll-thumb:#C4CBD6;  --scroll-thumb-hover:#A8B2C0;
}
```

### 4.4 单色 · 墨影 v4（High-Contrast Monochrome）

修复 A8：主 CTA 改**反白填充 + 深墨字**（灰底白字对比不足的解法）；状态四态靠明度阶 + 字形双通道（P7）。

```css
:root[data-theme="bw"]{
  color-scheme:dark;
  --canvas:#222222;  --bg-base:#262626;  --bg-panel:#2E2E2E;
  --bg-raised:#343434;  --bg-overlay:#3A3A3A;
  --border-hair:#3F3F3F;  --border-soft:#4A4A4A;  --border-strong:#5A5A5A;
  --ink-hi:#FFFFFF;  --ink:#D9D9D9;  --ink-mid:#A7A7A7;  --ink-dim:#8C8C8C;
  --ink-orig:#C9C9C9;  --ink-trans:#F2F2F2;  --ink-speaker:#FFFFFF;  /* 琥珀→纯白+600字重 */
  --orig-bar:#4A4A4A;
  --accent:#E8E8E8;  --accent-fill:#E8E8E8;  --accent-fill-hover:#D4D4D4;
  --accent-dim:rgba(232,232,232,.14);  --accent-bd:rgba(232,232,232,.40);
  --fg-on-primary:#222222;  --fg-on-primary-hover:#222222;
  --fg-on-danger:#FFFFFF;   --fg-on-warning:#222222;  --fg-on-approved:#222222;
  --st-todo:#9C9C9C;     --st-todo-fg:#EDEDED;      /* 四态=明度阶 62/75/86/95% */
  --st-pending:#B4B4B4;  --st-pending-fg:#1D1D1D;
  --st-issue:#E0E0E0;    --st-issue-fg:#1D1D1D;     /* issue 用最亮+实心菱形字形区分 */
  --st-approved:#FFFFFF; --st-approved-fg:#1D1D1D;
  /* pill 底/边沿用明度阶；全部状态同时携带字形符号（○◔△✓），见 §5.5 */
  --st-todo-bg:rgba(156,156,156,.14);   --st-todo-bd:rgba(156,156,156,.30);
  --st-pending-bg:rgba(180,180,180,.16);--st-pending-bd:rgba(180,180,180,.34);
  --st-issue-bg:rgba(224,224,224,.18);  --st-issue-bd:rgba(224,224,224,.40);
  --st-approved-bg:rgba(255,255,255,.20);--st-approved-bd:rgba(255,255,255,.45);
  --ov-hover:rgba(255,255,255,.05);  --ov-press:rgba(0,0,0,.12);
  --ov-selected:rgba(232,232,232,.14); --ov-scrim:rgba(0,0,0,.55);
  --diff-del:#BFBFBF;  --diff-add:#FFFFFF;  --mt-mark:rgba(255,255,255,.10);
  --focus-ring:#FFFFFF;
  --scroll-thumb:#555555;  --scroll-thumb-hover:#666666;
}
body.theme-bw #bgLayer{ filter:grayscale(1) }   /* 背景图同步灰阶，保留现状 */
```

### 4.5 字阶（六档，主题无关）

**彻底废除 10/11px**（A2，约 120 处引用按 §4.8 映射迁移）。

| Token | 值 | 行高 | 用途 |
|---|---|---|---|
| `--fs-caption` | 12px | 1.5 | badge、overline、元信息、hint、kbd、字节指示 |
| `--fs-body` | 14px | 1.6 | **默认 UI 字号**：按钮、输入、菜单、列表 |
| `--fs-lead` | 16px | 1.6 | 面板导语、空状态描述、场景标题副行 |
| `--fs-h3` | 18px | 1.4 | 弹窗标题、面板节标题 |
| `--fs-h2` | 22px | 1.3 | 场景标题（stage h1）、统计 KPI |
| `--fs-h1` | 28px | 1.2 | 空状态大标题（全应用最大，仅此一处常用） |

权重三档：`--fw-normal:400 --fw-medium:500 --fw-semi:600`。按钮/可点击标签一律 500。

**内容轴与 chrome 轴分离**：稿件原文/译文字号是用户可调的**内容排印**（8–72px，默认 17px，index.html:668/679），不属本字阶，继续走 `--orig-font-size/--trans-font-size`（style.css:560/599 现状机制不变）。

字体栈沿用现状四族（style.css:63-66）：UI 黑体栈 / 日文衬线（原文）/ 日文黑体（译文）/ JetBrains Mono。中文 UI 不引入 webfont（桌面离线优先，Raycast 式 ss03 之类品牌字体玩法在此不适用的理由：用户可自定义稿件字体是产品功能，UI 字体必须让位）。

### 4.6 间距 · 圆角 · 投影 · 热区 · 动效 · z-index · 布局

```css
:root{
  /* ── 间距（4px 半步 + 8px 主网格，沿用现状值）── */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px;
  --sp-6:24px; --sp-8:32px; --sp-10:40px; --sp-12:48px;
  --pad-scroll-end:96px;  --pad-scroll-end-sm:64px;   /* 滚动尾留白，现状保留 */

  /* ── 圆角（利落 6-8px 体系）── */
  --r-xs:4px;     /* 徽章、kbd、脊线端点 */
  --r-sm:6px;     /* 输入框、toolbtn、tab、命令条分组 */
  --r-md:8px;     /* 按钮、行卡片、面板卡 */
  --r-lg:12px;    /* 弹窗、浮层、空状态卡 */
  --r-pill:999px; /* 状态 pill、进度胶囊 */

  /* ── 投影（只给悬浮物；版内元素零投影）── */
  --sh-hi:inset 0 1px 0 rgba(255,255,255,.045);
  --sh-1:0 1px 2px rgba(0,0,0,.40);                                  /* 浮出 1 级：popover */
  --sh-2:0 4px 12px rgba(0,0,0,.45), var(--sh-hi);                   /* 浮出 2 级：toast、拖拽侧栏 */
  --sh-3:0 12px 32px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.40), var(--sh-hi); /* 弹窗 */

  /* ── 热区 / 控件高度（P6 三层分离）── */
  --hit-min:40px;      /* 全部可交互元素的最小热区（tests/ui-a11y.test.mjs 断言名） */
  --hit-visual:32px;   /* 密集列表控件的视觉高；热区用透明 padding 补足 40px */
  --row-h:32px;        /* 密集列表行（术语表、文件树） */

  /* ── 动效（沿用现状曲线）── */
  --ease:cubic-bezier(.4,0,.2,1);  --ease-out:cubic-bezier(.16,1,.3,1);
  --t-press:60ms; --t-fast:100ms; --t-base:160ms; --t-slow:240ms;

  /* ── 层级（沿用现状）── */
  --z-base:0; --z-sticky:10; --z-rail:20; --z-topbar:30; --z-dropdown:40;
  --z-scrim:50; --z-modal:60; --z-popover:70; --z-toast:80;

  /* ── 布局尺寸 ── */
  --topbar-h:48px;  --strip-h:44px;  --statusbar-h:32px;
  --rail-w:220px;   --rail-w-collapsed:52px;
  --sidebar-w:316px;                /* 可拖 280–460，<1120 转抽屉 */
  --stage-measure:clamp(780px,calc(95vw - 645px),2000px);
  --row-num-col:48px;
  --byte-limit:120;  --width-limit:30;   /* 契约值：DEVELOPMENT.md「显示与容量」，勿在此改 */
}
```

### 4.7 功能性保留变量（实施时**必须**继续生效）

| 变量 | 驱动方 | 证据 |
|---|---|---|
| `--text-area-alpha` + `--row-bg-glass` 系列 | 主题设置「文本区透明度」 | style.css:194-202、306-314 |
| `--bg-mask-opacity` | 背景遮罩强度 | style.css:303 |
| `--orig-font-size/-family/-color`、`--trans-font-*` | 文本排印设置 | style.css:558-599 |
| `--stage-measure` | 稿件行宽随视口扩展，最小 780px、最大 2000px | style.css:119 |
| `--row-h/--control-h/--density-pad` | `data-density` 三档 | style.css:3474-3479 |
| `--row-num-col`、`--byte-limit/--width-limit` | 布局与容量契约 | style.css:123-127、DEVELOPMENT.md |

### 4.8 迁移别名层（过渡期，带删除条件）

```css
/* ⚠ 过渡层：仅允许「改名替换」期间存在。全部 --fs-2xs/--fs-xs/--fs-sm/… 引用替换完毕后整体删除，
   删除条件 = grep 归零。禁止在新代码中引用本层。 */
:root{
  --fs-2xs:var(--fs-caption);  --fs-xs:var(--fs-caption);  --fs-sm:var(--fs-caption);
  --fs-base:var(--fs-body);    --fs-md:var(--fs-body);
  --fs-lg:var(--fs-lead);      --fs-xl:var(--fs-h3);       --fs-2xl:var(--fs-h2);
  --fs-h1:28px; /* 新增档 */
}
```

旧**取色**别名（`--vermilion/--paper/--smoke/--quiet/--amber/--ink/--hairline/--app-bg/--panel-bg…`，style.css:140-215）**不给映射**：实施时逐处改写为新 token（约 800 行 CSS 的机械替换，P0 范围），因为它们是三代语言混杂的根因，映射等于把混乱合法化。

---

## 5. 核心原子组件规范

### 5.1 按钮（四级 × 六状态）

层级语义（对齐现状 id 编排，index.html:51-128）：

| 层级 | 类 | 用途 | 视觉 |
|---|---|---|---|
| Primary | `.btn-primary` | 每视图**至多一个**：顶栏单主 CTA、弹窗确认键、空状态导入 | `--accent-fill` 填充 + `--fg-on-primary` |
| Secondary | `.btn`（默认） | 一切常规动作（保存/跳转/筛选） | `--bg-raised` 填充 + `--border-strong` 描边 + `--ink` |
| Ghost | `.btn-ghost` | 工具栏低频动作、行内复制、取消 | 透明填充 + `--ink-mid`，hover 才现底 |
| Danger | `.btn-danger` | 清空翻译/清除进度等不可逆动作 | `--st-issue-bg` 底 + `--st-issue` 描边 + `--st-issue-fg`；hover 才转实心 |

```css
.btn{
  min-height:var(--hit-min);              /* 热区 40 */
  height:var(--hit-visual);               /* 视觉 32：差值用纵向透明 padding 呈现 */
  padding:4px 14px; margin:0;
  border:1px solid var(--border-strong); border-radius:var(--r-sm);
  background:var(--bg-raised); color:var(--ink);
  font:var(--fw-medium) var(--fs-body)/1.2 var(--font-ui);
  cursor:pointer; white-space:nowrap;
}
.btn:hover{ background:var(--bg-overlay); color:var(--ink-hi);
            border-color:var(--border-strong); transition:background-color var(--t-fast) var(--ease) }
.btn:active{ background:var(--bg-panel); transform:translateY(1px) }  /* 位移 1px 即「按下去」 */
.btn:disabled{ opacity:.5; cursor:not-allowed; transform:none }

.btn-primary{ background:var(--accent-fill); border-color:transparent; color:var(--fg-on-primary) }
.btn-primary:hover{ background:var(--accent-fill-hover); color:var(--fg-on-primary-hover) }
.btn-primary:active{ background:var(--accent-fill) }

.btn-ghost{ background:transparent; border-color:transparent; color:var(--ink-mid) }
.btn-ghost:hover{ background:var(--ov-hover); color:var(--ink-hi) }

.btn-danger{ background:var(--st-issue-bg); border-color:var(--st-issue-bd); color:var(--st-issue-fg) }
.btn-danger:hover{ background:var(--st-issue); color:var(--fg-on-danger) }

.btn[data-busy="true"]{ cursor:wait; pointer-events:none }   /* busy spinner 沿用现状 4432-4444 */
```

密集列表（术语表/文件树）内的按钮：`height:var(--hit-visual)` 不变，40px 热区由「行高 40 + 行可点」兜底——行本身是热区（现状 `#tabs .doc-tab` 已是此模式，style.css:340-343）。

### 5.2 焦点环（全应用唯一规则，修复 A5）

```css
:where(button,a,input,select,textarea,[tabindex]):focus-visible{
  outline:2px solid var(--focus-ring);   /* tests/ui-a11y.test.mjs:47 断言此形 */
  outline-offset:2px;
  border-radius:var(--r-xs);             /* outline 跟随圆角 */
}
:where(input,select,textarea):focus{ border-color:var(--accent) }  /* 文本插入符位置的补充提示 */
/* 禁止任何 box-shadow 型焦点；433/2625/4395 三处旧规则实施时删除 */
```

### 5.3 文本输入 / 选择框

```css
.input, input[type=text], select, textarea{
  min-height:var(--hit-min);
  padding:6px 10px;
  border:1px solid var(--border-strong); border-radius:var(--r-sm);
  background:var(--bg-raised); color:var(--ink);
  font:var(--fs-body)/1.5 var(--font-ui);
}
::placeholder{ color:var(--ink-dim) }
```

密集表格内输入（术语行等）：视觉高 32px、热区由行距兜底，同 5.1 尾注。

### 5.4 编辑卡片（行卡片全状态）

状态矩阵（互斥层从上往下覆盖）：

| 状态 | 载体 | 视觉 |
|---|---|---|
| 默认 | `.para` | `--canvas` 底、无描边；脊线上股 `--orig-bar`、下股=状态色 60% 明度 |
| 悬停 | `.para:hover` | `--bg-base` 底；脊线下股提至 100% |
| 激活（当前行） | `.para.active` | `--bg-raised` 底 + `1px --border-soft` 描边 + `--r-md`；元信息行完整显徽章 |
| 编辑中 | `.para:focus-within` | 描边转 `--accent-bd`；译文 textarea 底转 `--bg-overlay` |
| 机翻差异 | `.para.mt-diff` | 译文段内 diff 标记（删=`--diff-del` 删除线、增=`--diff-add`）+ 行尾「机翻基线」12px 徽章；不做整行染色 |
| 搜索命中 | `.para.name-match` / mark | 命中词琥珀 mark（`--ink-speaker` 底 14% 透明 + 深字） |
| 术语命中 | `.term-hit` | 点状下划线 `--accent`（现状机制保留，style.css:617） |
| 已通过 | `.para.done` | 下股脊线 `--st-approved`；元信息行 ✓ 字形 |

```css
.para{ position:relative; padding:var(--sp-3) var(--sp-4) var(--sp-3) calc(var(--sp-4) + 2px);
       border:1px solid transparent; border-radius:var(--r-md); background:var(--canvas) }
.para .spine{ position:absolute; left:0; top:var(--r-md); bottom:var(--r-md);
              width:2px; border-radius:var(--r-xs); overflow:hidden;
              display:flex; flex-direction:column }
.para .spine i:first-child{ flex:1 1 0; background:var(--orig-bar) }          /* 上股：原文区间 */
.para .spine i:last-child { flex:1 1 0 }                                       /* 下股：状态区间 */
.para[data-state="todo"]     .spine i:last-child{ background:color-mix(in srgb,var(--st-todo)     60%,transparent) }
.para[data-state="pending"]  .spine i:last-child{ background:color-mix(in srgb,var(--st-pending)  60%,transparent) }
.para[data-state="issue"]    .spine i:last-child{ background:color-mix(in srgb,var(--st-issue)    60%,transparent) }
.para[data-state="approved"] .spine i:last-child{ background:var(--st-approved) }  /* 完成=满格 */
.para:hover{ background:var(--bg-base) }
.para.active{ background:var(--bg-raised); border-color:var(--border-soft) }
.para:focus-within{ border-color:var(--accent-bd) }
```

背景图模式（body.has-background）：卡片底换成 `--row-bg-glass`（color-mix 链路保留，style.css:199-201），脊线与描边不变——脊线是状态通道，不允许被透明度稀释。

### 5.5 状态徽章（颜色 + 字形双通道）

```
○ 未翻译   ◔ 待校   △ 有问题   ✓ 已通过
```

- pill：`--st-*-bg` 底 + `--st-*-bd` 边 + `--st-*-fg` 字（12px/500），左置字形。
- **修复 A9**：黄系底一律深字（`--st-pending-fg:#2A1F04`），废除「黄底浅黄字」。
- 墨影主题：四态=明度阶 + 字形（△ 实心 vs ○ 空心），不依赖色相（P7）。
- 非激活行不渲染完整徽章（3.2 减噪承诺）；徽章只出现在激活行、校对面板、doc-tab 分段条（`#tabs .doc-tab .seg`，style.css:348-357，保留）。

### 5.6 空状态导入卡

> **变更（2026-09-20，master 裁决）**：不要有边框的整卡容器 —— 内容无框居中，
> 仅保留插图 + 标题 + 描述 + 主按钮 + 拖放提示。

```css
.empty-state{
  max-width:440px; margin:18vh auto 0; padding:var(--sp-8) var(--sp-6);
  border:1px dashed var(--border-strong); border-radius:var(--r-lg);
  background:var(--bg-panel); text-align:center;
}
.empty-state .empty-illust{ /* 64px 内联 SVG：一张稿纸线稿，两行文字代表原文/译文 */ }
.empty-title{ font:var(--fw-semi) var(--fs-h1)/1.2 var(--font-ui); color:var(--ink-hi) }
.empty-desc{ margin:var(--sp-3) 0 var(--sp-6); font:var(--fs-lead)/1.6 var(--font-ui); color:var(--ink-mid) }
.empty-action{ min-height:var(--hit-min) }   /* tests/ui-a11y.test.mjs:49 断言此选择器 */
.empty-state .drop-hint{ margin-top:var(--sp-4); font:var(--fs-caption)/1.5 var(--font-ui); color:var(--ink-dim) }
```

文案（按 frontend-design 写作纪律：动词开路，空屏是邀请不是感叹）：

> **从一句对白开始**（H1 28）
> 导入一份 Galgame 脚本，每段对白都会在这里成为可翻译的稿页。（lead 16）
> [导入文本]（Primary 40px）
> 也可以把 .txt / .ks 直接拖进窗口。（caption 12）

同模式复用到：词典无结果、术语表为空、搜索无命中——只换插图与文案，壳一律 `.empty-state`。

### 5.7 标签页三件套

| 控件 | 位置 | 激活态 |
|---|---|---|
| 工作区 switch（4 档） | 顶栏中央 | `--bg-raised` 胶囊 + `--ink-hi`（分段控件，非下划线 tab） |
| 侧栏面板 tabs（5 档） | 侧栏头 | 文字转 `--ink-hi` + 底部 2px `--accent` 短线 |
| 文档 doc-tab | 故事轨 | `--bg-raised` 卡片 + 分段进度条（保留现状 seg-bar，style.css:348-357） |

三件套高度全部 ≥40px 热区（现状 26-31px，A3）。

### 5.8 图标（内联 SVG，禁 emoji）

- 网格：24 viewBox / 1.5px 描边 / `currentColor`，尺寸 16px（行内）与 20px（按钮）两档。
- 必备集（15 枚）：import、save、save-all、export、undo、redo、search、replace、book（词典）、pen（批注）、check、warning、close、panel-collapse、more。（原第 16 枚 theater 随剧场功能于 2026-09-19 一并移除。）
- 替换点：↩↪（index.html:125-126）→ undo/redo；＋（234/241/247/303）→ plus；📖（272）→ book；📝（337）→ pen；✓ 伪元素（style.css:1762）→ check。
- 以 `<symbol>` sprite 内联进 index.html（无框架、离线、零依赖，符合项目技术形态）。

### 5.9 Toast / 忙碌 / 弹窗

- Toast：`--bg-overlay` 底 + 左缘 3px 状态色条 + `--ink-hi`（修复 A6 硬编码）；错误 toast 同构换 `--st-issue`。
- 忙碌：`data-busy` spinner 现状保留（style.css:4429-4447）；长任务文案进状态栏（⑥），不弹模态。
- 弹窗：`--bg-overlay` + `--r-lg` + `--sh-3`；遮罩 `--ov-scrim`；标题 18px、正文 14px、确认键 Primary、取消 Ghost——现状五个模态结构保留，样式重绘。
- errbox（index.html:794-798）迁入 style.css，用 `--st-issue` 系 token（修复 A6）。

---

## 6. 对比度与验收

### 6.1 对比度目标

| 配对 | 目标 | 依据 |
|---|---|---|
| 正文墨水对所在表面 | ≥ 7:1（AAA） | 用户要求 WCAG AAA/AA；暗色四级现状已达标（style.css:19-23 注释） |
| 12px caption、按钮字 | ≥ 4.5:1（AA） | WCAG 1.4.3 |
| `--fg-on-primary` 对 `--accent-fill` | ≥ 4.5:1 | 三主题逐一定值：暗 6.4 / 亮 5.9 / 墨影 15.9（#222 on #E8E8E8） |
| 状态 fg 对状态 bg | ≥ 4.5:1 | 修复 A9 的验收口径 |
| 焦点环对相邻表面 | ≥ 3:1 | WCAG 1.4.11 非文本对比 |

### 6.2 自动化验收（新增测试义务）

新增 `tests/contrast.test.mjs`：解析 style.css 的三主题变量块，用 WCAG 相对亮度公式计算 6.1 表中全部配对，任一不达标即红。**没有这个测试，§4 的色值就是口头承诺**——这符合本项目「契约必须挂单测」的既有纪律（DEVELOPMENT.md 维护契约）。

### 6.3 人工验收清单（交付前）

对照 ui-ux-pro-max Pre-Delivery Checklist 逐条打勾：无 emoji 图标、cursor-pointer、hover 150-300ms 过渡、三主题切换逐屏目检、Tab 键走查全应用焦点环、`prefers-reduced-motion` 下动画降级、960×600 与 1280×800 双档截图。

---

## 7. 落地路线图（规划与执行分离；按 AGENTS.md §2 带优先级与工作量）

| # | 事项 | 优先级 | 人日 | 说明 |
|---|---|---|---|---|
| 1 | 文档接线：style.css:4 改指本文档；DEVELOPMENT.md 契约区补一行 | P0 | 0.1 | 防再次失联 |
| 2 | Token v4 落地：§4 三主题块写入，删除两套取色别名层（140-215）与 a11y 补丁层（4323-4348 并入正式层），全文件取色替换 | P0 | 2 | 约 800 行机械替换，行为不变 |
| 3 | 字阶收敛：10/11px→12px 全量替换（§4.8 映射 + 120 处 grep 归零）；删除 4.8 过渡层 | P0 | 1 | 替换完 grep 校验归零 |
| 4 | 控件体系：40/32 热区制 + 圆角 4/6/8/12 全量 + §5.2 唯一焦点规则（删 433/2625/4395 旧规则） | P0 | 1 | 同步 ui-a11y.test.mjs（应保持绿） |
| 5 | 顶栏重构 + 单主 CTA 状态机（3.5）+ SVG sprite 16 枚（5.8）+ 状态栏（⑥） | P1 | 2.5 | HTML + main.js 接线，保留全部 id |
| 6 | 编辑卡片 v4：双股脊线 + 状态矩阵（§5.4）+ renderer.js 类名接线 | P1 | 2 | 签名元素，先做暗色主题验收 |
| 7 | `tests/contrast.test.mjs`（§6.2） | P1 | 0.5 | 与 #2 同批交付更稳 |
| 8 | 侧栏五面板 + 五弹窗 + 密集表格翻新（热区/圆角/on-* 核查） | P2 | 2.5 | 机械量大，无设计分歧 |
| 9 | 空状态卡 / 背景图玻璃行适配（4.7 功能变量回归验证） | P2 | 1 | 剧场模式已整功能移除（2026-09-19），不适用 |
| 10 | 动效与微交互打磨（reduced-motion 全局规则、toast 重绘、hover 节奏） | P3 | 1 | 最后做，避免返工 |
| **合计** | | | **≈13.5** | P0≈4.1 / P1≈5 / P2≈3.5 / P3≈1 |

依赖关系：#2 → #3/#4 →（#5、#6 可并行）→ #8 → #9 → #10。#7 与 #2 同批。

风险登记：
- 双股脊线（P5）是唯一假设性改动，#6 交付后先自用一篇脚本再继续 #8；
- 「热区 40 + 视觉 32」若在术语密集表试用中显得松，允许密集表退到「行即热区」方案（5.1 尾注），不动 `--hit-min` 本身；
- 别名删除（#2）波及面最大，须单独成一个 commit，出问题可独立回滚。
