# Galweave 视觉设计规范 v3 — 深夜译场

> **版本**：v3（取代 v2，v2 内容全量吸收，无信息丢失）
> **适用范围**：仅 CSS / 样式层，不动业务逻辑
> **目标气质**：工程化工具的骨架 + 文稿的阅读节奏。不是 VS Code 的冰冷密度，也不是 Notion 的消费级圆润。
> **一句话定位**：一份在深夜里能被连续阅读 6 小时而不刺眼的稿纸，外面套着一套精确到 1px 的工具外壳。
> **前置阅读**：本文件的所有行号引用基于 `src/style.css`（2466 行）实读，改动前请复核。

---

## 0. v3 相对 v2 的变更

### 0.1 两处色值修正（v2 有实测错误）

v2 声称 `--text-dim` 对比度 4.6:1，实测不成立。以下是用 WCAG 2.1 相对亮度公式实算的结果：

| Token | v2 值 | 实测（on `--bg-void`） | v3 修正值 | 修正后 |
|---|---|---|---|---|
| `--text-dim` | `#616B7E` | **3.62:1** ❌ 未达 AA | `#7C8798` | **5.35:1** ✅ |
| `--st-todo` | `#6B7688` | **4.23:1** ❌ 未达 AA | `#7A8698` | **5.27:1** ✅ |

连带调整：`--text-mid` `#8B95A7` → `#949EB0`（避免与提亮后的 `--text-dim` 档差塌陷）。

### 0.2 新增：状态色前景档（`--st-*-fg`）

pill 徽标里的 10px 文字若直接用状态色，对比度在 3.64–6.85 之间浮动，其中"未翻译"只有 3.64。拆成两档：

- **状态色本体**（`--st-*`）：用于 3px 圆点、1px 边框、进度条填充 —— 图形元素，3:1 即可
- **状态色前景**（`--st-*-fg`）：用于 pill 内文字 —— 文本元素，必须 ≥ 4.5:1

实测 pill 文字对比度（合成底按 CSS gamma 空间叠加规则计算）：

| 状态 | pill 底（状态色 14% over `--bg-raised`） | `--st-*-fg` 文字 | 对比度 |
|---|---|---|---|
| 未翻译 | `#292F3A` | `#9AA5B8` | 5.41 ✅ |
| 待校对 | `#38352E` | `#F0C454` | 7.41 ✅ |
| 有问题 | `#3C2E32` | `#FF8F73` | 5.79 ✅ |
| 已定稿 | `#233639` | `#5FD0A0` | 6.64 ✅ |

### 0.3 新增：状态形状编码（修正 v2 的色觉障碍漏洞）

v2 用「不同颜色的 3px 圆点」区分四态 —— 形状相同，色一失效就全靠文字。实测四态色在三类色觉障碍下的 CIELAB ΔE76：

| 配对 | 常色 | 红色盲 | 绿色盲 |
|---|---|---|---|
| 未翻译 ↔ 待校对 | 76.1 | 73.2 | 81.1 |
| 未翻译 ↔ 有问题 | 66.3 | 38.7 | 58.2 |
| 未翻译 ↔ 已定稿 | 50.2 | 34.7 | 26.0 |
| 待校对 ↔ 有问题 | 46.2 | 36.2 | 23.4 |
| 待校对 ↔ 已定稿 | 68.8 | 40.2 | 55.8 |
| **有问题 ↔ 已定稿** | 89.3 | **15.8 ⚠️ 弱** | 33.5 |

红色盲下「有问题 / 已定稿」ΔE 仅 15.8，会混淆。这是 v2 配色方案唯一的真实弱点（其余配对全部 ≥ 23）。

**解决方案：形状冗余编码。** 四个状态各配一个 8×8 SVG 字形，与颜色正交：

| 状态 | 字形 | 语义 |
|---|---|---|
| 未翻译 | `○` 空心圆 | 空，待填 |
| 待校对 | `◐` 半填充圆 | 半成品 |
| 有问题 | `▲` 实心三角 | 警示，唯一有尖角的 |
| 已定稿 | `✓` 对勾 | 完成 |

> 不用 emoji。全部走 8×8 viewBox 的 inline SVG，`fill:currentColor`。

### 0.4 间距网格升级：4px → 8px 主网格

v2 用 4px 网格，本版改 **8px 主网格 + 4px 半步**。理由见 §4。

### 0.5 v3 新增章节（v2 完全未覆盖）

| 章节 | 内容 |
|---|---|
| §5 | 图标系统（尺寸档、描边、命中区） |
| §6 | z-index 层级 + 三档密度模式 |
| §7.6–7.14 | 按钮/输入/下拉/开关、模态、Toast、右键菜单、命令面板、空状态、加载态、滚动条、分隔器 |
| §8.5 | 警示三级体系（inline / toast / modal） |
| §9 | 无障碍实测表 |

---

## 1. 设计原则

1. **语义靠字形，不靠颜色。** 原文明朝 / 译文黑体的字体族差异是本规范的基石 —— 截图转灰度、色觉障碍、低亮度屏下依然可分。颜色永远是第二信号。
2. **冗余编码。** 任何关键信息至少有两条独立通道（颜色 + 形状 / 字体 + 亮度 / 位置 + 边框）。任一条失效，信息仍在。
3. **密度优先于留白。** 这是专业工具，不是营销页。信息密度是特性不是缺陷，留白只用在需要"呼吸"的阅读区（原文/译文）。
4. **不做位移反馈。** hover / active 只改颜色与阴影，不改尺寸不位移 —— 2000+ 行虚拟滚动里，任何布局抖动都是灾难。
5. **暗色深度靠内高光，不靠黑阴影。** 纯黑 box-shadow 在暗底上只会变脏，真正的层次来自顶部 1px 内高光 + 边框明度分级。

---

## 2. 配色系统

### 2.1 为什么是冷蓝黑底，不是紫黑或暖褐

画面主体是日文假名。暖色/紫调底色会降低假名灰度笔画的辨识度，长时间阅读疲劳翻倍。**冷蓝黑底 + 暖色语义标记**才能让原文"浮"起来。

不用 `#0d1117` 原值：太中性、偏"GitHub 网页"，缺少工具的空间深度。以下色板在其基础上做了蓝相偏移 + 明度分层。

现有 `src/style.css` 的朱红文稿系（`--ink:#151315` / `--paper:#f2ebe3` / `--vermilion:#b9584f`）**整体废弃**。

> ⚠️ **2026-08-30 P0 实读修正：文件里是三套变量体系，不是两套。**
>
> | 层 | 位置（改造前） | 内容 |
> |---|---|---|
> | 第一套 暖褐陶土系 | `:1–64` + `:66–126`(light) + `:129–189`(bw) | `--app-bg` / `--text` / `--accent:#c96b59`，前 1644 行样式在用 |
> | 第二套 朱红文稿系 | `:1646–1660` | `--ink` / `--paper` / `--vermilion`，1645 行之后 821 行 CSS 的取色源 |
> | **第三套 统一编辑部** | `:1941–2030`（含 light/bw 共 3 个块） | 把 `--ink` 等**硬编码回**朱红文稿色，并反向桥接 `--app-bg:var(--ink)` / `--text:var(--paper)` / `--accent:var(--vermilion)` |
>
> **第三套才是最终生效层**，也是 v3 token 无法生效的真正根因。只删 `1647–1659` 不但无效（会被第三套重新定义），还会让 821 行 CSS 的 `var(--ink)` 全部解析失败。
>
> 正确做法见 §12 P0-1：**别名层重定向**，而不是删除。此修正已落地（2026-08-30）。

### 2.2 背景层（5 级，明度差 6–8%）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-void` | `#0B0D12` | 编辑器画布底（`#list` / `#stage`），最深 |
| `--bg-base` | `#11141B` | 应用底（`body`） |
| `--bg-panel` | `#161A22` | 侧栏 / 顶栏 / 场景树 |
| `--bg-raised` | `#1C212B` | 输入框 / 卡片 / 行悬停 |
| `--bg-overlay` | `#222834` | 下拉 / 浮层 / 模态 |

### 2.3 边框层（3 级）

暗色 UI 的层次主要靠边框，不是阴影。

| Token | 值 | 用途 |
|---|---|---|
| `--border-hair` | `#232936` | 1px 发丝线：行分隔、树引导线 |
| `--border-soft` | `#2C3341` | 常规边框：按钮、输入框默认态 |
| `--border-strong` | `#3A4354` | 强调边框：hover、分组边界 |

### 2.4 文字层（4 级）

对比度实测（相对各级背景）：

| Token | 值 | void | base | panel | raised | overlay | 用途 |
|---|---|---|---|---|---|---|---|
| `--text-hi` | `#E6EAF2` | 16.12 | 15.28 | 14.45 | 13.38 | 12.26 | 译文、关键数字 |
| `--text` | `#C3CAD8` | 11.81 | 11.20 | 10.59 | 9.80 | 8.98 | UI 正文、原文强调 |
| `--text-mid` | `#949EB0` | 7.15 | 6.78 | 6.41 | 5.93 | 5.43 | 次要信息、标签 |
| `--text-dim` | `#7C8798` | 5.35 | 5.07 | 4.79 | 4.44 | 4.06 | 辅助、占位符、禁用 |

> 全部 ≥ 4.0:1。`--text-dim` 在 `--bg-overlay` 上为 4.06，**不用于承载正文**，仅作辅助说明与占位符。

### 2.5 覆盖层（overlay tint）

v2 里这些是散落的硬编码 rgba。统一收口：

