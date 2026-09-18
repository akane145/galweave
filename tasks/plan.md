# Implementation Plan: 多样例模块化格式设计器

## Overview

在现有“样例配置与格式档案”能力上增加零正则、多样例的可视化规则生成流程。用户为同一种文本布局提供至少 2 组原文/译文样例，选中并标注“编号、角色名、正文”，再指定原文记录的语义类型（对话或旁白）。程序仅从已标注字段和其间的固定文字生成声明式规则，拿整份文件预演并验证无损回写后才允许保存或载入。

本期只处理原文件中已经同时存在原文槽和译文槽的文本格式，不负责插入译文行。

## Existing Foundation

- `src/offline-formats.js` 已支持 `{text}`、`{id}`、`{name}`、顺序/编号配对、多行模板、控制符保护和回写复验。
- `src/offline-formats-ui.js` 已支持选中文字标记字段、预览、档案导入导出和保存。
- `src/main.js` 已在普通导入时仅自动采用唯一完整匹配的离线格式档案。
- `src/parsers.js` 已把离线格式档案接入原格式导出，并在记录顺序变化时阻止回写。
- `src/universal-parser.js` 已有对话、旁白、说话人等语义视图；本功能不重复实现控制符识别或全文语义解析。

## Confirmed Scope

- 面向完全不懂正则的单人用户，主流程不显示正则或 `{text}` 一类模板语法。
- 每个布局至少需要 2 组已标注的原文/译文样例；单个样例不能生成规则。
- 一个格式档案可以包含多个布局，例如“带角色名的对话”和“不带角色名的旁白”。
- 每条记录必须有现成的原文槽和译文槽，译文内容可以为空。
- 原文与译文按出现顺序或相同编号配对；沿用现有两种方式。
- 固定前缀、后缀、分隔符和换行由程序从未标注部分自动保留，不作为可编辑字段。
- 未识别内容保持原样；手动载入前必须确认，自动采用时则要求没有未识别的非忽略内容。

## Architecture Decisions

### 1. 使用声明式片段，不执行用户代码

内部规则由 `literal` 与 `field` 两种片段组成：

```js
[
  { type: 'literal', value: 'JP[' },
  { type: 'field', field: 'id' },
  { type: 'literal', value: '] ' },
  { type: 'field', field: 'text' },
]
```

匹配器仍可在内部编译成转义后的正则，但 UI、档案和用户均不需要编写正则。禁止动态执行、回调脚本和任意表达式。

### 2. 多样例用于证明同一布局，而不是“猜”格式

每条样例先由用户明确标注字段区间。系统把样例转换成片段骨架；同一布局的所有样例必须得到相同骨架，否则指出哪一条例子的固定文字或字段顺序不一致。程序不依赖单例启发式猜测字段边界。

### 3. 多布局共存，原文语义与物理结构分离

一个档案保存多种原文布局与译文布局。原文布局可标为“对话”或“旁白”；角色名是可选字段。相同的译文布局允许被多种原文布局复用并在保存时去重，避免“译文格式相同”造成伪歧义。

### 4. 格式档案升级为 v2，并兼容 v1

- v2 保存片段化的 `sourcePatterns`、`targetPatterns`、配对方式和忽略前缀。
- 当前 v1 的单个原文/译文模板在读取时无损迁移为各一个 v2 pattern。
- 旧档案无需用户重建；新档案默认导出 v2。
- 不保存用户粘贴的完整脚本文本，只保存生成后的结构规则和必要标签。

### 5. 安全门禁沿用并加强

- 生成规则前：至少 2 组样例、每侧恰好一个正文、字段不重叠、编号配对时两侧均有编号。
- 全文预演时：同一位置若匹配多个不同规则、重复编号、孤立原文/译文、结构注入均报错。
- 保存/导出时：只替换译文侧 `text`/`name` span，继续校验控制符、记录顺序和再次解析结果。
- 自动采用档案时：仍要求唯一档案完整匹配且无未识别内容。

## UX Flow

1. 用户选择当前脚本或粘贴外部文本。
2. 创建一个布局，例如“有角色名的对话”。
3. 添加至少 2 组原文/译文样例。
4. 在每个样例中选中文字，点击“编号”“角色名”“正文”；未标注文字自动视为固定结构。
5. 为原文布局选择“对话”或“旁白”。旁白布局通常不标角色名。
6. 系统即时比较样例骨架，显示一致或冲突位置，不展示正则。
7. 用户可继续增加另一个布局，例如“旁白”。
8. 点击“预览全部文本”，检查解析记录、匹配布局、未识别行和错误。
9. 通过无损回写检查后，保存格式档案或直接载入。

