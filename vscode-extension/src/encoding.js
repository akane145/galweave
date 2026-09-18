// encoding.js — 字节编码检测与反向编码（纯逻辑，无 DOM / 无 Node 内置依赖）
//
// 两个职责：
//   1. detectEncoding(bytes) —— 从**原始字节**判断编码（UTF-8 / UTF-16 / Shift-JIS / EUC-JP / ISO-2022-JP）
//   2. 反向表编码 —— 用**调用方注入的解码器**反推"字符 → 字节"，于是不必自己维护 JIS 映射表，
//      也不会与宿主解码器分叉：宿主能解的字符才允许编码回去。
//
// 为什么不能"试着解一下，成功就是它"：
//   TextDecoder 对任意字节几乎都能给出字符串（坏字节变 U+FFFD），而 A1-DF 在 Shift-JIS 里是合法半角片假名，
//   于是一份 EUC-JP 文件用 Shift-JIS 解也"成功"。所以判定分两步：
//   ① 用**字节结构**筛出候选（哪些编码的字节序列全部合法）；
//   ② 候选不止一个时，把两种解法的结果交给 scoreJapanese 比"像不像日语"（注入了解码器才做）。
//
// 编码表只认结论、不认"猜测"：拿不准就返回 unknown，让调用方什么都不做，而不是按错的编码重写文件。

/** 编码标识（内部统一用这一套，展示与写盘再各自映射） */
export const ENC = {
  UTF8: 'utf-8',
  UTF8_BOM: 'utf-8-bom',
  UTF16LE: 'utf-16le',
  UTF16BE: 'utf-16be',
  SJIS: 'shift-jis',
  EUCJP: 'euc-jp',
  ISO2022JP: 'iso-2022-jp',
  UNKNOWN: 'unknown',
};

export const ENC_LABEL = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 (BOM)',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'shift-jis': 'Shift-JIS',
  'euc-jp': 'EUC-JP',
  'iso-2022-jp': 'ISO-2022-JP',
  unknown: '未知编码',
};

/** 交给 TextDecoder 的标签（WHATWG 标签名，不是 VS Code 的设置值） */
export const DECODER_LABEL = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'shift-jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
};

/**
 * VS Code 的 `files.encoding` 取值。
 * 刻意写死成表、注释出处：这串 id 是 VS Code 自己的编码注册表用的（本机 VS Code 里
 * `shiftjis`/`eucjp` 都在，`utf8bom`/`utf16le`/`utf16be` 同源），猜错会写出一个无效设置。
 * ISO-2022-JP 不在注册表里（该版本无此项）→ 返回 null，调用方走"用 VS Code 的解码选择器"这条路。
 */
export function vsCodeEncodingId(enc) {
  switch (enc) {
    case ENC.UTF8: return 'utf8';
    case ENC.UTF8_BOM: return 'utf8bom';
    case ENC.UTF16LE: return 'utf16le';
    case ENC.UTF16BE: return 'utf16be';
    case ENC.SJIS: return 'shiftjis';
    case ENC.EUCJP: return 'eucjp';
    default: return null;
  }
}

export function encodingLabel(enc) {
  return ENC_LABEL[enc] || String(enc || '');
}

/** 是不是"文本文件按 UTF-8 读会乱码"的编码（扩展据此决定要不要提醒用户） */
export function needsUtf8Attention(enc) {
  return enc === ENC.SJIS || enc === ENC.EUCJP || enc === ENC.ISO2022JP
    || enc === ENC.UTF16LE || enc === ENC.UTF16BE;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input.length === 'number') return Uint8Array.from(input);
  return new Uint8Array(0);
}

/* ---------------- 结构判定 ---------------- */