| Token | 值 | 用途 |
|---|---|---|
| `--ov-hover` | `rgba(255,255,255,.045)` | 行 / 列表项 hover 叠加 |
| `--ov-press` | `rgba(0,0,0,.22)` | active 按压叠加 |
| `--ov-selected` | `rgba(88,166,255,.10)` | 选中态叠加 |
| `--ov-disabled` | `rgba(17,20,27,.55)` | 禁用态叠加 |
| `--scrim` | `rgba(5,7,11,.66)` | 模态遮罩（合成后 ≈ `#090B10`） |

### 2.6 强调色（功能 / 焦点双色制）

| Token | 值 | 职责 |
|---|---|---|
| `--accent` | `#58A6FF` | 功能青蓝：焦点环、激活态、链接、当前行指示（on raised 6.39:1） |
| `--accent-dim` | `rgba(88,166,255,.14)` | 激活态背景 |
| `--accent-glow` | `rgba(88,166,255,.10)` | 当前行左侧渐变起色 |
| `--accent-ring` | `rgba(88,166,255,.16)` | 焦点环外扩 |

**为什么青蓝而非蓝紫 `#7c6fcd`：** 蓝紫在暗底上偏装饰性、易与"已禁用"混淆；青蓝是跨平台通用的"可操作"信号。

### 2.7 语义色（原文 / 译文 / 说话人）

| Token | 值 | 语义 | on void |
|---|---|---|---|
| `--orig` | `#A9B4C6` | 原文：冷灰蓝，**主动退后** | 9.28 |
| `--trans` | `#E6EAF2` | 译文：**最亮，主动前进** | 16.12 |
| `--name` | `#D9A05B` | 说话人：琥珀，画面里唯一的暖色锚点 | 8.45 |
| `--orig-bar` | `#3A4354` | 原文左侧色条默认态 | — |

### 2.8 状态色（4 态）

| Token | 值 | 前景 `--st-*-fg` | 状态 | 语义 |
|---|---|---|---|---|
| `--st-todo` | `#7A8698` | `#9AA5B8` | 未翻译 | 中性灰，不抢注意力 |
| `--st-pending` | `#E3B341` | `#F0C454` | 待校对 | 琥珀，等待行动 |
| `--st-issue` | `#F0785A` | `#FF8F73` | 有问题 | 朱橙，需要修 |
| `--st-approved` | `#4BB98C` | `#5FD0A0` | 已定稿 | 青绿，完成 |

pill 底 / 边框不透明度：

| 状态 | 底（bg） | 边框（bd） |
|---|---|---|
| 未翻译 | `rgba(122,134,152,.14)` | `rgba(122,134,152,.28)` |
| 待校对 | `rgba(227,179,65,.14)` | `rgba(227,179,65,.30)` |
| 有问题 | `rgba(240,120,90,.15)` | `rgba(240,120,90,.32)` |
| 已定稿 | `rgba(75,185,140,.14)` | `rgba(75,185,140,.30)` |

> 用 **琥珀 / 朱橙 / 青绿** 而非红黄绿老三样：色相跨度更大、明度差明显。但仍需 §0.3 的形状编码兜底（红色盲下 issue/approved 会靠色）。

### 2.9 辅助语义色

| Token | 值 | 用途 |
|---|---|---|
| `--diff-add` | `#4BB98C` | 导入/导出 diff 新增行（复用 approved） |
| `--diff-del` | `#F0785A` | diff 删除行（复用 issue） |
| `--note` | `#D9A05B` | 批注标记（复用 name，暖色锚点语义一致） |
| `--mt-mark` | `rgba(88,166,255,.10)` | 机翻结果底纹（复用 accent，不新增色相） |

> **克制原则**：机翻标记、diff 不新增色相。色相每多一个，画面的语义噪音就多一层。四个状态色 + 一个功能色 + 一个暖色锚点，就是这套工具需要的全部色相。

### 2.10 浅色主题

只重定义背景/文字/边框三组 + accent。语义色与状态色的**色相保持不变**，仅压暗明度适配亮底：

```css
:root[data-theme="light"]{
  --bg-void:#FFFFFF;  --bg-base:#F7F8FA;  --bg-panel:#FFFFFF;
  --bg-raised:#F0F2F6; --bg-overlay:#FFFFFF;
  --border-hair:#E8EBF0; --border-soft:#D8DDE6; --border-strong:#BFC7D4;
  --text-hi:#0B0D12; --text:#2E3542; --text-mid:#5D6675; --text-dim:#767F8E;
  --accent:#0969DA;  --accent-dim:rgba(9,105,218,.10);
  --accent-glow:rgba(9,105,218,.06); --accent-ring:rgba(9,105,218,.18);
  --orig:#4A5568; --trans:#0B0D12; --name:#9A6115; --orig-bar:#D8DDE6;
  --st-todo:#6B7688; --st-pending:#9A6700; --st-issue:#C4432B; --st-approved:#1A7F5A;
  --st-todo-fg:#5D6675; --st-pending-fg:#7A5200; --st-issue-fg:#A5341F; --st-approved-fg:#0F6B4B;
  --ov-hover:rgba(15,23,42,.045); --ov-press:rgba(15,23,42,.08); --scrim:rgba(15,23,42,.38);
  --sh-hi:inset 0 1px 0 rgba(255,255,255,.9);
}
```

**主题切换过渡**：在 `html` 上加 `transition: background-color 200ms, color 200ms`。切换瞬间给 `body` 挂 `.theme-switching`（`pointer-events:none`），避免切换过程中误触。

---

## 3. 字体系统

### 3.1 四族分工

**核心策略：原文用明朝（衬线），译文用黑体（无衬线）。** 字体族差异是比颜色更可靠的语义信号。

```css
--font-ui:       "HarmonyOS Sans SC","MiSans","PingFang SC","Source Han Sans SC","Noto Sans SC","Microsoft YaHei UI",system-ui,sans-serif;
--font-serif-jp: "Noto Serif JP","Yu Mincho","YuMincho","Hiragino Mincho ProN","Source Han Serif SC","Songti SC",SimSun,serif;
--font-sans-jp:  "Noto Sans JP","Yu Gothic UI","Hiragino Kaku Gothic ProN","Meiryo","Microsoft YaHei",sans-serif;
--font-mono:     "JetBrains Mono","Cascadia Code","Cascadia Mono","Sarasa Mono SC","Sarasa Term SC",Consolas,monospace;
```

| 场景 | 字体 | 理由 |
|---|---|---|
| 界面（按钮/菜单/树/标签） | `--font-ui` | 中文优先，字形方正，小字号可读性好 |
| **原文** | `--font-serif-jp` | 明朝体，假名笔画舒展，长文阅读疲劳最低 |
| **译文 / 译名输入** | `--font-sans-jp` | 黑体，与原文形成质感反差 |
| 行号/编号/字节数/标记符 | `--font-mono` | 数字垂直对齐 |

> ⚠️ **不要给日文原文上等宽字体。** 假名在等宽字形里字面偏小、字重偏轻，可读性显著下降。等宽只服务数字和结构符号。

### 3.2 字体加载 — 离线优先（对 Tauri 桌面版是硬约束）

**禁止 `@import url('https://fonts.googleapis.com/...')`。** Galweave 是离线桌面工具，webfont CDN 在断网/内网环境下会直接拖垮首屏，且 Tauri 的 CSP 默认会拦截。

采用**纯系统字体栈 + 可选内置子集**：

1. **默认**：完全依赖上表的系统字体栈，零网络请求。中日韩用户的系统上必然命中 `Yu Mincho` / `Hiragino` / `PingFang` / `Microsoft YaHei` 中的某一档。
2. **可选增强**：把 Noto Serif JP 的 **日文子集（约 1.2MB woff2）** 打进 Tauri 资源，用 `@font-face` + `unicode-range` 只覆盖 `U+3040–30FF`（假名）+ `U+4E00–9FFF`（汉字）中日共用区：

```css
@font-face{
  font-family:"Galweave Serif JP";
  src:url("/fonts/NotoSerifJP-Subset.woff2") format("woff2");
  font-weight:400 700;
  font-display:swap;
  unicode-range:U+3040-30FF,U+31F0-31FF,U+4E00-9FFF,U+FF66-FF9F;
}
```

3. 单文件 HTML 形态**不内置**字体（体积优先），只走系统栈。字体栈里 `--font-serif-jp` 已覆盖三平台，退化可接受。

### 3.3 字重映射

只用 4 档，避免系统字体 fallback 时的合成字重（fake bold 在暗底上会糊）：

| Token | 值 | 用途 |
|---|---|---|
| `--fw-normal` | 400 | 正文、原文/译文 |
| `--fw-medium` | 500 | UI 控件文字、小字号加读性 |
| `--fw-semi` | 600 | 标签、说话人名、当前行号 |
| `--fw-bold` | 700 | 仅用于危险态数字、超限警示 |

> Windows 上 `PingFang SC` 不存在，`HarmonyOS Sans SC` / `MiSans` 也不存在，会落到 `Microsoft YaHei UI`（只有 Regular/Bold 两档）。600 在 YaHei 上会合成 —— 因此 **600 只在 ≤12px 的标签上使用**，正文级文字一律 400/500。

### 3.4 字阶（type scale）

| Token | 字号 | 行高 | 字重 | 用途 |
|---|---|---|---|---|
| `--fs-2xs` | 10px | 1.4 | 500 | 行号、角标、`<kbd>`、状态 pill |
| `--fs-xs` | 11px | 1.45 | 500 | overline 标签、状态文字、说话人名 |
| `--fs-sm` | 12px | 1.5 | 500 | 工具栏按钮、树节点次要信息 |
| `--fs-base` | 13px | 1.6 | 400 | UI 正文、输入控件 |
| `--fs-md` | 14px | 1.65 | 400 | 侧栏正文、批注内容 |
| `--fs-lg` | **16px** | **1.9** | 400 | **原文 / 译文正文**（阅读核心 = 30.4px 行高） |
| `--fs-xl` | 18px | 1.5 | 500 | 场景标题、模态标题 |
| `--fs-2xl` | 22px | 1.35 | 500 | 空状态主标题 |