## Task List

### Phase 1: Contract and Inference Core

#### Task 1: 定义 v2 格式档案与 v1 迁移

**Priority:** 高  
**Estimate:** 1.0 人日  
**Dependencies:** 无

**Description:** 定义纯数据的 v2 schema、校验规则与 v1→v2 迁移，使后续多布局解析和 UI 共用同一契约。

**Acceptance criteria:**

- [ ] v1 内置档案和用户档案读取后行为不变。
- [ ] v2 能表达多个原文/译文 pattern、字段片段、语义类型、配对方式和忽略前缀。
- [ ] 非法字段、重复字段、空 literal 起始、缺少正文及超出既有大小约束的档案会被拒绝。

**Verification:**

- [ ] `node --test "tests/offline-formats.test.mjs"`
- [ ] 新增 v1 迁移和 v2 校验单测。

**Files likely touched:**

- `src/offline-formats.js`
- `tests/offline-formats.test.mjs`
- `docs/DEVELOPMENT.md`

#### Task 2: 实现多样例标注模型与骨架归纳

**Priority:** 高  
**Estimate:** 1.5 人日  
**Dependencies:** Task 1

**Description:** 新增纯逻辑模块，把用户标注的字符区间转换为片段规则，并比较至少两组样例是否证明同一布局。

**Acceptance criteria:**

- [ ] 单个样例明确拒绝，至少 2 组样例才可生成布局。
- [ ] 支持 `id`、`name`、`text` 标注，拒绝重叠、越界、重复正文或字段顺序冲突。
- [ ] 固定前后缀不同或字段缺失时，错误能定位到具体样例和冲突片段。

**Verification:**

- [ ] `node --test "tests/format-samples.test.mjs"`
- [ ] 覆盖对话、旁白、空译文、多行正文、全角符号和 CRLF 样例。

**Files likely touched:**

- `src/format-samples.js`（新增，纯逻辑、无 DOM）
- `tests/format-samples.test.mjs`（新增）
- `docs/DEVELOPMENT.md`

#### Task 3: 扩展离线解析器支持多 pattern

**Priority:** 高  
**Estimate:** 1.5 人日  
**Dependencies:** Task 1

**Description:** 让全文扫描器在同一档案中识别多个原文/译文布局，并在匹配冲突时保守失败。

**Acceptance criteria:**

- [ ] 同一文件可混合解析带角色名对话和无角色名旁白。
- [ ] 相同译文 pattern 可被多个原文布局共享，不产生伪歧义。
- [ ] 真正的多 pattern 重叠、重复编号、孤立槽或配对数量不一致会阻止载入。

**Verification:**

- [ ] `node --test "tests/offline-formats.test.mjs"`
- [ ] 未编辑输出与输入逐字符一致，包括 BOM、CRLF、多行记录和空译文。

**Files likely touched:**

- `src/offline-formats.js`
- `tests/offline-formats.test.mjs`

### Checkpoint A: 规则引擎

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] v1 档案回归通过。
- [ ] 两类布局的 v2 测试文件可完整解析并严格往返。

### Phase 2: Safe Editing Path

#### Task 4: 接通 v2 编辑模型与原格式回写

**Priority:** 高  
**Estimate:** 1.0 人日  
**Dependencies:** Tasks 2–3

**Description:** 将 pattern/语义类型映射到现有段落模型，确保编辑器只暴露角色名和译文，并复用现有原格式导出入口。

**Acceptance criteria:**

- [ ] 对话样例正确进入角色名与正文栏，旁白不伪造角色名。
- [ ] 原文、固定前后缀、编号和未识别内容始终只读并保持原样。
- [ ] 记录被重排、删除或新增时继续阻止原格式回写。

**Verification:**

- [ ] `node --test "tests/offline-formats.test.mjs" "tests/core.test.mjs"`
- [ ] 对话和旁白各修改一条后，只有目标 span 发生变化。

**Files likely touched:**

- `src/offline-formats.js`
- `src/parsers.js`
- `tests/offline-formats.test.mjs`

#### Task 5: 完善控制符与结构注入回归门禁

**Priority:** 高  
**Estimate:** 0.75 人日  
**Dependencies:** Task 4