/** 严格 UTF-8 校验：拒绝过长编码、代理区、> U+10FFFF（TextDecoder 的 fatal 也能做，但那要宿主支持） */
export function isValidUtf8(b) {
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { i += 1; continue; }
    let need;
    let min;
    let cp;
    if (c >= 0xC2 && c <= 0xDF) { need = 1; min = 0x80; cp = c & 0x1F; }
    else if (c >= 0xE0 && c <= 0xEF) { need = 2; min = 0x800; cp = c & 0x0F; }
    else if (c >= 0xF0 && c <= 0xF4) { need = 3; min = 0x10000; cp = c & 0x07; }
    else return false;                       // 0x80-0xC1 / 0xF5-0xFF 不是合法首字节
    if (i + need >= n) return false;
    for (let k = 1; k <= need; k++) {
      const t = b[i + k];
      if (t < 0x80 || t > 0xBF) return false;
      cp = (cp << 6) | (t & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += need + 1;
  }
  return true;
}

/**
 * Shift-JIS 结构扫描（CP932 范围）。
 * 合法：ASCII、0xA1-0xDF 单字节半角片假名、0x81-0x9F / 0xE0-0xFC 引导 + 0x40-0x7E / 0x80-0xFC 尾字节。
 * 0x80 / 0xA0 / 0xFD-0xFF 在 CP932 里不是合法首字节 → 记违规。
 */
export function scanShiftJis(b) {
  let pairs = 0;
  let violations = 0;
  let halfWidth = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 0x80) continue;
    if (c >= 0xA1 && c <= 0xDF) { halfWidth += 1; continue; }
    if ((c >= 0x81 && c <= 0x9F) || (c >= 0xE0 && c <= 0xFC)) {
      const t = b[i + 1];
      const trailOk = t !== undefined && ((t >= 0x40 && t <= 0x7E) || (t >= 0x80 && t <= 0xFC));
      if (!trailOk) { violations += 1; continue; }
      pairs += 1;
      i += 1;
      continue;
    }
    violations += 1;
  }
  return { pairs, violations, halfWidth };
}

/**
 * EUC-JP 结构扫描。
 * 合法：ASCII、0x8E + 0xA1-0xDF（半角片假名）、0x8F + 两字节 A1-FE（JIS X 0212）、
 * 0xA1-0xFE 双字节（JIS X 0208）。0x80-0x8D / 0x90-0xA0 / 0xFF 非法。
 */
export function scanEucJp(b) {
  let pairs = 0;
  let violations = 0;
  let halfWidth = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 0x80) continue;
    if (c === 0x8E) {
      const t = b[i + 1];
      if (t !== undefined && t >= 0xA1 && t <= 0xDF) { halfWidth += 1; i += 1; continue; }
      violations += 1;
      continue;
    }
    if (c === 0x8F) {
      const t1 = b[i + 1];
      const t2 = b[i + 2];
      if (t1 !== undefined && t2 !== undefined && t1 >= 0xA1 && t1 <= 0xFE && t2 >= 0xA1 && t2 <= 0xFE) {
        pairs += 1;
        i += 2;
        continue;
      }
      violations += 1;
      continue;
    }
    if (c >= 0xA1 && c <= 0xFE) {
      const t = b[i + 1];
      if (t !== undefined && t >= 0xA1 && t <= 0xFE) { pairs += 1; i += 1; continue; }
      violations += 1;
      continue;
    }
    violations += 1;
  }
  return { pairs, violations, halfWidth };
}

/** ISO-2022-JP 的切换序列：ESC $ B / ESC ( B / ESC $ @ / ESC & @ ESC $ B 等 */
export function hasIso2022JpEscape(b) {
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] !== 0x1B) continue;
    const a = b[i + 1];
    const c = b[i + 2];
    if ((a === 0x24 || a === 0x28 || a === 0x29) && c >= 0x21 && c <= 0x7E) return true;
  }
  return false;
}