现有 `src/style.css` 散落的 `9/10/11/12/13/15/17px` 七档全部收敛到这 8 档。

### 3.5 中日混排规则

```css
.orig, .trans, textarea.trans{
  line-break: strict;          /* 禁则处理：避免行首出现 。、）等 */
  overflow-wrap: break-word;   /* 长串 URL / 无空格拉丁文 才断 */
  word-break: normal;          /* CJK 保持默认，禁止 break-all */
  text-align: start;
}
.num, .byte-count, .pid, .orig .idx{
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;   /* 老浏览器兜底 */
}
```

- **`line-break: strict`** 是 galgame 文本的刚需 —— 对话里大量 `「」『』、。！？`，宽松禁则会让标点掉到行首。
- **不用 `text-spacing-trim` / `hanging-punctuation`**：前者 Chrome 123+ 才有，后者只有 Safari。等覆盖率上来再加，现在加了等于没加。
- **数字列必须 `tabular-nums`**：行号、字节数位数变化时宽度不能跳。

### 3.6 必须修的 bug

`src/style.css:63`：

```css
--mono-font: var(--ui-font);   /* ❌ 现有：等宽退化成无衬线 */
--mono-font: var(--font-mono); /* ✅ 修正 */
```

影响面：`:421 .file-tree`、`:458`、`:501`、`:523`、`:537`、`:555`、`:576`、`:582 .bkt`、`:614 kbd`、`:686` —— 共 10 处数字/结构显示。

---

## 4. 间距系统（8px 主网格）

### 4.1 网格定义

**主网格 8px，半步 4px。** 纯 8px 网格在专业工具里不够用 —— 图标与文字的间隙（4–6px）、标签内距（4/8px）、紧凑控件内距（6px）都落在 8 的倍数之间。强行对齐 8 会让控件撑得过大，直接牺牲信息密度（违反原则 3）。

因此：**8 的倍数用于布局间距，4 的奇数倍（4/12/20）只用于控件内部微调。**

| Token | 值 | 网格 | 典型用途 |
|---|---|---|---|
| `--sp-1` | 4px | 半步 | 图标与文字间隙、tag 内距、紧凑内距 |
| `--sp-2` | 8px | **主** | 按钮内距、列表项间距、控件间距 |
| `--sp-3` | 12px | 半步 | 工具栏元素间距、输入框横向内距 |
| `--sp-4` | 16px | **主** | 面板内距、卡片内距 |
| `--sp-5` | 20px | 半步 | 分组间距 |
| `--sp-6` | 24px | **主** | 区块间距、模态内距 |
| `--sp-8` | 32px | **主** | 大区块间距 |
| `--sp-10` | 40px | **主** | 页面级留白、空状态 |
| `--sp-12` | 48px | **主** | 空状态垂直留白 |

### 4.2 行内垂直节拍（`.para` 内部）

原文/译文区是唯一需要"呼吸"的地方，用半步值：

| 区域 | 值 |
|---|---|
| 原文区 `padding-block` | `12px 8px` |
| 译文区 `padding-block` | `12px 12px` |
| 行间分隔 | 由 1px `--border-hair` 承担，**不额外加 margin** |
| 上下文组与当前行之间 | `--sp-5` (20px) |

> 现有 `.para .body{ padding:27px 20px 28px 0 }`（`src/style.css:1749`）行高 75px，密度偏低但方向对。改到 `padding:12px 0` 配合 `--fs-lg/1.9`，单条对话行高约 54px，屏幕内可见行数 +39%。

### 4.3 负空间规则

- **同一视觉组内**元素间距 ≤ `--sp-2`（8px）
- **不同视觉组之间**间距 ≥ `--sp-4`（16px）
- **1px 发丝线可替代 8px 间距**承担分隔职责 —— 这是保密度的关键技巧

---

## 5. 图标系统

### 5.1 规格

| 项 | 值 |
|---|---|
| 图标库 | **Lucide**（MIT）。线性、几何规整，与 VS Code / Linear 气质一致 |
| viewBox | 统一 `0 0 24 24` |
| 描边 | `stroke-width:1.5`，`stroke-linecap:round`，`stroke-linejoin:round` |
| 填充 | `fill:none`，颜色 `stroke:currentColor` |
| 尺寸档 | `12 / 14 / 16 / 20 / 24` px —— 同一视图内不超过 3 档 |

### 5.2 尺寸档与用途

| 尺寸 | 用途 |
|---|---|
| 12px | 树展开 chevron、行内角标、状态字形（§0.3） |
| 14px | 工具栏按钮图标（配 26px 高按钮） |
| 16px | 侧栏动作、面板折叠触发器、Toast 图标 |
| 20px | 空状态插图、模态标题图标 |
| 24px | 品牌标识、命令面板行首 |

### 5.3 硬规则

- **不用 emoji 当图标。** emoji 跨平台字形不一致、无法改色、在暗底上饱和度失控。
- **每个图标按钮必须带 `aria-label`**（包括只有图标的 toolbar 按钮）。
- **命中区 ≥ 24×24px**（桌面工具可放宽到 24；若做触摸形态则 44×44）。
- **相邻可点击图标间距 ≥ 4px**，防止误触。
- **图标 `flex:none`**，防止长文本挤压变形。

---

## 6. 层级与密度

### 6.1 z-index 层级

现有 `src/style.css:1663` 的 `#topbar{z-index:30}` 正好落在下表，其余散落值需收敛。

| Token | 值 | 层 |
|---|---|---|
| `--z-base` | 0 | 内容流 |
| `--z-sticky` | 10 | 表格头、行内浮出按钮（如术语表"插入"） |
| `--z-rail` | 20 | 侧栏 / 场景树 |
| `--z-topbar` | 30 | 顶栏（现有值，保留） |
| `--z-dropdown` | 40 | 下拉、自动完成 |
| `--z-scrim` | 50 | 模态遮罩 |
| `--z-modal` | 60 | 模态对话框 |
| `--z-popover` | 70 | Tooltip、右键菜单 |
| `--z-toast` | 80 | Toast 通知 |

> 禁止出现 `z-index:9999` / `99999`。新层只能在上表内取，需要新层就扩表，不就地加数。

### 6.2 三档密度模式

只通过 3 个变量切换，不写第二套样式：

| 模式 | `--row-pad-y` | `--fs-lg` | `--ctrl-h` | 适用 |
|---|---|---|---|---|
| `compact` | 6px | 15px | 24px | 校对扫描、双屏并排 |
| **`default`** | **12px** | **16px** | **26px** | 默认 |
| `relaxed` | 16px | 17px | 30px | 长文精翻、外接大屏 |

```css
:root[data-density="compact"]{ --row-pad-y:6px;  --fs-lg:15px; --ctrl-h:24px; }
:root[data-density="relaxed"]{ --row-pad-y:16px; --fs-lg:17px; --ctrl-h:30px; }
```

持久化到 `localStorage`，与主题同机制。

---

## 7. 组件视觉规范

### 7.1 顶部导航栏

**布局**
- 高度 `--topbar-h: 48px`（现有 header + command strip 合计 ~74px，压缩到 48 + 40）
- 三段式栅格：`品牌 | 模式切换 | (弹性) 进度与文件 | 动作区`
- 内距 `0 var(--sp-4)`，元素间距 `--sp-4`
- 底部 `1px solid var(--border-hair)` + `var(--sh-hi)`

**颜色**

| 元素 | 背景 | 文字 | 边框 |
|---|---|---|---|
| 容器 | `--bg-panel` | — | 底边 `--border-hair` |
| 品牌字 | 透明 | `--text-hi` / 副标 `--text-dim` | — |
| 模式项 默认 | 透明 | `--text-mid` | — |
| 模式项 hover | `--ov-hover` 叠加 | `--text` | — |
| 模式项 active | 透明 + 底边 `2px var(--accent)` | `--text-hi` | — |
| 动作按钮 | `--bg-raised` | `--text` | `--border-soft` |

**模式切换不用填充块选中态** —— 用底部 2px 下划线，更接近专业工具语言（VS Code 标签、Figma 面板切换同款）。

**进度区**（核心信息，给足权重）
- 轨道：`width:200px; height:4px; border-radius:var(--r-pill); background:var(--bg-raised)`
- 填充：三段内联 `linear-gradient(90deg, var(--st-approved) 0 X%, var(--st-pending) X% Y%, var(--st-issue) Y% Z%)`
- 数字：`--fs-xs` / `--font-mono` / `tabular-nums` / `--text-mid`，格式 `1,204 / 3,180`
- 轨道与数字之间 `--sp-2`

### 7.2 左侧场景树（`#storyRail`）

**布局**
- 宽度 `--rail-w: 220px`（现有 `src/style.css:1657` 是 224px，收整到网格）
- 内距 `--sp-2`，节点高度 `30px`，节点内距 `0 var(--sp-2)`
- 缩进单位 **12px**（比常规 16px 紧，适配长文件名）
- 顶部"当前脚本"卡：文件名 `--fs-sm`/`--text-hi`/500，下方进度 `--fs-2xs`/`--text-dim`

**颜色**

| 元素 | 背景 | 文字 |
|---|---|---|
| 容器 | `--bg-panel` | — |
| 节点 默认 | 透明 | `--text-mid` |
| 节点 hover | `--ov-hover` 叠加 | `--text` |
| 节点 active | `--ov-selected` + 左边 `2px var(--accent)` | `--text-hi` |
| 完成度文字 | — | `--fs-2xs` / `--text-dim` / `tabular-nums` |

