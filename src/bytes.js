// 字节计数与阈值判定 —— 纯逻辑，不依赖 DOM。
//
// 为什么需要两种口径：galgame 引擎（NScripter / KAG 等）的文本缓冲区大多按
// Shift-JIS 字节算，全角字符 = 2 字节；而 UTF-8 下中文 = 3 字节。同一句话
// 两种口径能差出一倍，指示器必须标明当前口径，否则用户会照着错误的数字改稿。
//
// ⚠️ 阈值上限来自 CSS 变量 --byte-limit（见规范 §8.3），Q3 目标引擎确定后一行切换。

/** UTF-8 字节数：按 Unicode 码点分 1/2/3/4 字节 */
export function utf8Bytes(str){
  if (!str) return 0;
  let n = 0;
  for (const ch of str){            // for..of 按码点迭代，代理对不会被拆成两次计数
    const c = ch.codePointAt(0);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0x10000) n += 3;
    else n += 4;
  }
  return n;
}

/** Shift-JIS 字节数：ASCII 与半角片假名 1 字节，其余（全角/汉字/假名）2 字节 */
export function sjisBytes(str){
  if (!str) return 0;
  let n = 0;
  for (const ch of str){
    const c = ch.codePointAt(0);
    if (c <= 0x7F) n += 1;                          // ASCII
    else if (c >= 0xFF61 && c <= 0xFF9F) n += 1;    // 半角片假名 ｦｧｨ…
    else n += 2;                                     // 全角假名 / 汉字 / 全角符号
  }
  return n;
}

/** 支持的计数口径（顺序 = 设置项下拉顺序） */
export const ENCODINGS = ['utf8', 'sjis'];

/**
 * 归一化口径：只接受 'sjis'（不区分大小写），其余一律回退 'utf8'。
 * 持久化读回时可能拿到 null / 旧值 / 大小写不一致的字符串，统一收口在这里。
 */
export function normalizeEncoding(enc){
  return String(enc == null ? '' : enc).trim().toLowerCase() === 'sjis' ? 'sjis' : 'utf8';
}

/** 按口径分派。enc: 'utf8' | 'sjis' */
export function byteCount(str, enc){
  return normalizeEncoding(enc) === 'sjis' ? sjisBytes(str) : utf8Bytes(str);
}

/**
 * 四段阈值（规范 §8.3，按目标引擎文本框容量占比）
 *   ok   < 70%       → 常态，不打扰
 *   mid  70% – 90%   → 提亮，提示快到了
 *   near 90% – 100%  → 琥珀，接近上限
 *   over > 100%      → 朱橙 + 延迟呼吸
 * limit 非正数时一律 ok（未配置上限就不该报警）
 */
export function usageLevel(bytes, limit){
  if (!(limit > 0)) return 'ok';
  const r = bytes / limit;
  if (r > 1) return 'over';
  if (r >= 0.9) return 'near';
  if (r >= 0.7) return 'mid';
  return 'ok';
}

/** 指示器 title 文案：超出时给出差量，用户不用自己做减法 */
export function formatByteTitle(bytes, limit, enc){
  const label = enc === 'sjis' ? 'Shift-JIS' : 'UTF-8';
  const over = bytes - limit;
  return over > 0
    ? `${bytes} / ${limit} 字节（${label}）· 超出 ${over} 字节`
    : `${bytes} / ${limit} 字节（${label}）`;
}

/** 口径后缀（规范：用 --fs-2xs 标注 SJIS / UTF8） */
export function encodingLabel(enc){
  return normalizeEncoding(enc) === 'sjis' ? 'SJIS' : 'UTF8';
}

/** 口径在设置项里的说明文案（含字节口径差异，避免用户照着错口径改稿） */
export function encodingName(enc){
  return normalizeEncoding(enc) === 'sjis'
    ? 'Shift-JIS（全角 2 字节）'
    : 'UTF-8（中文 3 字节）';
}

/** 字数上限的可选范围（规范 §8.3 的文本框容量；Q3 未定前用 NScripter 常见值 120 兜底） */
export const BYTE_LIMIT_MIN = 20;
export const BYTE_LIMIT_MAX = 4000;
export const BYTE_LIMIT_DEFAULT = 120;

/**
 * 归一化字数上限。
 * 非数字 / 非正数 → 0，语义是"未配置上限"（指示器隐藏，不误报）；
 * 合法值钳到 [BYTE_LIMIT_MIN, BYTE_LIMIT_MAX] 并取整。
 */
export function normalizeByteLimit(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(BYTE_LIMIT_MAX, Math.max(BYTE_LIMIT_MIN, Math.round(n)));
}