/** 无 BOM UTF-16 的征兆：NUL 字节集中在同一侧 */
function utf16NoBomHint(b) {
  const n = Math.min(b.length, 4096);
  if (n < 4) return null;
  let evenNulls = 0;
  let oddNulls = 0;
  for (let i = 0; i < n; i++) {
    if (b[i] !== 0) continue;
    if (i % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  const nulls = evenNulls + oddNulls;
  // 门槛取 1/4：真实 UTF-16 文本（尤其含汉字时）NUL 不会很多，但一两个孤立 NUL 也不该当特征
  if (nulls < n / 4) return null;
  if (oddNulls >= nulls * 0.9) return ENC.UTF16LE; // 低位在前：ASCII 的 0x00 落在奇数位
  if (evenNulls >= nulls * 0.9) return ENC.UTF16BE;
  return null;
}

/* ---------------- 解码结果的"像不像日语"打分 ---------------- */

/**
 * 给一段解出来的文本打分（0-1，越大越像正常的日语脚本）。
 * 用途只有一个：Shift-JIS 与 EUC-JP 的结构都合法时二选一。
 * 判据来自两种误读的**可观测形态**：
 *   · EUC-JP 字节被当成 Shift-JIS → 成片的半角片假名（A1-DF 在 SJIS 里是半角）
 *   · Shift-JIS 字节被当成 EUC-JP → 大量 U+FFFD 或私用区字符
 */
export function scoreJapanese(text) {
  let good = 0;
  let bad = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD) { bad += 4; continue; }
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) { bad += 2; continue; }
    if (c >= 0xFF61 && c <= 0xFF9F) { bad += 2; continue; }              // 半角片假名
    if (c >= 0xE000 && c <= 0xF8FF) { bad += 3; continue; }              // 私用区
    if (c < 0x80) { good += 1; continue; }                               // ASCII
    if ((c >= 0x3040 && c <= 0x30FF)                                     // 平假名 / 片假名
      || (c >= 0x4E00 && c <= 0x9FFF)                                    // 汉字
      || (c >= 0x3000 && c <= 0x303F)                                    // 日语标点
      || (c >= 0xFF01 && c <= 0xFF60)                                    // 全角符号
      || (c >= 0xFFE0 && c <= 0xFFE6)) { good += 2; continue; }
    good += 1;                                                           // 拉丁字母等：不奖不罚
  }
  const total = good + bad;
  return total === 0 ? 0 : good / total;
}

/* ---------------- 检测 ---------------- */

/**
 * 从字节判定编码。
 *
 * @param {Uint8Array|number[]} input 原始字节
 * @param {{decode?: (label:string, bytes:Uint8Array)=>string}} [opts]
 *        注入解码器后，Shift-JIS / EUC-JP 的结构歧义可以用"解出来像不像日语"裁决；
 *        不注入时歧义一律判 Shift-JIS 并标 medium（老 galgame 脚本以 Shift-JIS 为主）。
 * @returns {{encoding:string, bom:boolean, confidence:'high'|'medium'|'low',
 *            evidence:string[], candidates?:Array<{encoding:string, score:number}>}}
 */
