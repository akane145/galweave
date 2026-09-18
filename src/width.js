// width.js — 显示宽度测算（全角等效宽度）—— 纯逻辑，不依赖 DOM。
//
// 为什么需要它：字节计（bytes.js）回答"这行占多少字节"，但**不能回答"这一行放不放得下"**。
// 同一个 120 字节，换成 60 个半角数字、40 个汉字、或 30 个汉字加几个标点，
// 在游戏对话框里的观感完全不同。引擎按**字形宽度**排版，不按字节。
//
// 口径选择：**全角等效宽度**，不是像素。
//   全角（汉字/假名/全角标点）= 1，半角（ASCII/半角片假名）= 0.5。
//   单位就是"几个全角字位"，与字体无关。
//   ⚠️ 刻意**不做像素测算**：本项目允许用户换字体（fonts.js / fontloader.js），
//   像素宽度随字体变化，既不可测也不稳定；而"能放几个全角字"是引擎侧的事实。
//
// 不硬编码任何具体引擎的规格（master 已定不做引擎预设）：上限一律用户可配。

/* ---------------- 字符宽度 ---------------- */

/** 零宽：组合符号、零宽连接符、变体选择符、控制字符 —— 不占字位 */
function isZeroWidth(c){
  return (c >= 0x0300 && c <= 0x036F)      // 组合附加符号
    || (c >= 0x200B && c <= 0x200F)        // ZWSP / ZWNJ / ZWJ / LRM / RLM
    || (c >= 0x2028 && c <= 0x202E)        // 行/段分隔符、双向控制
    || (c >= 0x2060 && c <= 0x2064)        // word joiner 等
    || (c >= 0xFE00 && c <= 0xFE0F)        // 变体选择符
    || c === 0xFEFF                        // BOM / 零宽不换行空格
    || (c >= 0xE0100 && c <= 0xE01EF)      // 变体选择符补充
    || c < 0x20                            // C0 控制字符
    || (c >= 0x7F && c <= 0x9F);           // DEL 与 C1 控制字符
}

/** 全角（占 1 个字位） */
function isFullWidth(c){
  return (c >= 0x1100 && c <= 0x115F)      // 谚文初声
    || (c >= 0x2E80 && c <= 0x303E)        // CJK 部首 / 康熙部首 / CJK 符号
    || (c >= 0x3041 && c <= 0x33FF)        // 平假名 / 片假名 / 注音 / 谚文兼容 / CJK 兼容
    || (c >= 0x3400 && c <= 0x4DBF)        // CJK 扩展 A
    || (c >= 0x4E00 && c <= 0x9FFF)        // CJK 统一表意
    || (c >= 0xA000 && c <= 0xA4CF)        // 彝文
    || (c >= 0xAC00 && c <= 0xD7A3)        // 谚文音节
    || (c >= 0xF900 && c <= 0xFAFF)        // CJK 兼容表意
    || (c >= 0xFE10 && c <= 0xFE19)        // 竖排形式
    || (c >= 0xFE30 && c <= 0xFE6F)        // CJK 兼容形式 / 小写变体
    || (c >= 0xFF01 && c <= 0xFF60)        // 全角 ASCII 与全角标点（，。！？：；「」等）
    || (c >= 0xFFE0 && c <= 0xFFE6)        // 全角货币/符号
    || (c >= 0x1F300 && c <= 0x1F64F)      // 绘文字
    || (c >= 0x1F900 && c <= 0x1F9FF)
    || (c >= 0x20000 && c <= 0x3FFFD);     // CJK 扩展 B 及以后
}

/**
 * 单字符占几个全角字位：0（零宽）/ 0.5（半角）/ 1（全角）。
 *
 * 半角片假名（ｱｲｳ，U+FF61–U+FF9F）与半角谚文（U+FFA0–U+FFDC）按 0.5 ——
 * 它们在引擎里确实只占半个字位，这也是翻译时常见的"用半角省空间"手段。
 */
export function charWidth(ch){
  const s = typeof ch === 'string' ? ch : String(ch == null ? '' : ch);
  if (!s) return 0;
  const c = s.codePointAt(0);
  if (isZeroWidth(c)) return 0;
  if (isFullWidth(c)) return 1;
  return 0.5;
}

/**
 * 文本的显示宽度（全角等效字位数）。
 *
 * 按**码点**迭代，代理对（emoji 等增补平面字符）不会被拆成两次计数。
 * @returns {number} 可为小数（例如 "AB" → 1.0）
 */