**展开图标**
- 12×12 Lucide `chevron-right`，`stroke-width:1.5`，`stroke:currentColor`
- 折叠 `rotate(0)` → 展开 `rotate(90deg)`，`160ms var(--ease-out)`
- 颜色：默认 `--text-dim`，hover `--text`
- **禁止用 `▸`/`▾` 字符** —— 不同字体下基线不一致，展开时会抖

**层级引导线**
- `border-left:1px dashed var(--border-hair)`，`margin-left:5px`
- 节点 hover 时该层引导线转 `solid var(--border-strong)`，`100ms`

**完成度标识**：见 §7.5。

### 7.3 翻译工作区（`#stage` / `#list` / `.para`）— 核心

#### 布局
- 内容列宽 `min(100%, var(--stage-measure))`，`--stage-measure: 860px`（现有 `src/style.css:1659` 是 820px）
- `.para` 栅格：`grid-template-columns: var(--row-num-col) minmax(0,1fr)`（`--row-num-col:48px`）
- 行号列：右对齐，`padding-right:var(--sp-3)`，`--fs-2xs` / `--font-mono` / `--text-dim`
- 行间分隔：`.para::after` → `height:1px; background:var(--border-hair); opacity:.6`

#### 原文区（`.orig-cell`）

| 属性 | 值 |
|---|---|
| 字体 | `--font-serif-jp` |
| 字号/行高 | `var(--fs-lg)` / `1.9` |
| 颜色 | `var(--orig)` |
| 左侧色条 | `border-left:2px solid var(--orig-bar)`；激活行 → `var(--orig)` |
| 说话人 `.orig-name` | `--fs-xs` / `--font-ui` / 600 / `letter-spacing:.06em` / `var(--name)` |

#### 译文区（`.translation-block` + `textarea.trans`）

| 属性 | 值 |
|---|---|
| 字体 | `--font-sans-jp` |
| 字号/行高 | `var(--fs-lg)` / `1.9` |
| 颜色 | `var(--trans)` |
| 背景 | 透明 → focus 时 `--bg-raised` |
| 边框 | 底部 `1px solid var(--border-hair)`；focus 时 `1px solid var(--accent)` |
| 内距 | `12px var(--sp-3)` |
| 圆角 | `--r-sm`（仅 focus 态显现，避免满屏框线） |

#### 状态样式

| 状态 | 表现 |
|---|---|
| 默认 | 底部 hairline 边框，背景透明 |
| hover（整行） | `--ov-hover` 叠加，**不改尺寸不位移** |
| **focus** | 背景 `--bg-raised`，底边 `--accent` 1px，**左侧浮出 2px 青蓝竖线**，`box-shadow:0 0 0 3px var(--accent-glow)`，`160ms` |
| disabled（原文锁定） | `color:var(--text-dim)`，`cursor:default`，**不加背景**（保持"只读文本"而非"禁用控件"的观感） |

> **不要用 `outline` 做焦点。** `outline` 不参与圆角、无法加外发光、在密集列表里会和相邻行的 outline 粘连。用 `box-shadow` 模拟 ring。

#### 上下文区（前后句，灰显）

与当前行同一栅格，但：

- 原文 `color:var(--text-dim)`（比 `--orig` 再暗一档）
- 译文 `color:var(--text-mid)`
- 整体 `opacity:.55`
- 上下各 `mask-image:linear-gradient(transparent, #000 24px)` —— 边缘渐隐，暗示"这是上下文"
- 上下文行与当前行之间留 `--sp-5` 呼吸位

### 7.4 右侧术语表面板（`#sidebar`）

**布局**
- 宽度 `--context-w: 304px`（现有 `src/style.css:1658` 是 328px，收整到 8 网格）
- Tab 条：4 等分 `grid-template-columns:repeat(4,1fr)`，高 `32px`，底部 `1px var(--border-hair)`
- 内容区 `.side-body` 内距 `--sp-4`
- 词条行：高 `32px`，`--fs-base`，左右分栏（原文 | 译文）

**颜色**

| 元素 | 值 |
|---|---|
| 容器 | `--bg-panel`，左边界 `1px var(--border-hair)` |
| Tab 默认 | 透明 / `--text-mid` / 底边 `1px transparent` |
| Tab hover | `--text`，底边 `--border-strong` |
| Tab active | `--text-hi`，底边 `2px var(--accent)` |
| 词条 原文 | `--font-sans-jp` / `--text` |
| 词条 译文 | `--text-mid` |
| 词条 hover | `--ov-hover`，右侧浮出"插入"按钮（`--z-sticky`） |
| 分区标题 | `--fs-2xs` / 600 / `letter-spacing:.08em` / `--text-dim` / 上边距 `--sp-4` |

**折叠**：整栏 `transform:translateX(100%)` + 容器 `width` 过渡 `240ms var(--ease-out)`。触发器固定在 stage 右上角，图标 16px。

> ⚠️ **不使用毛玻璃。** 理由见 §10。

### 7.5 状态标签与完成度进度

#### 状态 pill

pill 型徽标（`--r-pill`），在行内、树节点、校对面板三处复用。

**规格**
- 高度 `18px`，内距 `0 var(--sp-2)`，`--fs-2xs` / 600 / `letter-spacing:.04em`
- 结构：`8×8 状态字形(SVG) + 4px gap + 文字`
- 文字色 `--st-*-fg`，背景 `--st-*-bg`，边框 `1px --st-*-bd`
- **hover**：背景不透明度 `+0.08`，`100ms`
- **标签本身不可点击**（点击应落到所属行），`cursor:inherit`

#### 完成度分段条

- **不用环形**：30px 高的树节点里直径不足 16px，读不出数，还占横向空间
- **不用圆点**：只能表达"有没有"，表达不了"多少"
- **用分段条**：可同时表达"各状态占比"和"总量"

```
[节点名 ................] [▮▮▮ 36×3] [72%]
```

- 分段条：三段 `flex-grow` 按 approved / pending / issue 比例分配，`gap:1px`，`border-radius:1px`
- 百分比：`--fs-2xs` / `--font-mono` / `tabular-nums` / `--text-dim`；`100%` 时切 `--st-approved` 并在条前方加 4px 圆点
- 顶栏规格：`200×4px` 轨道 `--bg-raised`

### 7.6 按钮

**四级**

| 级别 | 背景 | 边框 | 文字 | 用途 |
|---|---|---|---|---|
| `default` | `--bg-raised` | `--border-soft` | `--text` | 常规动作 |
| `secondary` | 透明 | `--border-soft` | `--text-mid` | 次常动作 |
| `primary` | `--accent-dim` | `rgba(88,166,255,.45)` | `--accent` | 每屏最多 1 个 |
| `danger` | `rgba(240,120,90,.12)` | `rgba(240,120,90,.40)` | `--st-issue-fg` | 破坏性动作 |

> ⚠️ **不要给 primary 用高饱和实心填充**（现有 `.primary-group` 用 `--accent-dark` 实心）。满屏实心色块是"网页感"的头号来源。专业工具里主操作只比次要操作"亮一点"，不靠填色。

**规格**：高 `--ctrl-h`（默认 26px），内距 `0 var(--sp-3)`，圆角 `--r-sm`，`--fs-sm`，`gap:var(--sp-1)`，图标 14px。

**六态**：见 §8.1 通用矩阵。

### 7.7 输入控件

| 控件 | 高 | 字号 | 圆角 | 内距 |
|---|---|---|---|---|
| text input | `--ctrl-h` | `--fs-sm` | `--r-sm` | `0 var(--sp-2)` |
| select | `--ctrl-h` | `--fs-sm` | `--r-sm` | `0 var(--sp-2)` |
| textarea | auto | `--fs-base` | `--r-sm` | `var(--sp-2) var(--sp-3)` |
| checkbox | 14×14 | — | `--r-xs` | — |
| switch | 28×16 | — | `--r-pill` | — |

**默认态**：`background:var(--bg-raised)`，`border:1px solid var(--border-soft)`，`color:var(--text)`
**hover**：`border-color:var(--border-strong)`，`100ms`
**focus-visible**：`box-shadow:var(--sh-focus)`，边框同步转 `--accent`
**invalid**：边框 `1px var(--st-issue)`，右侧 16px 警示图标 `--st-issue`，下方 `--fs-2xs` / `--st-issue-fg` 错误文案（§8.5）
**disabled**：`--ov-disabled` 叠加，`cursor:not-allowed`，**文字保持 `--text-dim`（4.44:1，仍可读）**

**select 下拉箭头**：10×10 Lucide `chevron-down`，`--text-dim`，绝对定位右侧 `var(--sp-2)`，`pointer-events:none`。**不用原生 `<select>` 箭头**（跨平台不一致且无法改色）。

**switch**：轨道 28×16 `--bg-raised` + 边框 `--border-soft`，滑块 12×12 `--text-mid`；on 态轨道 `--accent-dim` + 边框 `rgba(88,166,255,.45)`、滑块 `--accent`。滑动 `160ms var(--ease-out)`，**只过渡 `transform`**。

### 7.8 模态对话框（`#modal`）