export function detectEncoding(input, opts = {}) {
  const b = toBytes(input);
  const decode = typeof opts.decode === 'function' ? opts.decode : null;
  const evidence = [];

  if (!b.length) return { encoding: ENC.UTF8, bom: false, confidence: 'high', evidence: ['空文件'] };

  // ① BOM 一票定音
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return { encoding: ENC.UTF8_BOM, bom: true, confidence: 'high', evidence: ['UTF-8 BOM'] };
  }
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
    if (b.length >= 4 && b[2] === 0x00 && b[3] === 0x00) {
      return { encoding: ENC.UNKNOWN, bom: true, confidence: 'low', evidence: ['UTF-32 LE BOM：本扩展不解码 32 位编码'] };
    }
    return { encoding: ENC.UTF16LE, bom: true, confidence: 'high', evidence: ['UTF-16 LE BOM'] };
  }
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    return { encoding: ENC.UTF16BE, bom: true, confidence: 'high', evidence: ['UTF-16 BE BOM'] };
  }

  // ② NUL 字节：要么是无 BOM 的 UTF-16，要么干脆不是文本。
  //    这一段必须排在"纯 ASCII"之前 —— UTF-16 的 ASCII 文本满屏 NUL，会被当成"7 位文本"。
  //    UTF-16 的码元是 2 字节，奇数长度直接排除。
  if (b.includes(0)) {
    const utf16 = (b.length >= 16 && b.length % 2 === 0) ? utf16NoBomHint(b) : null;
    if (utf16) {
      return { encoding: utf16, bom: false, confidence: 'medium', evidence: ['NUL 字节集中在同一侧（无 BOM 的 UTF-16 特征）'] };
    }
    return {
      encoding: ENC.UNKNOWN, bom: false, confidence: 'low',
      evidence: ['含 NUL 字节，但不满足无 BOM UTF-16 的特征 → 不按文本处理'],
    };
  }

  // ③ 纯 ASCII：任何编码都解得一样，直接当 UTF-8
  let ascii = true;
  for (let i = 0; i < b.length; i++) { if (b[i] >= 0x80) { ascii = false; break; } }
  if (ascii) {
    if (hasIso2022JpEscape(b)) {
      return { encoding: ENC.ISO2022JP, bom: false, confidence: 'high', evidence: ['全部 7 位，且含 ESC 切换序列'] };
    }
    return { encoding: ENC.UTF8, bom: false, confidence: 'high', evidence: ['纯 ASCII'] };
  }

  // ④ 严格 UTF-8
  if (isValidUtf8(b)) {
    return { encoding: ENC.UTF8, bom: false, confidence: 'high', evidence: ['字节序列是合法 UTF-8'] };
  }
  evidence.push('不是合法 UTF-8');

  // ⑤ ISO-2022-JP（7 位转义）
  if (hasIso2022JpEscape(b)) {
    let sevenBit = true;
    for (let i = 0; i < b.length; i++) { if (b[i] >= 0x80) { sevenBit = false; break; } }
    if (sevenBit) {
      return { encoding: ENC.ISO2022JP, bom: false, confidence: 'high', evidence: ['ESC 切换序列 + 全 7 位'] };
    }
  }

  // ⑥ 日文双字节编码：先看结构合法性
  const sjis = scanShiftJis(b);
  const euc = scanEucJp(b);
  evidence.push(`Shift-JIS 结构：成对 ${sjis.pairs}、半角 ${sjis.halfWidth}、违规 ${sjis.violations}`);
  evidence.push(`EUC-JP 结构：成对 ${euc.pairs}、半角 ${euc.halfWidth}、违规 ${euc.violations}`);

  const sjisOk = sjis.violations === 0;
  const eucOk = euc.violations === 0;
  if (sjisOk && !eucOk) return { encoding: ENC.SJIS, bom: false, confidence: 'high', evidence };
  if (eucOk && !sjisOk) return { encoding: ENC.EUCJP, bom: false, confidence: 'high', evidence };

  if (sjisOk && eucOk) {
    // 两种结构都合法 —— 只能靠"解出来像不像日语"裁决
    if (decode) {
      const scores = [];
      for (const [enc, label] of [[ENC.SJIS, DECODER_LABEL[ENC.SJIS]], [ENC.EUCJP, DECODER_LABEL[ENC.EUCJP]]]) {
        let text = '';
        try { text = decode(label, b); } catch (e) { text = ''; }
        scores.push({ encoding: enc, score: scoreJapanese(text) });
      }
      scores.sort((x, y) => y.score - x.score || (x.encoding === ENC.SJIS ? -1 : 1));
      const win = scores[0];
      return {
        encoding: win.encoding,
        bom: false,
        confidence: win.score - scores[1].score > 0.15 ? 'medium' : 'low',
        evidence: evidence.concat([`解码打分：${scores.map(s => `${ENC_LABEL[s.encoding]}=${s.score.toFixed(2)}`).join(' / ')}`]),
        candidates: scores,
      };
    }
    return {
      encoding: ENC.SJIS,
      bom: false,
      confidence: 'medium',
      evidence: evidence.concat(['两种结构都合法且未注入解码器 → 保守取 Shift-JIS']),
    };
  }

  // ⑦ 两种结构都有违规：谁轻谁赢，但违规占比过高就承认拿不准
  const best = sjis.violations <= euc.violations
    ? { encoding: ENC.SJIS, violations: sjis.violations }
    : { encoding: ENC.EUCJP, violations: euc.violations };
  // 门槛按**比例**：小文件里几个坏字节就已过半，不能因为绝对数小就认下来。
  // 大文件留一点余量（真实脚本偶尔有孤立坏字节），但超过 64 个就直接认输。
  if (best.violations / b.length > 0.05 || best.violations > 64) {
    return { encoding: ENC.UNKNOWN, bom: false, confidence: 'low', evidence: evidence.concat(['两种日文编码的结构都对不上 → 不猜']) };
  }
  return { encoding: best.encoding, bom: false, confidence: 'low', evidence: evidence.concat(['两种结构都有违规，取违规较少的一种']) };
}

/**
 * 按检测结果把字节解成文本（解码器由调用方注入，本模块不碰 TextDecoder）。
 * BOM 在这里剥掉：解出来的文本要能直接拿去解析脚本，不能带一个不可见字符打头。
 */
