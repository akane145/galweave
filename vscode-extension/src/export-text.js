// export-text.js — 导出文本的收尾处理（纯逻辑，不碰文件系统）
//
// 存在的唯一理由：`parsers.buildExport` 的收尾是 `lines.join(nl) + nl`（parsers.js:401），
// **总是**补一个换行，所以末尾没有换行的源文件回写后会多出一个。
// 桌面版一直是这样（引擎多半不在意），但"无损还原"的说法在这种文件上不成立。
// 本模块在自己的层里把这一位补回来，不改共享代码。

/**
 * 按源文件的实际情况还原结尾换行。
 * @param {string} text buildExport 的产物
 * @param {boolean} endsWithNewline 源文件末尾是否有换行（parseLines 的返回值）
 */
export function restoreTrailingNewline(text, endsWithNewline) {
  if (endsWithNewline) return text;
  return String(text).replace(/\r?\n$/, '');
}

import { setParseConf } from '../../src/parsers.js';

/**
 * 生成"原格式"导出文本 —— 与桌面版回写用的是同一个 buildExport，
 * 因此天然满足"原文行原样输出、只改译文槽位"。
 *
 * **conf 必须显式传**：`buildExport` 内部的 `buildStarPrefix` 读的是
 * `src/parsers.js` 的模块级 `parseConf.close`（parsers.js:371）。
 * 不显式对齐的话，导出结果会取决于"最后一次解析的是哪个文件" ——
 * 用户打开文件 B 之后再导出文件 A，就会拿 B 的标记字符去写 A 的译文行。
 *
 * @param {{paras:Array, nl:string, trailingBlank:boolean, endsWithNewline:boolean}} parsed
 * @param {(paras:Array, nl:string, trailingBlank:boolean)=>string} buildExportFn
 * @param {object} [conf] 该文件命中的规则配置
 */
export function exportOriginalFormat(parsed, buildExportFn, conf) {
  if (conf) setParseConf(conf);
  const text = buildExportFn(parsed.paras, parsed.nl, parsed.trailingBlank);
  return restoreTrailingNewline(text, parsed.endsWithNewline);
}

/**
 * 往返自检：把解析结果重建回文本，与原文逐字节比对。
 *
 * **这是导出前的强制关卡。** 与其去枚举"哪些文件不能安全重建"（枚举不全就等着损坏文件），
 * 不如直接重建一遍比对 —— 凡是重建结果与原文件不一致的，一律拒绝导出。
 * 实测样本里就有三种会导致不一致，每一种都能毁掉文件：
 *   ① 译文行编号与原文行不同（引擎约定，如 `新建 文本文档 (11).txt` 全部 +1）
 *      —— 重建会按原文行改掉全部译文行编号
 *   ② 自定义正则规则的译文行格式与 ☆/★ 分段式不同（如 `(13).txt` 的 `●…● [[名]] …`）
 *      —— buildStarPrefix 会写出格式错误的译文行
 *   ③ 文件开头有空行 —— buildExport 不保留前导空行
 *
 * @returns {{ok:boolean, rebuilt?:string, diffAt?:number, line?:number, expected?:string, actual?:string}}
 */
export function verifyRoundTrip(parsed, originalText, buildExportFn, conf) {
  const rebuilt = exportOriginalFormat(parsed, buildExportFn, conf);
  if (rebuilt === originalText) return { ok: true, rebuilt };

  let i = 0;
  const n = Math.min(rebuilt.length, originalText.length);
  while (i < n && rebuilt[i] === originalText[i]) i++;
  const from = Math.max(0, i - 60);
  return {
    ok: false,
    rebuilt,
    diffAt: i,
    line: originalText.slice(0, i).split(/\r?\n/).length,
    expected: originalText.slice(from, i + 60),
    actual: rebuilt.slice(from, i + 60),
  };
}

/**
 * 给出"为什么重建不一致"的可用解释，供导出被拒时展示。
 * 只覆盖已知的三类成因；认不出来就返回空数组，让调用方展示位置的原始差异。
 */
export function explainRoundTripFailure(parsed) {
  const paras = Array.isArray(parsed?.paras) ? parsed.paras : [];
  const reasons = [];

  const idDiffers = paras.some(p => p.lineIndices.trans !== null && p.lineIndices.trans !== undefined
    && p.transId && p.id && p.transId !== p.id);
  if (idDiffers) {
    reasons.push('译文行编号与原文行不同（引擎约定）。重建译文行会按原文行改写这些编号，可能让引擎找不到译文。');
  }
  if (paras.some(p => p.rangeSource === 'regex-named')) {
    reasons.push('本文件用的是自定义正则规则，译文行格式与 ☆/★ 分段式不同，重建会写出格式错误的译文行。');
  }
  if (paras.length && parsed.lines?.[0] && parsed.lines[0].role === 'blank') {
    reasons.push('文件开头有空行，重建不保留前导空行。');
  }
  return reasons;
}
