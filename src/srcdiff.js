// srcdiff.js — 原句对照的轻量差异区间（纯逻辑，无 DOM）
//
// 用途：侧栏「建议」里相似翻译记忆的「原句对照」——把当前原句与记忆原文的
// 差异段落标出来，让译者看清到底差在哪（否定、数字、称呼……）。
//
// 只求"变动区间"，不求最短编辑脚本：连续共同前缀 + 共同后缀即可覆盖
// 「只差一个词」的场景，且 O(n)、无依赖、可单测。整句重写时区间会很大，
// 这本身也是如实信息（说明两句几乎不同）。
//
// ⚠️ 切分按**码点**而非码元：代理对（emoji 等）不能被劈成两个半字符，
// 否则渲染出来是乱码方块。

const isHighSurrogate = (c) => c >= 0xD800 && c <= 0xDBFF;
const isLowSurrogate = (c) => c >= 0xDC00 && c <= 0xDFFF;

/** 位置 i 起一个码点占用的码元数（1 或 2） */
function codePointWidth(s, i){
  if (i + 1 < s.length && isHighSurrogate(s.charCodeAt(i)) && isLowSurrogate(s.charCodeAt(i + 1))) return 2;
  return 1;
}

/** 恰好在位置 end 之前结束的码点占用的码元数（1 或 2） */
function widthEndingAt(s, end){
  if (end >= 2 && isLowSurrogate(s.charCodeAt(end - 1)) && isHighSurrogate(s.charCodeAt(end - 2))) return 2;
  return 1;
}

/**
 * 求两段文本的差异区间（按码点对齐）。
 *
 * 返回 `{ prefix, suffix, aMid, bMid, changed }`：
 *   a === prefix + aMid + suffix，b === prefix + bMid + suffix，
 *   prefix / suffix 是两侧逐字相同的公共部分（可能为空串）。
 * 任一侧为另一侧的子串时，对应 mid 为空串；两侧完全相同时 changed 为 false。
 *
 * @param {string} a 当前原句
 * @param {string} b 记忆原文
 * @returns {{prefix:string, suffix:string, aMid:string, bMid:string, changed:boolean}}
 */
export function diffSourcePair(a, b){
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);

  let p = 0;
  while (p < x.length && p < y.length){
    const wx = codePointWidth(x, p);
    const wy = codePointWidth(y, p);
    if (wx !== wy || x.slice(p, p + wx) !== y.slice(p, p + wy)) break;
    p += wx;
  }

  let s = 0;
  while (s < x.length - p && s < y.length - p){
    const wx = widthEndingAt(x, x.length - s);
    const wy = widthEndingAt(y, y.length - s);
    if (wx !== wy || x.slice(x.length - s - wx, x.length - s) !== y.slice(y.length - s - wy, y.length - s)) break;
    s += wx;
  }

  const prefix = x.slice(0, p);
  const suffix = s ? x.slice(x.length - s) : '';
  const aMid = x.slice(p, x.length - s);
  const bMid = y.slice(p, y.length - s);
  return { prefix, suffix, aMid, bMid, changed: aMid !== '' || bMid !== '' };
}