**Description:** 确认 v2 多 pattern 沿用 `tokenizeInline` 控制符保护，并补足跨行内容可能伪造新记录的测试。

**Acceptance criteria:**

- [ ] 删除、新增或重排受保护控制符会阻止回写。
- [ ] 译文插入类似原文/译文前缀时不能改变记录数量或字段边界。
- [ ] 多行正文合法换行与结构性结束标签能够区分。

**Verification:**

- [ ] `node --test "tests/offline-formats.test.mjs" "tests/universal-parser.test.mjs"`

**Files likely touched:**

- `src/offline-formats.js`
- `tests/offline-formats.test.mjs`

### Phase 3: Zero-regex UI

#### Task 6: 构建多样例布局编辑器

**Priority:** 高  
**Estimate:** 2.0 人日  
**Dependencies:** Task 2

**Description:** 用可增删的布局卡片和样例对替换当前直接编辑模板的主流程；通过选择文字并点击字段按钮完成标注。

**Acceptance criteria:**

- [ ] 用户可以新增布局、添加/删除样例对，并选择对话或旁白。
- [ ] 文本选择可标为编号、角色名或正文，已标字段以可访问的视觉标识显示并可撤销。
- [ ] UI 不展示或要求输入正则、捕获组、模板占位符语法。

**Verification:**

- [ ] 为 DOM 独立的 UI 状态转换补纯逻辑测试。
- [ ] `node --test "tests/settings-ui.test.mjs" "tests/ui-modules.test.mjs" "tests/format-samples.test.mjs"`
- [ ] 键盘可操作，窄屏布局不溢出。

**Files likely touched:**

- `src/offline-formats-ui.js`
- `src/style.css`
- `tests/settings-ui.test.mjs`
- `tests/ui-modules.test.mjs`

#### Task 7: 增加冲突解释与全文预览

**Priority:** 高  
**Estimate:** 1.0 人日  
**Dependencies:** Tasks 3 and 6

**Description:** 将样例冲突、pattern 命中、未识别内容和配对错误翻译为非技术用户能修正的提示。

**Acceptance criteria:**

- [ ] 预览表显示每条记录命中的布局、原文、译文和物理行号。
- [ ] 错误使用“第几条样例/哪一段固定文字/哪个字段”的表述，不暴露内部正则。
- [ ] 未识别非空内容必须逐类确认；自动采用档案时仍不接受任何未确认内容。

**Verification:**

- [ ] 针对字段冲突、双重匹配、孤立译文和未知行增加消息快照或精确断言。
- [ ] 手动验证 100+ 条记录时预览分页与响应性。

**Files likely touched:**

- `src/offline-formats-ui.js`
- `src/offline-formats.js`
- `src/style.css`
- `tests/offline-formats.test.mjs`

### Checkpoint B: 用户主流程

- [ ] 从两组对话样例和两组旁白样例生成档案。
- [ ] 全文预览、载入、修改译文、保存、重新导入完整走通。
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run build:html`

### Phase 4: Persistence, Documentation, Release Gate

#### Task 8: 接入档案保存、导入导出与自动匹配

**Priority:** 中  
**Estimate:** 0.75 人日  
**Dependencies:** Tasks 3 and 7

**Description:** 让 v2 档案沿用现有设置存储和 JSON 交换流程，同时保留 v1 档案兼容与唯一匹配策略。

**Acceptance criteria:**

- [ ] 保存后重启仍可使用 v2 档案，且设置中不包含原始样例正文。
- [ ] v1/v2 档案均可导入；导出文件只包含规则。
- [ ] 多个档案同时匹配时不擅自选择，并引导用户进入预览。

**Verification:**

- [ ] `node --test "tests/settings.test.mjs" "tests/offline-formats.test.mjs"`
- [ ] 浏览器 localStorage 与桌面 settings.json 两条路径行为一致。

**Files likely touched:**

- `src/offline-formats-ui.js`
- `src/settings.js`
- `src/main.js`
- `tests/settings.test.mjs`

#### Task 9: 更新维护契约与用户文档

**Priority:** 中  
**Estimate:** 0.5 人日  
**Dependencies:** Tasks 1–8

**Description:** 记录 v2 档案结构、至少 2 组样例的规则、无损门禁和明确不支持的格式。

**Acceptance criteria:**

- [ ] `docs/DEVELOPMENT.md` 的维护契约记录样例下限、现有模板/档案大小上限及改动纪律。
- [ ] `docs/USER_GUIDE.md` 用无正则步骤说明对话与旁白两个布局的配置方法。
- [ ] `docs/RELEASE_NOTES.md` 说明兼容性和安全边界。

**Verification:**

- [ ] 文档示例能按实际 UI 从头完成，不出现已废弃的正则主流程。

**Files likely touched:**

- `docs/DEVELOPMENT.md`
- `docs/USER_GUIDE.md`
- `docs/RELEASE_NOTES.md`

#### Task 10: 完整回归与浏览器交互验收

**Priority:** 高  
**Estimate:** 0.75 人日  
**Dependencies:** Tasks 8–9

**Description:** 对桌面/普通 Vite/单文件 HTML 共用路径做最终回归，重点验证导入和保存不会破坏原文件。

**Acceptance criteria:**

- [ ] 对话+旁白、编号分区、顺序交错、多行正文、空译文五类样本通过端到端验收。
- [ ] v1 档案、默认 ☆/★ 解析器和镜像格式没有回归。
- [ ] 失败场景均在载入或回写前停止，并提供可操作提示。

**Verification:**

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run build:html`
- [ ] 在真实浏览器中完成创建档案→载入→编辑→导出→重新解析的交互测试。