- 宽度 `min(480px, calc(100vw - var(--sp-8)))`，圆角 `--r-lg`，背景 `--bg-overlay`
- 阴影 `--sh-3`
- 标题 `--fs-xl` / 500 / `--text-hi`；正文 `--fs-base` / `--text`
- 内距 `--sp-6`，标题与正文间距 `--sp-3`，正文与操作区间距 `--sp-6`
- 操作区右对齐，`gap:var(--sp-2)`，**顺序：取消 | 确认**（危险操作：取消 | 危险）
- 遮罩 `--scrim`，点击遮罩关闭；`Esc` 关闭
- 入场：`opacity 0→1` + `transform:scale(.98)→1`，`240ms var(--ease-out)`
- 打开时焦点落在**第一个可交互元素**（危险操作模态则落在"取消"上）
- 焦点陷阱（focus trap）：`Tab` 在模态内循环，不逃逸到背景
- 关闭后焦点归还触发元素

### 7.9 Toast

- 位置：右下角，距边 `--sp-6`，`--z-toast`
- 尺寸：`min-width:280px; max-width:400px`，内距 `var(--sp-3) var(--sp-4)`，圆角 `--r-md`
- 背景 `--bg-overlay`，边框 `1px var(--border-soft)`，阴影 `--sh-3`
- 结构：`16px 图标 + var(--sp-2) gap + 文案`（文案 `--fs-base` / `--text`）
- 图标色：info `--accent` / success `--st-approved` / warn `--st-pending` / error `--st-issue`
- 入场：`translateY(8px) + opacity 0` → `0 / 1`，`240ms var(--ease-out)`
- 停留 `4s`（error 不自动消失，需手动关）
- 多条堆叠 `gap:var(--sp-2)`，最多同时 3 条，超出挤掉最旧
- **`role="status"` + `aria-live="polite"`**（error 用 `assertive`）

### 7.10 右键菜单 / 命令面板

**右键菜单**
- 宽 `200px`，内距 `var(--sp-1)`，圆角 `--r-md`，背景 `--bg-overlay`，阴影 `--sh-3`，`--z-popover`
- 项高 `28px`，内距 `0 var(--sp-2)`，圆角 `--r-xs`，`--fs-base` / `--text`
- hover：`--ov-hover` + 文字 `--text-hi`，`100ms`
- 快捷键右对齐 `--fs-2xs` / `--text-dim` / `--font-mono`
- 分隔线 `1px var(--border-hair)`，上下 `var(--sp-1)`
- 禁用项 `--text-dim` + `cursor:not-allowed`
- 跟随鼠标定位，贴边时自动翻转

**命令面板**（`Ctrl+K`）
- 宽 `min(560px, calc(100vw - var(--sp-10)))`，垂直居中偏上（`top:20vh`）
- 输入行高 `44px`，`--fs-md`，无边框，底部 `1px var(--border-hair)`
- 结果行高 `32px`，最多显示 8 条后滚动
- 选中行 `--ov-selected` + 左侧 `2px var(--accent)`
- 每项：`16px 图标 + var(--sp-3) + 标题 + (弹性) + 分组标签`

### 7.11 空状态

```
        [20px 图标, --text-dim]
    [主标题 --fs-2xl / 500 / --text]
  [说明文案 --fs-md / --text-mid, max-width:36ch]
        [主操作按钮]
```

- 垂直居中，容器 `min-height:240px`
- 元素间距：`--sp-4` / `--sp-2` / `--sp-6`
- 图标 `--text-dim`，**不用大插图**（专业工具里插图是噪音）
- 必须给出**下一步动作按钮**，不能只说"没有数据"

### 7.12 加载态

按耗时分档，避免闪烁：

| 耗时 | 表现 |
|---|---|
| < 300ms | **什么都不显示**（延迟 300ms 再渲染，防止闪烁） |
| 300ms – 2s | 12px spinner，`--accent`，`animation:spin .8s linear infinite` |
| > 2s | **骨架屏** + 百分比进度 |

**骨架屏**：与真实内容同构的占位块，`background:linear-gradient(90deg, var(--bg-raised) 25%, var(--bg-overlay) 50%, var(--bg-raised) 75%)`，`background-size:200% 100%`，`animation:shimmer 1.4s ease-in-out infinite`。

**规则：**
- 异步按钮操作期间 `disabled` + 按钮内 spinner，**必须禁止重复提交**
- 内容加载完成时**预留空间**（`min-height`），避免 content-jumping
- `prefers-reduced-motion` 下 shimmer 退化为静态 `--bg-raised`

### 7.13 滚动条

桌面工具滚动条应**常显但低对比**，hover 提亮 —— 完全隐藏会让用户失去位置感。

```css
::-webkit-scrollbar{ width:12px; height:12px; }
::-webkit-scrollbar-track{ background:transparent; }
::-webkit-scrollbar-thumb{
  background:var(--scroll-thumb);
  border:3px solid transparent;      /* 制造 6px 视觉宽度 + 内缩 */
  background-clip:content-box;
  border-radius:var(--r-pill);
}
::-webkit-scrollbar-thumb:hover{ background:var(--scroll-thumb-hover); }
::-webkit-scrollbar-corner{ background:transparent; }
```

- `--scroll-thumb: #333A48` / `--scroll-thumb-hover: #444D5E`
- **滚动容器必须设 `scrollbar-gutter: stable`**，防止滚动条出现时内容横向抖动
- 长列表（`#list`）用 `content-visibility:auto` + `contain-intrinsic-size` 配合虚拟滚动

### 7.14 可拖动分隔器

- 命中区 **6px**（可见线仅 1px，命中区靠 `::before` 外扩）
- 可见线 `1px var(--border-hair)`
- hover：`2px var(--accent)`，`cursor:col-resize`，`100ms`
- drag 中：`2px var(--accent)` + 整条 `rgba(88,166,255,.06)`
- 双击复位到默认宽度
- 拖动期间给 `body` 加 `user-select:none; cursor:col-resize`
- 最小/最大宽度：侧栏 `180–400px`，场景树 `160–360px`

---

## 8. 交互反馈设计

### 8.1 六态通用矩阵

所有可交互元素必须完整实现这六态。每格标出允许改动的视觉通道。

| 状态 | 背景 | 边框 | 文字 | 阴影 | 变换 | 光标 | 时长 |
|---|---|---|---|---|---|---|---|
| **rest** | 基准 | 基准 | 基准 | — | — | `pointer` | — |
| **hover** | `+--ov-hover` | `--border-strong` | 提亮一档 | — | ❌ 禁止位移/缩放 | `pointer` | `100ms` |
| **active** | `+--ov-press` | 同 hover | 同 hover | — | `translateY(1px)` | `pointer` | `60ms` |
| **focus-visible** | 同 hover | `--accent` | — | `var(--sh-focus)` | — | `pointer` | `160ms` |
| **selected** | `+--ov-selected` | `--accent`（左侧 2px 竖线） | `--text-hi` | — | — | `pointer` | `160ms` |
| **disabled** | `+--ov-disabled` | 基准（**不变灰**） | `--text-dim` | — | — | `not-allowed` | — |

**关键约束：**

1. **hover 只改颜色，不改尺寸。** 任何 `width/height/padding/margin/transform:scale` 的 hover 变化都会引起布局抖动，在虚拟滚动长列表里是灾难。
2. **`focus` 与 `focus-visible` 分开。** 用 `:focus-visible` 而非 `:focus`，鼠标点击不出现焦点环，键盘导航才出现。
3. **永远不要 `outline:none` 而不给替代。** 焦点环用 box-shadow：
   ```css
   --sh-focus: 0 0 0 1px var(--accent), 0 0 0 4px var(--accent-ring);
   ```
4. **disabled 边框不变灰。** 灰边框在暗底上会消失，用户会以为元素不存在。
5. **`active` 用 60ms。** 按压反馈必须比 hover 更快才跟手。

### 8.2 当前行高亮 — 拒绝"整块背景"

整块填充背景是最偷懒也最廉价的做法，在密集列表里会让画面变脏。

**采用组合（5 层，全部无位移）：**

1. **左侧 2px 竖线**：`--accent`，`border-radius:1px`，贯穿原文+译文高度（`top:8px; bottom:8px`）
2. **横向渐变淡出**：`linear-gradient(90deg, rgba(88,166,255,.10) 0%, rgba(88,166,255,.03) 32%, transparent 60%)`
3. **行号变色加粗**：`.num` → `color:var(--accent); font-weight:600`
4. **原文左侧色条提亮**：`--orig-bar` → `var(--orig)`
5. **译文框外扩柔光**：`box-shadow:0 0 0 3px var(--accent-glow)`

**明确不用**：`outline`（与相邻行粘连）、整块高饱和背景（脏）、边框全包围（笨重）。

### 8.3 字节数指示器

**不用抖动（shake）。** 抖动在输入过程中会打断肌肉记忆，且在 2000+ 行虚拟滚动里触发布局重排，是纯负收益。

**四段阈值**（按目标引擎文本框容量 `%`）：

| 占用 | 数字色 | 左侧条 | 输入框底边 | 动效 |
|---|---|---|---|---|
| < 70% | `--text-dim` | 无 | `--border-hair` | 无 |
| 70–90% | `--text-mid` | 无 | `--border-hair` | 无 |
| 90–100% | `--st-pending-fg` | `2px --st-pending` | `--border-strong` | 无 |
| **> 100%** | `--st-issue-fg` / 600 | `2px --st-issue` | `1px --st-issue` | **延迟呼吸** |

**延迟呼吸的细节：**
- 触发条件：占用 > 100% **且** 停止输入 `400ms`（debounce）
- 表现：仅指示器本体 `opacity: 1 → .45 → 1`，`1.2s`，循环最多 **3 次**后停止
- **不作用于输入框、不位移、不改尺寸** —— 只在余光里提醒，不打断输入流
- `prefers-reduced-motion` 下退化为静态 `--st-issue` 色