export function visualWidth(str){
  const s = typeof str === 'string' ? str : String(str == null ? '' : str);
  if (!s) return 0;
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 宽度显示：整数不留小数点，小数保留一位（28 / 28.5） */
export function formatWidth(w){
  const n = Number(w);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* ---------------- 阈值 ---------------- */

/** 上限可选范围：10（短对话框）– 200（宽一行）。 */
export const WIDTH_LIMIT_MIN = 10;
export const WIDTH_LIMIT_MAX = 200;
/**
 * 默认上限：30 个全角字位。
 *
 * 不硬编码引擎规格（master 已定不做引擎预设），这是**中性起点**：
 * 常见 galgame 对话框一行大致 25–40 个全角字，用户按自己的目标调整即可。
 * 与 byteLimit 同一套模式：0 = 未配置 = 指示器隐藏，不误报。
 */
export const WIDTH_LIMIT_DEFAULT = 30;

/** 归一化宽度上限。非数字/非正数 → 0（语义"未配置"）；合法值钳到范围内取整。 */
export function normalizeWidthLimit(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(WIDTH_LIMIT_MAX, Math.max(WIDTH_LIMIT_MIN, Math.round(n)));
}

/**
 * 四段阈值。与 bytes.usageLevel 同构，保证两个指示器**同一套视觉语言**
 * （ok/mid/near/over 四态，CSS 侧共用 data-level 配色）。
 */
export function widthLevel(width, limit){
  if (!(limit > 0)) return 'ok';
  const r = width / limit;
  if (r > 1) return 'over';
  if (r >= 0.9) return 'near';
  if (r >= 0.7) return 'mid';
  return 'ok';
}

/** 指示器 title 文案：超出时给出差量，用户不用自己做减法 */
export function formatWidthTitle(width, limit){
  const over = width - limit;
  const w = formatWidth(width);
  return over > 0
    ? `${w} / ${limit} 全角字位 · 超出 ${formatWidth(over)} 个字位`
    : `${w} / ${limit} 全角字位`;
}

/* ---------------- 折行建议 ---------------- */

/**
 * 适合在其**之后**断行的标点（中文/日文习惯：标点跟着上一句走，不留行首）。
 * 破折号与省略号同理 —— 它们的后半截不该被推到下一行开头。
 */
const BREAK_AFTER = new Set('、。，．！？!?,;:：；）」』】》〉〕］｝·―—…‥〜～'.split(''));

/** 适合在其**之前**断行的字符（开括号类，它们不该挂在行尾）。 */
const BREAK_BEFORE = new Set('（(「『【《〈〔［｛'.split(''));

/**
 * 给一段超宽文本找**折行锚点**：在 limit 个字位处断开，返回 [前段, 后段]。
 * 未超宽返回 null（调用方据此不提示）。
 *
 * 断点优先取标点之后（保持语义完整）；若标点位置离上限太远（不足 60%），
 * 退回"正好超出的那个字之前" —— 宁可切在词中间，也不要为了找标点把前半行留得过短。
 *
 * @returns {{before:string, after:string, at:number}|null} at 为 UTF-16 下标
 */
export function suggestBreak(text, limit){
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!s || !(limit > 0)) return null;
  if (visualWidth(s) <= limit) return null;

  let w = 0;             // 已累计宽度
  let i = 0;             // UTF-16 下标
  let cut = -1;          // 正好超出的位置（上一个字符之后）
  let punctCut = -1;     // 最近的标点之后
  for (const ch of s){
    const cw = charWidth(ch);
    if (w + cw > limit){ cut = i; break; }
    w += cw;
    i += ch.length;
    if (BREAK_AFTER.has(ch)) punctCut = i;
  }
  if (cut < 0) cut = s.length;

  // 标点断点要"够靠后"才采用，否则前半行会短得没必要
  let at = cut;
  if (punctCut > 0 && punctCut <= cut && punctCut >= limit * 0.6) at = punctCut;

  // 避头尾（禁則処理）微调。两条例外的方向相反，故分两步：
  //   行末禁则：开括号不能留在行尾 → 断点**前移**，让括号跟到下一行开头；
  //   行首禁则：标点不能出现在行首 → 断点**后移**，把它收进本行末尾（追い込み）。
  // 微调可能让本行比 limit 少/多一个字位，这是折行建议的正常代价，好过难看的断法。
  // guard 防止极端文本（连续十几个括号）在这里空转。
  let guard = 0;
  while (at > 1 && BREAK_BEFORE.has(s[at - 1]) && guard++ < 8) at -= 1;
  guard = 0;
  while (at < s.length && BREAK_AFTER.has(s[at]) && guard++ < 8) at += 1;

  if (at <= 0 || at >= s.length) return null;
  return { before: s.slice(0, at), after: s.slice(at), at };
}