**Files likely touched:**

- `tests/offline-formats.test.mjs`
- `tests/settings-ui.test.mjs`
- 必要时新增小型测试 fixture；不提交用户真实脚本文本。

## Dependency Graph

```text
Task 1 v2 契约
  ├─ Task 2 多样例归纳 ── Task 6 样例 UI ── Task 7 预览解释
  └─ Task 3 多 pattern 解析 ── Task 4 编辑/回写 ── Task 5 安全回归
                                 │                    │
                                 └──────── Task 8 持久化/自动匹配
                                                      │
                                            Task 9 文档 ── Task 10 验收
```

Tasks 2 and 3 can proceed in parallel after Task 1. Tasks 5 and 6 can proceed in parallel after their respective dependencies. The UI and parser must not be developed against separate implicit contracts; v2 schema is the shared boundary.

## Effort Summary

| Phase | Estimate |
|---|---:|
| Contract and inference core | 4.0 人日 |
| Safe editing path | 1.75 人日 |
| Zero-regex UI | 3.0 人日 |
| Persistence, docs, release gate | 2.0 人日 |
| **Total** | **约 10.75 人日** |

建议预留约 1–2 人日处理真实脚本暴露出的布局歧义，因此排期按 **11–13 人日** 更稳妥。

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 多条样例看似相同，实际存在可选片段 | 高 | MVP 不支持单 pattern 可选字段；要求拆成两个布局，错误提示给出冲突位置。 |
| 多个 pattern 在同一位置同时命中 | 高 | 不按优先级猜测；全文预演报错，要求用户补充固定文字或合并重复布局。 |
| 多行正文吞掉后续记录 | 高 | 要求明确结束 literal；全文记录数与再次解析必须一致。 |
| 新档案破坏旧 v1 用户配置 | 高 | 读取时迁移、保留 v1 回归 fixture，新写出才使用 v2。 |
| 零正则 UI 仍让用户理解成本过高 | 中 | 用布局、样例、字段高亮和自然语言冲突说明；不展示内部模板。 |
| 保存大量样例撑大 settings | 中 | 不持久化原始样例，只保存归纳后的片段规则。 |

## Not Doing

- 不处理只有原文、需要程序新增译文槽的文件。
- 不支持嵌套语法树、转义字符串、二进制脚本或需要执行引擎代码的格式。
- 不使用大模型或网络服务猜测规则。
- 不暴露任意正则、脚本或插件回调作为主流程。
- 不做具体游戏引擎预设；规则完全来自用户样例。
- 不把前缀、后缀做成独立可编辑字段，它们作为固定 literal 原样保存。
- 不改变现有控制符保护、QA/proof 分工或单人使用边界。

## Definition of Done

- 完全不懂正则的用户能用至少两组样例建立包含对话和旁白的档案。
- 档案可在后续同格式文件上唯一自动匹配。
- 原文、编号、固定结构、控制符、换行和未识别内容保持不变。
- 保存后的文件能够被同一档案重新解析，记录数、配对关系和源字段完全一致。
- v1 档案、默认解析器、镜像格式和单文件 HTML 构建均无回归。