**结构**：`[2px 色条] 124 / 120 B`
- 数字 `--font-mono` + `tabular-nums`，避免位数变化时宽度跳动
- `title` 属性给出完整说明：`124 / 120 字节（UTF-8）· 超出 4 字节`
- **计数口径要明确标注**：galgame 引擎常按 Shift-JIS 字节算（全角 = 2 字节），而 UTF-8 下中文 = 3 字节。指示器必须显示当前口径，两种口径用 `--fs-2xs` 后缀标注（`SJIS` / `UTF8`）。

> ⚠️ 阈值依赖目标引擎文本框规格 —— 这是**已知阻塞项 Q3**。在 Q3 答复前，默认按 `--byte-limit:120`（NScripter 常见值）实现，阈值做成变量便于后续切换。

### 8.4 动效 Token

| Token | 值 | 应用 |
|---|---|---|
| `--ease` | `cubic-bezier(.4,0,.2,1)` | 通用（Material 标准曲线） |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | 展开、滑入、弹层 |
| `--t-fast` | `100ms` | hover、颜色切换 |
| `--t-press` | `60ms` | active 按压 |
| `--t-base` | `160ms` | focus ring、展开折叠、图标旋转 |
| `--t-slow` | `240ms` | 面板滑入、模态、Toast |
| `--t-delay-warn` | `400ms` | 超限警示延迟（debounce） |

**规则：**
- 只过渡 `color / background-color / border-color / opacity / transform / box-shadow`
- **禁止过渡 `width / height / top / left / padding / margin`**（2000+ 行虚拟滚动下会掉帧）
- 面板位移用 `transform: translateX()` 而非改 `width`
- 数值区间参考：微交互 150–300ms；UI 动效不超过 500ms

### 8.5 警示三级体系

按影响范围选择反馈层级，不要所有问题都弹模态：

| 级别 | 触发场景 | 表现 | 位置 |
|---|---|---|---|
| **L1 字段级** | 单条译文字节超限、术语冲突、格式标记丢失 | 输入框边框转 `--st-issue` + 行内 `--fs-2xs` 错误文案 | 紧贴出错控件 |
| **L2 操作级** | 保存失败、导入部分失败、机翻接口报错 | Toast（error 不自动消失，带"重试"动作） | 右下角 |
| **L3 破坏性** | 覆盖文件、删除术语条目、清空校对批注 | 模态二次确认，标题明写后果，确认按钮用 `danger` | 屏幕中央 |

**L3 硬规则：**
- 标题必须写出**具体后果**（"将覆盖 `story_01.ks` 中 1,204 条译文"），不能只写"确定删除？"
- 默认焦点落在**取消**上
- 按钮顺序：取消在左，危险操作在右
- 不可逆操作（删除且无撤销）要求输入确认词

### 8.6 reduced-motion

```css
@media (prefers-reduced-motion: reduce){
  *, *::before, *::after{
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

**例外**：超限呼吸（§8.3）在 reduced-motion 下不是"变快"，而是**退化为静态色** —— 因为它承载信息，不能简单跳过。

---

## 9. 无障碍（实测）

### 9.1 对比度矩阵（实测值）

| 前景 \ 背景 | void | base | panel | raised | overlay |
|---|---|---|---|---|---|
| `--text-hi` | 16.12 | 15.28 | 14.45 | 13.38 | 12.26 |
| `--text` | 11.81 | 11.20 | 10.59 | 9.80 | 8.98 |
| `--text-mid` | 7.15 | 6.78 | 6.41 | 5.93 | 5.43 |
| `--text-dim` | 5.35 | 5.07 | 4.79 | 4.44 | 4.06 |
| `--orig` | 9.28 | 8.80 | 8.32 | 7.71 | 7.06 |
| `--trans` | 16.12 | 15.28 | 14.45 | 13.38 | 12.26 |
| `--name` | 8.45 | 8.01 | 7.58 | 7.01 | 6.42 |
| `--accent` | 7.69 | 7.29 | 6.90 | 6.39 | 5.85 |
| `--st-pending` | 9.99 | 9.47 | 8.96 | 8.29 | 7.59 |
| `--st-approved` | 7.98 | 7.56 | 7.15 | 6.62 | 6.06 |
| `--st-issue` | 6.98 | 6.62 | 6.26 | 5.79 | 5.31 |

全部 ≥ 4.0:1。`--text-dim` on `--bg-overlay`（4.06）仅用于辅助说明，不承载正文。

### 9.2 检查清单

- [ ] 所有交互元素有 `:focus-visible` 样式（无 `outline:none` 裸奔）
- [ ] Tab 顺序与视觉顺序一致；模态内有焦点陷阱
- [ ] 图标按钮带 `aria-label`
- [ ] Toast 用 `role="status"` + `aria-live`；error 用 `assertive`
- [ ] 状态不只靠颜色传达（§0.3 的形状编码）
- [ ] 长列表有 `aria-rowcount` / 虚拟滚动的 `aria-setsize`
- [ ] 缩放 200% 下无内容截断
- [ ] `prefers-reduced-motion` 下动效降级，且超限警示退化为静态色
- [ ] 键盘可完成全部核心流程（翻行、编辑、切状态、保存）

---

## 10. 明确不做的事（反模式清单）

| ❌ 不做 | 理由 | 替代方案 |
|---|---|---|
| **侧栏毛玻璃 `backdrop-filter`** | ① 长列表滚动时合成层压力导致掉帧；② 降低文字对比度，与"长时间阅读"直接冲突；③ 现有实现只在设了背景图时生效，绝大多数场景看不到 | 分层背景色 + 1px 边框 + 顶部内高光 |
| **高饱和实心主按钮** | 满屏色块 = 网页感 | primary 用 `--accent-dim` 底 + accent 文字 |
| **抖动 / shake 动效** | 打断输入流，触发重排 | 延迟 400ms 的呼吸 ×3，仅作用于指示器本体 |
| **全文统一圆角** | 容器变钝，失去工具感 | 容器 0–2px / 控件 4px / 浮层 8–10px |
| **日文原文用等宽字体** | 假名字面缩小、字重变轻 | 等宽只服务数字与结构符号 |
| **`outline` 做焦点环** | 不跟圆角、无法外发光、密集列表里粘连 | `box-shadow` 模拟 ring |
| **状态色用红/黄/绿老三样** | 色相跨度不足，色觉障碍下糊成一片 | 琥珀 / 朱橙 / 青绿 + 形状编码 |
| **hover 改尺寸 / 缩放** | 虚拟滚动里布局抖动 | 只改颜色与阴影 |
| **webfont CDN（Google Fonts）** | Tauri 离线是硬需求，CSP 也会拦 | 系统字体栈 + 可选内置子集 |
| **`z-index: 9999`** | 层级失控，无法维护 | §6.1 层级表 |

---

## 11. CSS 变量清单

> **用法**：整段替换 `src/style.css` 的 `:root`。主题切换保持现有 `:root[data-theme="…"]` 机制，只需重定义同名变量。

```css
:root{
  /* ═══════ 背景 5 级 ═══════ */
  --bg-void:#0B0D12;        /* 编辑器画布 */
  --bg-base:#11141B;        /* 应用底 */
  --bg-panel:#161A22;       /* 侧栏 / 顶栏 */
  --bg-raised:#1C212B;      /* 输入框 / hover */
  --bg-overlay:#222834;     /* 浮层 / 模态 */

  /* ═══════ 边框 3 级 ═══════ */
  --border-hair:#232936;
  --border-soft:#2C3341;
  --border-strong:#3A4354;

  /* ═══════ 文字 4 级 ═══════ */
  --text-hi:#E6EAF2;        /* 16.12:1 */
  --text:#C3CAD8;           /* 11.81:1 */
  --text-mid:#949EB0;       /*  7.15:1 */
  --text-dim:#7C8798;       /*  5.35:1  ← v2 的 #616B7E 仅 3.62:1，已修正 */

  /* ═══════ 覆盖层 ═══════ */
  --ov-hover:rgba(255,255,255,.045);
  --ov-press:rgba(0,0,0,.22);
  --ov-selected:rgba(88,166,255,.10);
  --ov-disabled:rgba(17,20,27,.55);
  --scrim:rgba(5,7,11,.66);

  /* ═══════ 强调（功能 / 焦点） ═══════ */
  --accent:#58A6FF;
  --accent-dim:rgba(88,166,255,.14);
  --accent-glow:rgba(88,166,255,.10);
  --accent-ring:rgba(88,166,255,.16);

  /* ═══════ 语义：原文 / 译文 / 说话人 ═══════ */
  --orig:#A9B4C6;
  --trans:#E6EAF2;
  --name:#D9A05B;
  --orig-bar:#3A4354;

  /* ═══════ 状态 4 态（本体 = 图形用，fg = 文字用） ═══════ */
  --st-todo:#7A8698;        --st-todo-fg:#9AA5B8;
  --st-pending:#E3B341;     --st-pending-fg:#F0C454;
  --st-issue:#F0785A;       --st-issue-fg:#FF8F73;
  --st-approved:#4BB98C;    --st-approved-fg:#5FD0A0;

  --st-todo-bg:rgba(122,134,152,.14);      --st-todo-bd:rgba(122,134,152,.28);
  --st-pending-bg:rgba(227,179,65,.14);    --st-pending-bd:rgba(227,179,65,.30);
  --st-issue-bg:rgba(240,120,90,.15);      --st-issue-bd:rgba(240,120,90,.32);
  --st-approved-bg:rgba(75,185,140,.14);   --st-approved-bd:rgba(75,185,140,.30);

  /* ═══════ 辅助语义（不新增色相） ═══════ */
  --diff-add:#4BB98C;
  --diff-del:#F0785A;
  --note:#D9A05B;
  --mt-mark:rgba(88,166,255,.10);

  /* ═══════ 字体 ═══════ */
  --font-ui:"HarmonyOS Sans SC","MiSans","PingFang SC","Source Han Sans SC","Noto Sans SC","Microsoft YaHei UI",system-ui,sans-serif;
  --font-serif-jp:"Noto Serif JP","Yu Mincho","YuMincho","Hiragino Mincho ProN","Source Han Serif SC","Songti SC",SimSun,serif;
  --font-sans-jp:"Noto Sans JP","Yu Gothic UI","Hiragino Kaku Gothic ProN","Meiryo","Microsoft YaHei",sans-serif;
  --font-mono:"JetBrains Mono","Cascadia Code","Cascadia Mono","Sarasa Mono SC","Sarasa Term SC",Consolas,monospace;

  /* 向后兼容别名（指向新字体栈，便于旧规则平滑迁移） */
  --ui-font:var(--font-ui);
  --story-font:var(--font-serif-jp);
  --mono-font:var(--font-mono);   /* ⚠️ 原为 var(--ui-font)，src/style.css:63 待修 */

  /* ═══════ 字阶 ═══════ */
  --fs-2xs:10px; --lh-2xs:1.4;
  --fs-xs:11px;  --lh-xs:1.45;
  --fs-sm:12px;  --lh-sm:1.5;
  --fs-base:13px; --lh-base:1.6;
  --fs-md:14px;  --lh-md:1.65;
  --fs-lg:16px;  --lh-lg:1.9;    /* 原文/译文阅读核心 */
  --fs-xl:18px;  --lh-xl:1.5;
  --fs-2xl:22px; --lh-2xl:1.35;

  --fw-normal:400; --fw-medium:500; --fw-semi:600; --fw-bold:700;

  /* ═══════ 间距（8px 主网格 + 4px 半步） ═══════ */
  --sp-1:4px;   --sp-2:8px;   --sp-3:12px;  --sp-4:16px;
  --sp-5:20px;  --sp-6:24px;  --sp-8:32px;  --sp-10:40px;  --sp-12:48px;

  /* ═══════ 圆角 ═══════ */
  --r-xs:3px; --r-sm:4px; --r-md:6px; --r-lg:10px; --r-pill:999px;

  /* ═══════ 阴影（暗色质感关键：顶部内高光） ═══════ */
  --sh-hi:inset 0 1px 0 rgba(255,255,255,.045);
  --sh-1:0 1px 2px rgba(0,0,0,.40);
  --sh-2:0 4px 12px rgba(0,0,0,.45), var(--sh-hi);
  --sh-3:0 12px 32px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.40), var(--sh-hi);
  --sh-focus:0 0 0 1px var(--accent), 0 0 0 4px var(--accent-ring);

  /* ═══════ 动效 ═══════ */
  --ease:cubic-bezier(.4,0,.2,1);
  --ease-out:cubic-bezier(.16,1,.3,1);
  --t-press:60ms; --t-fast:100ms; --t-base:160ms; --t-slow:240ms; --t-delay-warn:400ms;

  /* ═══════ 层级 ═══════ */
  --z-base:0; --z-sticky:10; --z-rail:20; --z-topbar:30; --z-dropdown:40;
  --z-scrim:50; --z-modal:60; --z-popover:70; --z-toast:80;

  /* ═══════ 布局尺寸 ═══════ */
  --rail-w:220px;
  --context-w:304px;
  --stage-measure:860px;
  --topbar-h:48px;
  --toolbar-h:40px;
  --row-num-col:48px;
  --ctrl-h:26px;
  --row-pad-y:12px;
  --byte-limit:120;          /* ⚠️ 依赖阻塞项 Q3（目标引擎文本框规格） */

  /* ═══════ 滚动条 ═══════ */
  --scroll-thumb:#333A48;
  --scroll-thumb-hover:#444D5E;
}

