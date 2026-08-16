# 词典插件开发指南（v1）

编辑器内置一个**统一词典查询接口**（`src/dict.js`），所有词典源以 Provider 适配器形式接入。
内置三类适配器 + 一个示例词库；本文说明接口契约、词典文件格式与各适配器的配置方法。

## 统一查询接口

```js
// Provider 契约（镜像机翻 Provider 的注册模式,见 src/mt.js）
{
  id: string,                 // 唯一标识（自定义源形如 'ds_xxx' / 'mdx:名称'）
  name: string,               // 显示名
  isConfigured(): boolean,    // 是否可用（未配置/加载失败的源不会被查询）
  lookup(word): Promise<DictResult[]>   // 查询一个词
}

// 返回的每条结果
{
  headword: string,                     // 词条
  reading?: string,                     // 读音（假名）
  senses: [{                            // 释义（至少一条）
    pos?: string,                       // 词性（如 动词一段 / 形容词）
    gloss: string,                      // 释义文本
    examples?: [{ src, dst }],          // 例句（原文 → 译文）
  }],
  source: string,                       // 来源词典名（框架自动填充）
}
```

注册：`import { registerProvider } from './src/dict.js'` 后调用 `registerProvider(provider)` 即可，
无需改动任何 UI。查询时 `lookupAll(word)` 并发调用所有已启用的 Provider，单个失败不影响其余
（失败信息会显示在结果区）。**精确命中（词条或读音完全等于查询词）优先返回；无精确命中时
返回前缀补全建议。**

## JSON 词典文件格式（galtrans-dict-v1）

```json
{
  "format": "galtrans-dict-v1",
  "name": "我的日汉词典",
  "entries": {
    "食べる": { "reading": "たべる", "senses": [
      { "pos": "动词一段", "gloss": "吃", "examples": [{ "src": "何か食べる？", "dst": "吃点什么吗？" }] }
    ]},
    "ごめん": "对不起"
  }
}
```

- 释义值可以是字符串（简写）或对象；
- `senses` 是数组，每项 `pos` / `gloss` / `examples` 都可省略（`gloss` 必填）；
- UTF-8 编码，`.json` 扩展名；
- 在侧栏「词典 → 词典源 → ＋ JSON 词典」导入。**桌面版记住文件路径**（重启后仍有效，
  词典文件移动后需重新添加）；**浏览器版为本次会话加载**，重新打开应用后需重新添加。

## MDX 词典（v2 格式）

侧栏「词典源 → ＋ MDX 词典」选择 `.mdx` 文件（可多选），即刻加载进查询。

- **实现**：桌面版走 Rust 原生引擎（`src-tauri/src/mdict.rs`，内存映射大文件，参照
  js-mdict 6.0.8 算法）；浏览器版用 js-mdict 6.0.8（MIT 许可，未用 AGPL 的 7.x），经
  `src/node-shims/*`（fs/zlib/assert 三个 shim + pako + buffer polyfill）接入；
- **桌面版路径持久化**：添加时经原生对话框取文件路径并即时校验，写入 SQLite
  `dict_sources` 表；**重启后自动恢复**——启动零开销，**首次查询时**才 `mdx_open`
  解析文件头（Rust 内存映射 + 惰性索引），查询在 Rust 进程内完成，不再把大词典搬进
  WebView；文件被移动/删除时查询结果区会显示错误，把文件放回即可恢复；
- **浏览器版会话内加载**：无法持久路径，重启后需重新选择（源列表显示「需重新添加」）；
- **查询行为**：精确命中（词条/读音，忽略大小写兜底）；无精确命中时返回前缀补全词条
  （最多 6 条，桌面版与浏览器版一致）；`@@@LINK` 变体词自动跟随到主词条（≤3 跳）；
- **词条内资源（.mdd）**：桌面版自动探测同名 `.mdd` 资源包并关联，词条里的图片/发音
  正常显示与播放（`sound://` 发音链接、`entry://` 词条跳转可用）；浏览器版受限于
  无文件系统，不加载 .mdd 资源；
- **安全**：MDX 词条是词典自带的 HTML，渲染前经 DOM 白名单消毒（`src/mdx.js` 的
  `sanitizeMdxHtml`）：移除 script/style/iframe/表单/媒体标签、`on*` 事件属性、`javascript:` 链接；
- **加密词典**：`Encrypted="2"`（key-info 块加密，如新世纪讨论版）可无密码读取；
  带密码的 `Encrypted="Yes"` 词典暂不支持，遇到会报「解析失败」；LZO 压缩的词典暂不支持。

### 生成测试用 MDX

```bash
pip install mdict-utils
# 源文本格式: 每词条 = 词条行 + 释义行(可多行) + '</>' 终止行
printf 'hello\r\ndef world\r\n</>\r\nfoo\r\ndef bar\r\n</>\r\n' > t.txt
mdict -a t.txt t.mdx
```

## HTTP 词典配置

侧栏「词典源 → ＋ HTTP 词典」打开配置弹窗：

| 字段 | 说明 | 示例 |
|---|---|---|
| 名称 | 显示名 | 我的在线词典 |
| URL 模板 | 必须含 `{word}` 占位，自动 URL 编码 | `https://api.example.com/dict?q={word}` |
| 请求头 JSON | 可选；API Key 放这里 | `{"Authorization": "Bearer sk-…"}` |
| 条目根 | 点路径；指向数组时逐条解析 | `$.data.list` |
| 词条 / 读音 | 每个条目内的点路径 | `$.word` / `$.kana` |
| 释义 | 字符串 / 字符串数组 / 对象数组均可 | `$.means` |

点路径语法：`$.a.b.0.c`（`$` 是根，数字段用于数组下标）。

释义路径支持的响应形状：

```json
"吃"                                   // 单个字符串
["吃", "进食"]                          // 字符串数组
[{"pos": "動", "gloss": "吃"}]          // 对象数组（gloss/translation/text 任一,pos 可选）
```

配置用「测试查询」验证后再保存。配置持久化在 `settings.json` 的 `dict.sources` 数组。

### 常见问题

- 连接成功但没有词条 → 检查「条目根」「释义」路径是否正确（用测试查询逐步排查）；
- 自建本地 API 可用任意 HTTP 服务（如 python -m http.server + 静态 JSON）；
- 跨域（CORS）限制由词典服务端控制，webview 内与浏览器一致。

## 接入新的词典源类型（面向贡献者）

v1 采用「内置适配器 + 配置」：在 `src/dict.js` 里新增一个 `createXxxProvider(cfg)` 工厂函数，
实现接口契约即可，配置 UI 与持久化照抄 HTTP 词典的写法（`src/main.js` 的词典源管理段落）。
MDX 适配器在 `src/mdx.js`，是「异步创建 Provider + 注入解析库」的参考实现。

适合作为适配器候选的后续方向：

- **浏览器版句柄持久化**：File System Access 句柄 + 重启后一次授权（仅 Chrome/Edge）；
- **动态 JS 插件**：从用户目录加载第三方 JS 并执行。当前**有意未实现**——引入任意代码
  执行面，且浏览器单文件版无法同等支持。若未来实现，需沙箱化并明确安全边界。

## 相关文件

| 文件 | 职责 |
|---|---|
| `src/dict.js` | Provider 框架 / JSON·HTTP 适配器 / lookupAll |
| `src/main.js` | 词典源管理 UI、查询结果渲染、划词查词接线 |
| `src/renderer.js` | 划词浮层（📖 查词）、输入建议浮层（Tab 采纳） |
| `tests/dict.test.mjs` | 框架与适配器单元测试 |