export function decodeBytes(bytes, info, decode) {
  const b = toBytes(bytes);
  const enc = info && info.encoding ? info.encoding : ENC.UTF8;
  if (enc === ENC.UNKNOWN) {
    // 判定为未知时也要给点东西看，但要标清楚这是"按 UTF-8 硬读"，不是判定结论
    return { text: decode('utf-8', b), encoding: ENC.UTF8, degraded: true, reason: '编码判定为未知，已按 UTF-8 读' };
  }
  const label = DECODER_LABEL[enc] || 'utf-8';
  let view = b;
  if (enc === ENC.UTF8_BOM && b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) view = b.subarray(3);
  else if (enc === ENC.UTF16LE && b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) view = b.subarray(2);
  else if (enc === ENC.UTF16BE && b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) view = b.subarray(2);
  let text;
  try {
    text = decode(label, view);
  } catch (e) {
    // 宿主没有这个解码器（理论上 Electron 都有）→ 退到 UTF-8，但要让调用方看得到降级
    text = decode('utf-8', b);
    return { text, encoding: ENC.UTF8, degraded: true, reason: `解码器不可用：${label}` };
  }
  const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return { text: stripped, encoding: enc, degraded: false };
}

/* ---------------- 反向表编码 ---------------- */

/** 反向表的候选字节序列（按优先级顺序生成；先标准双字节区，再 JIS X 0212 三字节区） */
export function* candidateSequences(kind) {
  if (kind === ENC.SJIS) {
    for (let lead = 0x81; lead <= 0x9F; lead++) {
      for (let trail = 0x40; trail <= 0xFC; trail++) {
        if (trail === 0x7F) continue;
        yield [lead, trail];
      }
    }
    for (let lead = 0xE0; lead <= 0xFC; lead++) {
      for (let trail = 0x40; trail <= 0xFC; trail++) {
        if (trail === 0x7F) continue;
        yield [lead, trail];
      }
    }
    for (let c = 0xA1; c <= 0xDF; c++) yield [c];          // 单字节半角片假名
    return;
  }
  if (kind === ENC.EUCJP) {
    for (let a = 0xA1; a <= 0xFE; a++) {
      for (let c = 0xA1; c <= 0xFE; c++) yield [a, c];     // JIS X 0208（标准区，优先）
    }
    for (let c = 0xA1; c <= 0xDF; c++) yield [0x8E, c];      // 半角片假名：2 字节
    for (let a = 0xA1; a <= 0xFE; a++) {
      for (let c = 0xA1; c <= 0xFE; c++) yield [0x8F, a, c]; // JIS X 0212（补字面）：3 字节
    }
  }
}

/**
 * 建"字符 → 字节"反向表。
 *
 * **为什么要反推而不是写死映射表**：JIS X 0208 有 6879 个字，加 CP932 扩展近万个，
 * 手抄一份必然有错且会与宿主的解码器分叉。这里让宿主的解码器自己交代它的映射 ——
 * 解码器认的字符才进表，于是"能解的都能编回去"。
 *
 * @param {string} kind ENC.SJIS | ENC.EUCJP
 * @param {(bytes:Uint8Array)=>string} decode 单序列解码（长度必须是 1 个字符才算数）
 */
export function buildReverseTable(kind, decode) {
  const map = new Map();
  for (const seq of candidateSequences(kind)) {
    let s;
    try { s = decode(Uint8Array.from(seq)); } catch (e) { continue; }
    if (typeof s !== 'string' || s.length !== 1) continue;
    const c = s.codePointAt(0);
    if (c === 0xFFFD || c < 0x20 || (c >= 0xE000 && c <= 0xF8FF)) continue;
    if (!map.has(s)) map.set(s, seq);
  }
  return map;
}

/**
 * 按反向表把文本编成字节。
 * 表里没有的字符进 `missing` —— 调用方**必须**在 missing 非空时拒绝写盘，
 * 否则会像"用 ? 顶替"那样把译文写坏（本项目的一贯取舍：宁可拒绝，不写坏文件）。
 */
export function encodeWithTable(text, map) {
  const out = [];
  const missing = new Set();
  for (const ch of String(text == null ? '' : text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); continue; }
    const seq = map.get(ch);
    if (!seq) { missing.add(ch); continue; }
    for (const byte of seq) out.push(byte);
  }
  return { bytes: Uint8Array.from(out), missing: [...missing] };
}