/* ═══════ 密度模式 ═══════ */
:root[data-density="compact"]{ --row-pad-y:6px;  --fs-lg:15px; --ctrl-h:24px; }
:root[data-density="relaxed"]{ --row-pad-y:16px; --fs-lg:17px; --ctrl-h:30px; }

/* ═══════ 中日混排 ═══════ */
.orig,.trans,textarea.trans{
  line-break:strict;
  overflow-wrap:break-word;
  word-break:normal;
}
.num,.byte-count,.pid{ font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1; }

/* ═══════ 焦点环：用 box-shadow，不用 outline ═══════ */
:where(button,[href],input,select,textarea,[tabindex]):focus-visible{
  outline:none;
  box-shadow:var(--sh-focus);
}

/* ═══════ 滚动条 ═══════ */
::-webkit-scrollbar{ width:12px; height:12px; }
::-webkit-scrollbar-track{ background:transparent; }
::-webkit-scrollbar-thumb{
  background:var(--scroll-thumb);
  border:3px solid transparent;
  background-clip:content-box;
  border-radius:var(--r-pill);
}
::-webkit-scrollbar-thumb:hover{ background:var(--scroll-thumb-hover); }
::-webkit-scrollbar-corner{ background:transparent; }

/* ═══════ reduced-motion ═══════ */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:.01ms !important;
    animation-iteration-count:1 !important;
    transition-duration:.01ms !important;
    scroll-behavior:auto !important;
  }
}
```

---

## 12. 落地优先级

按 **视觉影响 ÷ 工作量** 排序。1 人日 = 8h。行号基于 `src/style.css`（2466 行）实读。

| 优先级 | 项目 | 工作量 | 影响 | 依据 |
|---|---|---|---|---|
| **P0-1** | **别名层重定向**合并三套变量体系：v3 核心 token 落 `:root`，旧变量名改为 `var(--bg-*)` 等别名；第三套（`1941–2030`）整体移除 | 0.2d | 🔴 决定一切 | 三套并存（见 §2.1 修正）；第三套是最终生效层。**不要直接删 `1647–1659`** —— 那 13 个变量是末段 821 行 CSS 的唯一取色源 |
| **P0-2** | 落地 §11 完整变量块（含 `--text-dim` / `--st-todo` 修正值与新增 overlay/fg 档）+ light/bw 三主题适配 | 0.3d | 🔴 无障碍 | `1–126`；bw 主题此前未重定义 `--ink` 等，背景恒为暗色 |
| **P0-3** | **字阶 token 化**：211 处 `font-size` 硬编码 → `var(--fs-*)`，按贴现值映射（视觉变化 ≤1px） | 0.3d | 🔴 层级感 | 游离值 43 处 + 档内硬编码 168 处；`30px`（`#empty b`）v3 无对应档，有意保留 |
| **P0-4** | 修 `--mono-font:var(--ui-font)` → `var(--font-mono)`，**并修 6 处字体 fallback 回归** | 0.1d | 🟠 数字对齐 | `63`；`--orig/trans-font-family` 的 fallback 原本指向 `--mono-font`，修好 mono 后会让原文渲染成真等宽，直接违反「原文明朝/译文黑体」基石 |
| **P1-1** | **翻译工作区重做**：四重区分 + 当前行五层高亮 + 上下文渐隐 | 1.5d | 🔴 编辑器质感主来源 | `.para` `1744–1800`、`.orig` `1757`、`.translation-block` `1758` |
| **P1-2** | 顶栏 + 命令条：48/40px 双条、模式切换下划线化、去实心填充按钮 | 1.0d | 🟠 第一印象 | `#topbar` `1663`、`.command-bar`、`.primary-group` | ✅ 完成（2026-08-30，实际 0.9d）。**「去实心」只作用于顶栏四按钮**；命令条 `#btnImport/#btnSave` 保持实心 accent（见下方决策修正） |
| **P1-3** | 场景树：220px、12px 缩进、Lucide chevron、分段进度条 | 0.5d | 🟠 导航可用性 | `#storyRail`、`.doc-tab` | ✅ 完成（2026-08-30，实际 0.7d）。chevron 用 CSS 两条边画（离线禁引图标库）；📁/📄 emoji 改为 CSS 圆点 |
| **P1-4** | **间距 8px 网格化**：339 处间距值，206 处非 4 倍数 → 吸附到 `--sp-*` | 0.8d | 🟠 布局节奏 | ✅ 完成（2026-08-31，实际 0.5d）。**原记「531 处 / 321 处」是错的**——那是把 width/height/border 全算进去了。真实间距值 339 处。见 §12.2 |
| **P2-1** | 侧栏术语表：Tab 下划线化、词条行 32px、分区标题 | 0.5d | 🟡 辅助区一致性 | ✅ 完成（2026-08-31）。词条行高走新增 `--row-h:32px`，与 `--control-h:34px` 分档 |
| **P2-2** | 状态 pill 系统 + **形状编码字形**（§0.3） | 0.6d | 🟡 信息层级 + 无障碍 | ✅ 完成（2026-08-31）。形状落 `.num::after`，CSS 绘制不用字符；补全 `--accent-bd` |
| **P2-3** | 字节数指示器 + 四段阈值 + 延迟呼吸 | 0.5d | 🟡 防错 | ✅ 完成（2026-08-31）。**此前完全不存在**，从零实现：新增 `src/bytes.js` 纯逻辑 + 10 条单测 + `renderer.js` 接入 |
| **P2-4** | 按钮/输入/下拉/开关 六态统一 | 0.6d | 🟡 一致性 | ✅ 完成（2026-08-31）。改 `focus-visible` 为 box-shadow 外发光；禁用态扩到全部控件（用了本项目唯一一处 !important）|
| **P3-1** | 模态、Toast、右键菜单、命令面板、空状态、加载态 | 1.0d | 🟢 完整性 | ⚠️ 部分完成（2026-08-31）。模态/Toast/空状态/加载态已对齐 v3；**右键菜单与命令面板只交付视觉层 + DOM 约定，JS 交互待 master 定** |
| **P3-2** | 滚动条、分隔器、层级表收敛、密度模式 | 0.5d | 🟢 收尾 | ✅ 完成（2026-08-31）。z-index 13 种散值 → `--z-*` 九档；密度三档只调 `--row-h`/`--control-h`，不动全局网格 |

