// encoding.js — 文本编码的选择与说明（纯逻辑，无 DOM / 无 IO）
//
// 为什么需要这个模块：桌面端读取早就支持多种编码，但**写出固定 UTF-8** ——
// 读进来是 Shift-JIS 的游戏脚本，保存回去变成 UTF-8，引擎读出来就是乱码，
// 而用户以为保存成功了。所以读出的编码必须能作为写回的默认编码。
//
// 分工：
//   · 本模块只管"名字、能不能写、怎么跟用户说"——纯数据与判断；
//   · 真正的编解码在 Rust 侧（`src-tauri/src/lib.rs` 的 encode_text / decode_with_name），
//     因为浏览器的 TextEncoder 只支持 UTF-8，自己实现 SJIS/EUC-JP 编码表不现实。
//
// ⚠️ 不要在这里"顺手"把不支持的编码降级成 UTF-8：那正是要修的静默替换。

/** 可选编码清单。`desktopOnly` 的项在浏览器端无法真正写出。 */
export const ENCODINGS = [
  { id: 'utf-8', label: 'UTF-8（无 BOM）', desktopOnly: false, japanese: true, chinese: true },
  { id: 'utf-8-bom', label: 'UTF-8（带 BOM）', desktopOnly: true, japanese: true, chinese: true },
  { id: 'shift-jis', label: 'Shift-JIS', desktopOnly: true, japanese: true, chinese: false },
  { id: 'euc-jp', label: 'EUC-JP', desktopOnly: true, japanese: true, chinese: false },
  { id: 'utf-16le', label: 'UTF-16 LE', desktopOnly: true, japanese: true, chinese: true },
  { id: 'utf-16be', label: 'UTF-16 BE', desktopOnly: true, japanese: true, chinese: true },
];

/** 默认写出编码（与 Rust 侧一致） */
export const DEFAULT_ENCODING = 'utf-8';

/** 旧版/别名写法 → 规范 id。无法识别返回 ''。 */
export function normalizeEncoding(name){
  const s = String(name == null ? '' : name).trim().toLowerCase();
  if (!s) return '';
  // 规范 id 本身先原样认下 —— 别名表容易漏掉"本来就是对的那种写法"
  if (ENCODINGS.some(e => e.id === s)) return s;
  const alias = {
    'utf8': 'utf-8',
    'utf_8': 'utf-8',
    'utf-8-sig': 'utf-8-bom',
    'utf8bom': 'utf-8-bom',
    'sjis': 'shift-jis',
    'shift_jis': 'shift-jis',
    'euc_jp': 'euc-jp',
    'utf16le': 'utf-16le',
    'utf16be': 'utf-16be',
  };
  return alias[s] || '';
}

/** 规范 id → 清单项；未知返回 null */
export function encodingInfo(name){
  const id = normalizeEncoding(name);
  return id ? (ENCODINGS.find(e => e.id === id) || null) : null;
}

/** 显示名（未知编码原样返回，便于把真实值暴露给用户而不是显示"未知"） */
export function encodingLabel(name){
  const info = encodingInfo(name);
  return info ? info.label : String(name == null ? '' : name);
}

/**
 * 该编码是否能在"当前运行形态"下真正写出。
 * 浏览器端只有 UTF-8（TextEncoder 的硬限制），其余编码标为不可用而不是假装支持。
 */
export function canWriteEncoding(name, isDesktop){
  const info = encodingInfo(name);
  if (!info) return false;
  return isDesktop ? true : !info.desktopOnly;
}

/**
 * 用户可选的写出编码清单（供导出/保存选择器用）。
 * 浏览器端把桌面专属项标成 disabled 并给出原因，而不是从列表里删掉 ——
 * 用户需要知道"这个能力在桌面版里有"。
 */
export function writeEncodingOptions(isDesktop){
  return ENCODINGS.map(e => ({
    id: e.id,
    label: e.label,
    // 能表示中文吗？SJIS/EUC-JP 表示不了简体中文，是最常见的保存失败原因
    chineseSafe: !!e.chinese,
    disabled: !canWriteEncoding(e.id, isDesktop),
    disabledReason: canWriteEncoding(e.id, isDesktop) ? '' : '浏览器版只能写出 UTF-8，请用桌面版',
  }));
}

/**
 * 保存时选编码的建议：**优先沿用原文件编码**（忠实往返）。
 * 原文件没有已知编码（新文件/浏览器）时用 UTF-8。
 */
export function suggestWriteEncoding(sourceEncoding){
  const id = normalizeEncoding(sourceEncoding);
  return id || DEFAULT_ENCODING;
}

/**
 * 在编码选择器里给"会出问题"的组合加一句提示。
 * 返回 '' 表示无需提示。
 */
export function encodingWarning(name, hasChinese){
  const info = encodingInfo(name);
  if (!info) return '';
  if (hasChinese && !info.chinese){
    return info.label + ' 无法表示简体中文，保存时会拒绝写入（改用 UTF-8，或让译文只用日文汉字）。';
  }
  if (name === 'utf-8-bom' && !hasChinese) {
    return '带 BOM 的 UTF-8 会被多数脚本引擎当成乱码开头，只有确认目标引擎需要时才用。';
  }
  return '';
}

/** 检测文本里有没有 CJK 扩展区之外的简体中文专用字（用于上面的提示，粗判即可） */
export function looksChinese(text, sampleLimit = 4000){
  const s = String(text == null ? '' : text).slice(0, sampleLimit);
  // 简体专用字（不含日文汉字里也有的常用字）——只做提示，不参与保存判定
  return /[们这那么什么说过语译对话时间学习实现确认风让见读]/.test(s);
}