**合计 ≈ 8.1 人日**（v2 为 5.6d，增量 2.5d：v3 新增章节 2.0d + P1-4 间距网格化 0.8d − P0 别名法省下的 0.3d）

> **P0 实际耗时 0.9d**（2026-08-30 已落地），低于原估 1.4d —— 别名层重定向省掉了重写 821 行 CSS 的成本。
> 验证方式：`.workbuddy/p0_verify.mjs`（结构 + 关键修复点 12/12）、`.workbuddy/p0_resolve.mjs`（模拟层叠算最终值，断言 10/10）。

**建议切分：**

- **第一批（P0，1.4d）** — 不动任何视觉，只做地基。做完这一步，后面每一处改动才是"真的生效"。✅ 实际 0.9d 完成（2026-08-30）
- **第二批（P1-1，1.5d）** — 单独做翻译工作区。这是"有没有编辑器质感"的唯一决定性区域，做完就有 70% 的观感提升。✅ 实际 1.6d 完成（2026-08-30，含层叠对比工具沉淀）
- **第三批（P1-2 + P1-3，1.5d）** — 外壳。✅ 实际 1.6d 完成（2026-08-30）
- **第四批（P2，2.2d）** — 控件与指示器。✅ 完成（2026-08-31）
- **第五批（P3，1.5d）** — 收尾。✅ 完成（2026-08-31）

> **v3 全部批次（P0 → P3）已于 2026-08-31 落地完毕**，实际约 6.1 人日（原估 8.1d）。
> 剩余未做项见 §12.3。

### 12.1 改版过程中的决策修正（2026-08-30）

改版不是照单执行规范，规范本身会被实现细节证伪。本批次有三处 **规范被实现推翻**：

1. **撤回「命令条去实心填充」**（P1-2）
   规范原意是「去掉实心块，避免抢视线」。但落地时发现命令条里只有 `#btnImport` / `#btnSave` 两个实心，
   它们是该区域**唯一的主操作**——去掉后命令条失去视觉锚点。
   「强调位唯一」的正确读法是：*每个区域内最多一个强调位*，而不是*全局消灭实心*。
   最终：**顶栏四按钮去实心，命令条主操作保留实心 accent**。

2. **`▾` 字符 → CSS 画 chevron**（P1-3）
   规范 §7.2 要求用 Lucide。但 Tauri 离线环境禁引 CDN 图标库，且为两个 chevron 引一套图标不划算。
   改为 `::before` 两条 1.5px 边旋转 45° 实现，零依赖、随 `currentColor` 走主题。
   同步清掉 `main.js` 里的 `caret.textContent='▾'` 与 📁/📄 emoji（emoji 在 Windows 是彩色图标，与单色工具感冲突）。

3. **特异性陷阱：改了不等于生效**（P1-2，最重要的一条方法论）
   `.command-bar{ min-height; padding }` 写完后**完全没生效**——被 `L2355` 的
   `.command-strip > #controls, .command-strip > #glossaryCommand, .command-strip > #searchbar`（特异性 **1,2,0**）压过。
   `.command-bar` 只有 0,1,0，位置再靠后也没用。
   同类还有 `#controls .primary-group button`（1,2,0）压过 `.primary-group button`（0,2,0）。
   **本项目 `style.css` 大量使用 id 选择器，任何新规则都必须先算特异性，不能只看行号顺序。**
   修正方式：复用同一组高特异性选择器、靠位置取胜，而不是堆 `!important`。

> ⚠️ **不要并行做 P0 和 P1。** P1 的所有视觉改动都建立在新 token 上。先合并变量再动视觉，否则会产生第二套"新变量 + 旧硬编码"的混合体，回到今天的困境。

---

## 13. 验收清单

改完后按此自检，每条都应能明确回答"是"：

**视觉**
- [ ] 截图转灰度后，原文与译文仍能一眼区分（明朝 vs 黑体）
- [ ] 当前行在 2000 行滚动中始终能被瞬间定位（左侧竖线 + 渐变）
- [ ] 连续阅读 30 分钟后眼睛无明显疲劳（无高饱和色块、无纯黑纯白对冲）
- [ ] 四种状态标签在 18px 高度下**不看文字仅凭颜色 + 形状**即可分辨
- [ ] 全文无硬编码色值（除 `#000`/`#fff` 的透明度叠加）

**性能**
- [ ] 侧栏滚动时无掉帧（无 `backdrop-filter`）
- [ ] hover 不触发任何 layout 重排（DevTools Performance 面板验证）
- [ ] 断网状态下首屏无字体闪烁（无 webfont CDN）

**一致性**
- [ ] 数字列（行号、编号、字节数）垂直严格对齐（`tabular-nums`）
- [ ] 所有可交互元素六态齐全（rest/hover/active/focus-visible/selected/disabled）
- [ ] 无 `z-index` 越界值（全部落在 §6.1 表内）
- [ ] 主题切换后无残留硬编码色

**无障碍**
- [ ] §9.2 全部条目通过
- [ ] `prefers-reduced-motion` 下动效降级，超限警示退化为静态色
- [ ] 键盘可完成：翻行 → 编辑 → 切状态 → 保存 全流程

### 12.2 P1-4 / P2 / P3 的实施教训（2026-08-31）

#### 1. 审计脚本自身会撒谎 —— 先验证工具再信结论

P1-4 第一版间距审计报「132 处间距值」，比记忆中的 531 少一大截。原因不是数据变了，是**脚本只解析了"一行一声明"的格式**，
把 `.speaker-plate{ display:flex; ... margin-bottom:var(--sp-1); }` 这种压缩行整条漏掉。

改用块类型栈重写后又发现第二个 bug：`@keyframes` 的进出靠 `pre` 文本判断，
而 `}` 处的 `pre` 已是块内内容，**计数只增不减** —— 第一个 `@keyframes` 之后的所有声明全部被跳过（1699 条 → 修正后 3317 条，漏了一半）。

→ **结论：审计工具跑出来的数，先用一个已知样本交叉验证，再拿它做决策。**

#### 2. CSS 注释里的 `{}` 会让 :root 块提前闭合

给 `--row-h` 写注释时写了「与 `button{height}` 一致」。注释里的 `}` 让 `p0_resolve` 的块解析**提前闭合了 `:root`**，
别名层（821 行 CSS 的唯一取色源）整体丢失，自检从 10/10 掉到 3/10。

→ **规则：CSS 注释里不写裸大括号。** 已加进收尾检查。

#### 3. 距离文档底部留白：语义变量 > 网格

`#list` 的 `padding-bottom` 在 4 个断点上有 7 处定义（80/100/120/76/70/82/64/36px），历代各自拍脑袋。
其中**宽屏实际生效的是 `@media (min-width:721px)` 里的 36px**，P1-1 权威段写的 76px 根本没生效。

→ 收敛为两个语义变量 `--pad-scroll-end:96px` / `--pad-scroll-end-sm:64px`，死规则全部无害化为同值。
这类"布局留白"不属于 8px 网格节奏，硬套 4 倍数没有收益，应当单独命名。

#### 4. 控件高度要分档，且 min-height 会顶穿 height

`button{}` 全局带 `min-height:var(--control-h)`（34px）。术语表行想要 32px，
只写 `height:32px` 不生效 —— 删除按钮被 min-height 顶到 34px，与同行输入框差 2px。

→ 新增 `--row-h:32px`（密集列表行）与 `--control-h:34px`（工具栏控件）两档，密集行里的按钮显式压 `min-height`。
这也是 P3-2 密度三档的地基。

#### 5. light / bw 主题的覆盖层变量长期缺失

`--ov-selected` 与 `--ov-disabled` 只在 dark 主题定义过。light / bw 下
`.tree-item.active`、`.para.match-current`、禁用控件**整条属性静默失效**（`var()` 无 fallback 时属性无效）。
而 `css_var_check` 扫的是全文件，dark 有定义就不报 —— 检查器没抓到，是人工比对主题块才发现的。

→ 已补齐三主题，并在 `p0_verify` 加「覆盖层三主题齐全」守卫生住不再退化。

### 12.3 剩余未做项

| 项 | 状态 | 说明 |
|---|---|---|
| 右键菜单 JS 交互 | ❌ 未做 | 视觉层 + DOM 约定已交付（`.menu > .menu-item / .menu-sep`）。需要定触发区域、子菜单、禁用项规则 |
| 命令面板 JS 交互 | ❌ 未做 | 视觉层 + DOM 约定已交付（`.palette-mask > .palette > .palette-input + .palette-list`）。需要定命令集、模糊匹配、快捷键（建议 Ctrl+Shift+P） |
| 字节数口径切换 UI | ❌ 未做 | `src/bytes.js` 已支持 utf8 / sjis 两种口径，`setByteEncoding()` 已导出；缺设置项入口。**依赖 Q3** |
| 死规则清理 | ❌ 未做 | 531 / 1354 两层的 `.para` / `.num` / `.body` / `.orig*` / `textarea.trans` 已被显式覆盖，视觉无影响。删除需单独批次排查同名类被 `glossary-row` 等引用 |
| 场景树分段进度条 | ❌ 未做 | 规范 §7.4 要求「三段 flex-grow 按 approved/pending/issue 分配」。DOM 未实现 |
| 视觉自检 | ⚠️ 待 master | 全部批次的渲染效果均未经人眼确认（模型读不了图） |
